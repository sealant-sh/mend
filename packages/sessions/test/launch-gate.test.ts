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
});
