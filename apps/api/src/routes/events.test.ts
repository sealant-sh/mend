import type { MendEvent } from "@mend/db";
import { Effect, Exit, PubSub, Queue, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { makeEventBus } from "../events-bus.ts";
import { admits, audienceOf, type EventView } from "./events.ts";

const event = (value: MendEvent) => ({ value, payload: JSON.stringify(value) });

describe("the event bus", () => {
  it("keeps delivering to other subscribers after one stream ends", async () => {
    const received = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* Queue.unbounded<string>();
          const bus = yield* makeEventBus(Stream.fromQueue(source));

          const leaving = yield* Scope.make();
          const staying = yield* Scope.make();
          yield* bus.subscribe.pipe(Scope.provide(leaving));
          const subscription = yield* bus.subscribe.pipe(Scope.provide(staying));
          yield* Scope.close(leaving, Exit.void);

          const project = event({ type: "project", projectId: "project-1" });
          yield* Queue.offer(source, project.payload);
          yield* Queue.offer(source, "not an event");
          const session = event({
            type: "session",
            sessionId: "session-1",
            projectId: "project-1",
          });
          yield* Queue.offer(source, session.payload);

          const first = yield* PubSub.take(subscription);
          const second = yield* PubSub.take(subscription);
          yield* Scope.close(staying, Exit.void);
          return [first, second];
        }),
      ),
    );
    expect(
      received.map((signal) => (signal.kind === "event" ? signal.event.type : "resync")),
    ).toEqual(["project", "session"]);
  });

  it("tells subscribers to re-read when the listen connection ends", async () => {
    const signal = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bus = yield* makeEventBus(Stream.fail("connection lost"));
          const subscription = yield* bus.subscribe;
          return yield* PubSub.take(subscription);
        }),
      ),
    );
    expect(signal).toEqual({ kind: "resync" });
  });
});

describe("what one stream may deliver (docs/adr/0003)", () => {
  const carol: EventView = {
    userId: "carol",
    organizationId: "org-a",
    projectIds: new Set(["project-shared-a", "project-private-carol"]),
    operator: false,
  };

  it("project-scoped events follow project visibility", () => {
    for (const type of ["session", "session-process", "agent-conversation"] as const) {
      expect(
        admits(carol, audienceOf({ type, sessionId: "s", projectId: "project-shared-a" })),
      ).toBe(true);
      expect(
        admits(carol, audienceOf({ type, sessionId: "s", projectId: "project-private-alice" })),
      ).toBe(false);
    }
    expect(
      admits(
        carol,
        audienceOf({
          type: "review-comment",
          commentId: "c",
          changeId: "ch",
          worktreeId: "w",
          projectId: "project-shared-b",
        }),
      ),
    ).toBe(false);
  });

  it("organization events reach members, user events their user, queue events the operator", () => {
    expect(admits(carol, audienceOf({ type: "organization", organizationId: "org-a" }))).toBe(true);
    expect(admits(carol, audienceOf({ type: "organization", organizationId: "org-b" }))).toBe(
      false,
    );
    expect(admits(carol, audienceOf({ type: "user", userId: "carol", facet: "devices" }))).toBe(
      true,
    );
    expect(admits(carol, audienceOf({ type: "user", userId: "alice", facet: "devices" }))).toBe(
      false,
    );
    expect(admits(carol, audienceOf({ type: "issue", issueId: "i" }))).toBe(false);
    expect(admits({ ...carol, operator: true }, audienceOf({ type: "issue", issueId: "i" }))).toBe(
      true,
    );
  });
});
