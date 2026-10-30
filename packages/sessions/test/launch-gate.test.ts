import { Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { makeLaunchGate } from "../src/launch-gate.ts";

describe("launch gate", () => {
  it("refuses a second launch of a session while the first is under way, and lets it finish", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const gate = makeLaunchGate();
        const release = yield* Deferred.make<void>();
        const first = yield* gate
          .run("s-1")(Deferred.await(release).pipe(Effect.as("first")))
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const underWay = gate.underWay("s-1");
        const second = yield* gate.run("s-1")(Effect.succeed("second")).pipe(Effect.exit);
        const other = yield* gate.run("s-2")(Effect.succeed("other"));
        yield* Deferred.succeed(release, undefined);
        const firstResult = yield* Fiber.join(first);
        return { underWay, second, other, firstResult, after: gate.underWay("s-1") };
      }),
    );
    expect(outcome.underWay).toBe(true);
    expect(Exit.isFailure(outcome.second)).toBe(true);
    expect(JSON.stringify(outcome.second)).toContain("session_starting");
    expect(outcome.other).toBe("other");
    expect(outcome.firstResult).toBe("first");
    expect(outcome.after).toBe(false);
  });

  it("opens again after a launch that failed", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const gate = makeLaunchGate();
        const failed = yield* gate.run("s-1")(Effect.fail("boom")).pipe(Effect.exit);
        const again = yield* gate.run("s-1")(Effect.succeed("again"));
        return { failed: Exit.isFailure(failed), again };
      }),
    );
    expect(outcome).toEqual({ failed: true, again: "again" });
  });

  it("runs a recovery once the launch under way ends, and refuses a launch while it runs", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const gate = makeLaunchGate();
        const order: string[] = [];
        const releaseLaunch = yield* Deferred.make<void>();
        const releaseRecovery = yield* Deferred.make<void>();
        const launch = yield* gate
          .run("s-1")(
            Deferred.await(releaseLaunch).pipe(
              Effect.andThen(Effect.sync(() => order.push("launch"))),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const recovery = yield* gate
          .runWhenFree("s-1")(
            Effect.sync(() => order.push("recovery started")).pipe(
              Effect.andThen(Deferred.await(releaseRecovery)),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const waited = [...order];
        yield* Deferred.succeed(releaseLaunch, undefined);
        yield* Fiber.join(launch);
        while (!order.includes("recovery started")) yield* Effect.yieldNow;
        const duringRecovery = yield* gate.run("s-1")(Effect.succeed("second")).pipe(Effect.exit);
        yield* Deferred.succeed(releaseRecovery, undefined);
        yield* Fiber.join(recovery);
        return { waited, order, duringRecovery, after: gate.underWay("s-1") };
      }),
    );
    expect(outcome.waited).toEqual([]);
    expect(outcome.order).toEqual(["launch", "recovery started"]);
    expect(Exit.isFailure(outcome.duringRecovery)).toBe(true);
    expect(outcome.after).toBe(false);
  });

  it("runs work between launches after the one under way, and a launch sent meanwhile waits for it", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const gate = makeLaunchGate();
        const order: string[] = [];
        const releaseLaunch = yield* Deferred.make<void>();
        const releaseBetween = yield* Deferred.make<void>();
        const launch = yield* gate
          .run("s-1")(
            Deferred.await(releaseLaunch).pipe(
              Effect.andThen(Effect.sync(() => order.push("launch"))),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const busy = yield* gate.runBetweenOr("s-1", Effect.succeed("busy"))(Effect.succeed("now"));
        const between = yield* gate
          .runBetween("s-1")(
            Effect.sync(() => order.push("between started")).pipe(
              Effect.andThen(Deferred.await(releaseBetween)),
              Effect.andThen(Effect.sync(() => order.push("between"))),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.succeed(releaseLaunch, undefined);
        yield* Fiber.join(launch);
        while (!order.includes("between started")) yield* Effect.yieldNow;
        const underWayBetween = gate.underWay("s-1");
        const next = yield* gate
          .run("s-1")(Effect.sync(() => order.push("next launch")))
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const underWayWaiting = gate.underWay("s-1");
        const busyBetween = yield* gate.runBetweenOr(
          "s-1",
          Effect.succeed("busy"),
        )(Effect.succeed("now"));
        yield* Deferred.succeed(releaseBetween, undefined);
        yield* Fiber.join(between);
        yield* Fiber.join(next);
        const free = yield* gate.runBetweenOr("s-1", Effect.succeed("busy"))(Effect.succeed("now"));
        return {
          busy,
          underWayBetween,
          underWayWaiting,
          busyBetween,
          order,
          free,
        };
      }),
    );
    expect(outcome).toEqual({
      busy: "busy",
      underWayBetween: false,
      underWayWaiting: true,
      busyBetween: "busy",
      order: ["launch", "between started", "between", "next launch"],
      free: "now",
    });
  });
});
