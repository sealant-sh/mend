import { SessionId } from "@mend/domain";
import {
  AgentHookReport,
  type HookedHarness,
  SessionProcess,
  agentWaitLine,
  currentAgentProcess,
} from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import type { CreateOptions } from "@sealant/sdk";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  CHANNEL_NOT_STARTED_HERE,
  CONTAINER_TOKEN_REFUSED,
  containerTokenRefused,
  pickupOnly,
} from "../src/channel-identity.ts";
import { CLAUDE_AGENT_HOOKS } from "../src/claude-settings.ts";
import {
  sealantLaunchLayer,
  servedSocketApis,
  setup,
  withEngine,
  type World,
} from "./engine/fixture.ts";

const report = (
  event: string,
  fields: { readonly harness?: HookedHarness; readonly tool?: string } = {},
) =>
  new AgentHookReport({
    harness: fields.harness ?? "claude",
    event,
    notificationType: null,
    tool: fields.tool ?? null,
  });

const hookOf = (sessionId: SessionId) => {
  const api = servedSocketApis.get(sessionId);
  if (api === undefined) throw new Error("the session serves no channel");
  return api.agentHook;
};

const agentOf = (world: World, sessionId: SessionId) =>
  currentAgentProcess([...world.processes.values()].filter((row) => row.sessionId === sessionId));

const statusOf = (world: World, sessionId: SessionId) => world.sessions.get(sessionId)?.status;

/** A session with a live claude TUI, as `mend claude` or the VS Code Open flow starts one. */
const withClaudeSession = <A, E>(
  work: (world: World, sessionId: SessionId) => Effect.Effect<A, E, SessionEngine>,
  spawned: Array<ReadonlyArray<string>> = [],
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
          base: null,
        });
        yield* engine.launch(session.id, ["claude"]);
        expect(agentOf(world, session.id)?.kind).toBe("agent-pty");
        return yield* work(world, session.id);
      }),
    { sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned) },
  );
};

describe("a terminal agent's hooks (G4)", () => {
  it("starts a terminal claude in the shared layout with Mend's hooks and nothing else", async () => {
    const spawned: Array<ReadonlyArray<string>> = [];
    await withClaudeSession(() => Effect.void, spawned);
    const claude = spawned.find((argv) => argv.includes("claude")) ?? [];
    expect(claude.slice(-2)).toEqual(["--settings", JSON.stringify({ hooks: CLAUDE_AGENT_HOOKS })]);
  });

  it("reads waiting while claude asks, and running once the tool ran or a prompt arrived", async () => {
    await withClaudeSession((world, sessionId) =>
      Effect.gen(function* () {
        const hook = hookOf(sessionId);
        expect(statusOf(world, sessionId)).toBe("running");

        expect(yield* hook(report("PermissionRequest", { tool: "Bash" }))).toBe("applied");
        expect(statusOf(world, sessionId)).toBe("waiting");
        expect(agentWaitLine(agentOf(world, sessionId))).toBe(
          "waiting · claude needs your permission to use Bash",
        );
        // The ~6 s notification that follows the ask is the same wait.
        expect(
          yield* hook(
            new AgentHookReport({
              harness: "claude",
              event: "Notification",
              notificationType: "permission_prompt",
              tool: null,
            }),
          ),
        ).toBe("unchanged");

        expect(yield* hook(report("PostToolUse", { tool: "Bash" }))).toBe("applied");
        expect(statusOf(world, sessionId)).toBe("running");
        expect(agentOf(world, sessionId)?.waiting).toBeNull();

        expect(yield* hook(report("Stop"))).toBe("applied");
        expect(agentWaitLine(agentOf(world, sessionId))).toBe("waiting · claude finished its turn");
        expect(yield* hook(report("UserPromptSubmit"))).toBe("applied");
        expect(statusOf(world, sessionId)).toBe("running");
      }),
    );
  });

  it("keeps the wait across a reconcile some other process start runs", async () => {
    await withClaudeSession((world, sessionId) =>
      Effect.gen(function* () {
        const engine = yield* SessionEngine;
        yield* hookOf(sessionId)(report("PermissionRequest", { tool: "Bash" }));
        yield* engine.openShell(sessionId);
        expect(statusOf(world, sessionId)).toBe("waiting");
        expect(agentOf(world, sessionId)?.waiting?.tool).toBe("Bash");
      }),
    );
  });

  it("brings no wait back from a report that arrives after the agent ended", async () => {
    await withClaudeSession((world, sessionId) =>
      Effect.gen(function* () {
        const engine = yield* SessionEngine;
        const hook = hookOf(sessionId);
        yield* hook(report("PermissionRequest", { tool: "Bash" }));
        yield* engine.stop(sessionId);
        const ended = agentOf(world, sessionId);
        expect(ended?.exitedAt).not.toBeNull();
        expect(ended?.waiting).toBeNull();
        const statusAfterStop = statusOf(world, sessionId);
        expect(statusAfterStop).not.toBe("waiting");

        expect(yield* hook(report("PermissionRequest", { tool: "Bash" }))).toBe("no-live-agent");
        expect(statusOf(world, sessionId)).toBe(statusAfterStop);
        expect(agentOf(world, sessionId)?.waiting).toBeNull();
      }),
    );
  });

  it("answers no live agent when the session's live agent is not a terminal agent of that harness", async () => {
    await withClaudeSession((world, sessionId) =>
      Effect.gen(function* () {
        const hook = hookOf(sessionId);
        // A Codex run by hand in this Claude session's shell reads Mend's system hooks too.
        expect(yield* hook(report("PermissionRequest", { harness: "codex", tool: "shell" }))).toBe(
          "no-live-agent",
        );
        const agent = agentOf(world, sessionId);
        if (agent === null) throw new Error("no agent");
        world.processes.set(agent.id, new SessionProcess({ ...agent, kind: "agent-protocol" }));
        expect(yield* hook(report("PermissionRequest", { tool: "Bash" }))).toBe("no-live-agent");
        expect(statusOf(world, sessionId)).toBe("running");
        expect(agentOf(world, sessionId)?.waiting).toBeNull();
      }),
    );
  });

  it("ignores an event outside the table without touching the session", async () => {
    await withClaudeSession((world, sessionId) =>
      Effect.gen(function* () {
        expect(yield* hookOf(sessionId)(report("PreToolUse", { tool: "Bash" }))).toBe("ignored");
        expect(statusOf(world, sessionId)).toBe("running");
      }),
    );
  });
});

describe("who may report a wait over the session channel", () => {
  const refusalOf = <A, E>(effect: Effect.Effect<A, E>) => {
    const exit = Effect.runSync(Effect.exit(effect));
    return Exit.isFailure(exit) ? String(exit.cause) : "";
  };

  it("refuses the workspace's own token in a person executor, and a token whose process has not started", () => {
    const asContainer = containerTokenRefused(undefined, undefined);
    expect(
      refusalOf(asContainer.agentHook(report("PermissionRequest", { tool: "Bash" }))),
    ).toContain(CONTAINER_TOKEN_REFUSED);
    expect(refusalOf(pickupOnly(undefined).agentHook(report("Stop")))).toContain(
      CHANNEL_NOT_STARTED_HERE,
    );
  });
});
