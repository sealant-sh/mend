import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GIT_BUNDLE_CONTENT_TYPE } from "@mend/api-contracts";
import type { StoreRef } from "@mend/db";
import { ProjectId, SessionId, Sha, WorktreeId } from "@mend/domain";
import {
  HandoffCutAt,
  HandoffMachine,
  HandoffBranch,
  HexSha,
  Session,
  Worktree,
  type WorktreeHandoff,
} from "@mend/domain/workbench";
import { SealantPlatformError } from "@mend/sealant";
import type { SessionEngine } from "@mend/sessions";
import { skippedFreshen, Store, StoreConfig } from "@mend/store";
import { buildHandoffBundle, makeHandoffWorld, sh } from "@mend/store/testing";
import { Deferred, Effect, Exit, Layer } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids, makeSession } from "../../test/support/tenancy-harness.ts";

const sharedA = ids("shared-a");
const NOW = new Date("2026-10-18T07:42:05Z");
const BUNDLE = { "content-type": GIT_BUNDLE_CONTENT_TYPE };
const NAME_KEY = "worktrees_project_name_key";
const CHECKPOINT_KEY = "worktrees_project_handoff_checkpoint_key";

let tmp: string;
let world: ReturnType<typeof makeHandoffWorld>;
let realStore: Store["Service"];
beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-handoff-route-"));
  world = makeHandoffWorld(tmp);
  realStore = await Effect.runPromise(
    Store.pipe(
      Effect.provide(
        Store.layer.pipe(Layer.provide(StoreConfig.layerFor(path.join(tmp, "store-root")))),
      ),
    ),
  );
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

let api: TenancyApi | null = null;
afterEach(async () => {
  await api?.dispose();
  api = null;
});

interface Seen {
  readonly provisions: Array<{
    name: string | null;
    kind: string;
    harness: string;
    owner: string | null;
  }>;
  readonly sessionsIn: Array<string>;
  readonly holds: Array<string>;
  readonly audits: Array<string>;
  readonly freshens: Array<string>;
  readonly refs: Array<StoreRef>;
  readonly namesRacing: Set<string>;
  readonly provisionGates: Array<Deferred.Deferred<void>>;
  readonly holdGates: Array<Deferred.Deferred<void>>;
  /** Sessions the engine reads as having a launch under way. */
  readonly launching: Set<string>;
  holdFails: boolean;
}

const unlaunched = (id: SessionId, worktreeId: WorktreeId, owner: string): Session =>
  new Session({
    ...makeSession(id, sharedA.project, worktreeId, owner),
    status: "starting",
    sealantWorkspaceId: null,
    sealantRunId: null,
    settledAt: null,
    startedAt: null,
  });

const uniqueViolation = (constraint: string) => ({ code: "23505", constraint });

