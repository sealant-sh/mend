import type { UnlandedFile } from "@mend/domain/workbench";

import { failureWords, refusalTagOf, removalRefusalDataOf } from "#/lib/refusal";

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

/** A refused worktree removal, as the page shows it. */
export interface WorktreeRemovalRefusal {
  /** The server's words, verbatim. */
  readonly words: string;
  /** Whether the change owner's `force=true` lifts this refusal. */
  readonly forceable: boolean;
  /** What is not on origin, when the refusal names it. */
  readonly unlanded: UnlandedFacts | null;
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
    return { words, forceable: false, unlanded: null };
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
  };
};

/** A refusal force never lifts, in the reader's words. */
const notLifted = (words: string): WorktreeRemovalRefusal => ({
  words,
  forceable: false,
  unlanded: null,
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
        : `The worktree was not removed · ${raw.replace(/\.$/, "")}. Try again.`,
    forceable: true,
    unlanded: null,
  };
};

/** What Clear settled says about the worktrees the store refused to remove, if any. */
export const keptNote = (kept: number): string | null =>
  kept === 0
    ? null
    : kept === 1
      ? "1 kept · removal refused · remove it from its menu to see why"
      : `${kept} kept · removal refused · remove one from its menu to see why`;
