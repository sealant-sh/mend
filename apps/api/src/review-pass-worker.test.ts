import { ChangePassesRepo } from "@mend/db";
import { ChangeId } from "@mend/domain";
import { SealantPrincipal } from "@mend/sealant";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { runReviewPass, UNKNOWN_ASKER, type ReviewPassJob } from "./review-pass-worker.ts";

/** The worker half of "Whose login pays" (ADR 0008): the pass runs as the asker, or not at all. */

const CHANGE = ChangeId.make("change-1");

const run = (job: ReviewPassJob) => {
  const rows: Array<string> = [];
  const principals: Array<unknown> = [];
  const layer = Layer.mock(ChangePassesRepo, {
    begin: (_changeId, kind) => Effect.sync(() => void rows.push(`begin:${kind}`)),
    complete: (_changeId, kind, count) =>
      Effect.sync(() => void rows.push(`complete:${kind}:${count}`)),
    fail: (_changeId, kind, detail) => Effect.sync(() => void rows.push(`fail:${kind}:${detail}`)),
  });
  const pass = Effect.gen(function* () {
    principals.push(yield* SealantPrincipal);
    return 2;
  });
  return Effect.runPromise(runReviewPass("tour", job, pass).pipe(Effect.provide(layer))).then(
    () => ({ rows, principals }),
  );
};

describe("runReviewPass", () => {
  it("runs the pass as the person who asked", async () => {
    const { rows, principals } = await run({ changeId: CHANGE, requestedBy: "carol" });
    expect(principals).toEqual([{ kind: "user", userId: "carol" }]);
    expect(rows).toEqual(["begin:tour", "complete:tour:2"]);
  });

  it("runs nothing when the job does not say who asked, and the pass says so", async () => {
    const { rows, principals } = await run({ changeId: CHANGE });
    expect(principals).toEqual([]);
    expect(rows).toEqual([`fail:tour:${UNKNOWN_ASKER}`]);
  });
});
