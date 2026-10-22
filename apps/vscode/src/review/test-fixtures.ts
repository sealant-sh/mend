import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FOLLOW_UP_INSTRUCTION_MAX,
  reviewTargetExists,
  reviewTargetFile,
  type ReviewCommentTarget,
} from "@mend/domain/workbench";

import type { MendConnection } from "../config.js";
import { MendApiError } from "../mend-http.js";
import type { Project, ProjectDetail, Session, SessionDetail } from "../types.js";
import type { Pasted } from "./agent-paste.js";
import type { Bound } from "./binding.js";
import type { ChangeRead } from "./change-rows.js";
import { startSend, type DeliverRequest } from "./delivery.js";
import { Instruction } from "./instruction.js";
import { KeptReviews, NODE_FILES, type KeptFiles } from "./kept-reviews.js";
import { EMPTY_REVIEW, type PendingComment, type SessionReview } from "./pending.js";
import { ReviewClient } from "./review-client.js";
import type { Composition, ReviewStore, Sent } from "./review-store.js";
import type {
  ChangeFile,
  Checkpoint,
  FollowUp,
  PinnedSlice,
  ReadPass,
  ServerComment,
  SliceDiff,
  WorktreeChain,
} from "./review-wire.js";
import { resolveSlice, type SliceChoice } from "./slices.js";

