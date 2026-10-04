import { createHash } from "node:crypto";

import {
  VcsUnsupportedOperationError,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
} from "@mend/t3-contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { GatedMend } from "./device-gate.ts";
import type { PersonHub } from "./hub.ts";
import type { MendChangeDiff } from "./mend-workbench.ts";
import type { BearerSession } from "./state.ts";

/**
 * t3code's changes panel over Mend's change (ADR 0012, "Concepts": the changes panel is the
 * change, one per worktree). `review.getDiffPreview` names the thread's worktree as its `cwd`; the
 * gateway answers with one `branch-range` source, the change against its base, from
 * `GET /api/changes/:id/diff`, read as the person. Mend serves the change as a patch, so
 * `review.getDiffFileContents` can rebuild only files the patch holds whole (added or deleted);
 * whole files of a modified one wait for phase 3's worktree read.
 */

const unsupported = (operation: string, detail: string) =>
  new VcsUnsupportedOperationError({ operation, kind: "git", detail });

/** One file's section of a unified git diff. */
export interface PatchFile {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly patch: string;
}

const pathOf = (line: string, prefix: "--- " | "+++ "): string | null => {
  const raw = line.slice(prefix.length).trim();
  if (raw === "/dev/null") return null;
  return raw.replace(/^[ab]\//, "");
};

/** Splits a unified git diff into its files. */
export const splitPatch = (diff: string): ReadonlyArray<PatchFile> => {
  const files: Array<PatchFile> = [];
  const sections = diff
    .split(/^(?=diff --git )/m)
    .filter((section) => section.startsWith("diff --git "));
  for (const patch of sections) {
    const lines = patch.split("\n");
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0] ?? "");
    let oldPath: string | null = header?.[1] ?? null;
    let newPath: string | null = header?.[2] ?? null;
    for (const line of lines) {
      if (line.startsWith("--- ")) oldPath = pathOf(line, "--- ");
      if (line.startsWith("+++ ")) {
        newPath = pathOf(line, "+++ ");
        break;
      }
      if (line.startsWith("@@")) break;
    }
    files.push({ oldPath, newPath, patch });
  }
  return files;
};

/** The side of a patch the hunks hold whole: every `+` line of an added file, `-` of a deleted one. */
const wholeSide = (patch: string, side: "+" | "-"): string => {
  const lines: Array<string> = [];
  let inHunk = false;
  let noNewline = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\")) {
      noNewline = true;
      continue;
    }
    if (line.startsWith(side)) lines.push(line.slice(1));
  }
  const text = lines.join("\n");
  return lines.length === 0 || noNewline ? text : `${text}\n`;
};

const diffHash = (diff: string): string =>
  `sha256:${createHash("sha256").update(diff).digest("hex")}`;

const nonEmptyOr = (value: string | null | undefined, fallback: string): string => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : fallback;
};

export const makeReviewHandlers = (input: {
  readonly hub: PersonHub;
  readonly mend: GatedMend;
  readonly session: BearerSession;
}) => {
  const { hub, mend, session } = input;

  /** The change of the thread at `cwd`, read as the person. */
  const changeAt = (operation: string, cwd: string) =>
    Effect.gen(function* () {
      const change = yield* hub
        .changeOfWorktree(cwd)
        .pipe(Effect.mapError((error) => unsupported(operation, error.message)));
      if (change === null) {
        return yield* unsupported(
          operation,
          `No Mend thread of yours works in ${cwd}, or its worktree has no change yet.`,
        );
      }
      const diff = yield* mend
        .changeDiff(session.deviceToken, change.changeId)
        .pipe(Effect.mapError((error) => unsupported(operation, error.message)));
      return { change, diff };
    });

  const getDiffPreview = (request: ReviewDiffPreviewInput) =>
    Effect.gen(function* () {
      const operation = "review.getDiffPreview";
      const { change, diff } = yield* changeAt(operation, request.cwd);
      const files = request.file === undefined ? null : request.file;
      const patch =
        files === null
          ? diff.diff
          : splitPatch(diff.diff)
              .filter(
                (file) =>
                  file.newPath === files.path ||
                  file.oldPath === files.path ||
                  (files.previousPath !== null && file.oldPath === files.previousPath),
              )
              .map((file) => file.patch)
              .join("");
      const result: ReviewDiffPreviewResult = {
        cwd: request.cwd,
        generatedAt: DateTime.makeUnsafe(Date.now()),
        sources: [
          {
            id: `mend-change:${change.changeId}`,
            kind: "branch-range",
            // Evidence, not a verdict: say what Mend observed the change on.
            title:
              diff.observation === undefined ? "Changes" : `Changes · ${diff.observation.label}`,
            baseRef: nonEmptyOr(change.baseRef, diff.change.baseSha),
            headRef: nonEmptyOr(diff.change.headSha, diff.change.branch),
            diff: patch,
            diffHash: diffHash(patch),
            truncated: false,
            files: filesOf(diff),
          },
        ],
      };
      return result;
    });

  const getDiffFileContents = (request: ReviewDiffFileContentsInput) =>
    Effect.gen(function* () {
      const operation = "review.getDiffFileContents";
      if (request.changeType !== "new" && request.changeType !== "deleted") {
        return yield* unsupported(
          operation,
          "Mend serves the change as a patch; whole files of a changed file are not available yet.",
        );
      }
      const { diff } = yield* changeAt(operation, request.cwd);
      const file = splitPatch(diff.diff).find((candidate) =>
        request.changeType === "new"
          ? candidate.newPath === request.newPath
          : candidate.oldPath === request.oldPath,
      );
      if (file === undefined) {
        return yield* unsupported(operation, "The file is not in the change any more.");
      }
      const result: ReviewDiffFileContentsResult =
        request.changeType === "new"
          ? { oldContents: "", newContents: wholeSide(file.patch, "+") }
          : { oldContents: wholeSide(file.patch, "-"), newContents: "" };
      return result;
    });

  return { getDiffPreview, getDiffFileContents };
};

const filesOf = (diff: MendChangeDiff) =>
  diff.files.map((file) => ({
    path: file.path,
    previousPath: null,
    additions: file.additions,
    deletions: file.deletions,
  }));
