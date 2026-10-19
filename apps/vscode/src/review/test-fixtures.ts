import type { Project, Session, SessionDetail } from "../types.js";
import type { ChangeRead } from "./change-rows.js";
import type { PendingComment } from "./pending.js";
import { ReviewClient } from "./review-client.js";
import type {
  ChangeFile,
  Checkpoint,
  PinnedSlice,
  ReadPass,
  ServerComment,
  SliceDiff,
  WorktreeChain,
} from "./review-wire.js";
import { resolveSlice, type SliceChoice } from "./slices.js";

/** One change for the review's unit tests: base, a mark, and the checkpoint review opened. */

export const checkpoint = (
  ordinal: number,
  trigger: Checkpoint["trigger"] = "user-mark",
): Checkpoint => ({
  id: `cp${ordinal}`,
  ordinal,
  trigger,
  createdAt: "2026-10-19T10:00:00.000Z",
});

export const CHECKPOINTS: ReadonlyArray<Checkpoint> = [
  checkpoint(0, "session-start"),
  checkpoint(1),
  checkpoint(2, "review-open"),
];

export const PINNED: PinnedSlice = {
  id: "slice-1",
  changeId: "change-1",
  diffDigest: "d",
  base: checkpoint(0, "session-start"),
  head: checkpoint(2, "review-open"),
  createdAt: "2026-10-19T10:00:00.000Z",
};

export const FILES: ReadonlyArray<ChangeFile> = [
  {
    oldPath: null,
    newPath: "src/auth/limit.ts",
    status: "added",
    additions: 15,
    deletions: 0,
    binary: false,
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 15, contextHash: "h1" }],
  },
  {
    oldPath: "README",
    newPath: null,
    status: "deleted",
    additions: 0,
    deletions: 1,
    binary: false,
    hunks: [],
  },
];

export const comment = (overrides: Partial<ServerComment>): ServerComment => ({
  id: "c1",
  file: "src/auth/limit.ts",
  line: 12,
  endLine: 12,
  anchor: null,
  author: { kind: "reviewer", name: "Dana" },
  body: "Use the shared limiter",
  suggestion: null,
  state: "open",
  evidence: [],
  sentToSessionId: null,
  createdAt: "2026-10-19T10:00:00.000Z",
  updatedAt: "2026-10-19T10:00:00.000Z",
  ...overrides,
});

export const pending = (overrides: Partial<PendingComment>): PendingComment => ({
  id: "p1",
  sliceId: PINNED.id,
  headId: PINNED.head.id,
  path: "src/auth/limit.ts",
  line: 12,
  endLine: 12,
  lineText: "  const recent = (hits.get(key) ?? []).filter(fresh);",
  body: "Use the shared limiter from guard.ts",
  createdAt: "2026-10-19T10:00:00.000Z",
  origin: { kind: "own" },
  ...overrides,
});

export const readOf = (choice: SliceChoice, overrides: Partial<ChangeRead> = {}): ChangeRead => {
  const checkpoints = overrides.chain?.checkpoints ?? CHECKPOINTS;
  const slice = resolveSlice(choice, PINNED, checkpoints);
  if (slice === null) throw new Error("the slice did not resolve");
  return {
    sessionId: "s1",
    sessionName: "add-rate-limit",
    changeId: "change-1",
    chain: { worktreeId: "w1", baseName: "main", checkpoints },
    pinned: PINNED,
    pinnedDiff: {
      files: FILES,
      worktreeChangedSinceSnapshot: false,
      observation: null,
      listingCut: false,
    },
    slice,
    diff: {
      files: FILES,
      worktreeChangedSinceSnapshot: false,
      observation: null,
      listingCut: false,
    },
    comments: [],
    pass: null,
    reviewedHead: null,
    drift: null,
    notice: null,
    readAt: "2026-10-19T10:00:00.000Z",
    ...overrides,
  };
};

export const PROJECT: Project = {
  id: "p1",
  name: "app",
  originUrl: null,
  storePath: "/s",
  defaultBranch: "main",
};

export const session = (id: string): Session => ({
  id,
  projectId: "p1",
  worktreeId: "w1",
  harness: "claude",
  model: null,
  label: id,
  worktree: id,
  branch: `mend/${id}`,
  status: "stopped",
  sealantWorkspaceId: null,
  summary: null,
  createdAt: "2026-10-19T09:00:00.000Z",
  settledAt: "2026-10-19T09:30:00.000Z",
  ownerUserId: id,
  livePeople: [],
  sharedControlEnabledAt: null,
  workspaceRetirement: null,
  workspaceLauncherUserId: id,
});

/** The session reads a review store makes: every session on one change, or on none. */
export const sessionReads = (changeId: string | null) => ({
  sessionDetail: async (sessionId: string): Promise<SessionDetail> => ({
    session: session(sessionId),
    processes: [],
    currentAgent: null,
    changeId,
  }),
  connection: async () => ({ url: "http://mend", token: null }),
  viewerId: async () => "dana",
  memberNames: async () => [{ userId: "dana", name: "Dana" }],
});

/** Mend as the review reads it: one change, its pinned slice, and the comments it holds. */
export class FakeMend extends ReviewClient {
  serverComments: ReadonlyArray<ServerComment> = [];

  constructor() {
    super(async () => {
      throw new Error("the fake answers every route the store reads");
    });
  }

  override async openReview(): Promise<PinnedSlice> {
    return PINNED;
  }

  override async chain(): Promise<WorktreeChain> {
    return { worktreeId: "w1", baseName: "main", checkpoints: CHECKPOINTS };
  }

  override async sliceDiff(): Promise<SliceDiff> {
    return {
      files: FILES,
      worktreeChangedSinceSnapshot: false,
      observation: null,
      listingCut: false,
    };
  }

  override async comments(): Promise<ReadonlyArray<ServerComment>> {
    return this.serverComments;
  }

  override async readPass(): Promise<ReadPass | null> {
    return null;
  }
}

/** Long enough for a store's read of the fakes to land. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));