export const SETTLE = { timeout: 10_000 } as const;

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
    oldPath: "src/app.ts",
    newPath: "src/app.ts",
    status: "modified",
    additions: 2,
    deletions: 1,
    binary: false,
    hunks: [{ oldStart: 10, oldLines: 4, newStart: 10, newLines: 5, contextHash: "m1" }],
  },
  {
    oldPath: "src/old-name.ts",
    newPath: "src/new-name.ts",
    status: "renamed",
    additions: 1,
    deletions: 1,
    binary: false,
    hunks: [{ oldStart: 3, oldLines: 3, newStart: 3, newLines: 3, contextHash: "r1" }],
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

/** Dana's session, shared control off. */
export const SESSION: Session = {
  id: "s1",
  projectId: "p1",
  worktreeId: "w1",
  harness: "claude",
  model: null,
  label: "add-rate-limit",
  worktree: "add-rate-limit",
  branch: "mend/add-rate-limit",
  status: "running",
  sealantWorkspaceId: null,
  summary: null,
  createdAt: "2026-10-19T09:00:00.000Z",
  settledAt: null,
  ownerUserId: "dana",
  livePeople: [],
  sharedControlEnabledAt: null,
  workspaceRetirement: null,
  workspaceLauncherUserId: "dana",
};

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
  anchor: null,
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
    facts: {
      session: SESSION,
      viewer: "dana",
      ownerName: "Dana",
      agent: null,
      startsTerminal: true,
    },
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

/** The session reads a review store makes: every session Dana's, on one change or on none. */
export const sessionReads = (changeId: string | null) => ({
  sessionDetail: async (sessionId: string): Promise<SessionDetail> => ({
    session: { ...session(sessionId), ownerUserId: "dana" },
    processes: [],
    currentAgent: null,
    changeId,
  }),
  connection: async () => ({ url: "http://mend", token: null }),
  async held() {
    return { connection: await this.connection(), current: () => true };
  },
  accountOf: async (): Promise<string | null> => "dana",
  memberNames: async () => [{ userId: "dana", name: "Dana" }],
  projectDetail: async (): Promise<ProjectDetail> => ({ project: PROJECT, sessions: [] }),
  /** Reads made only once `connect` gives a connection, as `MendClient.pinned` makes them. */
  pinned(connect: () => Promise<MendConnection>) {
    return {
      sessionDetail: async (sessionId: string): Promise<SessionDetail> => {
        await connect();
        return this.sessionDetail(sessionId);
      },
    };
  },
});

/** One VS Code's global storage, of its own, for a test's kept reviews. */
export const storage = (): Promise<string> => mkdtemp(join(tmpdir(), "mend-kept-reviews-"));

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One window's file reads and writes, each read and write held back `ms`: two windows reading
 * one review at once both read it before either writes, as two VS Code windows can. A write in
 * place, not to a `.tmp` renamed over its file, is truncated `ms` before it is written, as a
 * write can be: another window reads it empty between.
 */
export const slowFiles = (ms: number): KeptFiles => ({
  ...NODE_FILES,
  readFile: async (path) => {
    try {
      return await NODE_FILES.readFile(path);
    } finally {
      await pause(ms);
    }
  },
  writeFile: async (path, text) => {
    await pause(ms);
    if (!path.endsWith(".tmp")) {
      await NODE_FILES.writeFile(path, "");
      await pause(ms);
    }
    await NODE_FILES.writeFile(path, text);
  },
});

/** A window's own kept reviews over a shared storage directory. */
export const keptIn = (directory: string, files: KeptFiles = NODE_FILES): KeptReviews =>
  new KeptReviews(directory, files);

/** Mend as the review reads it: one change, its pinned slice, and the comments it holds. */
export class FakeMend extends ReviewClient {
  serverComments: ReadonlyArray<ServerComment> = [];

  constructor() {
    super(
      async () => {
        throw new Error("the fake answers every route the store reads");
      },
      () => undefined,
    );
  }

  /** This Mend, each call made only once `connect` gives a connection, as a pinned client's are. */
  override pinned(connect: () => Promise<Bound>): ReviewClient {
    return new Proxy(this, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return async (...args: ReadonlyArray<unknown>) => {
          await connect();
          return Reflect.apply(value, target, args);
        };
      },
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

  /** Every write the review made, in order: `state d1 open`, `post …`, `deliver s1 <key>`. */
  readonly writes: Array<string> = [];
  /** Every follow-up asked for, as sent. */
  readonly delivered: Array<DeliverRequest> = [];
  /** How `follow-up/deliver` answers, and what `GET …/follow-up` lists. */
  answer: FollowUp["status"] = "delivering";
  listed: FollowUp | null = null;
  /** The follow-up Mend holds pending, as `GET …/follow-up` lists it until it is delivered. */
  #held: FollowUp | null = null;

  override async setCommentState(
    _changeId: string,
    commentId: string,
    state: "open" | "addressed" | "dismissed",
  ): Promise<ServerComment> {
    this.writes.push(`state ${commentId} ${state}`);
    const found = this.serverComments.find((candidate) => candidate.id === commentId);
    if (found === undefined) throw new Error(`no comment ${commentId}`);
    const next = { ...found, state };
    this.serverComments = this.serverComments.map((candidate) =>
      candidate.id === commentId ? next : candidate,
    );
    return next;
  }

  override async postComment(
    _changeId: string,
    sliceId: string,
    target: ReviewCommentTarget,
    body: string,
  ): Promise<ServerComment> {
    if (!reviewTargetExists(FILES, target))
      throw new MendApiError(
        "The comment anchor is not present in this Review slice.",
        422,
        "StoreFailure",
      );
    this.writes.push(`post ${body}`);
    const posted = comment({
      id: `posted-${this.serverComments.length}`,
      file: reviewTargetFile(target),
      line: target.startLine,
      endLine: target.endLine,
      anchor: { sliceId, baseId: PINNED.base.id, headId: PINNED.head.id, side: target.side },
      body,
    });
    this.serverComments = [...this.serverComments, posted];
    return posted;
  }

  override async deliver(sessionId: string, request: DeliverRequest): Promise<FollowUp> {
    if (request.instruction.trim() === "" || request.instruction.length > FOLLOW_UP_INSTRUCTION_MAX)
      throw new MendApiError(
        `Follow-up instructions must contain between 1 and ${FOLLOW_UP_INSTRUCTION_MAX} characters.`,
        422,
        "StoreFailure",
      );
    this.writes.push(`deliver ${sessionId} ${request.idempotencyKey}`);
    this.delivered.push(request);
    const answered: FollowUp = { key: request.idempotencyKey, status: this.answer, error: null };
    this.#held = this.answer === "pending" ? answered : null;
    return answered;
  }

  override async followUp(): Promise<FollowUp | null> {
    return this.listed ?? this.#held;
  }

  /** Mend marks these comments sent to the session, as a delivered follow-up does. */
  markSent(sessionId: string): void {
    this.#held = null;
    this.serverComments = this.serverComments.map((candidate) =>
      candidate.state === "open" ? { ...candidate, sentToSessionId: sessionId } : candidate,
    );
  }
}

/**
 * Send review as its editor does: the composition kept as the session's review, `text` saved over
 * it, and sent as saved.
 */
export const sendComposed = async (
  store: ReviewStore,
  composition: Composition,
  text: string,
): Promise<Sent> => {
  const { ref, document } = await store.keepDocument(composition);
  const saved = await store.saveDocument(ref, document.revision, text);
  return saved.kind === "saved"
    ? store.send(ref, saved.revision)
    : { sent: false, words: `VS Code did not save the review: ${saved.kind}` };
};

export const instructionOf = (text: string): Instruction => {
  const parsed = Instruction.parse(text, "add-rate-limit");
  if (!parsed.ok) throw new Error(parsed.words);
  return parsed.instruction;
};

/** A review she sent with one comment, `sent`: its record holds the comment, sending still. */
export const sentReview = (key = "key-1"): SessionReview => {
  const review = startSend(
    { ...EMPTY_REVIEW, pending: [pending({ id: "sent" })] },
    {
      key,
      slice: {
        id: PINNED.id,
        baseId: PINNED.base.id,
        headId: PINNED.head.id,
        diffDigest: PINNED.diffDigest,
      },
      instruction: instructionOf("the review"),
      paste: { kind: "all" },
      pending: ["sent"],
      open: [],
      now: "2026-10-19T10:50:00.000Z",
    },
  );
  if (review === null) throw new Error("the review did not start");
  return review;
};

/** Long enough for a store's read of the fakes to land. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

const missing = (path: string): Error =>
  Object.assign(new Error(`ENOENT: no such file, '${path}'`), { code: "ENOENT" });

/**
 * One machine's disk in memory, for tests that run on fake timers: every window's kept reviews
 * share it, as the windows of one VS Code share its global storage.
 */
export const memoryFiles = (): KeptFiles => {
  const files = new Map<string, { readonly text: string; readonly at: number }>();
  return {
    mkdir: async () => undefined,
    readFile: async (path) => {
      const found = files.get(path);
      if (found === undefined) throw missing(path);
      return found.text;
    },
    create: async (path, text) => {
      if (files.has(path)) throw Object.assign(new Error(`EEXIST: '${path}'`), { code: "EEXIST" });
      files.set(path, { text, at: Date.now() });
    },
    writeFile: async (path, text) => {
      files.set(path, { text, at: Date.now() });
    },
    rename: async (from, to) => {
      const found = files.get(from);
      if (found === undefined) throw missing(from);
      files.delete(from);
      files.set(to, found);
    },
    rm: async (path) => {
      files.delete(path);
    },
    readdir: async (path) =>
      [...files.keys()].flatMap((name) =>
        name.startsWith(`${path}/`) ? [name.slice(path.length + 1)] : [],
      ),
    modified: async (path) => files.get(path)?.at ?? null,
  };
};

/** A window with no terminal of hers to paste into. */
export const noPaste = async (): Promise<Pasted> => "not-attached";
