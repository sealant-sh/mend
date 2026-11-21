import { describe, expect, it } from "vitest";

import {
  type ChainCheckpoint,
  checkpointLabel,
  checkpointMarks,
  type SliceAnswer,
  turnCheckpoints,
  type TurnTimes,
  unconfirmedWords,
} from "./turn-checkpoints.ts";

const at = (minute: number) => `2026-11-20T03:${String(minute).padStart(2, "0")}:00.000Z`;

const turn = (id: string, ordinal: number, start: number, status = "completed"): TurnTimes => ({
  id,
  ordinal,
  input: id,
  status,
  error: null,
  createdAt: at(start),
  startedAt: at(start),
});

const checkpoint = (
  ordinal: number,
  minute: number,
  sessionId: string | null = "s-1",
  trigger = "turn-boundary",
) =>
  ({
    id: `c-${ordinal}`,
    ordinal,
    sessionId,
    sha: `${ordinal}abcdef0123456`,
    createdAt: new Date(at(minute)),
    trigger,
  }) satisfies ChainCheckpoint;

const slices = (turns: ReadonlyArray<TurnTimes>, chain: ReadonlyArray<ChainCheckpoint>) =>
  turnCheckpoints(turns, chain, "s-1").map((each) => ({
    turn: each.turnId,
    from: each.from?.ordinal ?? null,
    to: each.to.ordinal,
  }));

describe("a turn's checkpoint", () => {
  it("is the one taken when the turn ended, not the ones the session took before the first message", () => {
    // The owner's session: the worktree's start, two taken while the session started, one after the reply.
    const chain = [checkpoint(0, 1, null), checkpoint(1, 1), checkpoint(2, 1), checkpoint(3, 3)];
    expect(slices([turn("t-1", 1, 2)], chain)).toEqual([{ turn: "t-1", from: 2, to: 3 }]);
  });

  it("is the last one before the next message, and the next turn starts from the newest of any session's", () => {
    const chain = [
      checkpoint(0, 0, null),
      checkpoint(1, 2),
      checkpoint(2, 3), // a review opened after the reply, before the next message
      checkpoint(3, 4, "s-2"), // another session in the worktree
      checkpoint(4, 6),
    ];
    expect(slices([turn("t-1", 1, 1), turn("t-2", 2, 5)], chain)).toEqual([
      { turn: "t-1", from: 0, to: 2 },
      { turn: "t-2", from: 3, to: 4 },
    ]);
  });

  it("is never one going back to a checkpoint took: those are the restore's own line", () => {
    // The turn read a file; going back ran after it, before the next message.
    const chain = [
      checkpoint(0, 0, null),
      checkpoint(1, 2),
      checkpoint(2, 4, "s-1", "restore-save"),
      checkpoint(3, 4, "s-1", "restore"),
    ];
    expect(slices([turn("t-1", 1, 1)], chain)).toEqual([{ turn: "t-1", from: 0, to: 1 }]);
    expect(slices([turn("t-1", 1, 3)], chain)).toEqual([]);
  });

  it("is the one that names the turn, even when it landed after the next turn began", () => {
    // SLNT-1263: the person sent again as turn 1 ended; turn 1's checkpoint (3) was written after
    // turn 2 had started. Checkpoint 2 is the session's origin, taken before turn 1 was sent.
    const chain = [
      checkpoint(0, 0, null),
      checkpoint(1, 0),
      checkpoint(2, 1),
      { ...checkpoint(3, 5), turnId: "t-1" },
      { ...checkpoint(4, 8), turnId: "t-2" },
    ];
    expect(slices([turn("t-1", 1, 2), turn("t-2", 2, 4)], chain)).toEqual([
      { turn: "t-1", from: 2, to: 3 },
      // Turn 2 started where turn 1's checkpoint left the files, though that one landed later.
      { turn: "t-2", from: 3, to: 4 },
    ]);
  });

  it("never takes another turn's named checkpoint by its time", () => {
    // Turn 1's own checkpoint failed; turn 2's landed in turn 1's window.
    const chain = [checkpoint(0, 0, null), { ...checkpoint(1, 3), turnId: "t-2" }];
    expect(slices([turn("t-1", 1, 1), turn("t-2", 2, 4)], chain)).toEqual([
      { turn: "t-2", from: 0, to: 1 },
    ]);
  });

  it("isn't drawn while the turn runs", () => {
    const chain = [checkpoint(0, 0, null), checkpoint(1, 2)];
    expect(slices([turn("t-1", 1, 1, "running")], chain)).toEqual([]);
  });
});

describe("which turns' checkpoints the conversation shows", () => {
  const chain = [checkpoint(0, 0, null), checkpoint(1, 2), checkpoint(2, 4), checkpoint(3, 6)];
  const turns = turnCheckpoints(
    [turn("t-1", 1, 1), turn("t-2", 2, 3), turn("t-3", 3, 5)],
    chain,
    "s-1",
  );
  const shown = (answers: ReadonlyArray<SliceAnswer>) =>
    checkpointMarks(turns, answers).map((mark) => `${mark.ordinal}: ${checkpointLabel(mark)}`);

  it("shows only the turns where a file changed", () => {
    expect(
      shown([
        { status: "success", data: { count: 2, more: false, paths: ["a.ts", "b.ts"] } },
        { status: "success", data: { count: 0, more: false, paths: [] } },
        { status: "success", data: { count: 1, more: false, paths: ["a.ts"] } },
      ]),
    ).toEqual(["1: Checkpoint · 2 files changed", "3: Checkpoint · 1 file changed"]);
  });

  it("waits while the files are read, and shows one it couldn't read without a count", () => {
    expect(
      shown([
        { status: "pending", data: undefined },
        { status: "error", data: undefined },
        // Mend ran out of time listing the files: there may be changes.
        { status: "success", data: { count: 0, more: true, paths: [] } },
      ]),
    ).toEqual(["2: Checkpoint", "3: Checkpoint"]);
  });
});

describe("a checkpoint Mend couldn't confirm", () => {
  it("says why on its line, and nothing when Mend could", () => {
    const chain = [
      checkpoint(0, 0, null),
      { ...checkpoint(1, 3), turnId: "t-1", unconfirmed: "next-turn-started" },
    ];
    const [mark] = checkpointMarks(turnCheckpoints([turn("t-1", 1, 1)], chain, "s-1"), [
      { status: "success", data: { count: 1, more: false, paths: ["BACK.md"] } },
    ]);
    expect(mark?.unconfirmed).toBe("next-turn-started");
    expect(unconfirmedWords(mark?.unconfirmed ?? null)).toContain("next turn had already started");
    expect(unconfirmedWords("capture-behind")).toContain("some may be missing");
    expect(unconfirmedWords(null)).toBeNull();
  });
});
