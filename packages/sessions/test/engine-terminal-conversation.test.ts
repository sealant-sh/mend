import type { SessionId } from "@mend/domain";
import { AgentHookReport, currentAgentProcess } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import type { CreateOptions } from "@sealant/sdk";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  sealantLaunchLayer,
  servedSocketApis,
  setup,
  withEngine,
  type World,
} from "./engine/fixture.ts";

// SLNT-1235: one session from its terminal and its conversation. A terminal launch records the
// session's mode, and a terminal agent's finished turn is read from its own transcript.

const agentOf = (world: World, sessionId: SessionId) =>
  currentAgentProcess([...world.processes.values()].filter((row) => row.sessionId === sessionId));

const withClaudeTerminal = <A, E>(
  work: (world: World, sessionId: SessionId) => Effect.Effect<A, E, SessionEngine>,
  execCalls: Array<ReadonlyArray<string>>,
) => {
  const created: Array<CreateOptions> = [];
  return withEngine(
    (world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const session = yield* engine.provision({
          projectId: project.id,
          harness: "claude",
          label: null,
          name: null,
          ownerUserId: "user-fixture",
          start: { kind: "base", base: null },
        });
        expect(world.sessions.get(session.id)?.mode ?? null).toBeNull();
        yield* engine.launch(session.id, ["claude"]);
        return yield* work(world, session.id);
      }),
    {
      sealantLayer: sealantLaunchLayer(
        created,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        execCalls,
      ),
    },
  );
};

describe("a session from its terminal and its conversation (SLNT-1235)", () => {
  it("records the terminal mode once a terminal agent starts", async () => {
    await withClaudeTerminal(
      (world, sessionId) =>
        Effect.sync(() => {
          expect(agentOf(world, sessionId)?.kind).toBe("agent-pty");
          expect(world.sessions.get(sessionId)?.mode).toBe("terminal");
        }),
      [],
    );
  });

  it("reads the agent's own transcript, by its id, once its turn ends", async () => {
    const execCalls: Array<ReadonlyArray<string>> = [];
    await withClaudeTerminal(
      (world, sessionId) =>
        Effect.gen(function* () {
          const providerSessionId = agentOf(world, sessionId)?.providerSessionId ?? null;
          expect(providerSessionId).not.toBeNull();
          const hook = servedSocketApis.get(sessionId)?.agentHook;
          if (hook === undefined) throw new Error("the session serves no channel");
          yield* hook(
            new AgentHookReport({
              harness: "claude",
              event: "Stop",
              notificationType: null,
              tool: null,
              providerSessionId,
            }),
          );
          const read = () =>
            execCalls.some(
              (argv) =>
                argv[0] === "sh" &&
                (argv[2] ?? "").includes(`.claude/projects/*/${providerSessionId}.jsonl`),
            );
          for (let wait = 0; wait < 200 && !read(); wait++) yield* Effect.sleep("10 millis");
          expect(read()).toBe(true);
        }),
      execCalls,
    );
  });
});
