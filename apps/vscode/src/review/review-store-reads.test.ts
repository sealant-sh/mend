import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventPointer } from "../client.js";
import { MendApiError } from "../mend-http.js";
import type { Project, Session, SessionDetail } from "../types.js";
import type { ChangeRead } from "./change-rows.js";
import { ReviewClient } from "./review-client.js";
import { ReviewMemory } from "./review-memory.js";
import { ReviewStore } from "./review-store.js";
import type {
  Checkpoint,
  PinnedSlice,
  ServerComment,
  SliceDiff,
  WorktreeChain,
} from "./review-wire.js";
import { keptIn, memoryFiles } from "./test-fixtures.js";

vi.mock("vscode", () => import("../test-vscode.js"));

const project: Project = {
  id: "p1",
  name: "api",
  originUrl: null,
  storePath: "/store/api",
  defaultBranch: "main",
};

const session: Session = {
  id: "s1",
  projectId: "p1",
  harness: "claude",
  model: null,
  label: null,
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
  workspaceLauncherUserId: null,
};

const noChange: SessionDetail = {
  session,
  processes: [],
  currentAgent: null,
  changeId: null,
};

const withChange: SessionDetail = {
  session: { ...session, worktreeId: "w1" },
  processes: [],
  currentAgent: null,
  changeId: "change-1",
};

const checkpoint = (ordinal: number, trigger: Checkpoint["trigger"]): Checkpoint => ({
  id: `cp${ordinal}`,
  ordinal,
  trigger,
  createdAt: `2026-10-19T10:${String(ordinal).padStart(2, "0")}:00.000Z`,
});

const fileList = (count: number): SliceDiff["files"] =>
  Array.from({ length: count }, (_, index) => ({
    oldPath: null,
    newPath: `src/f${index}.ts`,
    status: "added",
    additions: 1,
    deletions: 0,
    binary: false,
    hunks: [],
  }));

/**
 * A Mend with one session's worktree: its chain, how many files each checkpoint holds, and
 * `reviews/open` answering the same slice for the same key, a new checkpoint for a new key.
 */
class World extends ReviewClient {
  readonly chainOf: Array<Checkpoint> = [checkpoint(0, "session-start")];
  /** Files changed from the base, at each checkpoint, by id. */
  readonly filesAt = new Map<string, number>([["cp0", 0]]);
  /** Files in the worktree now, checkpointed or not. */
  files = 0;
  readonly opened: Array<string> = [];
  readonly pins = new Map<string, PinnedSlice>();
  readonly ranges: Array<string> = [];
  written: ReadonlyArray<ServerComment> = [];
  missing = new Set<string>();

  constructor() {
    super(
      async () => ({ url: "http://mend.test", token: "t" }),
      () => undefined,
    );
  }

  /** The agent wrote: a checkpoint of `trigger` holding `files` files. */
  take(trigger: Checkpoint["trigger"], files = this.files): Checkpoint {
    this.files = files;
    const taken = checkpoint(this.chainOf.length, trigger);
    this.chainOf.push(taken);
    this.filesAt.set(taken.id, files);
    return taken;
  }

  override async openReview(_changeId: string, key: string): Promise<PinnedSlice> {
    this.opened.push(key);
    const known = this.pins.get(key);
    if (known !== undefined) return known;
    const base = this.chainOf[0] ?? checkpoint(0, "session-start");
    const slice = {
      id: `slice-${this.pins.size + 1}`,
      changeId: "change-1",
      diffDigest: "d",
      base,
      head: this.take("review-open"),
      createdAt: "2026-10-19T10:00:00.000Z",
    };
    this.pins.set(key, slice);
    return slice;
  }

  override async sliceDiff(_changeId: string, sliceId: string): Promise<SliceDiff> {
    const slice = [...this.pins.values()].find((pinned) => pinned.id === sliceId);
    const files = this.filesAt.get(slice?.head.id ?? "") ?? 0;
    return {
      files: fileList(files),
      worktreeChangedSinceSnapshot: files !== this.files,
      observation: {
        state: "observed",
        observedAt: "2026-10-19T10:00:00.000Z",
      },
      listingCut: false,
    };
  }

  override async rangeDiff(_worktreeId: string, from: string, to: string): Promise<SliceDiff> {
    this.ranges.push(`${from}→${to}`);
    if (this.missing.has(from) || this.missing.has(to))
      throw new MendApiError(`checkpoint ${to} not found`, 404);
    return {
      files: fileList(Math.max(0, (this.filesAt.get(to) ?? 0) - (this.filesAt.get(from) ?? 0))),
      worktreeChangedSinceSnapshot: false,
      observation: null,
      listingCut: false,
    };
  }

  override async chain(worktreeId: string): Promise<WorktreeChain> {
    return { worktreeId, baseName: "main", checkpoints: [...this.chainOf] };
  }

  override async comments(): Promise<ReadonlyArray<ServerComment>> {
    return this.written;
  }

