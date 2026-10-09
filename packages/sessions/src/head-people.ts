/**
 * Whether a worktree's head capture holds `harness/people/` (docs/adr/0016, decision 14): a
 * worktree with no layout record whose head does is `person` all the same. Asked before every
 * launch of a worktree with no layout while `MEND_HARNESS_LAYOUT` is `person`, which, under the
 * default, is every launch of a worktree that falls back to shared (an image or runtime that
 * cannot run per person). So a "no" is kept per worktree, for the head it was read at: a later
 * launch at the same head reads no manifest (review of mend#582, finding 6). A shared executor
 * never writes `people/`, and a new head is read again.
 */
import { Effect } from "effect";

/** What a worktree's head is, by its manifest key; null before its first capture. */
export interface HeadRef {
  readonly key: string;
  readonly n: number;
}

export const makeHeadPeopleCheck = <K, E1, E2>(read: {
  readonly head: (worktreeId: K) => Effect.Effect<HeadRef | null, E1>;
  /** Reads the head's manifest and lists `harness/people/`, one file at most. */
  readonly holdsPeople: (manifestKey: string) => Effect.Effect<boolean, E2>;
  /** How many worktrees' heads are remembered before the memory starts over. */
  readonly bound?: number;
}): ((worktreeId: K) => Effect.Effect<boolean>) => {
  const without = new Map<K, string>();
  const bound = read.bound ?? 4_096;
  return (worktreeId) =>
    Effect.gen(function* () {
      const head = yield* read.head(worktreeId);
      // Capture 0 is the project base: nobody's directory is in it.
      if (head === null || head.n === 0) return false;
      if (without.get(worktreeId) === head.key) return false;
      const holds = yield* read.holdsPeople(head.key);
      if (holds) {
        without.delete(worktreeId);
        return true;
      }
      if (without.size >= bound) without.clear();
      without.set(worktreeId, head.key);
      return false;
    }).pipe(
      // Unreadable says nothing, and is not remembered: the next launch reads again.
      Effect.catch(() => Effect.succeed(false)),
      Effect.catchDefect(() => Effect.succeed(false)),
    );
};
