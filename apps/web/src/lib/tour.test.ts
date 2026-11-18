import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReviewDiffFileView, ReviewDiffHunkView } from "@mend/api-contracts";
import { ChangeId, SessionId } from "@mend/domain";
import { ChangePass, ChangeTour, TourStop } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import type { ChangePassDto, ChangeTourDto, TourStopDto } from "./api.ts";
import { changeFileOf } from "./change-files.ts";
import {
  descriptionState,
  narrationParts,
  paragraphs,
  passFailureWords,
  removedWithin,
  stopPlace,
  stopPlaceWords,
  tourDigestTexts,
} from "./tour.ts";

const at = (iso: string) => new Date(iso);

const stop = (fields: Partial<TourStopDto>): TourStopDto =>
  TourStop.make({
    title: "The retry sends the same key every time",
    file: "src/payments/retry.ts",
    line: 25,
    endLine: 29,
    narration: "The key comes from the order id.",
    evidence: [],
    grounded: false,
    ...fields,
  });

const tour = (createdAt = "2026-11-19T10:00:00Z", stops = [stop({})]): ChangeTourDto =>
  ChangeTour.make({
    id: "tour-1",
    changeId: ChangeId.make("change-1"),
    sessionId: SessionId.make("session-1"),
    summary: "Checkout could charge a customer twice.",
    approach: "Claude Code reproduced it with a test first.",
    stops,
    diffDigest: "digest",
    createdAt: at(createdAt),
  });

const pass = (
  status: ChangePassDto["status"],
  finishedAt: string | null = null,
  detail: string | null = null,
): ChangePassDto =>
  ChangePass.make({
    changeId: ChangeId.make("change-1"),
    kind: "tour",
    status,
    detail,
    findings: null,
    startedAt: at("2026-11-19T09:00:00Z"),
    finishedAt: finishedAt === null ? null : at(finishedAt),
  });

const file = (path: string, hunks: ReadonlyArray<{ newStart: number; newLines: number }>) =>
  changeFileOf(
    ReviewDiffFileView.make({
      oldPath: path,
      newPath: path,
      status: "modified",
      additions: 1,
      deletions: 0,
      binary: false,
      patch: "",
      hunks: hunks.map((hunk) =>
        ReviewDiffHunkView.make({
          header: "",
          oldStart: hunk.newStart,
          oldLines: hunk.newLines,
          contextHash: "",
          patch: "",
          ...hunk,
        }),
      ),
    }),
  );

describe("the Description block's state", () => {
  it("shows the description when the tour is written and no pass is asked for", () => {
    const written = tour();
    expect(descriptionState(written, pass("completed", "2026-11-19T10:00:00Z"))).toEqual({
      kind: "ready",
      tour: written,
    });
  });

  it("says Mend is writing while the pass is queued or running, over an older description", () => {
    expect(descriptionState(tour(), pass("queued"))).toEqual({ kind: "writing" });
    expect(descriptionState(null, pass("running"))).toEqual({ kind: "writing" });
  });

  it("says there is none when no pass ever ran", () => {
    expect(descriptionState(null, null)).toEqual({ kind: "none" });
  });

  it("shows a failure with its words, and a failure newer than the tour over it", () => {
    expect(descriptionState(null, pass("failed", "2026-11-19T10:00:00Z", "boom"))).toEqual({
      kind: "failed",
      detail: "boom",
    });
    expect(
      descriptionState(tour("2026-11-19T10:00:00Z"), pass("failed", "2026-11-19T11:00:00Z", "x"))
        .kind,
    ).toBe("failed");
  });

  it("keeps the description when the failure is older than it", () => {
    expect(
      descriptionState(tour("2026-11-19T12:00:00Z"), pass("failed", "2026-11-19T11:00:00Z", "x"))
        .kind,
    ).toBe("ready");
  });
});

describe("why a pass failed, in a person's words", () => {
  it("names the agent login that needs connecting again, with the command", () => {
    expect(passFailureWords("No claude connected account matches the asker; reconnect it")).toBe(
      "Your Claude Code login needs connecting again. Run `mend connect claude` on your computer, then try again.",
    );
    expect(passFailureWords("codex: reconnect it")).toContain("`mend connect codex`");
  });

  it("says a session with no record leaves nothing to write from", () => {
    expect(
      passFailureWords(
        "the session has no record (it never launched supervised) — the tour would be diff-only guesswork",
      ),
    ).toBe("The session left no record for Mend to read, so there is nothing to write it from.");
  });

  it("shows any other detail as a sentence, and asks for a retry when there is none", () => {
    expect(passFailureWords("the tour did not match its schema")).toBe(
      "The tour did not match its schema.",
    );
    expect(passFailureWords("The review pass timed out after 5 minutes. Ask for it again.")).toBe(
      "The review pass timed out after 5 minutes. Ask for it again.",
    );
    expect(passFailureWords(null)).toBe("Try again.");
  });
});

