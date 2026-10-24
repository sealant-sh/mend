import { Session, SessionProcess } from "@mend/domain/workbench";
import { SealantPlatformError } from "@mend/sealant";
import { ProtocolHost, ProtocolHostNotLiveError, SessionEngine } from "@mend/sessions";
import type { CreateOptions } from "@sealant/sdk";
import { Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import {
  recordingProtocolHostLayer,
  sealantLaunchLayer,
  setup,
  withEngine,
} from "./engine/fixture.ts";

/**
 * The recording host, made to refuse a turn to a process it has let go, as the real host does: a
 * conversation the engine detached takes no more turns.
 */
const detachingProtocolHostLayer = (
  attached: Array<{ readonly process: SessionProcess; readonly mode: string }>,
  submitted: Array<string>,
) =>
  Layer.effect(
    ProtocolHost,
    Effect.map(ProtocolHost, (host) => {
      const detached = new Set<string>();
      const live = () => {
        const current = attached.at(-1)?.process.id;
        return current !== undefined && !detached.has(current);
      };
      return {
        ...host,
        has: (processId) => Effect.sync(() => !detached.has(processId)),
        detach: (processId) => Effect.sync(() => void detached.add(processId)),
        detachForHandOver: (processId) => Effect.sync(() => void detached.add(processId)),
        submitTurn: (sessionId, input, author, correlation) =>
          Effect.suspend(() =>
            live()
              ? host.submitTurn(sessionId, input, author, correlation)
              : Effect.fail(new ProtocolHostNotLiveError({ processId: "detached" })),
          ),
      };
    }),
  ).pipe(Layer.provide(recordingProtocolHostLayer(attached, submitted)));

describe("a mode switch to the terminal the conversation cannot make (SLNT-142)", () => {
  it("refused for missing saved state, it leaves the conversation running and taking turns", async () => {
    const created: Array<CreateOptions> = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: Array<string> = [];
    let refusal: unknown = null;
    let after: Session | undefined;
    let conversation: SessionProcess | undefined;
    let laterTurn = "not sent";
    await withEngine(
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
          // A conversation launched with no prompt: no turn has run, so no transcript exists.
          yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");
          refusal = yield* engine
            .switchMode(session.id, "pty", { mode: "pty" }, "user-fixture")
            .pipe(Effect.flip);
          after = world.sessions.get(session.id);
          conversation = [...world.processes.values()].find(
            (process) => process.sessionId === session.id && process.kind === "agent-protocol",
          );
          const turn = yield* engine
            .submitTurn(session.id, "still here?", "user-fixture")
            .pipe(Effect.result);
          laterTurn = Result.isSuccess(turn) ? "delivered" : turn.failure._tag;
        }),
      {
        captured: makeMemoryCaptureStore(),
        sealantLayer: sealantLaunchLayer(created),
        protocolHostLayer: detachingProtocolHostLayer(attached, submitted),
      },
    );
    expect(refusal).toBeInstanceOf(SealantPlatformError);
    expect(refusal instanceof SealantPlatformError ? refusal.code : null).toBe(
      "mode_switch_state_missing",
    );
    expect.soft(after?.status).toBe("running");
    expect.soft(conversation?.exitedAt).toBeNull();
    expect.soft(laterTurn).toBe("delivered");
    expect.soft(submitted).toEqual(["still here?"]);
    expect(attached).toHaveLength(1);
  }, 30_000);
});
