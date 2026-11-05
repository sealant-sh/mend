import { AgentConversationRepo } from "@mend/db";
import {
  AgentTurnId,
  ClientMessageId,
  SealantRunId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
} from "@mend/domain";
import { AgentTurn, MessageInput, type SendMessageInput } from "@mend/domain/workbench";
import { SealantClient, SealantPlatformError, sealantRequestPriority } from "@mend/sealant";
import { it } from "@mend/test-ci/effect-vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { describe, expect } from "vitest";

import { SessionEngine } from "../src/engine.ts";
import { ProtocolHost } from "../src/protocol-host.ts";
import { seedStoppedBeforeRestart } from "./engine/capture-fixture.ts";
import {
  agentConversationStub,
  protocolHostStubLayer,
  sealantLaunchLayer,
  setup,
  withEngineEffect,
} from "./engine/fixture.ts";
import { makeSteerStore } from "./support/steer-store.ts";

const exhausted = () =>
  new SealantPlatformError({
    code: "BudgetExceededError",
    status: 429,
    message: "normal owner allowance exhausted",
    cause: null,
  });
const reserve = Effect.suspend(() =>
  sealantRequestPriority() === "interactive" ? Effect.void : Effect.fail(exhausted()),
);

describe("person workflows with normal owner allowance exhausted", () => {
  it.effect(
    "Stop reaches both lookups and closes the process; concurrent reads remain refused",
    () => {
      let spent = false;
      const closed: string[] = [];
      const base = sealantLaunchLayer([]);
      const platform = Layer.effect(
        SealantClient,
        Effect.map(SealantClient, (client) => ({
          ...client,
          getWorkspace: (id) =>
            Effect.suspend(() => (spent ? reserve : Effect.void)).pipe(
              Effect.andThen(client.getWorkspace(id)),
            ),
          getSession: (workspace, id) =>
            Effect.suspend(() => (spent ? reserve : Effect.void)).pipe(
              Effect.andThen(client.getSession(workspace, id)),
              Effect.map((pty) => ({
                ...pty,
                close: async () => {
                  await Promise.resolve();
                  if (sealantRequestPriority() !== "interactive") throw exhausted();
                  await pty.close();
                  closed.push(id);
                },
              })),
            ),
        })),
      ).pipe(Layer.provide(base));
      return withEngineEffect(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "shell",
              label: null,
              name: null,
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            yield* engine.launch(session.id, ["bash"]);
            const process = [...world.processes.values()].find(
              (row) => row.sessionId === session.id && row.exitedAt === null,
            );
            if (process === undefined) return yield* Effect.die("missing live process");
            spent = true;
            const background = yield* engine.detach(platformRead(platform));
            yield* engine.stop(session.id);
            expect((yield* Fiber.join(background))._tag).toBe("Failure");
            expect(closed).toContain(process.sealantSessionId);
            expect(world.processes.get(process.id)?.status).toBe("stopped");
            expect(world.processes.get(process.id)?.exitedAt).not.toBeNull();
            expect(world.sessions.get(session.id)?.status).toBe("stopped");
          }),
        { sealantLayer: platform },
      );
    },
  );

  it.effect(
    "send delivers once, steer and interrupt reach the provider, and its record stream stays normal",
    () => {
      const sessionId = SessionId.make("priority-message");
      const processId = SessionProcessId.make("priority-process");
      const turn = new AgentTurn({
        id: AgentTurnId.make("priority-turn"),
        sessionId,
        processId,
        ordinal: 0,
        author: "user-fixture",
        input: "first",
        status: "running",
        providerTurnId: "provider-turn",
        error: null,
        usage: null,
        createdAt: new Date(),
        startedAt: new Date(),
        endedAt: null,
      });
      const store = makeSteerStore(new Map([[turn.id, turn]]));
      const delivered: string[] = [];
      const streamPriorities: string[] = [];
      const opened = Deferred.makeUnsafe<void>();
      const reconnect = Deferred.makeUnsafe<void>();
      const reconnected = Deferred.makeUnsafe<void>();
      // A retained public facade handle starts its own Promise runtime, as the SDK does.
      const deliver = (words: string) =>
        Effect.tryPromise({
          try: () =>
            Effect.runPromise(
              Effect.promise(async () => {
                await Promise.resolve();
                if (sealantRequestPriority() !== "interactive") throw exhausted();
                delivered.push(words);
              }),
            ),
          catch: exhausted,
        });
      let startRecord: Effect.Effect<void> = Effect.void;
      const host = Layer.effect(
        ProtocolHost,
        Effect.map(ProtocolHost, (original) => ({
          ...original,
          sendMessage: (input: SendMessageInput) =>
            Effect.gen(function* () {
              yield* reserve;
              yield* startRecord;
              const admitted = yield* store.admitTurnMessage(input, processId, "queue-requested");
              if (admitted._tag === "Created") yield* deliver(input.input);
              return admitted.result;
            }).pipe(Effect.orDie),
          steerTurn: (input) =>
            Effect.gen(function* () {
              yield* reserve;
              yield* deliver("steer");
              return (yield* store.admitTurnSteer({
                turnId: input.turnId,
                author: input.sender,
                input: input.input,
                clientSteerId: null,
              })).steer;
            }).pipe(Effect.orDie),
          interruptTurn: () => deliver("interrupt").pipe(Effect.orDie),
        })),
      ).pipe(Layer.provide(protocolHostStubLayer));
      return withEngineEffect(
        (world, tmp) =>
          Effect.gen(function* () {
            seedStoppedBeforeRestart(world, tmp, {
              sessionId,
              workspaceId: SealantWorkspaceId.make("priority-workspace"),
              runId: SealantRunId.make("priority-run"),
              processLive: false,
            });
            const engine = yield* SessionEngine;
            const request: SendMessageInput = {
              sessionId,
              sender: "user-fixture",
              input: MessageInput.make("follow-up"),
              clientMessageId: ClientMessageId.make(crypto.randomUUID()),
              intent: "queue",
            };
            startRecord = engine
              .detach(
                Stream.runDrain(
                  Stream.fromAsyncIterable(
                    {
                      async *[Symbol.asyncIterator]() {
                        streamPriorities.push(sealantRequestPriority());
                        Effect.runSync(Deferred.succeed(opened, undefined));
                        yield "opened";
                        await Effect.runPromise(Deferred.await(reconnect));
                        streamPriorities.push(sealantRequestPriority());
                        Effect.runSync(Deferred.succeed(reconnected, undefined));
                        yield "reconnected";
                      },
                    },
                    exhausted,
                  ),
                ),
              )
              .pipe(Effect.asVoid);
            const first = yield* engine.sendMessage(request);
            const replay = yield* engine.sendMessage(request);
            expect(replay.messageId).toBe(first.messageId);
            yield* engine.interruptTurn(turn.id);
            const steered = yield* engine.steerTurn({
              turnId: turn.id,
              sender: "user-fixture",
              input: "steer",
              clientSteerId: null,
            });
            expect(steered.input).toBe("steer");
            expect(delivered).toEqual(["follow-up", "interrupt", "steer"]);
            yield* Deferred.await(opened);
            yield* Deferred.succeed(reconnect, undefined);
            yield* Deferred.await(reconnected);
            expect(streamPriorities).toEqual(["normal", "normal"]);
          }),
        {
          conversationLayer: Layer.succeed(AgentConversationRepo, {
            ...agentConversationStub,
            ...store,
            byTurnId: (id) => Effect.succeed(id === turn.id ? turn : null),
            openTurns: () => Effect.succeed([turn]),
          }),
          protocolHostLayer: host,
        },
      );
    },
  );
});

const platformRead = (platform: Layer.Layer<SealantClient>) =>
  Effect.flatMap(SealantClient, (client) => client.getWorkspace("workspace-1")).pipe(
    Effect.result,
    Effect.provide(platform),
  );
