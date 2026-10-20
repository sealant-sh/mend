import { describe, expect, it } from "vitest";

import type {
  ChangeFile,
  Checkpoint,
  FileStatus,
  PinnedSlice,
  ServerComment,
} from "./review-wire.js";
import {
  diffTitle,
  headerFact,
  lastReviewHead,
  lastTurn,
  newerChoice,
  resolveSlice,
  sliceName,
  sliceOffers,
  statusLetter,
} from "./slices.js";

const checkpoint = (ordinal: number, trigger: Checkpoint["trigger"] = "user-mark"): Checkpoint => ({
  id: `cp${ordinal}`,
  ordinal,
  trigger,
  createdAt: `2026-10-19T10:${String(ordinal).padStart(2, "0")}:00.000Z`,
});

const chain = [
  checkpoint(0, "session-start"),
  checkpoint(1, "session-start"),
  checkpoint(2, "turn-boundary"),
  checkpoint(3, "user-mark"),
  checkpoint(4, "review-open"),
];

const pinnedTo = (head: Checkpoint): PinnedSlice => ({
  id: "slice-1",
  changeId: "change-1",
  diffDigest: "d".repeat(64),
  base: checkpoint(0, "session-start"),
  head,
  createdAt: head.createdAt,
});

const pinned = pinnedTo(checkpoint(4, "review-open"));

const file = (overrides: Partial<ChangeFile>): ChangeFile => ({
  oldPath: "src/a.ts",
  newPath: "src/a.ts",
  status: "modified",
  additions: 0,
  deletions: 0,
  binary: false,
  hunks: [],
  ...overrides,
});

const sent = (headId: string, overrides: Partial<ServerComment> = {}): ServerComment => ({
  id: `c-${headId}`,
  file: "src/a.ts",
  line: 3,
  endLine: 3,
  anchor: { sliceId: "s", baseId: "cp0", headId, side: "new" },
  author: { kind: "reviewer", name: "Dana" },
  body: "rename it",
  suggestion: null,
  state: "open",
  evidence: [],
  sentToSessionId: "session-1",
  createdAt: "2026-10-19T10:00:00.000Z",
  updatedAt: "2026-10-19T10:00:00.000Z",
  ...overrides,
});

describe("a slice she reads (story d, step 5)", () => {
  it("takes comments only on the pinned slice, base to the checkpoint review opened (G10)", () => {
    const main = resolveSlice({ kind: "pinned" }, pinned, chain);
    expect(main).toMatchObject({
      from: { ordinal: 0 },
      to: { ordinal: 4 },
      commentable: true,
    });
    const others = [
      resolveSlice(
        { kind: "since-last-review", from: checkpoint(2), to: checkpoint(4) },
        pinned,
        chain,
      ),
      resolveSlice({ kind: "last-turn", from: checkpoint(1), to: checkpoint(2) }, pinned, chain),
      resolveSlice({ kind: "between", from: checkpoint(0), to: checkpoint(4) }, pinned, chain),
    ];
    for (const slice of others) expect(slice?.commentable).toBe(false);
  });

  it("keeps a chosen slice on its own two checkpoints when newer ones arrive", () => {
    const newer = [...chain, checkpoint(5, "turn-boundary")];
    const slice = resolveSlice(
      { kind: "since-last-review", from: checkpoint(2), to: checkpoint(4) },
      pinned,
      newer,
    );
    expect([slice?.from.ordinal, slice?.to.ordinal]).toEqual([2, 4]);
  });

  it("has nothing to read when its start is not before its end, or an end left the chain", () => {
    expect(
      resolveSlice({ kind: "between", from: checkpoint(3), to: checkpoint(3) }, pinned, chain),
    ).toBe(null);
    expect(
      resolveSlice({ kind: "between", from: checkpoint(2), to: checkpoint(9) }, pinned, chain),
    ).toBe(null);
  });
});