  override async readPass(): Promise<null> {
    return null;
  }
}

const memento = () => {
  const kept = new Map<string, unknown>();
  return {
    get: (key: string): unknown => kept.get(key),
    update: async (key: string, value: unknown): Promise<void> => {
      kept.set(key, value);
    },
  };
};

/** A review store over `world`, its session reads gated by `detail` and counted. */
const storeOver = (
  world: World,
  options: {
    readonly detail?: () => Promise<SessionDetail>;
    readonly kept?: ReturnType<typeof memento>;
    readonly viewer?: string;
  } = {},
) => {
  const reads = { started: 0, inFlight: 0, most: 0 };
  const store = new ReviewStore(
    {
      sessionDetail: async () => {
        reads.started++;
        reads.inFlight++;
        reads.most = Math.max(reads.most, reads.inFlight);
        try {
          return await (options.detail?.() ?? Promise.resolve(withChange));
        } finally {
          reads.inFlight--;
        }
      },
      connection: async () => ({ url: "http://mend.test", token: "t" }),
      viewerId: async (): Promise<string | null> => options.viewer ?? "dana",
      projectDetail: async () => ({ project, sessions: [] }),
      memberNames: async () => [
        { userId: "dana", name: "Dana" },
        { userId: "ana", name: "Ana" },
      ],
    },
    world,
    new ReviewMemory(options.kept ?? memento()),
    keptIn("/global-storage/reviews", memoryFiles()),
  );
  return { store, reads };
};

const readyRead = async (store: ReviewStore) => {
  await vi.waitFor(() => expect(store.state().kind).toBe("ready"));
  const read = store.ready();
  if (read === null) throw new Error("the store read nothing");
  return read;
};

/** Waits for the store's next read to land. */
const nextRead = async (store: ReviewStore, before: ChangeRead) => {
  await vi.waitFor(() => expect(store.ready()).not.toBe(before));
  return readyRead(store);
};

afterEach(() => {
  vi.useRealTimers();
});

describe("ReviewStore.forget", () => {
  it("drops what the section showed", async () => {
    const { store } = storeOver(new World(), { detail: async () => noChange });
    store.follow(project, session);
    await vi.waitFor(() => expect(store.state().kind).toBe("empty"));
    store.forget();
    expect(store.state()).toEqual({ kind: "idle" });
  });

  it("keeps a read that lands after it from drawing the session again", async () => {
    const held = Promise.withResolvers<SessionDetail>();
    const { store } = storeOver(new World(), { detail: () => held.promise });
    store.follow(project, session);
    expect(store.state().kind).toBe("reading");
    store.forget();
    held.resolve(noChange);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.state()).toEqual({ kind: "idle" });
  });

  it("lets the same session be followed again afterwards", async () => {
    const { store } = storeOver(new World(), { detail: async () => noChange });
    store.follow(project, session);
    await vi.waitFor(() => expect(store.state().kind).toBe("empty"));
    store.forget();
    store.follow(project, session);
    expect(store.state().kind).toBe("reading");
  });
});

describe("the worktree moved on past the pinned slice (story d, edge case)", () => {
  it("keeps the pinned slice, says how many files changed since, and re-pins on Review the newer change", async () => {
    const world = new World();
    const kept = memento();
    const { store } = storeOver(world, { kept });
    store.follow(project, session);
    const first = await readyRead(store);
    expect(first.diff.files).toHaveLength(0);
    expect(first.drift).toBe(null);

    world.take("turn-boundary", 3);
    store.reread();
    const moved = await nextRead(store, first);
    expect(moved.diff.files).toHaveLength(0);
    expect(moved.pinned.id).toBe(first.pinned.id);
    expect(moved.drift).toEqual({ files: 3 });

    await store.repin();
    const newer = await nextRead(store, moved);
    expect(newer.pinned.id).not.toBe(first.pinned.id);
    expect(newer.diff.files).toHaveLength(3);
    expect(newer.drift).toBe(null);

    const reloaded = storeOver(world, { kept }).store;
    reloaded.follow(project, session);
    expect((await readyRead(reloaded)).pinned.id).toBe(newer.pinned.id);
    expect(new Set(world.opened).size).toBe(2);
  });

  it("says the worktree changed, uncounted, when no checkpoint holds the newer files yet", async () => {
    const world = new World();
    const { store } = storeOver(world);
    store.follow(project, session);
    const first = await readyRead(store);
    world.files = 2;
    store.reread();
    expect((await nextRead(store, first)).drift).toEqual({ files: null });
  });
});

