import { AgentConversationRepo } from "@mend/db";
import {
  AgentTurnId,
  ClientMessageId,
  SealantRunId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
} from "@mend/domain";
import {
  AgentTurn,
  MessageInput,
  MessageSettings,
  Session,
  type SendMessageInput,
} from "@mend/domain/workbench";
import { it } from "@mend/test-ci/effect-vitest";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";

import { SessionEngine } from "../src/engine.ts";
import { ProtocolHost, ProtocolHostNotLiveError } from "../src/protocol-host.ts";
import { seedStoppedBeforeRestart } from "./engine/capture-fixture.ts";
import {
  agentConversationStub,
  protocolHostStubLayer,
  withEngineEffect,
} from "./engine/fixture.ts";
import { makeSteerStore } from "./support/steer-store.ts";

const sessionId = SessionId.make("session-message");
const processId = SessionProcessId.make("agent-boot");
const sender = "user-fixture";
const makeTurn = (patch: Partial<AgentTurn> = {}) =>
  new AgentTurn({
    id: AgentTurnId.make(crypto.randomUUID()),
    sessionId,
    processId,
    ordinal: 0,
    author: sender,
    input: "start",
    status: "running",
    providerTurnId: null,
    error: null,
    usage: null,
    createdAt: new Date(),
    startedAt: new Date(),
    endedAt: null,
    ...patch,
  });
const request = (): SendMessageInput => ({
  sessionId,
  sender,
  input: MessageInput.make("  keep every word\n"),
  clientMessageId: ClientMessageId.make(crypto.randomUUID()),
  intent: "default",
});

const cases: ReadonlyArray<{
  name: string;
  turns: ReadonlyArray<Partial<AgentTurn>>;
  result: "Steer" | "Turn" | "Ambiguous";
  off?: boolean;
  queue?: boolean;
}> = [
  { name: "own running turn without provider id", turns: [{}], result: "Steer" },
  { name: "author wins over another payer", turns: [{ billedUserId: "another" }], result: "Steer" },
  {
    name: "harness turn uses its payer",
    turns: [{ author: null, billedUserId: sender, origin: "harness" }],
    result: "Steer",
  },
  {
    name: "payer cannot steer another author",
    turns: [{ author: "another", billedUserId: sender }],
    result: "Turn",
  },
  { name: "no recorded sender", turns: [{ author: null, billedUserId: null }], result: "Turn" },
  {
    name: "queued caller behind another sender",
    turns: [{ status: "queued" }, { author: "another" }],
    result: "Turn",
  },
  {
    name: "another session does not qualify",
    turns: [{ sessionId: SessionId.make("elsewhere") }],
    result: "Turn",
  },
  { name: "idle conversation", turns: [], result: "Turn" },
  {
    name: "several own running turns",
    turns: [{}, { processId: SessionProcessId.make("another-process") }],
    result: "Ambiguous",
  },
  { name: "explicit queue with several own turns", turns: [{}, {}], queue: true, result: "Turn" },
  { name: "preference off with several own turns", turns: [{}, {}], off: true, result: "Turn" },
];

