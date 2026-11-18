import type { RemovalBlocker, UnlandedFile } from "@mend/domain/workbench";

import { failureWords, refusalTagOf } from "./refusal.ts";
import { removalRefusalDataOf } from "./removal-refusal.ts";

/** How many files the refusal lays out before counting the rest. */
const NAMED_FILES = 5;

/** What a refused worktree removal holds that is not on origin, as the dialog lays it out. */
export interface UnlandedFacts {
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
  /** The first files. */
  readonly named: ReadonlyArray<UnlandedFile>;
  /** Files past the named ones, counted. */
  readonly more: number;
}

/** A worktree removal that didn't happen, as the page shows it. */
export interface WorktreeRemovalRefusal {
  /** The server's words, verbatim: what the page says when it knows no plainer words. */
  readonly words: string;
  /** Whether the change owner's `force=true` lifts this refusal ("Remove anyway"). */
  readonly forceable: boolean;
  /** What is not on origin, when the refusal names it. */
  readonly unlanded: UnlandedFacts | null;
  /** Why, one entry per thing that holds the worktree; empty when the server gave no reasons. */
  readonly blockers: ReadonlyArray<RemovalBlocker>;
  /** Only the owner of the worktree's change may remove it (`RemovalForbidden`). */
  readonly forbidden: boolean;
}

const factsOf = (files: ReadonlyArray<UnlandedFile>): UnlandedFacts => ({
  files: files.length,
  additions: files.reduce((sum, file) => sum + file.additions, 0),
  deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  named: files.slice(0, NAMED_FILES),
  more: Math.max(0, files.length - NAMED_FILES),
});

/**
 * A worktree removal Mend refused, read from the blockers the web tier hands back beside the
 * words (`RemovalRefused`), or from the change owner's refusal (`RemovalForbidden`). Anything
 * else, a transport failure among them, is not a refusal to show here.
 */
export const removalRefusalOf = (cause: unknown): WorktreeRemovalRefusal | null => {
  const words = failureWords(cause, "");
  if (refusalTagOf(cause) === "RemovalForbidden" && words !== "") {
    return { words, forceable: false, unlanded: null, blockers: [], forbidden: true };
  }
  const refusal = removalRefusalDataOf(cause);
  if (refusal === null || refusal.scope !== "worktree") return null;
  const files = refusal.blockers.flatMap((blocker) =>
    blocker._tag === "Unlanded" && "files" in blocker.standing ? blocker.standing.files : [],
  );
  return {
    words: words === "" ? "The worktree was not removed." : words,
    forceable: refusal.forceWouldLift,
    unlanded: files.length === 0 ? null : factsOf(files),
    blockers: refusal.blockers,
    forbidden: false,
  };
};

/** A refusal force never lifts, in the reader's words. */
const notLifted = (words: string): WorktreeRemovalRefusal => ({
  words,
  forceable: false,
  unlanded: null,
  blockers: [],
  forbidden: false,
});

/**
 * What the second step says when the forced removal itself failed. A refusal is Mend's words,
 * offered again only when force lifts it. Another contract failure is a refusal force never lifts,
 * said plainly. A transport failure left the removal unknown, so trying again stays offered.
 */
export const forcedRemovalFailureOf = (cause: unknown): WorktreeRemovalRefusal => {
  const refusal = removalRefusalOf(cause);
  if (refusal !== null) return refusal;
  const raw = failureWords(cause, "");
  const tag = refusalTagOf(cause);
  if (tag === "WorktreeNotFound") return notLifted("This worktree is no longer in the store.");
  if (tag !== null) return notLifted(raw === "" ? "The worktree was not removed." : raw);
  return {
    words:
      raw === ""
        ? "The worktree was not removed. Try again."
        : `The worktree was not removed. ${raw.replace(/\.$/, "")}. Try again.`,
    forceable: true,
    unlanded: null,
    blockers: [],
    forbidden: false,
  };
};

// ─── In a person's words ─────────────────────────────────────────────────────

/** What the words need to know beyond the refusal: names the blockers carry only as ids. */
export interface RefusalContext {
  /** The worktree as the page names it. */
  readonly worktreeName: string;
  readonly viewerId: string;
  /** A session's title, or null when the page doesn't list it. */
  readonly sessionTitle: (sessionId: string) => string | null;
  /** Where landed work lives: "GitHub" for a GitHub origin, else "origin"; null with none. */
  readonly remote: string | null;
  /** Who started the worktree's change, for a refusal only they can lift; null when unknown. */
  readonly changeOwner: string | null;
}