describe("last turn", () => {
  const span = (checkpoints: ReadonlyArray<Checkpoint>): ReadonlyArray<number> | null => {
    const turn = lastTurn(checkpoints);
    return turn === null ? null : [turn.from.ordinal, turn.to.ordinal];
  };

  it("is the session's first turn: from its start to the turn boundary taken when it ended", () => {
    expect(
      span([
        checkpoint(0, "session-start"),
        checkpoint(1, "turn-boundary"),
        checkpoint(2, "review-open"),
      ]),
    ).toEqual([0, 1]);
  });

  it("is the newer of two turns: from the first turn's end to the second's", () => {
    expect(
      span([
        checkpoint(0, "session-start"),
        checkpoint(1, "turn-boundary"),
        checkpoint(2, "command-settle"),
        checkpoint(3, "turn-boundary"),
        checkpoint(4, "review-open"),
      ]),
    ).toEqual([1, 3]);
  });

  it("starts at a session start after the turn before it", () => {
    expect(
      span([
        checkpoint(0, "session-start"),
        checkpoint(1, "turn-boundary"),
        checkpoint(2, "session-start"),
        checkpoint(3, "turn-boundary"),
      ]),
    ).toEqual([2, 3]);
  });

  it("starts at the base when no session start was recorded", () => {
    expect(
      span([checkpoint(0, null), checkpoint(1, "user-mark"), checkpoint(2, "turn-boundary")]),
    ).toEqual([0, 2]);
  });

  it("does not exist before a turn ended", () => {
    expect(span([checkpoint(0, "session-start"), checkpoint(1, "review-open")])).toBe(null);
  });
});

describe("since my last review", () => {
  it("starts from the head of her most recently sent review, not the highest checkpoint", () => {
    const comments = [
      sent("cp3", { id: "older", createdAt: "2026-10-19T10:00:00.000Z" }),
      sent("cp2", { id: "newer", createdAt: "2026-10-19T11:00:00.000Z" }),
    ];
    expect(lastReviewHead(chain, comments, "Dana", [])?.ordinal).toBe(2);
  });

  it("is hers: another reviewer's newer review, and Mend's drafts, do not move it", () => {
    const comments = [
      sent("cp2", { createdAt: "2026-10-19T10:00:00.000Z" }),
      sent("cp3", {
        id: "ana",
        author: { kind: "reviewer", name: "Ana" },
        createdAt: "2026-10-19T11:00:00.000Z",
      }),
      sent("cp4", {
        id: "mend",
        author: { kind: "mend", name: "Dana" },
        createdAt: "2026-10-19T12:00:00.000Z",
      }),
    ];
    expect(lastReviewHead(chain, comments, "Dana", [])?.ordinal).toBe(2);
    expect(lastReviewHead(chain, comments, null, [])).toBe(null);
  });

  it("is not moved by marking an older review's comment addressed later", () => {
    const comments = [
      sent("cp2", {
        createdAt: "2026-10-19T10:00:00.000Z",
        updatedAt: "2026-10-19T13:00:00.000Z",
        state: "addressed",
      }),
      sent("cp3", { id: "c2", createdAt: "2026-10-19T11:00:00.000Z" }),
    ];
    expect(lastReviewHead(chain, comments, "Dana", [])?.ordinal).toBe(3);
  });

  it("counts reviews this VS Code sent, by when they were sent", () => {
    expect(
      lastReviewHead(chain, [sent("cp3")], "Dana", [
        { headId: "cp2", at: "2026-10-19T12:00:00.000Z" },
      ])?.ordinal,
    ).toBe(2);
    expect(lastReviewHead(chain, [{ ...sent("cp3"), sentToSessionId: null }], "Dana", [])).toBe(
      null,
    );
  });
});

describe("a newer read of what she chose", () => {
  it("offers last turn again once a newer turn ended, and nothing while hers is the newest", () => {
    const turns = [
      checkpoint(0, "session-start"),
      checkpoint(1, "turn-boundary"),
      checkpoint(2, "review-open"),
    ];
    const chosen = {
      kind: "last-turn",
      from: checkpoint(0, "session-start"),
      to: checkpoint(1, "turn-boundary"),
    } as const;
    const basis = {
      pinned: pinnedTo(checkpoint(2, "review-open")),
      reviewedHead: null,
    };
    expect(newerChoice(chosen, { ...basis, chain: turns })).toBe(null);
    const newer = newerChoice(chosen, {
      ...basis,
      chain: [...turns, checkpoint(3, "turn-boundary")],
    });
    expect(newer).toMatchObject({
      kind: "last-turn",
      from: { ordinal: 1 },
      to: { ordinal: 3 },
    });
  });

  it("offers since my last review again once newer checkpoints arrived", () => {
    const chosen = {
      kind: "since-last-review",
      from: checkpoint(2),
      to: checkpoint(4),
    } as const;
    const basis = { pinned, reviewedHead: checkpoint(2) };
    expect(newerChoice(chosen, { ...basis, chain })).toBe(null);
    expect(newerChoice(chosen, { ...basis, chain: [...chain, checkpoint(5)] })).toMatchObject({
      from: { ordinal: 2 },
      to: { ordinal: 5 },
    });
  });
});

