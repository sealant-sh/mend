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

const C_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/**
 * A path as git prints it: bare, or (for names with control or non-ASCII bytes, with
 * `core.quotePath` on, the default) in double quotes with C escapes and octal bytes, which are
 * UTF-8. `"b/caf\303\251.txt"` is `b/café.txt`.
 */
export const unquoteGitPath = (raw: string): string => {
  if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))) return raw;
  const body = raw.slice(1, -1);
  const bytes: Array<number> = [];
  const encoder = new TextEncoder();
  for (let index = 0; index < body.length; index++) {
    const char = body[index] ?? "";
    if (char !== "\\") {
      bytes.push(...encoder.encode(char));
      continue;
    }
    const next = body[index + 1] ?? "";
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
    } else if (next in C_ESCAPES) {
      bytes.push(C_ESCAPES[next] ?? 0);
      index += 1;
    } else {
      bytes.push(...encoder.encode(char));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
};

const withoutSide = (path: string): string => path.replace(/^[ab]\//, "");

const pathOf = (line: string, prefix: "--- " | "+++ "): string | null => {
  // git ends a name that has spaces with a tab on these lines.
  const raw = line.slice(prefix.length).replace(/\t$/, "").trim();
  if (raw === "/dev/null") return null;
  return withoutSide(unquoteGitPath(raw));
};

/** The two paths of a `diff --git` header, each bare or quoted. */
const headerPaths = (line: string): readonly [string | null, string | null] => {
  const rest = line.slice("diff --git ".length);
  if (!rest.includes('"')) {
    const bare = /^a\/(.+) b\/(.+)$/.exec(rest);
    return [bare?.[1] ?? null, bare?.[2] ?? null];
  }
  const tokens: Array<string> = [];
  let index = 0;
  while (index < rest.length && tokens.length < 2) {
    if (rest[index] === " ") {
      index += 1;
      continue;
    }
    if (rest[index] === '"') {
      let end = index + 1;
      while (end < rest.length && rest[end] !== '"') end += rest[end] === "\\" ? 2 : 1;
      tokens.push(unquoteGitPath(rest.slice(index, end + 1)));
      index = end + 1;
    } else {
      const end = rest.indexOf(" ", index);
      tokens.push(rest.slice(index, end === -1 ? undefined : end));
      index = end === -1 ? rest.length : end;
    }
  }
  return [
    tokens[0] === undefined ? null : withoutSide(tokens[0]),
    tokens[1] === undefined ? null : withoutSide(tokens[1]),
  ];
};

/** Splits a unified git diff into its files. */
export const splitPatch = (diff: string): ReadonlyArray<PatchFile> => {
  const files: Array<PatchFile> = [];
  const sections = diff
    .split(/^(?=diff --git )/m)
    .filter((section) => section.startsWith("diff --git "));
  for (const patch of sections) {
    const lines = patch.split("\n");
    let [oldPath, newPath] = headerPaths(lines[0] ?? "");
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
