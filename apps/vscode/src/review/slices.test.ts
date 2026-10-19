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
  lastTurnStart,
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

const pinned: PinnedSlice = {
  id: "slice-1",
  changeId: "change-1",
  diffDigest: "d".repeat(64),
  base: chain[0] ?? checkpoint(0),
  head: chain[4] ?? checkpoint(4),
  createdAt: "2026-10-19T10:04:00.000Z",
};

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

const sent = (headId: string): ServerComment => ({
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
});

describe("a slice she reads (story d, step 5)", () => {
  it("takes comments only on the pinned slice, base to the checkpoint review opened (G10)", () => {
    const main = resolveSlice({ kind: "pinned" }, pinned, chain);
    expect(main).toMatchObject({ from: { ordinal: 0 }, to: { ordinal: 4 }, commentable: true });
    const others = [
      resolveSlice({ kind: "since-last-review", from: checkpoint(2) }, pinned, chain),
      resolveSlice({ kind: "last-turn", from: checkpoint(2) }, pinned, chain),
      resolveSlice({ kind: "between", from: checkpoint(0), to: checkpoint(4) }, pinned, chain),
    ];
    for (const slice of others) expect(slice?.commentable).toBe(false);
  });

  it("reads a choice other than the pinned one up to the newest checkpoint", () => {
    const newer = [...chain, checkpoint(5, "turn-boundary")];
    expect(
      resolveSlice({ kind: "since-last-review", from: checkpoint(4) }, pinned, newer)?.to.ordinal,
    ).toBe(5);
  });

  it("has nothing to read when its start is not before its end", () => {
    expect(resolveSlice({ kind: "since-last-review", from: checkpoint(4) }, pinned, chain)).toBe(
      null,
    );
    expect(
      resolveSlice({ kind: "between", from: checkpoint(3), to: checkpoint(3) }, pinned, chain),
    ).toBe(null);
  });

  it("starts the last turn at the newest turn boundary before now", () => {
    expect(lastTurnStart(chain, pinned)?.ordinal).toBe(2);
    expect(lastTurnStart([checkpoint(0, "user-mark"), checkpoint(1, "review-open")], pinned)).toBe(
      null,
    );
  });

  it("takes since my last review from the newest head a sent review was pinned to", () => {
    expect(lastReviewHead(chain, [sent("cp2"), sent("cp3")], [])?.ordinal).toBe(3);
    expect(lastReviewHead(chain, [{ ...sent("cp3"), sentToSessionId: null }], [])).toBe(null);
    expect(lastReviewHead(chain, [sent("cp2")], ["cp3"])?.ordinal).toBe(3);
  });

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
      "last turn · checkpoint 2 → now",
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
    expect(after.map((offer) => offer.label)).toContain("since my last review");
    expect(after.find((offer) => offer.label === "since my last review")?.span).toBe(
      "checkpoint 3 → now",
    );
  });
});

describe("the header and the tabs", () => {
  it("reads files, lines, the observed word and the seconds since", () => {
    expect(
      headerFact({
        files: [file({ additions: 100, deletions: 10 }), file({ additions: 20, deletions: 8 })],
        observation: { state: "observed", observedAt: "2026-10-19T10:00:00.000Z" },
        readAt: "2026-10-19T10:00:30.000Z",
        now: new Date("2026-10-19T10:00:40.000Z"),
      }),
    ).toBe("2 files · +120 −18 · observed · 40 s ago");
  });

  it("says claimed when Mend only claims the diff, never a verdict", () => {
    expect(
      headerFact({
        files: [file({})],
        observation: { state: "claimed", observedAt: null },
        readAt: "2026-10-19T10:00:00.000Z",
        now: new Date("2026-10-19T10:02:00.000Z"),
      }),
    ).toBe("1 file · +0 −0 · claimed · 2 min ago");
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
