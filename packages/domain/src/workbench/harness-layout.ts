import { Schema } from "effect";

/**
 * How an executor's processes are people (docs/adr/0016-per-person-harness-homes.md).
 *
 * - `person`: every process runs as one person's own Linux user, with that user's home
 *   (`/home/<name>`) and that person's saved directory (`/workspace/harness-home/people/<id>`).
 * - `shared`: everything runs as root with one `HOME`, the launcher's: how every executor ran
 *   before 0.36.
 */
export const HarnessLayout = Schema.Literals(["person", "shared"]);
export type HarnessLayout = typeof HarnessLayout.Type;

/**
 * What decided a launch's layout (decision 14), in the order Mend asks:
 *
 * - `worktree`: the worktree's sticky record (`worktrees.harness_layout`); once `person`, always.
 * - `operator`: the operator-only `harnessLayout` on a start that made the worktree (the benchmark).
 * - `capability`: what Mend or Core knows of the image, when it rules `person` out.
 * - `flag`: `MEND_HARNESS_LAYOUT`, for a worktree with no layout yet.
 * - `fallback`: a launch predicted `person` whose prepare found otherwise, on a fresh worktree.
 */
export const HarnessLayoutSource = Schema.Literals([
  "worktree",
  "operator",
  "capability",
  "flag",
  "fallback",
]);
export type HarnessLayoutSource = typeof HarnessLayoutSource.Type;

/**
 * The reserved uid range: inside `useradd`'s normal range, above the image users bases ship.
 * Accounts take uids from `LINUX_UID_FIRST` up; the group `mend` takes `MEND_GROUP_GID`, the
 * range's first id, which no account is given.
 */
export const LINUX_UID_RANGE = { first: 40_000, last: 49_999 } as const;
export const LINUX_UID_FIRST = LINUX_UID_RANGE.first + 1;
export const MEND_GROUP = { name: "mend", gid: LINUX_UID_RANGE.first } as const;

/** A person's Linux identity, the same in every executor and every project of the instance. */
export class LinuxIdentity extends Schema.Class<LinuxIdentity>("LinuxIdentity")({
  /** The account, Mend's user id: what names the person's saved directory. */
  accountId: Schema.String,
  /** Login name (`linuxLoginNameOf`). */
  name: Schema.String,
  uid: Schema.Number,
}) {}

/** The passwd home of an identity. */
export const linuxHomeOf = (identity: { readonly name: string }): string =>
  `/home/${identity.name}`;
