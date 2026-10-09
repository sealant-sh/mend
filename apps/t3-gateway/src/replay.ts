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
  /** Records a change the hub published, with the size of its encoding. */
  readonly push: (sequence: number, change: A, bytes: number) => void;
  /**
   * Every change after `after`, oldest first, or null when the log cannot say: `after` is older
   * than what it holds, or newer than `latest`, the hub's own sequence.
   */
  readonly since: (after: number, latest: number) => ReadonlyArray<A> | null;
}

/** How much a log holds: at most `capacity` changes, of at most `maxBytes` encoded together. */
export interface ReplayLimits {
  readonly capacity: number;
  readonly maxBytes: number;
}

export const makeReplayLog = <A>(limits: ReplayLimits, floor: number): ReplayLog<A> => {
  const held: Array<{ readonly sequence: number; readonly change: A; readonly bytes: number }> = [];
  let covered = floor;
  let bytes = 0;
  return {
    push: (sequence, change, size) => {
      held.push({ sequence, change, bytes: size });
      bytes += size;
      // The oldest go first, a change past the budget on its own too: a resume from before it is
      // answered with a snapshot.
      while (held.length > 0 && (held.length > limits.capacity || bytes > limits.maxBytes)) {
        const dropped = held.shift();
        if (dropped === undefined) break;
        bytes -= dropped.bytes;
        covered = dropped.sequence;
      }
    },
    since: (after, latest) =>
      after < covered || after > latest
        ? null
        : held.filter((entry) => entry.sequence > after).map((entry) => entry.change),
  };
};

/** A block of sequences a hub reserved: from `start`, up to but not including `end`. */
export interface SequenceBlock {
  readonly start: number;
  readonly end: number;
}

/**
 * A hub's sequences, stamped from the blocks it reserved (`reserveSequences`). Blocks are not
 * contiguous, as other hubs reserve in between: past the end of one, the next sequence is the
 * first of the next. Run out with none reserved, it stamps on, and from then on owns nothing: a
 * sequence past every reservation may be given by another hub too, so no resume is replayed.
 */
export interface Sequencer {
  /** The last sequence stamped, or the first block's start before any. */
  readonly current: () => number;
  readonly next: () => number;
  /** Whether a client could have been given `after` by this hub, so replay may answer it. */
  readonly owns: (after: number) => boolean;
  /** The block to reserve from, when half of this one is used and none is reserved yet. */
  readonly wants: () => number | null;
  /** A block reserved for when this one runs out. */
  readonly add: (block: SequenceBlock) => void;
  /** True once, the first time it is asked after the hub ran out of sequences. */
  readonly overran: () => boolean;
}

export const makeSequencer = (first: SequenceBlock | null): Sequencer => {
  const blocks: Array<SequenceBlock> = first === null ? [] : [first];
  let sequence = first?.start ?? 0;
  let end = first?.end ?? Number.MAX_SAFE_INTEGER;
  let reserved: SequenceBlock | null = null;
  let owning = first !== null;
  let unreported = false;
  return {
    current: () => sequence,
    next: () => {
      sequence += 1;
      if (sequence < end) return sequence;
      if (reserved !== null) {
        sequence = reserved.start;
        end = reserved.end;
        reserved = null;
      } else if (owning) {
        owning = false;
        unreported = true;
      }
      return sequence;
    },
    owns: (after) => owning && blocks.some((block) => after >= block.start && after < block.end),
    wants: () => {
      if (!owning || reserved !== null) return null;
      const size = blocks.at(-1);
      const half = size === undefined ? 0 : (size.end - size.start) / 2;
      return sequence < end - half ? null : end;
    },
    add: (block) => {
      reserved = block;
      blocks.push(block);
    },
    overran: () => {
      const was = unreported;
      unreported = false;
      return was;
    },
  };
};

/**
 * t3code's own limits (t3:apps/server/src/ws.ts `SHELL_RESUME_MAX_GAP`, and
 * t3:apps/server/src/orchestration-v2/ThreadStream.ts `THREAD_RESUME_MAX_REPLAY_EVENTS` and
 * `THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES`): past these a resuming client gets a snapshot. t3code
 * has no byte limit for the shell; the gateway holds at most 8 MiB of it per hub.
 */
export const SHELL_REPLAY_LIMITS: ReplayLimits = { capacity: 1_000, maxBytes: 8 * 1024 * 1024 };
export const THREAD_REPLAY_LIMITS: ReplayLimits = { capacity: 128, maxBytes: 1024 * 1024 };