const worldWith = async (
  limits: Parameters<typeof createTenancyApi>[0] = {},
  seen: Seen,
  sessions: ReadonlyArray<Session> = [],
) => {
  let count = 0;
  const checkpoints = new Set<string>();
  const provision: SessionEngine["Service"]["provision"] = (input) =>
    Effect.gen(function* () {
      count += 1;
      const worktreeId = WorktreeId.make(`worktree-handoff-${count}`);
      const sessionId = SessionId.make(`session-handoff-${count}`);
      seen.provisions.push({
        name: input.name,
        kind: input.start.kind,
        harness: input.harness,
        owner: input.ownerUserId,
      });
      const gate = seen.provisionGates.shift();
      if (gate !== undefined) yield* Deferred.await(gate);
      if (input.start.kind !== "handoff")
        return yield* Effect.die("a base start in a handoff test");
      const { admitted, ownerUserId } = input.start;
      if (input.name !== null && seen.namesRacing.delete(input.name)) {
        return yield* Effect.die(uniqueViolation(NAME_KEY));
      }
      if (checkpoints.has(admitted.snapshot)) {
        return yield* Effect.die(uniqueViolation(CHECKPOINT_KEY));
      }
      checkpoints.add(admitted.snapshot);
      const handoff: WorktreeHandoff = {
        machine: admitted.trailers.machine,
        localBranch: admitted.trailers.localBranch,
        cutAt: admitted.trailers.cutAt,
        head: HexSha.make(admitted.head),
        index: HexSha.make(admitted.index),
        checkpoint: HexSha.make(admitted.snapshot),
        mergeBase: HexSha.make(admitted.mergeBase),
        worktreeTree: HexSha.make(admitted.worktreeTree),
        indexTree: HexSha.make(admitted.indexTree),
        ownerUserId,
        deltaPack: `captures/${worktreeId}/0/packs/${"d".repeat(64)}`,
        commitsAhead: admitted.commitsAhead,
        previous: input.start.previous,
      };
      api?.world.addWorktree(
        new Worktree({
          id: worktreeId,
          projectId: ProjectId.make(input.projectId),
          name: input.name ?? worktreeId,
          directory: input.name ?? worktreeId,
          branch: `mend/${input.name ?? worktreeId}`,
          baseSha: admitted.mergeBase,
          baseRef: "main",
          handoff,
          createdAt: new Date(NOW.getTime() + count * 1000),
          updatedAt: NOW,
        }),
      );
      return unlaunched(sessionId, worktreeId, ownerUserId);
    });
  return createTenancyApi(limits, {
    sessions,
    implement: {
      store: {
        freshenBase: (_storePath, baseRef) =>
          Effect.sync(() => {
            seen.freshens.push(baseRef);
            return skippedFreshen("no credential in this test");
          }),
        admitHandoff: (_storePath, defaultBranch, bytes, options) =>
          realStore.admitHandoff(world.storePath, defaultBranch, bytes, options),
      },
      storeRefs: { list: () => Effect.succeed(seen.refs) },
      engine: {
        launchUnderWay: (sessionId) => seen.launching.has(sessionId),
        provision,
        provisionSessionIn: (worktreeId, input) =>
          Effect.sync(() => {
            seen.sessionsIn.push(String(worktreeId));
            return unlaunched(
              SessionId.make(`session-again-${worktreeId}`),
              worktreeId,
              input.ownerUserId ?? "nobody",
            );
          }),
        holdWorkspace: (sessionId) =>
          Effect.gen(function* () {
            seen.holds.push(sessionId);
            const gate = seen.holdGates.shift();
            if (gate !== undefined) yield* Deferred.await(gate);
          }).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                if (seen.holdFails) {
                  return Effect.fail(
                    new SealantPlatformError({
                      code: "workspace_create_failed",
                      status: null,
                      message: "the platform refused the workspace",
                      cause: null,
                    }),
                  );
                }
                const current = api?.world.sessions.get(sessionId);
                return Effect.succeed(
                  new Session({
                    ...(current ?? unlaunched(sessionId, sharedA.worktree, "alice")),
                    id: sessionId,
                    status: "idle",
                  }),
                );
              }),
            ),
          ),
        detach: (effect) => Effect.forkDetach(effect),
      },
      audit: {
        record: (event) =>
          Effect.sync(() => {
            seen.audits.push(`${event.action}:${event.subjectType}`);
          }),
      },
    },
  });
};

const freshSeen = (): Seen => ({
  provisions: [],
  sessionsIn: [],
  holds: [],
  audits: [],
  freshens: [],
  refs: [],
  namesRacing: new Set(),
  provisionGates: [],
  holdGates: [],
  launching: new Set(),
  holdFails: false,
});

const post = (
  on: TenancyApi,
  user: "alice" | "bob" | "carol",
  bytes: Uint8Array,
  query = "harness=claude&hold=true",
  signal?: AbortSignal,
) =>
  on.postBytes(
    user,
    `/api/projects/${sharedA.project}/handoffs?${query}`,
    bytes,
    BUNDLE["content-type"],
    signal,
  );

const branchRef = (name: string, sha: string): StoreRef => ({
  projectId: sharedA.project,
  name: `refs/heads/mend/${name}`,
  sha: Sha.make(sha),
  version: 1,
  updatedAt: NOW,
});