describe("reads in flight (as flow 2)", () => {
  it("keeps one read in flight under a burst of frames and refreshes, and one more after it", async () => {
    vi.useFakeTimers();
    const world = new World();
    world.take("turn-boundary", 1);
    const gates: Array<PromiseWithResolvers<SessionDetail>> = [];
    const { store, reads } = storeOver(world, {
      detail: () => {
        const gate = Promise.withResolvers<SessionDetail>();
        gates.push(gate);
        return gate.promise;
      },
    });
    store.follow(project, session);
    const frame: EventPointer = {
      type: "session-change",
      sessionId: "s1",
      projectId: "p1",
      changeId: "change-1",
      facet: null,
    };
    for (let tick = 0; tick < 10; tick++) {
      store.heard(frame);
      store.reread();
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(reads.most).toBe(1);
    expect(reads.started).toBe(1);
    gates[0]?.resolve(withChange);
    await vi.waitFor(() => expect(reads.started).toBe(2));
    gates[1]?.resolve(withChange);
    await vi.waitFor(() => expect(store.state().kind).toBe("ready"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reads.most).toBe(1);
    expect(reads.started).toBe(2);
  });
});

describe("a reconnect", () => {
  it("reads the followed change again on the stream's resync", async () => {
    vi.useFakeTimers();
    const { store, reads } = storeOver(new World());
    store.follow(project, session);
    await vi.waitFor(() => expect(store.state().kind).toBe("ready"));
    expect(reads.started).toBe(1);
    store.heard({
      type: "resync",
      sessionId: null,
      projectId: null,
      changeId: null,
      facet: null,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reads.started).toBe(2);
  });
});

describe("a slice she chose", () => {
  it("stays on its own two checkpoints while newer ones arrive, until she reads the newer one", async () => {
    const world = new World();
    world.take("turn-boundary", 2);
    const { store } = storeOver(world);
    store.follow(project, session);
    const first = await readyRead(store);
    const turn = {
      kind: "last-turn",
      from: checkpoint(0, "session-start"),
      to: checkpoint(1, "turn-boundary"),
    } as const;
    store.choose("s1", turn);
    const chosen = await nextRead(store, first);
    expect([chosen.slice.from.id, chosen.slice.to.id]).toEqual(["cp0", "cp1"]);

    world.take("turn-boundary", 5);
    store.reread();
    const later = await nextRead(store, chosen);
    expect([later.slice.from.id, later.slice.to.id]).toEqual(["cp0", "cp1"]);

    store.readNewer();
    const newer = await nextRead(store, later);
    expect([newer.slice.choice.kind, newer.slice.from.id, newer.slice.to.id]).toEqual([
      "last-turn",
      "cp1",
      "cp3",
    ]);
  });

  it("falls back to main → now, saying why, when its checkpoints left the chain", async () => {
    const world = new World();
    const { store } = storeOver(world);
    store.follow(project, session);
    const first = await readyRead(store);
    store.choose("s1", {
      kind: "between",
      from: checkpoint(0, "session-start"),
      to: checkpoint(9, "user-mark"),
    });
    const fell = await nextRead(store, first);
    expect(fell.slice.choice.kind).toBe("pinned");
    expect(fell.notice).toBe(
      "main → checkpoint 9 is no longer in this worktree's checkpoints · showing main → now",
    );
  });

  it("falls back once when Mend has no such range, and Refresh does not ask for it again", async () => {
    const world = new World();
    world.take("turn-boundary", 2);
    const { store } = storeOver(world);
    store.follow(project, session);
    const first = await readyRead(store);
    world.missing.add("cp1");
    store.choose("s1", {
      kind: "between",
      from: checkpoint(0, "session-start"),
      to: checkpoint(1, "turn-boundary"),
    });
    const fell = await nextRead(store, first);
    expect(fell.slice.choice.kind).toBe("pinned");
    expect(fell.notice).toContain("Mend could not read main → checkpoint 1");
    const asked = world.ranges.length;
    store.reread();
    const again = await nextRead(store, fell);
    expect(again.notice).toBe(null);
    expect(world.ranges.length).toBe(asked);
  });
});

const sentBy = (id: string, name: string, headId: string, createdAt: string): ServerComment => ({
  id,
  file: "src/f0.ts",
  line: 1,
  endLine: 1,
  anchor: { sliceId: "old", baseId: "cp0", headId, side: "new" },
  author: { kind: "reviewer", name },
  body: "x",
  suggestion: null,
  state: "open",
  evidence: [],
  sentToSessionId: "s1",
  createdAt,
  updatedAt: createdAt,
});

describe("since my last review", () => {
  it("starts from her own most recent review, not another reviewer's", async () => {
    const world = new World();
    world.take("turn-boundary", 1);
    world.take("turn-boundary", 2);
    world.written = [
      sentBy("dana", "Dana", "cp1", "2026-10-19T10:00:00.000Z"),
      sentBy("ana", "Ana", "cp2", "2026-10-19T11:00:00.000Z"),
    ];
    const dana = storeOver(world).store;
    dana.follow(project, session);
    expect((await readyRead(dana)).reviewedHead?.id).toBe("cp1");
    const ana = storeOver(world, { viewer: "ana" }).store;
    ana.follow(project, session);
    expect((await readyRead(ana)).reviewedHead?.id).toBe("cp2");
  });
});