/** One reason a worktree stays: a short bold lead, then what it means and what to do. */
export interface RefusalReason {
  readonly tone: "info" | "warning";
  readonly title: string;
  readonly body: string;
}

/** A refusal as the "Not removed" dialog says it. */
export interface RefusalExplained {
  /** The line under the title: the worktree is still here, and the main reason. */
  readonly lead: string;
  readonly reasons: ReadonlyArray<RefusalReason>;
}

type Blocker<Tag extends RemovalBlocker["_tag"]> = Extract<RemovalBlocker, { readonly _tag: Tag }>;

const short = (sha: string) => sha.slice(0, 7);
const sentence = (words: string) => `${words.trim().replace(/[.\s]+$/, "")}.`;
const firstName = (name: string) => name.split(/\s+/)[0] ?? name;

const remoteName = (context: RefusalContext) => context.remote ?? "origin";

/** "Your session Fix login", "Grace Hopper's session Fix login", "A session". */
const sessionWords = (
  blocker: {
    readonly sessionId: string;
    readonly owner: { readonly userId: string; readonly name: string } | null;
  },
  context: RefusalContext,
): string => {
  const title = context.sessionTitle(blocker.sessionId);
  const whose =
    blocker.owner === null
      ? "A session"
      : blocker.owner.userId === context.viewerId
        ? "Your session"
        : `${blocker.owner.name}'s session`;
  return title === null ? whose : `${whose} ${title}`;
};

const LIVE_TITLES: Readonly<Record<Blocker<"SessionLive">["activity"], string>> = {
  live: "A session is still running in it.",
  starting: "A session is still starting in it.",
  stopping: "A session is still stopping.",
  "process-running": "A session still has a process running.",
  "forward-open": "A session still has a Service forward open.",
};

const LIVE_DOING: Readonly<Record<Blocker<"SessionLive">["activity"], string>> = {
  live: "is working",
  starting: "is starting",
  stopping: "is stopping",
  "process-running": "still has a process running",
  "forward-open": "still has a Service forward open",
};

const ROLE_WORDS: Readonly<Record<Blocker<"SessionLive">["role"], string>> = {
  inhabitant: "",
  holder: ", which holds this worktree as a repository,",
  linked: ", which mounts this worktree as a linked project,",
};

/**
 * A session working in the worktree. Since stopping the last running session also stops its
 * workspace (mend#1815), stopping it is what lets the worktree go: a conversation counts as running
 * between turns, so waiting for it to finish is not advice that works.
 */
const liveReason = (blocker: Blocker<"SessionLive">, context: RefusalContext): RefusalReason => {
  const who = sessionWords(blocker, context);
  const where = blocker.role === "inhabitant" ? " in this worktree" : "";
  const what = `${who}${ROLE_WORDS[blocker.role]} ${LIVE_DOING[blocker.activity]}${where}.`;
  const theirs = blocker.owner !== null && blocker.owner.userId !== context.viewerId;
  const next =
    blocker.activity === "stopping"
      ? "Try again once it says Stopped."
      : theirs && blocker.owner !== null
        ? `Ask ${firstName(blocker.owner.name)} to stop it, then remove the worktree.`
        : "Stop it, then remove the worktree.";
  return { tone: "info", title: LIVE_TITLES[blocker.activity], body: `${what} ${next}` };
};

const savingReason = (blocker: Blocker<"Saving">, context: RefusalContext): RefusalReason => {
  const kinds = new Set(blocker.holds.map((hold) => hold.kind));
  const viaHolder = blocker.holds.some((hold) => hold.via === "holder");
  const titled = blocker.holds
    .map((hold) => (hold.sessionId === null ? null : context.sessionTitle(hold.sessionId)))
    .find((title): title is string => title !== null);
  const whose = viaHolder
    ? "A session that holds this worktree as a repository"
    : titled === undefined
      ? "Its session"
      : `The session ${titled}`;
  if (kinds.has("saving"))
    return {
      tone: "info",
      title: "The workspace is still saving.",
      body: `${whose} stopped, and Mend is still copying its work out of the workspace. Removing the worktree now would lose that work. Try again once the session says Stopped.`,
    };
  if (kinds.has("not-saved"))
    return {
      tone: "warning",
      title: "Some work isn't saved.",
      body: `Mend couldn't finish copying the work of ${whose.charAt(0).toLowerCase()}${whose.slice(1)} out of its workspace, so it kept the workspace. The session's owner can discard what isn't saved, then remove the worktree.`,
    };
  return {
    tone: "info",
    title: "The workspace hasn't ended yet.",
    body: "Mend is still closing the workspace this worktree's session ran in. Try again in a moment.",
  };
};

