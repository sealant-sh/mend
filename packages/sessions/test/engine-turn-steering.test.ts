import { AgentConversationRepo, makeHarnessLayoutsMemoryState } from "@mend/db";
import {
  AgentTurnId,
  AgentTurnSteerId,
  SealantRunId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
} from "@mend/domain";
import { AgentTurn, AgentTurnSteer, Session } from "@mend/domain/workbench";
import { it } from "@mend/test-ci/effect-vitest";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";

import { SessionEngine } from "../src/engine.ts";
import { ProtocolHost, type SteerTurnInput } from "../src/protocol-host.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { seedStoppedBeforeRestart } from "./engine/capture-fixture.ts";
import { agentConversationStub, withEngineEffect } from "./engine/fixture.ts";
import { MARIA, personPlatform } from "./engine/person-fixture.ts";

describe("SessionEngine native steering admission", () => {
  it.effect.each(["allowed", "retiring", "control-off"] as const)(
    "%s keeps the sender's existing payer",
    (condition) => {
      const sessionId = SessionId.make("session-steer");
      const workspaceId = SealantWorkspaceId.make("workspace-steer");
      const state = makeHarnessLayoutsMemoryState();
      const sent: Array<SteerTurnInput> = [];
      const loginReads: Array<string> = [];
      const turn = new AgentTurn({
        id: AgentTurnId.make("turn-steer"),
        sessionId,
        processId: SessionProcessId.make("agent-boot"),
        ordinal: 0,
        author: MARIA,
        billedUserId: MARIA,
        billedAccountId: "existing-login",
        billedAccountName: "Existing login",
        input: "start",
        status: "running",
        providerTurnId: "native",
        error: null,
        usage: null,
        createdAt: new Date(),
        startedAt: new Date(),
        endedAt: null,
      });
      const receipt = new AgentTurnSteer({
        id: AgentTurnSteerId.make("d662262a-b147-4f97-a8e5-c225f0a41502"),
        sessionId,
        processId: turn.processId,
        turnId: turn.id,
        ordinal: 0,
        author: MARIA,
        input: "  keep this\n",
        delivery: { _tag: "Accepted", evidence: "provider-acknowledged" },
        clientSteerId: null,
        queuedTurnId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return withEngineEffect(
        (world, tmp) =>
          Effect.gen(function* () {
            seedStoppedBeforeRestart(world, tmp, {
              sessionId,
              workspaceId,
              runId: SealantRunId.make("run-steer"),
              processLive: false,
            });
            const session = world.sessions.get(sessionId);
            if (session === undefined) return yield* Effect.die("missing session");
            world.sessions.set(
              sessionId,
              new Session({
                ...session,
                sharedControlEnabledAt: condition === "control-off" ? null : new Date(),
              }),
            );
            if (condition === "retiring")
              state.retirements.set(workspaceId, {
                workspaceId,
                sessionId,
                worktreeId: session.worktreeId,
                launcher: session.ownerUserId,
                state: "retiring",
                preRelease: false,
                stops: [],
                reason: null,
                checkedAt: null,
                restart: [],
                updatedAt: new Date(),
              });
            const engine = yield* SessionEngine;
            const input = { turnId: turn.id, sender: MARIA, input: receipt.input };
            const result = yield* engine.steerTurn(input).pipe(Effect.result);
            if (condition === "allowed") {
              expect(result._tag).toBe("Success");
              if (result._tag === "Success") expect(result.success).toEqual(receipt);
              expect(sent).toEqual([input]);
            } else {
              expect(result).toMatchObject({
                _tag: "Failure",
                failure: { _tag: "SessionTurnRefusedError" },
              });
              expect(sent).toEqual([]);
            }
            expect(loginReads).toEqual([]);
            expect(turn.billedAccountId).toBe("existing-login");
          }),
        {
          captured: makeMemoryCaptureStore(),
          prepareWorld: (world) => world.members.set(MARIA, "member"),
          conversationLayer: Layer.succeed(AgentConversationRepo, {
            ...agentConversationStub,
            byTurnId: (id) => Effect.succeed(id === turn.id ? turn : null),
          }),
          protocolHostLayer: Layer.succeed(ProtocolHost, {
            attach: () => Effect.void,
            rehydrate: () => Effect.void,
            submitTurn: () => Effect.die("not in test"),
            steerTurn: (input) =>
              Effect.sync(() => {
                sent.push(input);
                return receipt;
              }),
            interruptTurn: () => Effect.void,
            respondRequest: () => Effect.die("not in test"),
            detach: () => Effect.void,
            has: () => Effect.succeed(true),
            quiescence: () => Effect.succeed(null),
            awaitQuiescent: () => Effect.void,
            endWork: () => Effect.void,
            detachForHandOver: () => Effect.void,
          }),
          harnessLayout: {
            flag: "person",
            state,
            platform: personPlatform([], { person: true }, undefined, (accountId) => {
              loginReads.push(accountId);
              return { _tag: "missing" };
            }),
          },
        },
      );
    },
  );
});