const earlierHandoff = (
  id: string,
  name: string,
  bundle: ReturnType<typeof buildHandoffBundle>,
  owner: string,
  localBranch: string | null = "fix/login",
  answered: { readonly commitsAhead: number; readonly previous: string | null } = {
    commitsAhead: 2,
    previous: null,
  },
) =>
  new Worktree({
    id: WorktreeId.make(id),
    projectId: sharedA.project,
    name,
    directory: name,
    branch: `mend/${name}`,
    baseSha: HexSha.make(bundle.mergeBase),
    baseRef: "main",
    handoff: {
      machine: HandoffMachine.make("dana-mbp"),
      localBranch: localBranch === null ? null : HandoffBranch.make(localBranch),
      cutAt: HandoffCutAt.make("2026-10-18T07:42:05.000Z"),
      head: HexSha.make(bundle.head),
      index: HexSha.make(bundle.index),
      checkpoint: HexSha.make(bundle.checkpoint),
      mergeBase: HexSha.make(bundle.mergeBase),
      worktreeTree: HexSha.make(bundle.worktreeTree),
      indexTree: HexSha.make(bundle.indexTree),
      ownerUserId: owner,
      deltaPack: `captures/${id}/0/packs/${"d".repeat(64)}`,
      ...answered,
    },
    createdAt: NOW,
    updatedAt: NOW,
  });

/** The same bundle with its prerequisites described in other words: other bytes, the same W. */
const relabelled = (bytes: Uint8Array): Uint8Array => {
  const text = Buffer.from(bytes).toString("latin1");
  const end = text.indexOf("\n\n");
  const header = text
    .slice(0, end)
    .split("\n")
    .map((line) => (line.startsWith("-") ? `${line.split(" ")[0]} described again` : line))
    .join("\n");
  return new Uint8Array(
    Buffer.concat([Buffer.from(header, "latin1"), Buffer.from(bytes.subarray(end))]),
  );
};

const until = async (condition: () => boolean, what: string) => {
  for (let tick = 0; tick < 200; tick += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`waited 2 s for ${what}`);
};

describe("GET /projects/:id/handoffs", () => {
  it("answers the budgets, and the largest size the wire carries for a budget that is off", async () => {
    api = await worldWith({}, freshSeen());
    const terms = await api.request("alice", "GET", `/api/projects/${sharedA.project}/handoffs`);
    expect(terms.status).toBe(200);
    expect(await terms.json()).toEqual({
      bundleBytes: 64 * 1024 * 1024,
      fileBytes: 8 * 1024 * 1024,
    });
    await api.dispose();
    api = await worldWith({ bundleBytes: 0, handoffFileBytes: 0 }, freshSeen());
    const open = await api.request("alice", "GET", `/api/projects/${sharedA.project}/handoffs`);
    expect(await open.json()).toEqual({
      bundleBytes: Number.MAX_SAFE_INTEGER,
      fileBytes: Number.MAX_SAFE_INTEGER,
    });
  });

  it("refuses a co-located store with store-co-located, before and instead of any bytes", async () => {
    api = await createTenancyApi({}, { sessionStore: "colocated" });
    const terms = await api.request("alice", "GET", `/api/projects/${sharedA.project}/handoffs`);
    expect(terms.status).toBe(422);
    expect(await terms.json()).toMatchObject({
      _tag: "HandoffRefused",
      reason: "store-co-located",
      message: expect.stringMatching(/co-located store.*nothing was created$/),
    });
    const bundle = buildHandoffBundle(world.checkout);
    api.world.calls.splice(0, api.world.calls.length);
    const received = await post(api, "alice", bundle.bytes);
    expect(received.status).toBe(422);
    expect(await received.json()).toMatchObject({ reason: "store-co-located" });
    expect(api.world.calls).toEqual([]);
  });
});

