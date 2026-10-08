import { Schema } from "effect";

import { Timestamp } from "../timestamp.ts";

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

// ─── pre-release executors and their migration (decision 14, Delivery 19) ────

/**
 * What would stop if a worktree's pre-release executor were replaced now, each as the owner sees
 * it beside "Replace this workspace now" (docs/adr/0016, decision 14):
 *
 * - `terminal`: a terminal agent (it ends resumable);
 * - `shell`: an open shell;
 * - `service`: a Service started by hand (`mend.toml` ones restart and are not listed);
 * - `turn`: a protocol agent with a turn or background work in flight;
 * - `process`: a process in the executor Mend did not start (`ps`);
 * - `container`: a running container of the executor's Docker sidecar (`docker ps`);
 * - `unchecked`: something Mend could not check (`docker ps` failing, a process whose start is not
 *   in its record): it holds an automatic replacement, and the owner sees why.
 */
export const WorkspaceRetirementStopKind = Schema.Literals([
  "terminal",
  "shell",
  "service",
  "turn",
  "process",
  "container",
  "unchecked",
]);
export type WorkspaceRetirementStopKind = typeof WorkspaceRetirementStopKind.Type;

export class WorkspaceRetirementStop extends Schema.Class<WorkspaceRetirementStop>(
  "WorkspaceRetirementStop",
)({
  kind: WorkspaceRetirementStopKind,
  /**
   * What it is, as observed: a session's label, a Service's name, a process's command name and
   * pid, a container's name, or why something could not be checked. Empty for a process or a
   * container when the viewer is not the change's owner: they see its kind only.
   */
  label: Schema.String,
}) {}

/**
 * A worktree's live `shared` executor once its next launch would be `person` (decision 14):
 * `marked` to retire (a join and a turn from anyone but its launcher are refused), or `retiring`
 * (every new start refused while Mend checks it, sends the final flush and replaces it once the
 * flush is saved).
 */
export const WorkspaceRetirementState = Schema.Literals(["marked", "retiring"]);
export type WorkspaceRetirementState = typeof WorkspaceRetirementState.Type;

/** What the session view says of its executor's retirement; null while none is under way. */
export class WorkspaceRetirement extends Schema.Class<WorkspaceRetirement>("WorkspaceRetirement")({
  state: WorkspaceRetirementState,
  /** The executor started before Mend 0.36 (no layout recorded for its launch). */
  preRelease: Schema.Boolean,
  /** The account whose launch made the executor: the only one whose joins and turns it takes. */
  launcher: Schema.NullOr(Schema.String),
  /** What would stop if it were replaced now; empty when nothing would. */
  stops: Schema.Array(WorkspaceRetirementStop),
  /** Why the last automatic replacement did not go ahead, as observed; null when none was tried. */
  reason: Schema.NullOr(Schema.String),
  /**
   * When what runs in the executor was last checked beyond Mend's own records (processes Mend did
   * not start, the sidecar's containers); null when only Mend's records were read.
   */
  checkedAt: Schema.NullOr(Timestamp),
  /**
   * What the viewer was shown, as one token: "Replace this workspace now" names it, so Mend ends
   * nothing that was not listed (the replacement is refused if more would stop now).
   */
  fingerprint: Schema.String,
  /** The viewer may replace it now: they own the change, and no agent turn is in flight. */
  canReplace: Schema.Boolean,
}) {}

/**
 * What the migration of a worktree's old shared home did with its memory (decision 14): who it
 * was credited to and why, and what it credited to nobody ("memory from before 0.36, not
 * credited"). `provisional` while a `shared` executor may still write; final once the worktree
 * runs per person and the job read its last `shared`-layout capture.
 */
export class PreReleaseMemory extends Schema.Class<PreReleaseMemory>("PreReleaseMemory")({
  /** The capture it read, by its place on the worktree's chain. */
  captureN: Schema.Number,
  provisional: Schema.Boolean,
  creditedTo: Schema.NullOr(Schema.String),
  decidedBy: Schema.Literals(["home-record", "only-person", "nobody", "nothing"]),
  /** Memory paths credited to nobody: two or more people's sessions shared the home. */
  notCredited: Schema.Array(Schema.String),
}) {}