/** "Land it first, or remove it anyway if you don't need it." with force; "Land it first." without. */
const orAnyway = (first: string, forceable: boolean, need = "it") =>
  forceable ? `${first}, or remove it anyway if you don't need ${need}.` : `${first}.`;

const unlandedReason = (
  blocker: Blocker<"Unlanded">,
  context: RefusalContext,
  forceable: boolean,
): RefusalReason => {
  const remote = remoteName(context);
  const { standing } = blocker;
  switch (standing._tag) {
    case "never-landed":
      return {
        tone: "warning",
        title: `This change isn't on ${remote}.`,
        body: `No session pushed it and no pull request holds it, so removing the worktree would lose it. ${orAnyway("Land it first", forceable)}`,
      };
    case "changed-since-landing":
      return {
        tone: "warning",
        title: "This change moved on since it was landed.",
        body: `It was landed to ${standing.landed.remoteBranch} at ${short(standing.landed.sha)} and has changed since, so removing the worktree would lose the newer work. ${orAnyway("Land it again", forceable)}`,
      };
    case "no-remote":
      return {
        tone: "warning",
        title: "This work isn't on any remote.",
        body: `The project has no origin, so the change can't be landed, and removing the worktree would lose it.${forceable ? " Remove it anyway only if you don't need it." : ""}`,
      };
    case "origin-moved":
      return {
        tone: "warning",
        title: `${remote} no longer has the landed commit.`,
        body: `${standing.landed.remoteBranch} ${standing.remoteSha === null ? "is gone" : `moved to ${short(standing.remoteSha)}`}, so the commit landed from here (${short(standing.landed.sha)}) isn't there any more. ${orAnyway("Land it again", forceable)}`,
      };
    case "origin-unchecked":
      return {
        tone: "warning",
        title: `Mend couldn't check ${remote}.`,
        body: `${sentence(standing.reason)} ${orAnyway("Try again", forceable, "the change")}`,
      };
    case "unread":
      return {
        tone: "warning",
        title: "Mend couldn't read this change.",
        body: `${sentence(standing.reason)} ${orAnyway("Try again", forceable, "the change")}`,
      };
  }
};

const nestedReason = (
  blocker: Blocker<"NestedRepositories">,
  forceable: boolean,
): RefusalReason => {
  const one = blocker.repositories.length === 1;
  const names = blocker.repositories
    .map((repository) => `${repository.path} on ${repository.branch}`)
    .join(", ");
  return {
    tone: "warning",
    title: "It holds repositories added in a session.",
    body: `${names} ${one ? "was" : "were"} added with mend repo add and ${one ? "is" : "are"} saved only with this worktree. Mend can't see whether ${one ? "it holds" : "they hold"} work that isn't on a remote.${forceable ? ` Remove it anyway only if you don't need ${one ? "it" : "them"}.` : ""}`,
  };
};

const reasonOf = (
  blocker: RemovalBlocker,
  context: RefusalContext,
  refusal: WorktreeRemovalRefusal,
): RefusalReason => {
  switch (blocker._tag) {
    case "SessionLive":
      return liveReason(blocker, context);
    case "Saving":
      return savingReason(blocker, context);
    case "SetupRunning":
      return {
        tone: "info",
        title: "A Service is being set up.",
        body: "A Service setup is running in this worktree, or ended without Mend seeing it end. Stop the session's Services, then remove the worktree.",
      };
    case "Unlanded":
      return unlandedReason(blocker, context, refusal.forceable);
    case "NestedRepositories":
      return nestedReason(blocker, refusal.forceable);
    case "RemovalUnderway":
      return blocker.stopped === null
        ? {
            tone: "info",
            title: "Another removal is under way.",
            body: "Mend is already removing this worktree or its project. Try again shortly.",
          }
        : {
            tone: "info",
            title: "An earlier removal stopped partway.",
            body: `Mend started removing ${blocker.stopped.kind} ${blocker.stopped.name} and stopped partway. Remove that ${blocker.stopped.kind} again to finish it.`,
          };
    case "ResourcesDeclared":
    case "ResourcePreservationFailed":
      return { tone: "info", title: "", body: refusal.words };
  }
};

const UNLANDED_BECAUSE: Readonly<
  Record<Blocker<"Unlanded">["standing"]["_tag"], (remote: string) => string>
> = {
  "never-landed": () => "its change was never landed",
  "changed-since-landing": () => "its change moved on since it was landed",
  "no-remote": () => "its work isn't on any remote",
  "origin-moved": (remote) => `${remote} no longer has the commit landed from it`,
  "origin-unchecked": (remote) => `Mend couldn't check ${remote}`,
  unread: () => "Mend couldn't read its change",
};