describe("SessionEngine send rule", () => {
  for (const example of cases)
    it.effect(example.name, () => {
      const turns = new Map(
        example.turns.map((patch) => {
          const turn = makeTurn(patch);
          return [turn.id, turn];
        }),
      );
      const store = makeSteerStore(turns);
      const preferences = new Map([
        [sender, new MessageSettings({ sendSteersRunningTurn: !example.off })],
      ]);
      return withEngineEffect(
        (world, tmp) =>
          Effect.gen(function* () {
            seedStoppedBeforeRestart(world, tmp, {
              sessionId,
              workspaceId: SealantWorkspaceId.make("workspace-message"),
              runId: SealantRunId.make("run-message"),
              processLive: false,
            });
            const engine = yield* SessionEngine;
            const input = {
              ...request(),
              intent: example.queue ? ("queue" as const) : ("default" as const),
            };
            const outcome = yield* engine.sendMessage(input).pipe(Effect.result);
            if (example.result === "Ambiguous") {
              expect(outcome).toMatchObject({
                _tag: "Failure",
                failure: { _tag: "MessageTargetAmbiguousError" },
              });
              expect(yield* store.messageByClientId(input)).toBeNull();
            } else {
              expect(outcome).toMatchObject({ _tag: "Success", success: { _tag: example.result } });
              if (outcome._tag !== "Success") return;
              const receipt = outcome.success;
              expect(receipt._tag === "Steer" ? receipt.steer.input : receipt.turn.input).toBe(
                input.input,
              );
              if (receipt._tag === "Steer") expect(receipt.steer.turnId).toBe([...turns.keys()][0]);
              preferences.set(sender, new MessageSettings({ sendSteersRunningTurn: false }));
              for (const [id, turn] of turns)
                turns.set(id, new AgentTurn({ ...turn, status: "completed" }));
              const session = world.sessions.get(sessionId);
              if (session === undefined) return yield* Effect.die("missing session");
              world.sessions.set(sessionId, new Session({ ...session, settledAt: new Date() }));
              const replay = yield* engine.sendMessage(input);
              expect(replay.messageId).toBe(receipt.messageId);
              expect(replay._tag).toBe(receipt._tag);
              expect(replay._tag === "Steer" ? replay.steer.id : replay.turn.id).toBe(
                receipt._tag === "Steer" ? receipt.steer.id : receipt.turn.id,
              );
            }
          }),
        {
          messageSettings: preferences,
          conversationLayer: Layer.succeed(AgentConversationRepo, {
            ...agentConversationStub,
            ...store,
            openTurns: () => Effect.sync(() => [...turns.values()]),
          }),
          protocolHostLayer: Layer.effect(
            ProtocolHost,
            Effect.map(ProtocolHost, (host) => ({
              ...host,
              sendMessage: (
                input: SendMessageInput,
                choice: Parameters<ProtocolHost["Service"]["sendMessage"]>[1],
              ) =>
                Effect.gen(function* () {
                  const admitted =
                    choice._tag === "Steer"
                      ? yield* store.admitSteerMessage(input, choice.turnId)
                      : yield* store.admitTurnMessage(input, processId, choice.reason);
                  return admitted.result;
                }).pipe(
                  Effect.catchTags({
                    SessionStoppingError: () =>
                      Effect.fail(new ProtocolHostNotLiveError({ processId })),
                    AgentTurnNotFoundError: Effect.die,
                    TurnSteerForbiddenError: Effect.die,
                  }),
                ),
            })),
          ).pipe(Layer.provide(protocolHostStubLayer)),
        },
      );
    });

  it.effect("returns a matching concurrent binding before reporting ambiguous selection", () => {
    const a = makeTurn();
    const b = makeTurn();
    const turns = new Map([
      [a.id, a],
      [b.id, b],
    ]);
    const store = makeSteerStore(turns);
    const input = request();
    return withEngineEffect(
      (world, tmp) =>
        Effect.gen(function* () {
          seedStoppedBeforeRestart(world, tmp, {
            sessionId,
            workspaceId: SealantWorkspaceId.make("workspace-message"),
            runId: SealantRunId.make("run-message"),
            processLive: false,
          });
          const result = yield* (yield* SessionEngine).sendMessage(input);
          expect(result).toMatchObject({
            _tag: "Turn",
            turn: { input: input.input, status: "queued" },
          });
          expect(turns.size).toBe(3);
        }),
      {
        conversationLayer: Layer.succeed(AgentConversationRepo, {
          ...agentConversationStub,
          ...store,
          openTurns: () =>
            store
              .admitTurnMessage(input, processId, "no-own-running-turn")
              .pipe(Effect.orDie, Effect.as([a, b])),
        }),
      },
    );
  });

  it.effect("replays a person's own message after shared control is turned off", () => {
    const store = makeSteerStore(new Map());
    const input = { ...request(), sender: "user-2" };
    return withEngineEffect(
      (world, tmp) =>
        Effect.gen(function* () {
          seedStoppedBeforeRestart(world, tmp, {
            sessionId,
            workspaceId: SealantWorkspaceId.make("workspace-message"),
            runId: SealantRunId.make("run-message"),
            processLive: false,
          });
          const admitted = yield* store.admitTurnMessage(input, processId, "no-own-running-turn");
          const engine = yield* SessionEngine;
          expect(yield* engine.sendMessage(input)).toEqual(admitted.result);
          expect(
            yield* engine
              .sendMessage({ ...input, clientMessageId: ClientMessageId.make(crypto.randomUUID()) })
              .pipe(Effect.flip),
          ).toMatchObject({ _tag: "SessionTurnRefusedError" });
        }),
      {
        conversationLayer: Layer.succeed(AgentConversationRepo, {
          ...agentConversationStub,
          ...store,
        }),
      },
    );
  });
});
