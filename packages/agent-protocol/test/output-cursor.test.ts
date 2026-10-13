import { describe, expect, it } from "@effect/vitest";
import type { AgentEvent } from "@mend/domain/workbench";
import { Deferred, Effect, Queue, Stream } from "effect";

import {
  AgentProtocolError,
  ClaudeAdapter,
  CodexAdapter,
  type AgentTransport,
} from "../src/index.ts";

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(value)}\n`);

const concatenate = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of parts) {
    result.set(part, position);
    position += part.length;
  }
  return result;
};

const makeCursorTransport = Effect.fn("test.makeCursorTransport")(function* (
  adapter: "codex" | "claude",
  failAcknowledge = false,
) {
  const input = yield* Queue.unbounded<Uint8Array>();
  const demand = yield* Queue.unbounded<number>();
  const finalized = yield* Deferred.make<void>();
  const acknowledgments: number[] = [];
  let pushed = 0;
  let pulls = 0;
  let receivedBytes = 0;
  let attempts = 0;
  const output = Stream.fromPull(
    Effect.succeed(
      Effect.gen(function* () {
        pulls += 1;
        yield* Queue.offer(demand, pulls);
        const bytes = yield* Queue.take(input);
        receivedBytes += bytes.length;
        return [bytes] as const;
      }),
    ),
  ).pipe(Stream.ensuring(Deferred.succeed(finalized, undefined)));
  const transport: AgentTransport = {
    send: () => Effect.void,
    output,
    acknowledgeOutput: () =>
      Effect.gen(function* () {
        attempts += 1;
        if (failAcknowledge) {
          return yield* new AgentProtocolError({
            adapter,
            operation: "acknowledgeOutput",
            message: "synthetic cursor persistence failure",
            cause: null,
          });
        }
        acknowledgments.push(receivedBytes);
      }),
    close: () => Queue.shutdown(input),
  };
  const push = (bytes: Uint8Array): void => {
    pushed += 1;
    Queue.offerUnsafe(input, bytes);
  };
  // The source yields exactly one frame per pull, with no prefetch. Requesting
  // the next frame proves runForEach finished handling the previous one, even
  // when it had only a partial line and therefore could not acknowledge it.
  const drain = () =>
    Effect.gen(function* () {
      const target = pushed + 1;
      let observed = pulls;
      while (observed < target) observed = yield* Queue.take(demand);
    });
  return {
    transport,
    push,
    drain,
    finalized: Deferred.await(finalized),
    acknowledgments,
    attempts: () => attempts,
  };
});

const providers = [
  {
    name: "codex" as const,
    start: CodexAdapter.start,
    item: (id: string) => ({
      method: "item/started",
      params: { turnId: "turn-cursor", item: { id, type: "agentMessage", text: "h\u00e9llo" } },
    }),
  },
  {
    name: "claude" as const,
    start: ClaudeAdapter.start,
    item: (id: string) => ({
      type: "assistant",
      message: { id: `message-${id}`, content: [{ id, type: "text", text: "h\u00e9llo" }] },
    }),
  },
];

for (const provider of providers) {
  const start = (transport: AgentTransport, onEvent: (event: AgentEvent) => Effect.Effect<void>) =>
    provider.start(transport, {
      cwd: "/workspace/repo",
      permissionMode: "bypass",
      providerSessionId: "11111111-1111-4111-8111-111111111111",
      // Reattached pipes have no startup RPC frames to mix into cursor observations.
      // Fresh Codex startup/projection is also covered in adapters.test.ts.
      rehydrate: { replayProviderTurnIds: ["turn-cursor"], resolvedProviderRequestIds: new Set() },
      onEvent,
    });

  describe(`${provider.name} output cursor`, () => {
    it.effect("waits for split UTF-8, a complete line and durable projection", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* makeCursorTransport(provider.name);
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const persisted: string[] = [];
          yield* start(fake.transport, (event) =>
            event._tag === "item.updated"
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(Effect.sync(() => persisted.push(event.item.text ?? ""))),
                  Effect.asVoid,
                )
              : Effect.void,
          );
          const bytes = encode(provider.item("item-split"));
          const split = bytes.indexOf(0xc3) + 1;
          expect(split).toBeGreaterThan(0);
          fake.push(bytes.slice(0, split));
          yield* fake.drain();
          expect(persisted).toEqual([]);
          expect(fake.attempts()).toBe(0);
          fake.push(bytes.slice(split));
          yield* Deferred.await(entered);
          expect(persisted).toEqual([]);
          expect(fake.acknowledgments).toEqual([]);
          yield* Deferred.succeed(release, undefined);
          yield* fake.drain();
          expect(persisted).toEqual(["h\u00e9llo"]);
          expect(fake.acknowledgments).toEqual([bytes.length]);
        }),
      ),
    );

    it.effect("projects every line in a multi-line frame before acknowledging it", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* makeCursorTransport(provider.name);
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const persisted: string[] = [];
          yield* start(fake.transport, (event) =>
            Effect.gen(function* () {
              if (event._tag !== "item.updated") return;
              if (event.item.providerItemId === "item-second") {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              persisted.push(event.item.providerItemId);
            }),
          );
          const bytes = concatenate(
            encode(provider.item("item-first")),
            encode(provider.item("item-second")),
          );
          fake.push(bytes);
          yield* Deferred.await(entered);
          expect(persisted).toEqual(["item-first"]);
          expect(fake.acknowledgments).toEqual([]);
          yield* Deferred.succeed(release, undefined);
          yield* fake.drain();
          expect(persisted).toEqual(["item-first", "item-second"]);
          expect(fake.acknowledgments).toEqual([bytes.length]);
        }),
      ),
    );

    it.effect(
      "holds the cursor when a complete line shares a frame with a trailing partial line",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fake = yield* makeCursorTransport(provider.name);
            const persisted: string[] = [];
            yield* start(fake.transport, (event) =>
              Effect.sync(() => {
                if (event._tag === "item.updated") persisted.push(event.item.providerItemId);
              }),
            );
            const first = encode(provider.item("item-first"));
            const second = encode(provider.item("item-second"));
            fake.push(concatenate(first, second.slice(0, -5)));
            yield* fake.drain();
            expect(persisted).toEqual(["item-first"]);
            expect(fake.attempts()).toBe(0);
            fake.push(second.slice(-5));
            yield* fake.drain();
            expect(persisted).toEqual(["item-first", "item-second"]);
            expect(fake.acknowledgments).toEqual([first.length + second.length]);
          }),
        ),
    );

    it.effect("never advances the cursor when the durable projection defects", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* makeCursorTransport(provider.name);
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const persisted: string[] = [];
          yield* start(fake.transport, (event) =>
            event._tag === "item.updated"
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  // onEvent has no typed error channel: failed persistence surfaces
                  // here as a defect. It must not commit a cursor past that event.
                  Effect.andThen(Effect.die(new Error("synthetic projection failure"))),
                  Effect.andThen(Effect.sync(() => persisted.push(event.item.providerItemId))),
                  Effect.asVoid,
                )
              : Effect.void,
          );
          fake.push(encode(provider.item("item-failed")));
          yield* Deferred.await(entered);
          expect(fake.attempts()).toBe(0);
          yield* Deferred.succeed(release, undefined);
          yield* fake.finalized;
          expect(persisted).toEqual([]);
          expect(fake.attempts()).toBe(0);
          expect(fake.acknowledgments).toEqual([]);
        }),
      ),
    );

    it.effect("reports acknowledgment failure after projection without committing the cursor", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* makeCursorTransport(provider.name, true);
          const reported = yield* Deferred.make<string>();
          const persisted: string[] = [];
          yield* start(fake.transport, (event) =>
            Effect.gen(function* () {
              if (event._tag === "item.updated") persisted.push(event.item.providerItemId);
              if (event._tag === "runtime.error") yield* Deferred.succeed(reported, event.message);
            }),
          );
          fake.push(encode(provider.item("item-before-ack")));
          expect(yield* Deferred.await(reported)).toContain("synthetic cursor persistence failure");
          expect(persisted).toEqual(["item-before-ack"]);
          expect(fake.attempts()).toBe(1);
          expect(fake.acknowledgments).toEqual([]);
        }),
      ),
    );

    for (const terminated of [true, false]) {
      it.effect(
        `projects a ${terminated ? "newline-terminated" : "unterminated"} final line from a finite stream`,
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const ended = yield* Deferred.make<void>();
              const persisted: string[] = [];
              let acknowledgments = 0;
              const bytes = encode(provider.item("item-eof"));
              const transport: AgentTransport = {
                send: () => Effect.void,
                output: Stream.make(terminated ? bytes : bytes.slice(0, -1)),
                acknowledgeOutput: () =>
                  Effect.sync(() => {
                    acknowledgments += 1;
                  }),
                close: () => Effect.void,
              };
              yield* start(transport, (event) =>
                Effect.gen(function* () {
                  if (event._tag === "item.updated") persisted.push(event.item.providerItemId);
                  if (event._tag === "runtime.error") yield* Deferred.succeed(ended, undefined);
                }),
              );
              yield* Deferred.await(ended);
              expect(persisted).toEqual(["item-eof"]);
              expect(acknowledgments).toBe(terminated ? 1 : 0);
            }),
          ),
      );
    }
  });
}
