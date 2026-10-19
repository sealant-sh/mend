import { Result, Schema } from "effect";

import { Sha } from "../ids.ts";
import type { WorktreeName } from "./worktree.ts";

/** The bundle's one ref: W, the working tree, whose parent is I, the index, whose parent is HEAD. */
export const HANDOFF_SNAPSHOT_REF = "refs/mend/handoff/snapshot";

/** The largest file a handoff carries; larger ones stay behind, named (`MEND_BUDGET_HANDOFF_FILE_BYTES`). */
export const HANDOFF_FILE_BYTES_DEFAULT = 8 * 1024 * 1024;

const HANDOFF_SUBJECT = "mend handoff";

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** A full lowercase sha-1 or sha-256 object name. */
export const HexSha = Sha.check(Schema.isPattern(SHA_PATTERN));

const isTrailerValue = (value: string): boolean =>
  value.length > 0 && value.trim() === value && !/\p{Cc}/u.test(value);

/** The machine the checkout lives on: printable, 1 to 64 characters, no surrounding space. */
export const HandoffMachine = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      isTrailerValue(value) && [...value].length <= 64
        ? undefined
        : "a machine name of 1 to 64 printable characters",
    ),
  ),
  Schema.brand("HandoffMachine"),
);
export type HandoffMachine = typeof HandoffMachine.Type;

/** The checkout's local branch as git names it (`fix/login`). */
export const HandoffBranch = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      isTrailerValue(value) ? undefined : "a branch name of printable characters",
    ),
  ),
  Schema.brand("HandoffBranch"),
);
export type HandoffBranch = typeof HandoffBranch.Type;

/** When the snapshot was cut, exactly as `Date.prototype.toISOString` writes it (UTC). */
export const HandoffCutAt = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) => {
      const instant = new Date(value);
      return !Number.isNaN(instant.getTime()) && instant.toISOString() === value
        ? undefined
        : "an ISO-8601 UTC instant like 2026-10-18T07:42:05.000Z";
    }),
  ),
  Schema.brand("HandoffCutAt"),
);
export type HandoffCutAt = typeof HandoffCutAt.Type;

/** The facts W's message carries. `localBranch` is null when HEAD is detached. */
export const HandoffTrailers = Schema.Struct({
  machine: HandoffMachine,
  localBranch: Schema.NullOr(HandoffBranch),
  cutAt: HandoffCutAt,
  /** The client's `origin/<default>` when it cut the snapshot. */
  defaultTip: HexSha,
  /** M: the merge base of HEAD with that tip, the bundle's cut and the change's base. */
  mergeBase: HexSha,
});
export type HandoffTrailers = typeof HandoffTrailers.Type;

const TRAILER_KEYS = {
  machine: "Mend-Machine",
  localBranch: "Mend-Branch",
  cutAt: "Mend-Cut-At",
  defaultTip: "Mend-Default-Tip",
  mergeBase: "Mend-Merge-Base",
};

/** The message of commit W: the subject, a blank line, then the trailers in a fixed order. */
export const formatHandoffMessage = (trailers: HandoffTrailers): string =>
  [
    HANDOFF_SUBJECT,
    "",
    `${TRAILER_KEYS.machine}: ${trailers.machine}`,
    ...(trailers.localBranch === null
      ? []
      : [`${TRAILER_KEYS.localBranch}: ${trailers.localBranch}`]),
    `${TRAILER_KEYS.cutAt}: ${trailers.cutAt}`,
    `${TRAILER_KEYS.defaultTip}: ${trailers.defaultTip}`,
    `${TRAILER_KEYS.mergeBase}: ${trailers.mergeBase}`,
    "",
  ].join("\n");

/** Why a commit message is not a handoff's: the reason, and the words naming what was found. */
export interface HandoffMessageFault {
  readonly reason: "not-a-handoff" | "garbled-trailer" | "duplicate-trailer" | "missing-trailer";
  readonly detail: string;
}

const fault = (
  reason: HandoffMessageFault["reason"],
  detail: string,
): Result.Result<never, HandoffMessageFault> => Result.fail({ reason, detail });

const knownKeys: ReadonlySet<string> = new Set(Object.values(TRAILER_KEYS));

const decodeTrailer = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  key: string,
  value: string | undefined,
): Result.Result<S["Type"], HandoffMessageFault> =>
  value === undefined
    ? fault("missing-trailer", `${key} is missing`)
    : Result.mapError(
        Schema.decodeUnknownResult(schema)(value),
        (): HandoffMessageFault => ({
          reason: "garbled-trailer",
          detail: `${key} is not valid: ${JSON.stringify(value)}`,
        }),
      );

/**
 * Read W's message back into its trailers. Strict: the subject must be `mend handoff`, every
 * line after the blank line a `Key: value` trailer Mend writes, each at most once.
 */