describe("the picker", () => {
  it("offers the storyboard's choices, and since my last review only after one was sent", () => {
    const offers = sliceOffers({
      pinned,
      chain,
      base: "main",
      current: { kind: "pinned" },
      reviewedHead: null,
    });
    expect(offers.map((offer) => `${offer.label} · ${offer.span}`)).toEqual([
      "main → now · base → checkpoint 4",
      "last turn · checkpoint 1 → checkpoint 2",
      "between two checkpoints… · pick two of 5 checkpoints",
    ]);
    expect(offers[0]?.current).toBe(true);
    const after = sliceOffers({
      pinned,
      chain: [...chain, checkpoint(5, "turn-boundary")],
      base: "main",
      current: { kind: "pinned" },
      reviewedHead: checkpoint(3),
    });
    expect(after.find((offer) => offer.label === "since my last review")?.span).toBe(
      "checkpoint 3 → checkpoint 5",
    );
  });

  it("marks a choice current only while it reads the same two checkpoints", () => {
    const longer = [...chain, checkpoint(5, "turn-boundary")];
    const current = {
      kind: "last-turn",
      from: checkpoint(1),
      to: checkpoint(2),
    } as const;
    const turn = (checkpoints: ReadonlyArray<Checkpoint>) =>
      sliceOffers({
        pinned,
        chain: checkpoints,
        base: "main",
        current,
        reviewedHead: null,
      }).find((offer) => offer.label === "last turn");
    expect(turn(chain)?.current).toBe(true);
    expect(turn(longer)).toMatchObject({
      current: false,
      span: "checkpoint 2 → checkpoint 5",
    });
  });
});

describe("the header and the tabs", () => {
  const at = {
    readAt: "2026-10-19T10:00:30.000Z",
    now: new Date("2026-10-19T10:00:40.000Z"),
  };

  it("reads files, lines, the observed word and the seconds since", () => {
    expect(
      headerFact({
        files: [file({ additions: 100, deletions: 10 }), file({ additions: 20, deletions: 8 })],
        observation: {
          state: "observed",
          observedAt: "2026-10-19T10:00:00.000Z",
        },
        listingCut: false,
        ...at,
      }),
    ).toBe("2 files · +120 −18 · observed · 40 s ago");
  });

  it("says claimed when Mend only claims the diff, never a verdict", () => {
    expect(
      headerFact({
        files: [file({})],
        observation: { state: "claimed", observedAt: null },
        listingCut: false,
        readAt: "2026-10-19T10:00:00.000Z",
        now: new Date("2026-10-19T10:02:00.000Z"),
      }),
    ).toBe("1 file · +0 −0 · claimed · 2 min ago");
  });

  it("says only when it was read when Mend gave no observation", () => {
    expect(
      headerFact({
        files: [file({})],
        observation: null,
        listingCut: false,
        ...at,
      }),
    ).toBe("1 file · +0 −0 · read 10 s ago");
  });

  it("says the listing was cut, and never observed, when Mend listed only the first files", () => {
    const fact = headerFact({
      files: [file({ additions: 3 }), file({ deletions: 1 })],
      observation: {
        state: "observed",
        observedAt: "2026-10-19T10:00:00.000Z",
      },
      listingCut: true,
      ...at,
    });
    expect(fact).toBe("listing cut at 2 files · +3 −1 in those · read 10 s ago");
    expect(fact).not.toContain("observed");
  });

  it("names slices and diff tabs in checkpoint words", () => {
    const main = resolveSlice({ kind: "pinned" }, pinned, chain);
    const between = resolveSlice(
      { kind: "between", from: checkpoint(2), to: checkpoint(3) },
      pinned,
      chain,
    );
    if (main === null || between === null) throw new Error("slices did not resolve");
    expect(sliceName(main, "main")).toBe("main → now");
    expect(sliceName(between, "main")).toBe("checkpoint 2 → checkpoint 3");
    expect(diffTitle("src/auth/limit.ts", main, "main")).toBe("limit.ts (main ↔ checkpoint 4)");
  });

  it("marks files as Source Control does", () => {
    const statuses: ReadonlyArray<FileStatus> = ["added", "modified", "deleted", "renamed"];
    expect(statuses.map((status) => statusLetter(file({ status })))).toEqual(["A", "M", "D", "R"]);
  });
});
