import { AgentTurnId } from "@mend/domain";
import { AgentTurn, type SessionProcess } from "@mend/domain/workbench";
import { ProtocolHost, type ProtocolHostHooks, SessionEngine } from "@mend/sessions";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  completedTurnOf,
  recordedTurnsLayer,
  recordingProtocolHostLayer,
  sealantLaunchLayer,
  setup,
  withEngine,
} from "./engine/fixture.ts";

/**
 * A conversation turn's checkpoint (SLNT-1263): taken when the turn ends, it names the turn, so the
 * conversation puts it after that turn and no other, and it says when Mend can't confirm it holds
 * exactly that turn's files.
 */
describe("a conversation turn's checkpoint", () => {
  /** The recording host, keeping the hooks the engine attached each process with. */
  const hostKeepingHooks = (
    attached: Array<{ readonly process: SessionProcess; readonly mode: string }>,
    hooks: Array<ProtocolHostHooks>,
  ) =>
    Layer.effect(
      ProtocolHost,
      Effect.gen(function* () {
        const inner = yield* ProtocolHost;
        return {
          ...inner,
          attach: (input) => {
            hooks.push(input.hooks);
            return inner.attach(input);
          },
        };
      }),
    ).pipe(Layer.provide(recordingProtocolHostLayer(attached, [])));

  /** Starts a Codex conversation, ends `turn` as Codex would, and returns the chain. */
  const endTurn = (turnsOf: (process: SessionProcess) => ReadonlyArray<AgentTurn>) => {
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const hooks: Array<ProtocolHostHooks> = [];
    const turns: Array<AgentTurn> = [];
    return withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", permissionMode: "bypass" },
            "user-fixture",
          );
          const process = attached[0]?.process;
          const hook = hooks[0];
          if (process === undefined || hook === undefined)
            return yield* Effect.die("the conversation was not attached");
          turns.push(...turnsOf(process));
          const [ended] = turns;
          if (ended === undefined) return yield* Effect.die("no turn to end");
          yield* hook.onTurnCompleted(ended);
          return {
            ended,
            chain: world.checkpoints.filter((each) => each.sessionId === session.id),
          };
        }),
      {
        sealantLayer: sealantLaunchLayer([]),
        protocolHostLayer: hostKeepingHooks(attached, hooks),
        conversationLayer: recordedTurnsLayer(turns),
      },
    );
  };

  it("names the turn it ended, and is confirmed when nothing came after", async () => {
    const { ended, chain } = await endTurn((process) => [completedTurnOf(process)]);
    const taken = chain.at(-1);
    expect(taken?.trigger).toBe("turn-boundary");
    expect(taken?.turnId).toBe(ended.id);
    expect(taken?.unconfirmed).toBeUndefined();
    // The other checkpoints of the session name no turn.
    expect(chain.slice(0, -1).every((each) => each.turnId === undefined)).toBe(true);
  });

  it("says so when the next turn was sent before it was taken", async () => {
    const { ended, chain } = await endTurn((process) => {
      const first = completedTurnOf(process);
      return [
        first,
        new AgentTurn({
          ...first,
          id: AgentTurnId.make("turn-next"),
          ordinal: 1,
          status: "running",
          providerTurnId: null,
          endedAt: null,
        }),
      ];
    });
    const taken = chain.at(-1);
    expect(taken?.turnId).toBe(ended.id);
    expect(taken?.unconfirmed).toBe("next-turn-started");
  });

  it("is confirmed when the next turn waits unsent", async () => {
    const { chain } = await endTurn((process) => {
      const first = completedTurnOf(process);
      return [
        first,
        new AgentTurn({
          ...first,
          id: AgentTurnId.make("turn-next"),
          ordinal: 1,
          status: "queued",
          providerTurnId: null,
          startedAt: null,
          endedAt: null,
        }),
      ];
    });
    expect(chain.at(-1)?.unconfirmed).toBeUndefined();
  });
});