export const parseHandoffMessage = (
  message: string,
): Result.Result<HandoffTrailers, HandoffMessageFault> => {
  const [subject, blank, ...trailerLines] = (
    message.endsWith("\n") ? message.slice(0, -1) : message
  ).split("\n");
  if (subject !== HANDOFF_SUBJECT || blank !== "") {
    return fault("not-a-handoff", `the subject is not "${HANDOFF_SUBJECT}"`);
  }
  const found = new Map<string, string>();
  for (const line of trailerLines) {
    const separator = line.indexOf(": ");
    const key = line.slice(0, separator);
    if (separator === -1 || !knownKeys.has(key)) {
      return fault("garbled-trailer", `${JSON.stringify(line)} is not a Mend trailer`);
    }
    if (found.has(key)) return fault("duplicate-trailer", `${key} appears more than once`);
    found.set(key, line.slice(separator + 2));
  }
  const branch = found.get(TRAILER_KEYS.localBranch);
  return Result.all({
    machine: decodeTrailer(HandoffMachine, TRAILER_KEYS.machine, found.get(TRAILER_KEYS.machine)),
    localBranch:
      branch === undefined
        ? Result.succeed(null)
        : decodeTrailer(HandoffBranch, TRAILER_KEYS.localBranch, branch),
    cutAt: decodeTrailer(HandoffCutAt, TRAILER_KEYS.cutAt, found.get(TRAILER_KEYS.cutAt)),
    defaultTip: decodeTrailer(HexSha, TRAILER_KEYS.defaultTip, found.get(TRAILER_KEYS.defaultTip)),
    mergeBase: decodeTrailer(HexSha, TRAILER_KEYS.mergeBase, found.get(TRAILER_KEYS.mergeBase)),
  });
};

/**
 * The `worktrees.handoff` value: where a handed-off worktree came from, who received it, its
 * replay key (`checkpoint`, the sha of W) and the seed of its capture 0.
 */
export const WorktreeHandoff = Schema.Struct({
  machine: HandoffMachine,
  localBranch: Schema.NullOr(HandoffBranch),
  cutAt: HandoffCutAt,
  /** H: the checkout's HEAD, where the worktree's branch starts. */
  head: HexSha,
  /** I: the commit whose tree is the checkout's index. */
  index: HexSha,
  /** W: the commit whose tree is the checkout's working tree; capture 0. */
  checkpoint: HexSha,
  /** M: the merge base with the default branch; the change's base. */
  mergeBase: HexSha,
  /** W's tree: the working tree capture 0 lays down. */
  worktreeTree: HexSha,
  /** I's tree: the index capture 0 lays down. */
  indexTree: HexSha,
  /** The account the handoff was received for; only it may replay the same bytes. */
  ownerUserId: Schema.String,
  /** The bucket key of the pack holding `W ^M`. */
  deltaPack: Schema.NonEmptyString,
});
export type WorktreeHandoff = typeof WorktreeHandoff.Type;

const WORKTREE_NAME_MAX = 64;

/** git check-ref-format refuses a ref component ending in `.lock`. */
const tidyName = (name: string, max: number): string => {
  const trimmed = name.slice(0, max).replace(/[^a-z0-9]+$/u, "");
  return trimmed.endsWith(".lock") ? `${trimmed.slice(0, -".lock".length)}-lock` : trimmed;
};

const slugOf = (branch: string): string =>
  tidyName(
    branch
      .toLowerCase()
      .replace(/[^a-z0-9._-]/gu, "-")
      .replace(/([._-])\1+/gu, "$1")
      .replace(/^[^a-z0-9]+/u, ""),
    WORKTREE_NAME_MAX,
  );

/**
 * The worktree a handoff creates: the branch slugged (`fix/login` → `fix-login`), or
 * `handoff-<head7>` when HEAD is detached or nothing of the branch name survives. A name already
 * taken gets `-2`, `-3`, … within 64 characters. Every result is a valid git
 * ref component under `mend/`.
 */
export const handoffWorktreeName = (
  localBranch: string | null,
  head: Sha,
  taken: (name: string) => boolean,
): WorktreeName => {
  const slug = localBranch === null ? "" : slugOf(localBranch);
  const base = slug === "" ? `handoff-${head.slice(0, 7)}` : slug;
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${tidyName(base, WORKTREE_NAME_MAX - suffix.length)}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
};

/** Files a handoff leaves behind by name: any whose basename starts with `.env`. */
export const isEnvPath = (path: string): boolean =>
  path.slice(path.lastIndexOf("/") + 1).startsWith(".env");

/** What the checkout holds against the default branch, as `mend handoff` counts it. */
export interface HandoffCounts {
  readonly commitsAhead: number;
  readonly uncommitted: number;
  readonly untracked: number;
  readonly defaultBranch: string;
}

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/** `2 commits ahead of main · 3 uncommitted files · 1 untracked`. */
export const formatFactLine = ({
  commitsAhead,
  uncommitted,
  untracked,
  defaultBranch,
}: HandoffCounts): string =>
  [
    commitsAhead === 0
      ? `even with ${defaultBranch}`
      : `${plural(commitsAhead, "commit", "commits")} ahead of ${defaultBranch}`,
    uncommitted === 0
      ? "no uncommitted files"
      : plural(uncommitted, "uncommitted file", "uncommitted files"),
    ...(untracked > 0 ? [`${untracked} untracked`] : []),
  ].join(" · ");
