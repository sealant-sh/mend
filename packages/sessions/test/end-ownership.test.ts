import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { makeEndOwnership } from "../src/end-ownership.ts";

const counted = () => {
  const holds = new Map<string, number>();
  const ownership = makeEndOwnership<string>({
    enter: (workspaceId) => holds.set(workspaceId, (holds.get(workspaceId) ?? 0) + 1),
    leave: (workspaceId) => holds.set(workspaceId, (holds.get(workspaceId) ?? 0) - 1),
  });
  return { ownership, held: (workspaceId: string) => holds.get(workspaceId) ?? 0 };
};

const agent = { id: "p-1", sealantWorkspaceId: "w-1" };

describe("end ownership", () => {
  it("an observer holds the end until its whole end has run, and a continuation asked meanwhile waits for it", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const { ownership } = counted();
        const finish = yield* Deferred.make<void>();
        const observer = yield* ownership
          .observe("p-1", () => Deferred.await(finish).pipe(Effect.as("recorded")))
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const second = yield* ownership.observe("p-1", () => Effect.succeed("again"));
        const asked = yield* ownership.continueFrom([agent], [], () => Effect.succeed("switched"));
        if (asked.kind !== "ending") return { second, asked: asked.kind, waited: false };
        const waiting = yield* asked.ended.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const waitedEarly = waiting.pollUnsafe() !== undefined;
        yield* Deferred.succeed(finish, undefined);
        const observed = yield* Fiber.join(observer);
        yield* Fiber.join(waiting);
        const after = yield* ownership.continueFrom([agent], [], () => Effect.succeed("switched"));
        return { second, asked: asked.kind, waitedEarly, observed, after };
      }),
    );
    expect(outcome.second).toEqual({ kind: "held", by: "observer" });
    expect(outcome.asked).toBe("ending");
    expect(outcome.waitedEarly).toBe(false);
    expect(outcome.observed).toEqual({ kind: "observed", value: "recorded" });
    expect(outcome.after).toEqual({ kind: "continued", value: "switched" });
  });

  it("a continuation holds its processes' ends and their workspaces until it ends, once", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const { ownership, held } = counted();
        const inside = yield* ownership.continueFrom([agent], [], (continuation) =>
          Effect.gen(function* () {
            const during = {
              held: held("w-1"),
              pins: ownership.pinsLiveness("p-1"),
              observer: yield* ownership.observe("p-1", () => Effect.succeed("x")),
              ownEnd: ownership.grant("p-1", continuation),
              othersEnd: ownership.grant("p-1", { kind: "holder", token: Symbol("other") }),
              another: yield* ownership.continueFrom([agent], [], () => Effect.void),
            };
            yield* ownership.release(continuation);
            return { ...during, heldAfterRelease: held("w-1") };
          }),
        );
        return { inside, heldAfter: held("w-1"), pinsAfter: ownership.pinsLiveness("p-1") };
      }),
    );
    if (outcome.inside.kind !== "continued") throw new Error("not continued");
    expect(outcome.inside.value.held).toBe(1);
    expect(outcome.inside.value.pins).toBe(true);
    expect(outcome.inside.value.observer).toEqual({ kind: "held", by: "continuation" });
    expect(outcome.inside.value.ownEnd).toBe("granted");
    expect(outcome.inside.value.othersEnd).toBe("refused");
    expect(outcome.inside.value.another).toEqual({ kind: "held" });
    expect(outcome.inside.value.heldAfterRelease).toBe(0);
    expect(outcome.heldAfter).toBe(0);
    expect(outcome.pinsAfter).toBe(false);
  });

  it("a Stop records over a continuation at once: it no longer pins the session or holds the workspace, and its own holder records nothing", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const { ownership, held } = counted();
        const result = yield* ownership.continueFrom([agent], [], (continuation) =>
          Effect.sync(() => ({
            stop: ownership.grant("p-1", { kind: "stop" }),
            pins: ownership.pinsLiveness("p-1"),
            held: held("w-1"),
            ownEnd: ownership.grant("p-1", continuation),
          })),
        );
        return { result, heldAfter: held("w-1") };
      }),
    );
    expect(outcome.result).toEqual({
      kind: "continued",
      value: { stop: "granted", pins: false, held: 0, ownEnd: "refused" },
    });
    expect(outcome.heldAfter).toBe(0);
  });

  it("a Stop that ends no process of a continuation still stops it holding the workspace", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const { ownership, held } = counted();
        return yield* ownership.continueFrom([agent], [], () =>
          Effect.sync(() => {
            ownership.stopContinuations(["p-0", "p-1"]);
            return { held: held("w-1"), pins: ownership.pinsLiveness("p-1") };
          }),
        );
      }),
    );
    expect(outcome).toEqual({ kind: "continued", value: { held: 0, pins: false } });
  });

  it("a Stop never records over an observer", () => {
    const outcome = Effect.runSync(
      Effect.gen(function* () {
        const { ownership } = counted();
        return yield* ownership.observe("p-1", (holder) =>
          Effect.sync(() => ({
            stop: ownership.grant("p-1", { kind: "stop" }),
            own: ownership.grant("p-1", holder),
          })),
        );
      }),
    );
    expect(outcome).toEqual({ kind: "observed", value: { stop: "refused", own: "granted" } });
  });

  it("whoever waits for a continuation's release wakes when it ends", async () => {
    const woke = await Effect.runPromise(
      Effect.gen(function* () {
        const { ownership } = counted();
        const go = yield* Deferred.make<void>();
        const continuing = yield* ownership
          .continueFrom([agent], [], () => Deferred.await(go))
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const waiter = yield* ownership.released("p-1").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const early = waiter.pollUnsafe() !== undefined;
        yield* Deferred.succeed(go, undefined);
        yield* Fiber.join(continuing);
        yield* Fiber.join(waiter);
        return early;
      }),
    );
    expect(woke).toBe(false);
  });

  it.each([
    ["before its body runs", false],
    ["while its body runs", true],
  ] as const)(
    "a claim interrupted %s leaves no owner and no workspace hold",
    async (_when, started) => {
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const { ownership, held } = counted();
          const inBody = yield* Deferred.make<void>();
          const continuing = yield* ownership
            .continueFrom([agent], [], () =>
              Deferred.succeed(inBody, undefined).pipe(Effect.andThen(Effect.never)),
            )
            .pipe(Effect.forkChild({ startImmediately: started }));
          const observing = yield* ownership
            .observe("p-2", () => Effect.never)
            .pipe(Effect.forkChild({ startImmediately: started }));
          if (started) yield* Deferred.await(inBody);
          yield* Fiber.interrupt(continuing);
          yield* Fiber.interrupt(observing);
          return {
            held: held("w-1"),
            byContinuation: ownership.heldByContinuation("p-1"),
            pins: ownership.pinsLiveness("p-1"),
            reclaimed: yield* ownership.continueFrom([agent], ["p-2"], () => Effect.succeed("ok")),
          };
        }),
      );
      expect(outcome).toEqual({
        held: 0,
        byContinuation: false,
        pins: false,
        reclaimed: { kind: "continued", value: "ok" },
      });
    },
  );
});