describe("POST /projects/:id/handoffs", () => {
  it("answers a project the caller cannot see as missing, touching nothing", async () => {
    const seen = freshSeen();
    api = await worldWith({}, seen);
    const bundle = buildHandoffBundle(world.checkout);
    api.world.calls.splice(0, api.world.calls.length);
    const response = await post(api, "bob", bundle.bytes);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ _tag: "NotFound", id: sharedA.project });
    expect(api.world.calls).toEqual([]);
    expect(seen.provisions).toEqual([]);
  });

  it("provisions a held, audited session under the branch's name; a second handoff is -2 and names the first", async () => {
    const seen = freshSeen();
    api = await worldWith({}, seen);
    const bundle = buildHandoffBundle(world.checkout, { machine: "dana-mbp" });
    const response = await post(api, "alice", bundle.bytes);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      replayed: false,
      previous: null,
      commitsAhead: 2,
      session: { id: "session-handoff-1", status: "idle" },
      worktree: {
        name: "fix-login",
        baseSha: bundle.mergeBase,
        baseRef: "main",
        handoff: {
          machine: "dana-mbp",
          localBranch: "fix/login",
          checkpoint: bundle.checkpoint,
          ownerUserId: "alice",
        },
      },
    });
    expect(seen.provisions).toEqual([
      { name: "fix-login", kind: "handoff", harness: "claude", owner: "alice" },
    ]);
    expect(seen.holds).toEqual(["session-handoff-1"]);
    expect(seen.audits).toEqual(["worktree.handed_off:worktree"]);

    sh(world.checkout, ["commit", "-q", "-am", "more"]);
    const later = buildHandoffBundle(world.checkout, { cutAt: "2026-10-18T09:00:00.000Z" });
    const second = await post(api, "alice", later.bytes, "harness=codex&hold=false");
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      replayed: false,
      previous: { name: "fix-login" },
      worktree: { name: "fix-login-2" },
    });
    expect(seen.provisions.at(-1)).toEqual({
      name: "fix-login-2",
      kind: "handoff",
      harness: "codex",
      owner: "alice",
    });
    expect(seen.holds).toEqual(["session-handoff-1"]);
  });

  it("names no earlier handoff when the taken name is someone else's, another branch's, or no handoff at all", async () => {
    const seen = freshSeen();
    api = await worldWith({}, seen);
    const bundle = buildHandoffBundle(world.checkout);
    const earlier = buildHandoffBundle(world.checkout, { cutAt: "2026-10-18T06:00:00.000Z" });
    api.world.addWorktree(earlierHandoff("worktree-carol", "fix-login", earlier, "carol"));
    api.world.addWorktree(
      earlierHandoff("worktree-other-branch", "fix-login-2", earlier, "alice", "Fix/Login"),
    );
    const response = await post(api, "alice", bundle.bytes, "harness=claude&hold=false");
    expect(await response.json()).toMatchObject({
      previous: null,
      worktree: { name: "fix-login-3" },
    });
  });

  it("takes the next suffix when the name is a branch ref the store still holds, or when another request's row lands first", async () => {
    const seen = freshSeen();
    api = await worldWith({}, seen);
    seen.refs.push(branchRef("fix-login", "1".repeat(40)));
    const bundle = buildHandoffBundle(world.checkout);
    const stranded = await post(api, "alice", bundle.bytes, "harness=claude&hold=false");
    expect(stranded.status).toBe(200);
    expect(await stranded.json()).toMatchObject({
      previous: null,
      worktree: { name: "fix-login-2" },
    });
    expect(seen.provisions.map((provision) => provision.name)).toEqual(["fix-login-2"]);

    seen.namesRacing.add("fix-login-3");
    const raced = await post(
      api,
      "alice",
      buildHandoffBundle(world.checkout, { cutAt: "2026-10-18T09:00:02.000Z" }).bytes,
      "harness=claude&hold=false",
    );
    expect(raced.status).toBe(200);
    expect(await raced.json()).toMatchObject({
      previous: { name: "fix-login-2" },
      worktree: { name: "fix-login-4" },
    });
    expect(seen.provisions.map((provision) => provision.name)).toEqual([
      "fix-login-2",
      "fix-login-3",
      "fix-login-4",
    ]);
  });

  it("replays the same bytes onto the worktree they made, before the session budget, and holds a session still owed its hold", async () => {
    const seen = freshSeen();
    api = await worldWith({ accountLiveSessions: 1 }, seen);
    const bundle = buildHandoffBundle(world.checkout);
    const fresh = await post(api, "alice", bundle.bytes);
    expect(fresh.status).toBe(429);
    expect(await fresh.json()).toMatchObject({ budget: "accountLiveSessions" });
    expect(seen.provisions).toEqual([]);
    expect(api.world.calls).not.toContain("store.admitHandoff");
    api.world.addWorktree(earlierHandoff("worktree-earlier", "fix-login", bundle, "alice"));
    const replayed = await post(api, "alice", bundle.bytes);
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({
      replayed: true,
      previous: null,
      commitsAhead: 2,
      worktree: { id: "worktree-earlier" },
      session: { status: "idle" },
    });
    expect(api.world.calls).not.toContain("store.admitHandoff");
    expect(seen.provisions).toEqual([]);
    expect(seen.sessionsIn).toEqual(["worktree-earlier"]);
    expect(seen.holds).toEqual(["session-again-worktree-earlier"]);
  });

  it("answers a replay from what the first receipt stored, admitting nothing: a file budget lowered since, the earlier handoff it named", async () => {
    const seen = freshSeen();
    api = await worldWith({ handoffFileBytes: 64 * 1024 }, seen);
    fs.mkdirSync(path.join(world.checkout, "assets"));
    fs.writeFileSync(path.join(world.checkout, "assets", "demo.bin"), Buffer.alloc(100 * 1024, 7));
    const bundle = buildHandoffBundle(world.checkout, { cutAt: "2026-10-18T09:30:00.000Z" });
    fs.rmSync(path.join(world.checkout, "assets"), { recursive: true, force: true });
    const first = buildHandoffBundle(world.checkout, { cutAt: "2026-10-18T09:20:00.000Z" });
    api.world.addWorktree(earlierHandoff("worktree-first", "fix-login", first, "alice"));
    api.world.addWorktree(
      earlierHandoff("worktree-second", "fix-login-2", bundle, "alice", "fix/login", {
        commitsAhead: 3,
        previous: "fix-login",
      }),
    );
    api.world.calls.splice(0, api.world.calls.length);
    const response = await post(api, "alice", bundle.bytes, "harness=claude&hold=false");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      replayed: true,
      commitsAhead: 3,
      previous: { name: "fix-login" },
      worktree: { id: "worktree-second" },
    });
    expect(api.world.calls).not.toContain("store.admitHandoff");
    expect(seen.provisions).toEqual([]);
  });

  it("returns and holds only the receiving account's own session on a replay: a teammate's session in the worktree is neither", async () => {
    const seen = freshSeen();
    const bundle = buildHandoffBundle(world.checkout, { cutAt: "2026-10-18T09:40:00.000Z" });
    const carols = unlaunched(
      SessionId.make("session-carol"),
      WorktreeId.make("worktree-earlier"),
      "carol",
    );
    api = await worldWith({}, seen, [carols]);
    api.world.addWorktree(earlierHandoff("worktree-earlier", "fix-login", bundle, "alice"));
    const response = await post(api, "alice", bundle.bytes);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      replayed: true,
      session: { id: "session-again-worktree-earlier", ownerUserId: "alice" },
    });
    expect(seen.sessionsIn).toEqual(["worktree-earlier"]);
    expect(seen.holds).toEqual(["session-again-worktree-earlier"]);
  });

  it("provisions one session for two different uploads of the same W by one account at once", async () => {
    const seen = freshSeen();
    api = await worldWith({}, seen);
    const bundle = buildHandoffBundle(world.checkout, { cutAt: "2026-10-18T09:50:00.000Z" });
    const gate = Deferred.makeUnsafe<void>();
    seen.provisionGates.push(gate);
    const one = post(api, "alice", bundle.bytes);
    await until(() => seen.provisions.length === 1, "the first provision");
    const two = post(api, "alice", relabelled(bundle.bytes));
    await new Promise((resolve) => setTimeout(resolve, 50));
    Deferred.doneUnsafe(gate, Exit.void);
    const answers = await Promise.all([one, two]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    const bodies = await Promise.all(answers.map((answer) => answer.json()));
    expect(bodies.map((body) => body.session.id)).toEqual([
      "session-handoff-1",
      "session-handoff-1",
    ]);
    expect(seen.provisions).toHaveLength(1);
  });

  it("refuses a replay by another account of the project, after admitting its bytes once", async () => {
    const seen = freshSeen();
    api = await worldWith({}, seen);
    const bundle = buildHandoffBundle(world.checkout);
    api.world.addWorktree(earlierHandoff("worktree-alice", "fix-login", bundle, "alice"));
    api.world.calls.splice(0, api.world.calls.length);
    const response = await post(api, "carol", bundle.bytes);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      _tag: "StoreFailure",
      message: expect.stringMatching(/received before, for another account/),
    });
    expect(api.world.calls.filter((call) => call === "store.admitHandoff")).toHaveLength(1);
    expect(seen.provisions).toEqual([]);
    expect(seen.sessionsIn).toEqual([]);
  });

  it("holds under one of the account's launch slots for the hold's whole course: a second hold past the ceiling never reaches the engine", async () => {
    const seen = freshSeen();
    api = await worldWith({ accountLaunchesInFlight: 1 }, seen);
    const gate = Deferred.makeUnsafe<void>();
    seen.holdGates.push(gate);
    const first = post(
      api,
      "alice",
      buildHandoffBundle(world.checkout, { cutAt: "2026-10-18T10:00:00.000Z" }).bytes,
    );
    await until(() => seen.holds.length === 1, "the first hold");
    const second = await post(
      api,
      "alice",
      buildHandoffBundle(world.checkout, { cutAt: "2026-10-18T10:00:01.000Z" }).bytes,
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ session: { id: "session-handoff-2" } });
    expect(seen.holds).toEqual(["session-handoff-1"]);
    Deferred.doneUnsafe(gate, Exit.void);
    expect(await (await first).json()).toMatchObject({
      session: { id: "session-handoff-1", status: "idle" },
    });
    const third = await post(
      api,
      "alice",
      buildHandoffBundle(world.checkout, { cutAt: "2026-10-18T10:00:02.000Z" }).bytes,
    );
    expect(await third.json()).toMatchObject({
      session: { id: "session-handoff-3", status: "idle" },
    });
    expect(seen.holds).toEqual(["session-handoff-1", "session-handoff-3"]);
  });

  it("re-holds on a replay only a session no launch is under way for", async () => {
    const seen = freshSeen();
    const bundle = buildHandoffBundle(world.checkout, { cutAt: "2026-10-18T10:10:00.000Z" });
    const alices = unlaunched(
      SessionId.make("session-alice"),
      WorktreeId.make("worktree-earlier"),
      "alice",
    );
    seen.launching.add(alices.id);
    api = await worldWith({}, seen, [alices]);
    api.world.addWorktree(earlierHandoff("worktree-earlier", "fix-login", bundle, "alice"));
    const response = await post(api, "alice", bundle.bytes);
    expect(await response.json()).toMatchObject({
      replayed: true,
      session: { id: "session-alice", status: "starting" },
    });
    expect(seen.holds).toEqual([]);
  });

  it("answers the session as it stands when the hold fails: starting, never claimed held", async () => {
    const seen = freshSeen();
    seen.holdFails = true;
    api = await worldWith({}, seen);
    const bundle = buildHandoffBundle(world.checkout);
    const response = await post(api, "alice", bundle.bytes);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      session: { id: "session-handoff-1", status: "starting" },
      worktree: { name: "fix-login" },
    });
    expect(seen.holds).toEqual(["session-handoff-1"]);
  });

  it("finishes the work when the connection drops, and a retry of the same bytes joins it", async () => {
    const seen = freshSeen();
    api = await worldWith({}, seen);
    const bundle = buildHandoffBundle(world.checkout);
    const gate = Deferred.makeUnsafe<void>();
    seen.provisionGates.push(gate);
    const controller = new AbortController();
    const dropped = post(
      api,
      "alice",
      bundle.bytes,
      "harness=claude&hold=true",
      controller.signal,
    ).then(
      (response) => `answered ${response.status}`,
      (cause) => `aborted ${cause instanceof Error ? cause.name : String(cause)}`,
    );
    await until(() => seen.provisions.length === 1, "the provision to start");
    const joined = post(api, "alice", bundle.bytes);
    controller.abort();
    expect(await dropped).toMatch(/^aborted|^answered 499$/);
    Deferred.doneUnsafe(gate, Exit.void);
    const answer = await joined;
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({
      replayed: false,
      session: { id: "session-handoff-1", status: "idle" },
      worktree: { name: "fix-login" },
    });
    expect(seen.provisions).toHaveLength(1);
    expect(seen.holds).toEqual(["session-handoff-1"]);
    expect(api.world.calls.filter((call) => call === "store.admitHandoff")).toHaveLength(1);
  });

  it("refuses the account's third admission at once as a budget, and never the two under way", async () => {
    const seen = freshSeen();
    api = await worldWith({ accountHandoffsInFlight: 2 }, seen);
    const first = Deferred.makeUnsafe<void>();
    const second = Deferred.makeUnsafe<void>();
    seen.provisionGates.push(first, second);
    const one = post(api, "alice", buildHandoffBundle(world.checkout).bytes);
    await until(() => seen.provisions.length === 1, "the first provision");
    const two = post(
      api,
      "alice",
      buildHandoffBundle(world.checkout, { cutAt: "2026-10-18T09:00:03.000Z" }).bytes,
    );
    await until(() => seen.provisions.length === 2, "the second provision");
    const third = await post(
      api,
      "alice",
      buildHandoffBundle(world.checkout, { cutAt: "2026-10-18T09:00:04.000Z" }).bytes,
    );
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({
      _tag: "BudgetExceeded",
      budget: "accountHandoffsInFlight",
      limit: 2,
      message: expect.stringMatching(/2 handoffs admitted at once for one account/),
    });
    Deferred.doneUnsafe(first, Exit.void);
    Deferred.doneUnsafe(second, Exit.void);
    expect((await one).status).toBe(200);
    expect((await two).status).toBe(200);
    const fourth = await post(
      api,
      "alice",
      buildHandoffBundle(world.checkout, { cutAt: "2026-10-18T09:00:05.000Z" }).bytes,
    );
    expect(fourth.status).toBe(200);
  });

  it("spends the account's origin-checks window on the admission's freshen, and says so in the refusal once it is spent", async () => {
    const seen = freshSeen();
    api = await worldWith({ accountOriginChecksPerMinute: 1 }, seen);
    const bundle = buildHandoffBundle(world.checkout, {
      defaultTip: "0123456789abcdef0123456789abcdef01234567",
    });
    const first = await post(api, "alice", bundle.bytes);
    expect(first.status).toBe(422);
    expect(await first.json()).toMatchObject({
      reason: "base-unknown",
      message: expect.stringMatching(/origin was not fetched · no credential in this test/),
    });
    expect(seen.freshens).toEqual(["main"]);
    const second = await post(api, "alice", bundle.bytes);
    expect(await second.json()).toMatchObject({
      reason: "base-unknown",
      message: expect.stringMatching(
        /origin was not fetched · budget reached · 1 fetches of origin per minute for one account/,
      ),
    });
    expect(seen.freshens).toEqual(["main"]);
  });

  it("refuses a file over the budget by name, as the file budget, and admits nothing", async () => {
    const seen = freshSeen();
    api = await worldWith({ handoffFileBytes: 64 * 1024 }, seen);
    fs.mkdirSync(path.join(world.checkout, "assets"));
    fs.writeFileSync(path.join(world.checkout, "assets", "demo.bin"), Buffer.alloc(100 * 1024, 7));
    const bundle = buildHandoffBundle(world.checkout);
    fs.rmSync(path.join(world.checkout, "assets"), { recursive: true, force: true });
    const response = await post(api, "alice", bundle.bytes);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      _tag: "BudgetExceeded",
      budget: "handoffFileBytes",
      limit: 64 * 1024,
      message: expect.stringMatching(
        /^assets\/demo.bin is 102400 bytes, over the budget reached · 65536 bytes in one handed-off file .* nothing was created$/,
      ),
    });
    expect(seen.provisions).toEqual([]);
  });

  it("refuses bytes that are not a handoff with not-a-handoff, and admits nothing", async () => {
    const seen = freshSeen();
    api = await worldWith({}, seen);
    const response = await post(api, "alice", new TextEncoder().encode("not a bundle"));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      _tag: "HandoffRefused",
      reason: "not-a-handoff",
      message: expect.stringMatching(/nothing was created$/),
    });
    expect(seen.provisions).toEqual([]);
  });
});
