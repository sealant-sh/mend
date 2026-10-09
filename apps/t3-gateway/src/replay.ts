/**
 * What a client resuming after a sequence missed (ADR 0012, "Delivery", phase 2: replay after a
 * sequence). A log holds the last `capacity` changes a hub published, each with its sequence; a
 * client that resumes after a sequence the log still covers gets only what came after it, and any
 * other gets a fresh snapshot, which t3code always takes as a reset.
 *
 * The log covers every change after `floor`: the sequence it started at, then, once it is full,
 * the sequence of the newest change it let go. A sequence below the floor, or above what the hub
 * has stamped, is not one it can answer.
 */
export interface ReplayLog<A> {
  /** Records a change the hub published. */
  readonly push: (sequence: number, change: A) => void;
  /**
   * Every change after `after`, oldest first, or null when the log cannot say: `after` is older
   * than what it holds, or newer than `latest`, the hub's own sequence.
   */
  readonly since: (after: number, latest: number) => ReadonlyArray<A> | null;
}

export const makeReplayLog = <A>(capacity: number, floor: number): ReplayLog<A> => {
  const held: Array<{ readonly sequence: number; readonly change: A }> = [];
  let covered = floor;
  return {
    push: (sequence, change) => {
      held.push({ sequence, change });
      if (held.length > capacity) {
        const dropped = held.splice(0, held.length - capacity);
        covered = dropped.at(-1)?.sequence ?? covered;
      }
    },
    since: (after, latest) =>
      after < covered || after > latest
        ? null
        : held.filter((entry) => entry.sequence > after).map((entry) => entry.change),
  };
};

/**
 * t3code's own limits (t3:apps/server/src/ws.ts `SHELL_RESUME_MAX_GAP`, and
 * t3:apps/server/src/orchestration-v2/ThreadStream.ts): past these a resuming client gets a
 * snapshot.
 */
export const SHELL_REPLAY_CAPACITY = 1_000;
export const THREAD_REPLAY_CAPACITY = 128;
