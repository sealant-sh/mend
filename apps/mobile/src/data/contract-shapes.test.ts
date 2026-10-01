// The phone reads the review endpoints with hand-written DTOs (raw fetch, no
// generated client), so a field the server renames or drops would decode as
// `undefined` and render as an empty review. These pins fail `pnpm
// typecheck` instead: each contract's wire shape must fit the DTO the phone
// reads it as. routes.test.ts pins the paths; this pins the payloads.

import type { OpenReviewResult, ReviewDiffView, SessionDetail } from "@mend/api-contracts";
import type { ReviewComment } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import type { OpenReviewDto, ReviewCommentDto, ReviewDiffDto } from "./review";
import type { CheckpointDto } from "./review-state";

/** A schema's encoded side as JSON carries it: dates and bigints travel as strings. */
type Wire<T> = T extends Date
  ? string
  : T extends bigint
    ? string
    : T extends ReadonlyArray<infer E>
      ? ReadonlyArray<Wire<E>>
      : T extends object
        ? { readonly [K in keyof T]: Wire<T[K]> }
        : T;

type Fits<From, To> = [From] extends [To] ? true : false;

const pins: {
  readonly open: Fits<Wire<typeof OpenReviewResult.Encoded>, OpenReviewDto>;
  readonly diff: Fits<Wire<typeof ReviewDiffView.Encoded>, ReviewDiffDto>;
  readonly comment: Fits<Wire<typeof ReviewComment.Encoded>, ReviewCommentDto>;
  readonly checkpoint: Fits<
    Wire<typeof SessionDetail.Encoded>["checkpoints"][number],
    CheckpointDto
  >;
} = { open: true, diff: true, comment: true, checkpoint: true };

describe("review payloads", () => {
  it("fit the DTOs the phone reads them as (checked by typecheck)", () => {
    expect(Object.values(pins).every((fits) => fits)).toBe(true);
  });
});
