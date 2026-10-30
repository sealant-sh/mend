import { Schema } from "effect";

import { SessionId, WorktreeId } from "../ids.ts";

/**
 * Removing a worktree or a project (docs/adr/0007-landing.md, "Worktree removal"; ADR 0003): one
 * rule set for both, and for every client. The server gathers facts, `decideRemoval` decides, and
 * a refusal crosses the wire as a list of blockers, never as words a client must read back. Words
 * are rendered here, for Mend's own clients and for a client that cannot override a refusal.
 */

// ─── Facts ──────────────────────────────────────────────────────────────────

/** A file's lines past what counts as kept, as the store counts them. */
export const UnlandedFile = Schema.Struct({
  path: Schema.String,
  additions: Schema.Int,
  deletions: Schema.Int,
});
export type UnlandedFile = typeof UnlandedFile.Type;

/** The branch a Mend landing pushed, and the commit it pushed. */
export const LandedAt = Schema.Struct({ remoteBranch: Schema.String, sha: Schema.String });
export type LandedAt = typeof LandedAt.Type;

/**
 * A change that is not known to be on origin. `no-remote` is its own case, for a project with no
 * origin, where nothing can ever be landed (decision Q3).
 */
export const UnlandedStanding = Schema.Union([
  Schema.TaggedStruct("no-remote", { files: Schema.Array(UnlandedFile) }),
  Schema.TaggedStruct("never-landed", { files: Schema.Array(UnlandedFile) }),
  Schema.TaggedStruct("changed-since-landing", {
    landed: LandedAt,
    files: Schema.Array(UnlandedFile),
  }),
  /** `remoteSha` null: origin's branch is gone. */
  Schema.TaggedStruct("origin-moved", {
    landed: LandedAt,
    remoteSha: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("origin-unchecked", { landed: LandedAt, reason: Schema.String }),
  /** The change could not be read at all: whether it is anywhere else is not known. */
  Schema.TaggedStruct("unread", { reason: Schema.String }),
]);
export type UnlandedStanding = typeof UnlandedStanding.Type;

/** Where a worktree's change stands for removal: kept somewhere removal does not reach, or not. */
export type ChangeStanding =
  | { readonly _tag: "at-base" }
  | {
      readonly _tag: "on-origin";
      readonly landed: LandedAt;
      readonly via: "branch" | "merged-pull-request";
    }
  | UnlandedStanding;

export const Person = Schema.Struct({ userId: Schema.String, name: Schema.String });
export type Person = typeof Person.Type;

/**
 * What holds a session's worktree in place: `live` (starting, running, waiting or idle),
 * `starting` (a launch or a shell admitted and still under way), `stopping` (only for a session
 * holding the worktree as a repository, docs/adr/0010: its drain is saving the repository's
 * files), a process that has not exited, or an open Service forward.
 */
export const SessionActivity = Schema.Literals([
  "live",
  "starting",
  "stopping",
  "process-running",
  "forward-open",
]);
export type SessionActivity = typeof SessionActivity.Type;

/**
 * A capture that is not saved yet (docs/adr/0002, "Stop drains, then terminates"). `holder`: the
 * hold is on the worktree of a session that holds this one as a repository.
 */
export const HoldFact = Schema.Struct({
  sessionId: Schema.NullOr(SessionId),
  kind: Schema.Literals(["saving", "not-saved", "executor", "lease"]),
  via: Schema.Literals(["own", "holder"]),
});
export type HoldFact = typeof HoldFact.Type;

/** A repository added with `mend repo add` whose files are saved only inside this worktree. */
export const NestedRepository = Schema.Struct({ path: Schema.String, branch: Schema.String });
export type NestedRepository = typeof NestedRepository.Type;

/**
 * How a session works in a worktree: in it, holding it as a repository (docs/adr/0010), or
 * mounting it as a linked project's worktree (ADR-0001).
 */
export const SessionRole = Schema.Literals(["inhabitant", "holder", "linked"]);
export type SessionRole = typeof SessionRole.Type;

export interface SessionFact {
  readonly sessionId: SessionId;
  readonly owner: Person | null;
  readonly role: SessionRole;
  readonly activity: SessionActivity | "settled";
}

/** What any worktree removal reads: what runs or saves there, and whose change it is. */
export interface WorktreeHolds {
  readonly worktreeId: WorktreeId;
  readonly name: string;
  /** The owner of the worktree's first session, as stored on the worktree; null when unknown. */
  readonly changeOwner: Person | null;
  readonly sessions: ReadonlyArray<SessionFact>;
  readonly holds: ReadonlyArray<HoldFact>;
  /**
   * A Service setup running in the worktree, or one whose end nobody has confirmed: it runs
   * commands there before any process of its own exists.
   */
  readonly setupRunning: boolean;
}

/** What only a removal without force reads as well: whether the work here is anywhere else. */
export interface WorktreeFacts extends WorktreeHolds {
  readonly standing: ChangeStanding;
  readonly nestedRepositories: ReadonlyArray<NestedRepository>;
}

export interface ProjectFacts {
  /**
   * Every worktree of the project, whoever's (decision Q2), with every session working in it,
   * another project's among them.
   */
  readonly worktrees: ReadonlyArray<WorktreeFacts>;
  /** Resources declared in the project (docs/adr/0019): their data lives only in their volumes. */
  readonly resources: ReadonlyArray<string>;
}

// ─── Blockers ───────────────────────────────────────────────────────────────

const worktreeRef = { worktreeId: WorktreeId, worktreeName: Schema.String };

/** A removal of a project or a worktree that committed to deleting and stopped partway. */
export const StoppedRemoval = Schema.Struct({
  kind: Schema.Literals(["worktree", "project"]),
  name: Schema.String,
});
export type StoppedRemoval = typeof StoppedRemoval.Type;

/** Why a removal does not go ahead. A refusal is a non-empty list of these. */
export const RemovalBlocker = Schema.Union([
  Schema.TaggedStruct("SessionLive", {
    ...worktreeRef,
    sessionId: SessionId,
    owner: Schema.NullOr(Person),
    role: SessionRole,
    activity: SessionActivity,
  }),
  Schema.TaggedStruct("Saving", { ...worktreeRef, holds: Schema.Array(HoldFact) }),
  Schema.TaggedStruct("SetupRunning", worktreeRef),
  Schema.TaggedStruct("Unlanded", {
    ...worktreeRef,
    owner: Schema.NullOr(Person),
    standing: UnlandedStanding,
  }),
  Schema.TaggedStruct("NestedRepositories", {
    ...worktreeRef,
    repositories: Schema.Array(NestedRepository),
  }),
  Schema.TaggedStruct("ResourcesDeclared", { names: Schema.Array(Schema.String) }),
  /**
   * Another removal of the same worktree, its project or one of the project's worktrees is under
   * way; `stopped` when that one is a deletion that stopped partway.
   */
  Schema.TaggedStruct("RemovalUnderway", { stopped: Schema.NullOr(StoppedRemoval) }),
]);
export type RemovalBlocker = typeof RemovalBlocker.Type;
type BlockerTag = RemovalBlocker["_tag"];

/**
 * What the change owner's explicit `force` lifts on a worktree removal: work that is not on
 * origin, never running or unsaved work. Project removal has no force (`RemovalTarget`).
 */
export const LIFTED_BY_FORCE = {
  SessionLive: false,
  Saving: false,
  SetupRunning: false,
  Unlanded: true,
  NestedRepositories: true,
  ResourcesDeclared: false,
  RemovalUnderway: false,
} as const satisfies Record<BlockerTag, boolean>;

const BLOCKER_ORDER = {
  RemovalUnderway: 0,
  SessionLive: 1,
  SetupRunning: 2,
  Saving: 3,
  Unlanded: 4,
  NestedRepositories: 5,
  ResourcesDeclared: 6,
} as const satisfies Record<BlockerTag, number>;

// ─── Decision ───────────────────────────────────────────────────────────────

/**
 * What is being removed. Only a worktree removal carries `force`, and a forced one is decided
 * without reading what force lifts.
 */
export type RemovalTarget =
  | { readonly kind: "worktree"; readonly force: false; readonly worktree: WorktreeFacts }
  | { readonly kind: "worktree"; readonly force: true; readonly worktree: WorktreeHolds }
  | { readonly kind: "project"; readonly project: ProjectFacts };

export type NonEmptyBlockers = readonly [RemovalBlocker, ...Array<RemovalBlocker>];

export type RemovalDecision =
  | { readonly _tag: "Remove" }
  | {
      readonly _tag: "Refuse";
      readonly blockers: NonEmptyBlockers;
      /** True only on a worktree removal, without force, whose every blocker force lifts. */
      readonly forceWouldLift: boolean;
    };

const isUnlanded = (standing: ChangeStanding): standing is UnlandedStanding =>
  standing._tag !== "at-base" && standing._tag !== "on-origin";

const holdBlockers = (facts: WorktreeHolds): ReadonlyArray<RemovalBlocker> => {
  const ref = { worktreeId: facts.worktreeId, worktreeName: facts.name };
  const blockers: Array<RemovalBlocker> = [];
  for (const session of facts.sessions) {
    if (session.activity === "settled") continue;
    blockers.push({
      _tag: "SessionLive",
      ...ref,
      sessionId: session.sessionId,
      owner: session.owner,
      role: session.role,
      activity: session.activity,
    });
  }
  if (facts.setupRunning) blockers.push({ _tag: "SetupRunning", ...ref });
  if (facts.holds.length > 0) blockers.push({ _tag: "Saving", ...ref, holds: facts.holds });
  return blockers;
};

const workBlockers = (facts: WorktreeFacts): ReadonlyArray<RemovalBlocker> => {
  const ref = { worktreeId: facts.worktreeId, worktreeName: facts.name };
  const blockers: Array<RemovalBlocker> = [];
  if (isUnlanded(facts.standing)) {
    blockers.push({ _tag: "Unlanded", ...ref, owner: facts.changeOwner, standing: facts.standing });
  }
  if (facts.nestedRepositories.length > 0) {
    blockers.push({ _tag: "NestedRepositories", ...ref, repositories: facts.nestedRepositories });
  }
  return blockers;
};

const blockersOfWorktree = (facts: WorktreeFacts): ReadonlyArray<RemovalBlocker> => [
  ...holdBlockers(facts),
  ...workBlockers(facts),
];

const ordered = (blockers: ReadonlyArray<RemovalBlocker>): ReadonlyArray<RemovalBlocker> =>
  blockers.toSorted((a, b) => BLOCKER_ORDER[a._tag] - BLOCKER_ORDER[b._tag]);

const nonEmpty = (blockers: ReadonlyArray<RemovalBlocker>): NonEmptyBlockers | null => {
  const [first, ...rest] = blockers;
  return first === undefined ? null : [first, ...rest];
};

/** The one rule both removals follow. Never stops anything: it only says what stands in the way. */
export const decideRemoval = (target: RemovalTarget): RemovalDecision => {
  if (target.kind === "worktree") {
    const standing = target.force
      ? holdBlockers(target.worktree).filter((blocker) => !LIFTED_BY_FORCE[blocker._tag])
      : blockersOfWorktree(target.worktree);
    const blockers = nonEmpty(ordered(standing));
    if (blockers === null) return { _tag: "Remove" };
    return {
      _tag: "Refuse",
      blockers,
      forceWouldLift: !target.force && blockers.every((blocker) => LIFTED_BY_FORCE[blocker._tag]),
    };
  }
  const { project } = target;
  const resources: ReadonlyArray<RemovalBlocker> =
    project.resources.length === 0 ? [] : [{ _tag: "ResourcesDeclared", names: project.resources }];
  const blockers = nonEmpty(
    ordered([...project.worktrees.flatMap(blockersOfWorktree), ...resources]),
  );
  return blockers === null
    ? { _tag: "Remove" }
    : { _tag: "Refuse", blockers, forceWouldLift: false };
};

/** A refusal for a removal that met another one under way. */
export const underway = (stopped: StoppedRemoval | null = null): NonEmptyBlockers => [
  { _tag: "RemovalUnderway", stopped },
];

/** A removal that met another one under way, with whatever else stands in the way. */
export const underwayWith = (
  stopped: StoppedRemoval | null,
  decision: RemovalDecision,
): NonEmptyBlockers => [
  ...underway(stopped),
  ...(decision._tag === "Refuse" ? decision.blockers : []),
];

// ─── Who removes a worktree (decisions Q4, Q7, Q8) ──────────────────────────

export type WorktreeRemovalRight =
  | { readonly _tag: "allowed" }
  | { readonly _tag: "not-change-owner"; readonly owner: Person }
  /** The caller has no say here: answered as not found, as before. */
  | { readonly _tag: "hidden" };

/**
 * Only the change's owner removes a worktree whose first owner is proven, whatever else the caller
 * manages. A worktree with no owner, or one the history cannot prove, keeps the rule from before:
 * whoever manages the project, or a caller who owns every session in it. A client outside Mend
 * refuses that case itself (`hasProvenOwner`).
 */
export const worktreeRemovalRight = (input: {
  readonly callerUserId: string;
  readonly changeOwner: Person | null;
  readonly changeOwnerProven: boolean;
  readonly managesProject: boolean;
  readonly ownsEverySession: boolean;
}): WorktreeRemovalRight => {
  if (input.changeOwner !== null && input.changeOwnerProven) {
    return input.changeOwner.userId === input.callerUserId
      ? { _tag: "allowed" }
      : { _tag: "not-change-owner", owner: input.changeOwner };
  }
  return input.managesProject || input.ownsEverySession ? { _tag: "allowed" } : { _tag: "hidden" };
};

// ─── Words ──────────────────────────────────────────────────────────────────

/**
 * `in-mend`: the web and the CLI, which offer the change owner's override. `outside-mend`: a
 * client that cannot override and sends the person to Mend (the T3 gateway).
 */
export type RefusalAudience = "in-mend" | "outside-mend";

/** The one sentence an in-Mend refusal ends with when force lifts every blocker. */
export const REMOVAL_FORCE_HINT = "Pass force=true to remove it anyway.";

/** What new work (a session, a shell, a Service, a forward) refused by a removal's mark reads. */
export const REMOVAL_START_REFUSED =
  "not started · a removal of this worktree or its project is under way · start again if Mend refuses it";

/** The same, when the mark is a deletion that stopped partway and refuses until it is finished. */
export const REMOVAL_START_REFUSED_STOPPED =
  "not started · a removal of this worktree or its project stopped partway · remove it again in Mend to finish it";

/** Decision Q3's sentence, verbatim. */
export const NO_REMOTE_OUTSIDE_MEND =
  "This worktree has work that is not on any remote. Remove it from Mend if you mean to discard it.";

/** Decision Q8: whether a client outside Mend may ask to remove the worktree at all. */
export const hasProvenOwner = (worktree: {
  readonly changeOwnerUserId: string | null;
  readonly changeOwnerProven: boolean;
}): boolean => worktree.changeOwnerUserId !== null && worktree.changeOwnerProven;

/** Decision Q8: a worktree with no provable change owner is not removed from outside Mend. */
export const OWNERLESS_OUTSIDE_MEND =
  "Mend cannot tell who started this worktree's change, so it keeps it. Remove it from Mend.";

/** How many files or repositories the words name before counting the rest. */
const NAMED = 5;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const namedThenCounted = (names: ReadonlyArray<string>) =>
  `${names.slice(0, NAMED).join(", ")}${names.length > NAMED ? `, ${names.length - NAMED} more` : ""}`;

/** `3 files · +12 −3 · src/a.ts +10 −2, src/b.ts +2 −1, docs/c.md +0 −0` */
export const describeUnlanded = (files: ReadonlyArray<UnlandedFile>): string => {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const named = namedThenCounted(
    files.map((file) => `${file.path} +${file.additions} −${file.deletions}`),
  );
  return `${plural(files.length, "file", "files")} · +${additions} −${deletions} · ${named}`;
};

/** `saving · 2 sessions · not saved · 1 session · workspace kept` */
export const holdWords = (holds: ReadonlyArray<HoldFact>): string => {
  const count = (kind: HoldFact["kind"]) => holds.filter((hold) => hold.kind === kind).length;
  const parts: Array<string> = [];
  if (count("saving") > 0) parts.push(`saving · ${plural(count("saving"), "session", "sessions")}`);
  if (count("not-saved") > 0) {
    parts.push(`not saved · ${plural(count("not-saved"), "session", "sessions")} · workspace kept`);
  }
  if (count("executor") > 0) {
    parts.push(`executor not ended · ${plural(count("executor"), "session", "sessions")}`);
  }
  if (count("lease") > 0) parts.push("executor lease held");
  return parts.join(" · ");
};

const activityWords: Record<SessionActivity, string> = {
  live: "is live",
  starting: "is starting",
  stopping: "is stopping",
  "process-running": "has a process running",
  "forward-open": "has a Service forward open",
};

const whose = (owner: Person | null) => (owner === null ? "a" : `${owner.name}'s`);
const short = (sha: string) => sha.slice(0, 7);
const landedWords = (landed: LandedAt) => `${landed.remoteBranch} · ${short(landed.sha)}`;
const trimStop = (words: string) => words.trim().replace(/\.+$/, "");

const capitalized = (words: string) => `${words.charAt(0).toUpperCase()}${words.slice(1)}`;

type Blocker<Tag extends BlockerTag> = Extract<RemovalBlocker, { readonly _tag: Tag }>;

/** How a session that is not in the worktree works in it, as a clause; empty for one that is. */
const roleInMend: Record<SessionRole, string> = {
  inhabitant: "",
  holder: ", which holds this worktree as a repository,",
  linked: ", which mounts this worktree as a linked project,",
};
const roleOutside: Record<SessionRole, string> = {
  inhabitant: "in this worktree",
  holder: "holding this worktree as a repository",
  linked: "mounting this worktree as a linked project",
};

const stoppedWords = (stopped: StoppedRemoval) =>
  `the removal of ${stopped.kind} ${stopped.name} stopped partway`;

/** In Mend, what is not on origin, and the act that would keep it. */
const unlandedInMend = (standing: UnlandedStanding): string => {
  switch (standing._tag) {
    case "no-remote":
      return `This worktree holds work that is not on any remote · ${describeUnlanded(standing.files)} · the project has no origin, so it cannot be landed. Discard it before removal.`;
    case "never-landed":
      return `This worktree holds a change that was never landed · ${describeUnlanded(standing.files)}. Land it or discard it before removal.`;
    case "changed-since-landing":
      return `This worktree changed since its last landing (${landedWords(standing.landed)}) · ${describeUnlanded(standing.files)}. Land it again or discard it before removal.`;
    case "origin-moved":
      return `origin's ${standing.landed.remoteBranch} no longer holds the landed commit ${short(standing.landed.sha)} · ${standing.remoteSha === null ? "the branch is gone" : `it is at ${short(standing.remoteSha)}`}. Land it again before removal.`;
    case "origin-unchecked":
      return `origin could not be checked for the last landing (${landedWords(standing.landed)}) · ${trimStop(standing.reason)}. Try again.`;
    case "unread":
      return `Mend could not read this worktree's change · ${trimStop(standing.reason)}. Try again.`;
  }
};

const unlandedOutside = (standing: UnlandedStanding): string => {
  switch (standing._tag) {
    case "no-remote":
      return NO_REMOTE_OUTSIDE_MEND;
    case "never-landed":
    case "changed-since-landing":
      return `This worktree has work that is not on origin · ${describeUnlanded(standing.files)}. Land it from Mend, or remove it from Mend if you mean to discard it.`;
    case "origin-moved":
      return `origin's ${standing.landed.remoteBranch} no longer holds this worktree's last landing. Land it again from Mend, or remove it from Mend if you mean to discard it.`;
    case "origin-unchecked":
      return `Mend could not check origin for this worktree's last landing · ${trimStop(standing.reason)}. Mend keeps the worktree; try again from Mend.`;
    case "unread":
      return `Mend could not read this worktree's change · ${trimStop(standing.reason)}. Mend keeps the worktree; try again from Mend.`;
  }
};

const nestedNames = (blocker: Blocker<"NestedRepositories">) =>
  namedThenCounted(
    blocker.repositories.map((repository) => `${repository.path} on ${repository.branch}`),
  );

/** One sentence per blocker, for a refused worktree removal. */
const worktreeSentence = (blocker: RemovalBlocker, audience: RefusalAudience): string => {
  const inMend = audience === "in-mend";
  switch (blocker._tag) {
    case "SessionLive":
      return inMend
        ? `not removed · ${whose(blocker.owner)} session ${blocker.sessionId.slice(0, 8)}${roleInMend[blocker.role]} ${activityWords[blocker.activity]} · stop it first.`
        : `${capitalized(whose(blocker.owner))} session ${roleOutside[blocker.role]} ${activityWords[blocker.activity]}. Mend keeps the worktree; stop the session in Mend, then remove the worktree there.`;
    case "SetupRunning":
      return inMend
        ? "not removed · a Service setup is running in this worktree, or ended without Mend seeing it end · stop the session's Service starts first."
        : "A Service setup is still running in this worktree. Mend keeps the worktree; stop it in Mend, then remove the worktree there.";
    case "Saving":
      return inMend
        ? `not removed · ${blocker.holds.some((hold) => hold.via === "holder") ? "a session holding this worktree as a repository is " : ""}${holdWords(blocker.holds)} · the worktree stays until its workspaces have saved and ended, or their owner discards what is unsaved.`
        : "This worktree's last session is still saving its files. Mend keeps the worktree; remove it from Mend once the save has finished.";
    case "Unlanded":
      return inMend ? unlandedInMend(blocker.standing) : unlandedOutside(blocker.standing);
    case "NestedRepositories":
      return inMend
        ? `This worktree holds ${plural(blocker.repositories.length, "repository", "repositories")} added with mend repo add, saved only with it · ${nestedNames(blocker)} · Mend cannot see whether ${blocker.repositories.length === 1 ? "it holds" : "they hold"} commits or edits that are not on origin, so removal waits for force, pushed or not.`
        : `This worktree holds repositories added with mend repo add (${nestedNames(blocker)}). Mend cannot see whether they hold work that is not on a remote, so it keeps the worktree. Remove it from Mend if you mean to discard it.`;
    case "ResourcesDeclared":
      return `The project has resources (${blocker.names.map((name) => `@${name}`).join(", ")}). Remove them first.`;
    case "RemovalUnderway":
      if (blocker.stopped !== null) {
        return inMend
          ? `not removed · ${stoppedWords(blocker.stopped)} · remove that ${blocker.stopped.kind} again to finish it.`
          : `Mend started removing ${blocker.stopped.kind} ${blocker.stopped.name} and stopped partway. Remove it again from Mend to finish.`;
      }
      return inMend
        ? "not removed · another removal of this worktree or its project is under way · try again shortly."
        : "Mend is already removing this worktree or its project. Check Mend before trying again.";
  }
};

/**
 * What a refused worktree removal says: a sentence per blocker, and in Mend, once at the end,
 * the override when force lifts every one. Outside Mend, a single `no-remote` change reads exactly
 * decision Q3's sentence.
 */
export const worktreeRefusalWords = (
  refusal: { readonly blockers: ReadonlyArray<RemovalBlocker>; readonly forceWouldLift: boolean },
  audience: RefusalAudience,
): string => {
  const sentences = refusal.blockers.map((blocker) => worktreeSentence(blocker, audience));
  if (audience === "in-mend" && refusal.forceWouldLift) sentences.push(REMOVAL_FORCE_HINT);
  return sentences.join(" ");
};

const unlandedClause = (standing: UnlandedStanding) => {
  switch (standing._tag) {
    case "no-remote":
      return "which is not on any remote";
    case "origin-unchecked":
      return "whose landing Mend could not check on origin";
    case "unread":
      return "which Mend could not read";
    case "never-landed":
    case "changed-since-landing":
    case "origin-moved":
      return "which is not on origin";
  }
};

const projectRoleWords: Record<SessionRole, string> = {
  inhabitant: "in",
  holder: "holding",
  linked: "linking",
};

/** One clause per blocker, for a refused project removal: whose work, and in which worktree. */
const projectClause = (blocker: RemovalBlocker): string => {
  switch (blocker._tag) {
    case "SessionLive":
      return `${whose(blocker.owner)} session ${projectRoleWords[blocker.role]} ${blocker.worktreeName} ${activityWords[blocker.activity]}`;
    case "SetupRunning":
      return `a Service setup is running in ${blocker.worktreeName}`;
    case "Saving":
      return `${blocker.worktreeName} is ${holdWords(blocker.holds)}`;
    case "Unlanded":
      return `${blocker.worktreeName} holds ${blocker.owner === null ? "a" : `${blocker.owner.name}'s`} change, ${unlandedClause(blocker.standing)}`;
    case "NestedRepositories":
      return `${blocker.worktreeName} holds repositories added with mend repo add (${nestedNames(blocker)})`;
    case "ResourcesDeclared":
      return `the project has resources (${blocker.names.map((name) => `@${name}`).join(", ")})`;
    case "RemovalUnderway":
      return blocker.stopped === null
        ? "another removal of this project or one of its worktrees is under way"
        : `${stoppedWords(blocker.stopped)}, so remove that ${blocker.stopped.kind} again first`;
  }
};

/** What a refused project removal says: every blocking worktree, and whose work it is (Q2). */
export const projectRefusalWords = (
  blockers: ReadonlyArray<RemovalBlocker>,
  audience: RefusalAudience,
): string => {
  const clauses = blockers.map(projectClause);
  if (audience === "in-mend") {
    return `not removed · ${clauses.join(" · ")} · stop, land or remove those first, then remove the project again.`;
  }
  // A clause that opens with a worktree's name keeps the name as it is written.
  const sentences = blockers.map((blocker, index) => {
    const clause = clauses[index] ?? "";
    const named =
      blocker._tag === "Saving" ||
      blocker._tag === "Unlanded" ||
      blocker._tag === "NestedRepositories";
    return `${named ? clause : capitalized(clause)}.`;
  });
  return `Mend kept this project. ${sentences.join(" ")} Stop, land or remove those in Mend, then remove the project again.`;
};

/** Who may remove a worktree the caller did not start (decision Q4). */
export const notChangeOwnerWords = (owner: Person, audience: RefusalAudience): string =>
  audience === "in-mend"
    ? `not removed · only ${owner.name}, who started this worktree's change, removes it.`
    : `Only ${owner.name}, who started this worktree's change, can remove it. Mend keeps it.`;
