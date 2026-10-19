import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GIT_BUNDLE_CONTENT_TYPE } from "@mend/api-contracts";
import { ProjectId, SessionId, WorktreeId } from "@mend/domain";
import {
  HandoffCutAt,
  HandoffMachine,
  HexSha,
  Session,
  Worktree,
  type WorktreeHandoff,
} from "@mend/domain/workbench";
import type { SessionEngine } from "@mend/sessions";
import { skippedFreshen, Store, StoreConfig } from "@mend/store";
import { buildHandoffBundle, makeHandoffWorld, sh } from "@mend/store/testing/handoff";
import { Effect, Layer } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids, makeSession } from "../../test/support/tenancy-harness.ts";

const sharedA = ids("shared-a");
const NOW = new Date("2026-10-18T07:42:05Z");
const BUNDLE = { "content-type": GIT_BUNDLE_CONTENT_TYPE };

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

const worldWith = async (limits: Parameters<typeof createTenancyApi>[0] = {}, seen: Seen) => {
  let count = 0;
  const provision: SessionEngine["Service"]["provision"] = (input) =>
    Effect.sync(() => {
      count += 1;
      const worktreeId = WorktreeId.make(`worktree-handoff-${count}`);
      const sessionId = SessionId.make(`session-handoff-${count}`);
      seen.provisions.push({
        name: input.name,
        kind: input.start.kind,
        harness: input.harness,
        owner: input.ownerUserId,
      });
      const handoff: WorktreeHandoff | null =
        input.start.kind === "handoff"
          ? {
              machine: input.start.admitted.trailers.machine,
              localBranch: input.start.admitted.trailers.localBranch,
              cutAt: input.start.admitted.trailers.cutAt,
              head: HexSha.make(input.start.admitted.head),
              index: HexSha.make(input.start.admitted.index),
              checkpoint: HexSha.make(input.start.admitted.checkpoint),
              mergeBase: HexSha.make(input.start.admitted.mergeBase),
              deltaPack: "projects/project-shared-a/packs/delta",
            }
          : null;
      api?.world.addWorktree(
        new Worktree({
          id: worktreeId,
          projectId: ProjectId.make(input.projectId),
          name: input.name ?? worktreeId,
          directory: input.name ?? worktreeId,
          branch: `mend/${input.name ?? worktreeId}`,
          baseSha:
            input.start.kind === "handoff"
              ? input.start.admitted.mergeBase
              : HexSha.make("0".repeat(40)),
          baseRef: "main",
          handoff,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      return unlaunched(sessionId, worktreeId, input.ownerUserId ?? "nobody");
    });
  return createTenancyApi(limits, {
    implement: {
      store: {
        freshenBase: () => Effect.succeed(skippedFreshen("no credential in this test")),
        admitHandoff: (_storePath, defaultBranch, bytes, options) =>
          realStore.admitHandoff(world.storePath, defaultBranch, bytes, options),
      },
      engine: {
        launchUnderWay: () => false,
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
        resumeSession: (sessionId, harness) =>
          Effect.sync(() => {
            seen.holds.push(`${sessionId}:${harness}`);
            const current = api?.world.sessions.get(sessionId);
            return new Session({
              ...(current ?? unlaunched(sessionId, sharedA.worktree, "alice")),
              id: sessionId,
              status: "idle",
            });
          }),
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

const freshSeen = (): Seen => ({ provisions: [], sessionsIn: [], holds: [], audits: [] });

const post = (
  on: TenancyApi,
  user: "alice" | "bob" | "carol",
  bytes: Uint8Array,
  query = "harness=claude&hold=true",
) =>
  on.postBytes(
    user,
    `/api/projects/${sharedA.project}/handoffs?${query}`,
    bytes,
    BUNDLE["content-type"],
  );

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

  it("provisions from the admitted snapshot under the branch's name, holds the session, audits it; a second handoff of the branch is -2", async () => {
    const seen = freshSeen();
    api = await worldWith({}, seen);
    const bundle = buildHandoffBundle(world.checkout, { machine: "dana-mbp" });
    const response = await post(api, "alice", bundle.bytes);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      replayed: false,
      commitsAhead: 2,
      session: { id: "session-handoff-1", status: "idle" },
      worktree: {
        name: "fix-login",
        baseSha: bundle.mergeBase,
        baseRef: "main",
        handoff: { machine: "dana-mbp", localBranch: "fix/login", checkpoint: bundle.checkpoint },
      },
    });
    expect(seen.provisions).toEqual([
      { name: "fix-login", kind: "handoff", harness: "claude", owner: "alice" },
    ]);
    expect(seen.holds).toEqual(["session-handoff-1:shell"]);
    expect(seen.audits).toEqual(["worktree.handed_off:worktree"]);

    sh(world.checkout, ["commit", "-q", "-am", "more"]);
    const later = buildHandoffBundle(world.checkout, { cutAt: "2026-10-18T09:00:00.000Z" });
    const second = await post(api, "alice", later.bytes, "harness=codex&hold=false");
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      replayed: false,
      worktree: { name: "fix-login-2" },
    });
    expect(seen.provisions.at(-1)).toEqual({
      name: "fix-login-2",
      kind: "handoff",
      harness: "codex",
      owner: "alice",
    });
    expect(seen.holds).toEqual(["session-handoff-1:shell"]);
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
    api.world.addWorktree(
      new Worktree({
        id: WorktreeId.make("worktree-earlier"),
        projectId: sharedA.project,
        name: "fix-login",
        directory: "fix-login",
        branch: "mend/fix-login",
        baseSha: HexSha.make(bundle.mergeBase),
        baseRef: "main",
        handoff: {
          machine: HandoffMachine.make("dana-mbp"),
          localBranch: null,
          cutAt: HandoffCutAt.make("2026-10-18T07:42:05.000Z"),
          head: HexSha.make(bundle.head),
          index: HexSha.make(bundle.index),
          checkpoint: HexSha.make(bundle.checkpoint),
          mergeBase: HexSha.make(bundle.mergeBase),
          deltaPack: "projects/project-shared-a/packs/delta",
        },
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    const replayed = await post(api, "alice", bundle.bytes);
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({
      replayed: true,
      commitsAhead: Number(
        sh(world.checkout, ["rev-list", "--count", `${bundle.mergeBase}..${bundle.head}`]),
      ),
      worktree: { id: "worktree-earlier" },
      session: { status: "idle" },
    });
    expect(seen.provisions).toEqual([]);
    expect(seen.sessionsIn).toEqual(["worktree-earlier"]);
    expect(seen.holds).toEqual(["session-again-worktree-earlier:shell"]);
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