describe("where a stop sits", () => {
  const retry = file("src/payments/retry.ts", [
    { newStart: 22, newLines: 19 },
    { newStart: 60, newLines: 5 },
  ]);
  const files = [retry, file("src/payments/charge.test.ts", [{ newStart: 1, newLines: 31 }])];

  it("puts a stop on lines directly above its first line, with the bar on its lines", () => {
    expect(stopPlace(stop({}), files)).toEqual({
      kind: "line",
      path: "src/payments/retry.ts",
      after: 24,
      from: 25,
      to: 29,
    });
  });

  it("puts a stop that starts a hunk after the hunk before, or above the first hunk", () => {
    expect(stopPlace(stop({ line: 60, endLine: 62 }), files)).toMatchObject({ after: 40 });
    expect(stopPlace(stop({ line: 22, endLine: 23 }), files)).toMatchObject({ after: 0 });
  });

  it("keeps the bar inside the hunk the stop starts in", () => {
    expect(stopPlace(stop({ line: 38, endLine: 55 }), files)).toMatchObject({ from: 38, to: 40 });
  });

  it("puts a whole-file stop under its file's header", () => {
    expect(
      stopPlace(stop({ file: "src/payments/charge.test.ts", line: null, endLine: null }), files),
    ).toEqual({ kind: "file", path: "src/payments/charge.test.ts" });
  });

  it("puts a stop with no file under the Description", () => {
    expect(stopPlace(stop({ file: null, line: null, endLine: null }), files)).toEqual({
      kind: "change",
    });
  });

  it("moves a stop whose lines or file the change no longer shows", () => {
    expect(stopPlace(stop({ line: 50, endLine: 52 }), files)).toEqual({
      kind: "file",
      path: "src/payments/retry.ts",
    });
    expect(stopPlace(stop({ file: "src/gone.ts" }), files)).toEqual({ kind: "change" });
  });

  it("names each stop's place the way the rail does", () => {
    expect(stopPlaceWords(stop({}))).toBe("retry.ts:25-29");
    expect(stopPlaceWords(stop({ endLine: null }))).toBe("retry.ts:25");
    expect(stopPlaceWords(stop({ line: null, endLine: null }))).toBe("retry.ts");
    expect(stopPlaceWords(stop({ file: null, line: null, endLine: null }))).toBe("Whole change");
  });
});

describe("the bar through a stop's lines", () => {
  const patch = [
    "diff --git a/r.ts b/r.ts",
    "--- a/r.ts",
    "+++ b/r.ts",
    "@@ -22,9 +24,11 @@ export async function chargeWithRetry()",
    " ): Promise<Charge> {",
    "+  const key = idempotencyKeyFor(order.id);",
    "   for (let attempt = 1; attempt <= attempts; attempt++) {",
    "-    const res = await create(order);",
    "+    const res = await create(order, {",
    "+      idempotencyKey: key,",
    "+    });",
    "     if (res.ok) return res.charge;",
    "-    await sleep(100 * attempt);",
    "+    await sleep(backoff(attempt));",
    "   }",
  ].join("\n");

  it("runs through the removed lines between the stop's first and last lines", () => {
    // New lines 25 to 29: old line 24 is removed between new 26 and 27.
    expect(removedWithin(patch, 25, 29)).toEqual([24]);
  });

  it("leaves out removed lines before the stop's first line or after its last", () => {
    expect(removedWithin(patch, 27, 29)).toEqual([]);
    expect(removedWithin(patch, 25, 26)).toEqual([]);
    expect(removedWithin(patch, 30, 31)).toEqual([26]);
  });
});

describe("narration and summary text", () => {
  it("reads code between backticks as code", () => {
    expect(
      narrationParts("Every attempt sends the same `idempotencyKey`, so Stripe dedupes."),
    ).toEqual([
      { code: false, text: "Every attempt sends the same ", start: 0 },
      { code: true, text: "idempotencyKey", start: 30 },
      { code: false, text: ", so Stripe dedupes.", start: 45 },
    ]);
    expect(narrationParts("a lone ` stays")).toEqual([
      { code: false, text: "a lone ` stays", start: 0 },
    ]);
  });

  it("splits the summary into its paragraphs", () => {
    expect(paragraphs("One.\n\nTwo\nlines.\n\n\n")).toEqual(["One.", "Two\nlines."]);
  });
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const git = (dir: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd: dir,
    env: { PATH: process.env["PATH"] ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" },
    encoding: "utf8",
  }).replace(/\n$/, "");
// `git diff --no-index` exits 1 when the files differ, which is the diff.
const noIndex = (dir: string, path: string) => {
  try {
    return git(dir, "diff", "--no-index", "--", "/dev/null", path);
  } catch (error) {
    const out: unknown =
      typeof error === "object" && error !== null && "stdout" in error ? error.stdout : "";
    return typeof out === "string" ? out.replace(/\n$/, "") : "";
  }
};

describe("whether the tour was written from this change", () => {
  it("matches the tour's digest for a change whose new files sort before its edits", () => {
    const dir = mkdtempSync(join(tmpdir(), "mend-tour-digest-"));
    try {
      git(dir, "init", "-q");
      writeFileSync(join(dir, "z.ts"), "one\n");
      git(dir, "add", "z.ts");
      git(dir, "commit", "-qm", "base");
      const base = git(dir, "rev-parse", "HEAD");
      writeFileSync(join(dir, "z.ts"), "one\ntwo\n");
      writeFileSync(join(dir, "a.ts"), "new\n");
      // The tour's digest: the worktree's diff as the tour composer reads it.
      const worktree = [git(dir, "diff", base), noIndex(dir, "a.ts")].join("\n");
      // The review's patch: the snapshot against the base.
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "snapshot");
      const patch = git(dir, "diff", "--find-renames", base, "HEAD");
      expect(sha(patch)).not.toBe(sha(worktree));
      expect(tourDigestTexts(patch).map(sha)).toContain(sha(worktree));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("has one text when the order is the same", () => {
    const patch = "diff --git a/a b/a\nindex 1..2 100644\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y";
    expect(tourDigestTexts(patch)).toEqual([patch]);
  });
});
