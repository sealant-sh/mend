import { PreviewId } from "@mend/domain";
import { PublicOrigin } from "@mend/network";
import { describe, expect, it } from "vitest";

import { NO_PREVIEWS, type WorktreePreviews } from "./previews.ts";
import {
  EDIT_BACKOFF_MAX_MS,
  editedReceipt,
  postedReceipt,
  receiptAfter,
  receiptOf,
  showsRendering,
  storedReceipt,
  UNANSWERED_HOLD_MS,
} from "./receipt.ts";
import { statusKey } from "./status-key.ts";

const message = { text: "billing-api · running", blocks: [] };
const key = statusKey(message);
const previews: WorktreePreviews = {
  _tag: "Shown",
  appUrl: PublicOrigin.make("https://app.mend.test"),
  previews: [
    {
      id: PreviewId.make("pv-web"),
      service: "web",
      facts: [
        {
          _tag: "Observed",
          service: "web",
          reachable: true,
          httpStatus: 200,
          observedAt: new Date("2026-10-30T12:00:00.000Z"),
        },
      ],
      openable: true,
    },
  ],
  unprepared: null,
};
const rendering = { key, base: key, previews, counts: { files: 2, additions: 3, deletions: 1 } };

describe("a status message's receipt", () => {
  it("reads back what was stored, previews and counts included", () => {
    const edited = editedReceipt(rendering, 1_000);
    expect(receiptOf(storedReceipt(edited))).toEqual(edited);
    expect(receiptOf(storedReceipt(postedReceipt(rendering)))).toMatchObject({
      shown: { _tag: "Rendered", key },
      editedAt: null,
    });
  });

  it("reads nothing as nothing shown, and a line an earlier release wrote as that line", () => {
    expect(receiptOf(null)).toMatchObject({ shown: { _tag: "Unknown" }, previews: NO_PREVIEWS });
    const legacy = receiptOf("billing-api · running");
    expect(legacy.shown).toEqual({ _tag: "Legacy", text: "billing-api · running" });
    expect(showsRendering(legacy.shown, key, message.text)).toBe(true);
    expect(showsRendering(legacy.shown, key, "billing-api · completed")).toBe(false);
  });

  it("keeps what the message showed after a refusal, holding the next edit for Slack's Retry-After", () => {
    const shown = editedReceipt(rendering, 1_000);
    expect(receiptAfter(shown, { _tag: "Refused", retryAfterMs: 30_000 }, 2_000)).toEqual({
      ...shown,
      holdUntil: 32_000,
      refusals: 1,
    });
  });

  it("backs off a refusal without a Retry-After, doubling up to fifteen minutes", () => {
    let receipt = editedReceipt(rendering, 0);
    const holds = [];
    for (let refusal = 0; refusal < 10; refusal++) {
      receipt = receiptAfter(receipt, { _tag: "Refused", retryAfterMs: null }, 0);
      holds.push(receipt.holdUntil);
    }
    expect(holds).toEqual([
      5_000,
      10_000,
      20_000,
      40_000,
      80_000,
      160_000,
      320_000,
      640_000,
      EDIT_BACKOFF_MAX_MS,
      EDIT_BACKOFF_MAX_MS,
    ]);
  });

  it("knows nothing of what an unanswered edit left, and holds the next until a late answer is moot", () => {
    const after = receiptAfter(editedReceipt(rendering, 0), { _tag: "Unanswered" }, 1_000);
    expect(after.shown).toEqual({ _tag: "Unknown" });
    expect(after.holdUntil).toBe(1_000 + UNANSWERED_HOLD_MS);
  });

  it("records a message Slack says is gone as gone, with nothing to wait for", () => {
    const after = receiptAfter(editedReceipt(rendering, 0), { _tag: "MessageGone" }, 1_000);
    expect(after.shown).toEqual({ _tag: "Gone" });
    expect(after.holdUntil).toBeNull();
    expect(receiptOf(storedReceipt(after)).shown).toEqual({ _tag: "Gone" });
  });
});