/**
 * Why the worktree stays, in a few words that finish "Mend didn't remove it because …" or
 * "Kept <name>: …". Null for a failure that gave no reason.
 */
export const keptBecause = (
  refusal: WorktreeRemovalRefusal,
  context: Pick<RefusalContext, "remote" | "changeOwner">,
): string | null => {
  if (refusal.forbidden)
    return context.changeOwner === null
      ? "only the person who started its change can remove it"
      : `only ${context.changeOwner}, who started its change, can remove it`;
  const first = refusal.blockers[0];
  if (first === undefined) return null;
  const remote = context.remote ?? "origin";
  switch (first._tag) {
    case "SessionLive":
      return first.activity === "live" || first.activity === "starting"
        ? "a session in it is running"
        : "a session is still using it";
    case "Saving":
      return "its workspace is still saving";
    case "SetupRunning":
      return "a Service is being set up in it";
    case "Unlanded":
      return UNLANDED_BECAUSE[first.standing._tag](remote);
    case "NestedRepositories":
      return "it holds repositories added in a session";
    case "RemovalUnderway":
      return "another removal is under way";
    case "ResourcesDeclared":
    case "ResourcePreservationFailed":
      return null;
  }
};

/** The second sentence of the dialog's lead: the one reason, or a pointer to several. */
const leadReason = (refusal: WorktreeRemovalRefusal, context: RefusalContext): string => {
  const because = keptBecause(refusal, context);
  if (because === null) return "Mend didn't remove it.";
  if (refusal.forbidden) return `${because.charAt(0).toUpperCase()}${because.slice(1)}.`;
  const kinds = new Set(refusal.blockers.map((blocker) => blocker._tag));
  if (kinds.size > 1) return "Mend didn't remove it, for the reasons below.";
  const first = refusal.blockers[0];
  if (first?._tag === "Saving")
    return "Mend can't remove a worktree while its workspace is saving.";
  if (first?._tag === "SessionLive" && (first.activity === "live" || first.activity === "starting"))
    return "Mend can't remove a worktree while a session in it is running.";
  return `Mend didn't remove it because ${because}.`;
};

/**
 * A refusal in the frames' words (Doop "Project · Worktrees · can't remove" and its siblings): the
 * worktree is still here and why, then one reason per blocker. A refusal the page can't word, or a
 * failure with no blockers, keeps the server's words as its only reason.
 */
export const explainRefusal = (
  refusal: WorktreeRemovalRefusal,
  context: RefusalContext,
): RefusalExplained => {
  const lead = `${context.worktreeName} is still here. ${leadReason(refusal, context)}`;
  const reasons = refusal.forbidden
    ? []
    : refusal.blockers.length === 0
      ? [{ tone: "info" as const, title: "", body: refusal.words }]
      : refusal.blockers.map((blocker) => reasonOf(blocker, context, refusal));
  return { lead, reasons };
};

// ─── What the page says after a removal ─────────────────────────────────────

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The toast after a removal: what went with it, and whether a change was thrown away. */
export const removedWords = (name: string, sessions: number, discarded: boolean): string => {
  const what =
    sessions === 0
      ? `Removed ${name}.`
      : sessions === 1
        ? `Removed ${name} and its session.`
        : `Removed ${name} and its ${sessions} sessions.`;
  return discarded ? `${what} Its change was discarded.` : what;
};

/** A worktree Clear finished left in place, and why in a few words (null when unknown). */
export interface KeptWorktree {
  readonly name: string;
  readonly because: string | null;
}

/**
 * What Clear finished says once it is done (Doop "Project · Worktrees · cleared"): how many it
 * removed, and which it kept and why. One kept worktree is named with its reason; several are named
 * and pointed at their own menus, where Remove says why.
 */
export const clearedWords = (removed: number, kept: ReadonlyArray<KeptWorktree>): string => {
  const parts: Array<string> = [];
  if (removed > 0) parts.push(`Removed ${count(removed, "worktree", "worktrees")}.`);
  const only = kept.length === 1 ? kept[0] : undefined;
  if (only !== undefined)
    parts.push(
      only.because === null
        ? `Kept ${only.name}: Mend couldn't remove it.`
        : `Kept ${only.name}: ${only.because}.`,
    );
  else if (kept.length > 1)
    parts.push(
      `Kept ${kept.map((worktree) => worktree.name).join(", ")}. Remove each from its menu to see why.`,
    );
  return parts.length === 0 ? "Nothing to clear." : parts.join(" ");
};
