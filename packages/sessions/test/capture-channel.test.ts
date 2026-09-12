import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import {
  CaptureStoreRepo,
  SessionChannelTokensRepo,
  SessionChannelTokensRepoMemory,
} from "@mend/db";
import { ProjectId, SessionId, WorktreeId } from "@mend/domain";
import {
  BlobStore,
  BlobStoreFsLive,
  captureKeys,
  changeSummaryKey,
  DeploymentConfig,
  type CaptureManifest,
} from "@mend/store";
import { buildManifest, snapshotDirectory, uploadObjects } from "@mend/store/testing";
import { Duration, Effect, Exit, Layer, Scope } from "effect";
import type * as Context from "effect/Context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CaptureChannel,
  CaptureChannelLive,
  CaptureUploadPolicy,
  PRESIGN_TTL_SECONDS,
} from "../src/capture-channel.ts";
import {
  SessionChannelNetworkHost,
  SessionChannelNetworkHostLive,
  SessionChannelRegistry,
  SessionChannelRegistryLive,
} from "../src/session-channel.ts";
import type { SessionSocketApi } from "../src/session-socket.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";

/**
 * The five capture routes (ADR-0002 "Session channel routes") over the network listener, with
 * the bearer token alone — sealantd's registrar never sends a session id header. Every 409
 * path is exercised against the in-memory pointer store, which mirrors the SQL's predicates.
 */

const WORKTREE = WorktreeId.make("wt-cap-1");
const PROJECT = ProjectId.make("proj-cap");
const SESSION = SessionId.make("sess-cap-1");

const inertApi: Omit<SessionSocketApi, "capture"> = {
  recipes: () => Effect.succeed([]),
  listServices: () => Effect.succeed([]),
  runServiceRecipe: () => Effect.succeed({}),
  runService: () => Effect.succeed({}),
  addService: () => Effect.succeed({}),
  stopService: () => Effect.succeed({}),
  restartService: () => Effect.succeed({}),
  stopSession: () => Effect.succeed({}),
  gitTransport: () => Effect.die("not in test"),
  gitTransportDone: () => Effect.void,
};

const post = (
  address: string,
  route: string,
  token: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> =>
  new Promise((resolve, reject) => {
    const [host, port] = address.split(":");
    const request = http.request(
      {
        host,
        port: Number(port),
        method: "POST",
        path: route,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        agent: false,
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => (text += String(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            json: text === "" ? {} : JSON.parse(text),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });

describe("capture channel routes", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-capture-channel-"));
  const blobRoot = path.join(scratch, "blobs");
  const memory = makeMemoryCaptureStore();
  const blobs = BlobStoreFsLive(blobRoot);
  const registry = SessionChannelRegistryLive;
  const tokens = SessionChannelTokensRepoMemory;
  const deployment = Layer.succeed(DeploymentConfig, {
    mode: "local",
    sessionEndpoint: { listen: "127.0.0.1:0", url: "http://127.0.0.1:0" },
    sessionStore: "captured",
  });
  const layer = Layer.mergeAll(
    SessionChannelNetworkHostLive.pipe(
      Layer.provide(deployment),
      Layer.provide(registry),
      Layer.provide(tokens),
    ),
    CaptureChannelLive.pipe(
      Layer.provide(memory.layer),
      Layer.provide(blobs),
      // Small numbers so a multipart plan is exercised with bytes a test can afford.
      Layer.provide(
        Layer.succeed(CaptureUploadPolicy, { multipartThresholdBytes: 64, partSizeBytes: 32 }),
      ),
    ),
    registry,
    tokens,
    blobs,
    memory.layer,
  );
  let address = "";
  let token = "";
  let cap0 = { id: "", key: "", manifest: {} as CaptureManifest };
  const keys1 = captureKeys(WORKTREE, 1);
  let channel: CaptureChannel["Service"];
  type Services =
    | SessionChannelNetworkHost
    | SessionChannelRegistry
    | SessionChannelTokensRepo
    | BlobStore
    | CaptureStoreRepo
    | CaptureChannel;
  // One scope for the whole file: the listener must outlive every `run`.
  const scope = Scope.makeUnsafe();
  let context: Context.Context<Services>;
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
    Effect.runPromise(effect.pipe(Effect.provide(context)));

  beforeAll(async () => {
    context = await Effect.runPromise(
      Layer.build(layer).pipe(Effect.provideService(Scope.Scope, scope)),
    );
    // Capture 0 as `createWorktree` writes it: an empty workspace class plus the base's git
    // section, registered under a Mend-held epoch that is released at once.
    const tree = path.join(scratch, "tree");
    fs.mkdirSync(path.join(tree, "harness", ".claude", "projects", "p"), { recursive: true });
    fs.writeFileSync(path.join(tree, "harness", ".claude", "projects", "p", "s.jsonl"), "{}\n");
    const snapshot = snapshotDirectory(tree, keys1, { chunkSize: 64 });
    const built = buildManifest({
      worktreeId: WORKTREE,
      n: 0,
      parent: null,
      epoch: 1,
      kind: "checkpoint",
      workspace: { root: snapshot.root, packs: snapshot.packs },
    });
    cap0 = { id: built.id, key: built.key, manifest: built.manifest };
    await run(
      Effect.gen(function* () {
        yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]]));
        const repo = yield* CaptureStoreRepo;
        yield* repo.init(WORKTREE);
        const claimed = yield* repo.claim(WORKTREE, "mend");
        yield* repo.register({
          worktreeId: WORKTREE,
          id: built.id,
          n: 0,
          parent: null,
          epoch: claimed.epoch,
          seq: 0n,
          kind: "checkpoint",
          manifestKey: built.key,
          sections: built.manifest.sections,
          gitFsck: "unverified",
        });
        yield* repo.release(WORKTREE, claimed.epoch);
      }),
    );
  });
  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("listens, registers a capture-scoped api, and refuses a bad token uniformly", async () => {
    await run(
      Effect.gen(function* () {
        const host = yield* SessionChannelNetworkHost;
        address = host.address ?? "";
        const registryService = yield* SessionChannelRegistry;
        const tokensRepo = yield* SessionChannelTokensRepo;
        channel = yield* CaptureChannel;
        token = yield* tokensRepo.issue(SESSION);
        registryService.register(SESSION, {
          ...inertApi,
          capture: channel.apiFor({
            worktreeId: WORKTREE,
            projectId: PROJECT,
            executorId: SESSION,
            footprintBytes: 0,
          }),
        });
        const bogus = yield* Effect.promise(() =>
          post(address, "/lease.heartbeat", "not-the-token-at-all", { worktree_id: WORKTREE }),
        );
        expect(bogus.status).toBe(401);
        // A colocated session (no capture api) answers 404 on the same routes.
        const other = SessionId.make("sess-colocated");
        const otherToken = yield* tokensRepo.issue(other);
        registryService.register(other, { ...inertApi });
        const missing = yield* Effect.promise(() =>
          post(address, "/plan.get", otherToken, { epoch: 0 }),
        );
        expect(missing.status).toBe(404);
      }),
    );
  });

  it("plan.get claims the lease on a booting executor and presigns every key the head needs", async () => {
    const first = await post(address, "/plan.get", token, { worktree_id: null, epoch: 0 });
    expect(first.status).toBe(200);
    expect(first.json["epoch"]).toBe(2);
    expect(first.json["worktree_id"]).toBe(WORKTREE);
    const head = first.json["head"] as Record<string, unknown>;
    expect(head["n"]).toBe(0);
    expect(head["capture_id"]).toBe(cap0.id);
    const urls = first.json["get_urls"] as Record<string, string>;
    for (const pack of cap0.manifest.sections.workspace.packs) {
      expect(urls[pack]).toMatch(/^file:\/\//);
    }
    expect(urls[cap0.manifest.sections.workspace.root]).toMatch(/^file:\/\//);
    expect(urls[cap0.key]).toMatch(/^file:\/\//);
    // The same executor re-planning under its epoch is fine; a stale epoch is fenced.
    const again = await post(address, "/plan.get", token, { epoch: 2 });
    expect(again.status).toBe(200);
    expect(again.json["epoch"]).toBe(2);
    const stale = await post(address, "/plan.get", token, { epoch: 1 });
    expect(stale.status).toBe(409);
    expect(stale.json["reason"]).toBe("stale-epoch");
    expect(stale.json["live_epoch"]).toBe(2);
    const wrong = await post(address, "/plan.get", token, { worktree_id: "wt-other", epoch: 2 });
    expect(wrong.status).toBe(409);
    expect(wrong.json["reason"]).toBe("wrong-worktree");
  });

  it("upload.urls mints only under the caller's epoch prefix, only while the lease predicate holds", async () => {
    const keys2 = captureKeys(WORKTREE, 2);
    const own = keys2.pack("a".repeat(64));
    const minted = await post(address, "/upload.urls", token, {
      worktree_id: WORKTREE,
      epoch: 2,
      keys: [own, keys1.pack("b".repeat(64)), "projects/p/x", "../escape"],
    });
    expect(minted.status).toBe(200);
    const urls = minted.json["urls"] as Record<string, string>;
    expect(Object.keys(urls)).toEqual([own]);
    expect(urls[own]).toMatch(/^file:\/\//);
    const stale = await post(address, "/upload.urls", token, {
      worktree_id: WORKTREE,
      epoch: 1,
      keys: [own],
    });
    expect(stale.status).toBe(409);
    expect(stale.json["reason"]).toBe("stale-epoch");
    // Expire the lease without waiting: the predicate `expires_at > now()` fails → 409.
    const realNow = memory.clock.now;
    memory.clock.now = () => realNow() + 60_000;
    const lost = await post(address, "/upload.urls", token, {
      worktree_id: WORKTREE,
      epoch: 2,
      keys: [own],
    });
    expect(lost.status).toBe(409);
    expect(lost.json["reason"]).toBe("lease-lost");
    memory.clock.now = realNow;
    // A heartbeat under the same epoch heals an expired lease (a Mend outage costs nothing).
    const healed = await post(address, "/lease.heartbeat", token, {
      worktree_id: WORKTREE,
      epoch: 2,
    });
    expect(healed.status).toBe(200);
    expect(healed.json["expires_in_secs"]).toBe(30);
  });

  it("upload.urls plans a multipart upload for a sized key at the threshold; upload.complete assembles it write-once", async () => {
    const keys2 = captureKeys(WORKTREE, 2);
    const big = keys2.pack("c".repeat(64));
    const small = keys2.pack("d".repeat(64));
    const unsized = keys2.pack("e".repeat(64));
    // Policy in this file: threshold 64 bytes, parts of 32. 70 bytes = 3 parts; 10 = one PUT;
    // a key without a size stays a single PUT whatever its bytes turn out to be; a size for a
    // key that is not listed (or not under the prefix) mints nothing.
    const minted = await post(address, "/upload.urls", token, {
      worktree_id: WORKTREE,
      epoch: 2,
      keys: [big, small, unsized, "../x"],
      sizes: { [big]: 70, [small]: 10, "../x": 99, [keys2.pack("0".repeat(64))]: 999 },
    });
    expect(minted.status).toBe(200);
    const urls = minted.json["urls"] as Record<string, string>;
    expect(Object.keys(urls).toSorted()).toEqual([small, unsized].toSorted());
    const multipart = minted.json["multipart"] as Record<
      string,
      { upload_id: string; part_size: number; part_urls: Array<string> }
    >;
    expect(Object.keys(multipart)).toEqual([big]);
    const plan = multipart[big];
    if (plan === undefined) throw new Error("no plan");
    expect(plan.part_size).toBe(32);
    expect(plan.part_urls).toHaveLength(3);
    for (const url of plan.part_urls) expect(url).toMatch(/^file:\/\//);
    const body = Buffer.alloc(70);
    for (let index = 0; index < body.length; index += 1) body[index] = index;
    const parts = plan.part_urls.map((url, index) => {
      const slice = body.subarray(index * 32, Math.min(70, (index + 1) * 32));
      fs.writeFileSync(url.slice("file://".length), slice);
      return { part_number: index + 1, etag: `"part-${index + 1}"` };
    });
    // The complete obeys the same predicates as every other route.
    const stale = await post(address, "/upload.complete", token, {
      worktree_id: WORKTREE,
      epoch: 1,
      key: big,
      upload_id: plan.upload_id,
      parts,
    });
    expect(stale.status).toBe(409);
    expect(stale.json["reason"]).toBe("stale-epoch");
    const outside = await post(address, "/upload.complete", token, {
      worktree_id: WORKTREE,
      epoch: 2,
      key: keys1.pack("c".repeat(64)),
      upload_id: plan.upload_id,
      parts,
    });
    expect(outside.status).toBe(400);
    const malformed = await post(address, "/upload.complete", token, {
      worktree_id: WORKTREE,
      epoch: 2,
      key: big,
      upload_id: plan.upload_id,
      parts: [parts[0], parts[0]],
    });
    expect(malformed.status).toBe(400);
    const done = await post(address, "/upload.complete", token, {
      worktree_id: WORKTREE,
      epoch: 2,
      key: big,
      upload_id: plan.upload_id,
      parts: [parts[2], parts[0], parts[1]],
    });
    expect(done.status).toBe(200);
    expect(done.json).toEqual({ size: 70 });
    expect(Buffer.from(fs.readFileSync(path.join(blobRoot, big))).equals(body)).toBe(true);
    // The upload is consumed; a sized key the bucket already holds gets a plain PUT URL and no
    // plan (the wire's `multipart` carries plans only).
    expect(fs.readdirSync(path.join(blobRoot, ".multipart"))).toEqual([]);
    const again = await post(address, "/upload.urls", token, {
      worktree_id: WORKTREE,
      epoch: 2,
      keys: [big],
      sizes: { [big]: 70 },
    });
    expect(again.status).toBe(200);
    expect(again.json["multipart"]).toEqual({});
    expect(Object.keys(again.json["urls"] as Record<string, string>)).toEqual([big]);
    // Two uploads opened for one key before either completes: the second complete is refused
    // with 409 `exists` — the write-once complete, decided by the store.
    const raced = keys2.pack("f".repeat(64));
    const openA = await post(address, "/upload.urls", token, {
      worktree_id: WORKTREE,
      epoch: 2,
      keys: [raced],
      sizes: { [raced]: 64 },
    });
    const openB = await post(address, "/upload.urls", token, {
      worktree_id: WORKTREE,
      epoch: 2,
      keys: [raced],
      sizes: { [raced]: 64 },
    });
    const planA = (openA.json["multipart"] as Record<string, typeof plan>)[raced];
    const planB = (openB.json["multipart"] as Record<string, typeof plan>)[raced];
    if (planA === undefined || planB === undefined) throw new Error("no plans");
    expect(planA.upload_id).not.toBe(planB.upload_id);
    for (const candidate of [planA, planB]) {
      candidate.part_urls.forEach((url, index) => {
        fs.writeFileSync(url.slice("file://".length), Buffer.alloc(32, index + 1));
      });
    }
    const two = [
      { part_number: 1, etag: '"p1"' },
      { part_number: 2, etag: '"p2"' },
    ];
    const winner = await post(address, "/upload.complete", token, {
      worktree_id: WORKTREE,
      epoch: 2,
      key: raced,
      upload_id: planA.upload_id,
      parts: two,
    });
    expect(winner.status).toBe(200);
    const loser = await post(address, "/upload.complete", token, {
      worktree_id: WORKTREE,
      epoch: 2,
      key: raced,
      upload_id: planB.upload_id,
      parts: two,
    });
    expect(loser.status).toBe(409);
    expect(loser.json["reason"]).toBe("exists");
    expect(loser.json["key"]).toBe(raced);
    expect(fs.readdirSync(path.join(blobRoot, ".multipart"))).toEqual([]);
    // An upload the store does not know: 500, which the executor retries with fresh URLs.
    const unknown = await post(address, "/upload.complete", token, {
      worktree_id: WORKTREE,
      epoch: 2,
      key: raced,
      upload_id: "never-minted",
      parts: two,
    });
    expect(unknown.status).toBe(500);
    // Part URLs count against the hourly URL quota exactly like PUT URLs.
    const tooMany = await post(address, "/upload.urls", token, {
      worktree_id: WORKTREE,
      epoch: 2,
      keys: [keys2.pack("9".repeat(64))],
      sizes: { [keys2.pack("9".repeat(64))]: 32 * 2_000 },
    });
    expect(tooMany.status).toBe(429);
    expect(tooMany.json["reason"]).toBe("quota-exceeded");
    expect(PRESIGN_TTL_SECONDS).toBe(15 * 60);
  });

  it("capture.register is the CAS: 409 on a stale epoch or wrong parent, 422 on missing bytes, 200 on a lost ack", async () => {
    const keys2 = captureKeys(WORKTREE, 2);
    const tree = path.join(scratch, "tree2");
    fs.mkdirSync(path.join(tree, "tree"), { recursive: true });
    fs.writeFileSync(path.join(tree, "tree", "note.txt"), "edited\n");
    const snapshot = snapshotDirectory(tree, keys2, { chunkSize: 64 });
    const cap1 = buildManifest({
      worktreeId: WORKTREE,
      n: 1,
      parent: cap0.id,
      epoch: 2,
      seq: 7,
      kind: "turn",
      workspace: { root: snapshot.root, packs: snapshot.packs },
    });
    const request = {
      worktree_id: WORKTREE,
      epoch: 2,
      n: 1,
      parent: cap0.id,
      capture_id: cap1.id,
      manifest_key: cap1.key,
      manifest: cap1.manifest,
    };
    // Nothing uploaded yet: the manifest itself is missing.
    const early = await post(address, "/capture.register", token, request);
    expect(early.status).toBe(422);
    expect(early.json["reason"]).toBe("missing-objects");
    await run(uploadObjects(new Map([[cap1.key, cap1.bytes]])));
    const packless = await post(address, "/capture.register", token, request);
    expect(packless.status).toBe(422);
    expect(packless.json["missing"]).toEqual(snapshot.packs);
    await run(uploadObjects(snapshot.objects));
    // The waiter learns about the register through the channel's hub.
    const waiting = run(
      Effect.gen(function* () {
        const hub = yield* CaptureChannel;
        return yield* hub.awaitRegister(WORKTREE, (row) => row.n === 1, Duration.seconds(5));
      }),
    );
    const landed = await post(address, "/capture.register", token, request);
    expect(landed.status).toBe(200);
    expect(landed.json["head_n"]).toBe(1);
    expect(landed.json["head_capture_id"]).toBe(cap1.id);
    const woken = await waiting;
    expect(woken?.id).toBe(cap1.id);
    expect(woken?.kind).toBe("turn");
    expect(memory.packs.size).toBe(snapshot.packs.length);
    // Lost ack: the chain already stands at n=1 with this id.
    const retry = await post(address, "/capture.register", token, request);
    expect(retry.status).toBe(200);
    // A different capture at n=1 collides with the head.
    const rival = buildManifest({ worktreeId: WORKTREE, n: 1, parent: cap0.id, epoch: 2, seq: 8 });
    await run(uploadObjects(new Map([[rival.key, rival.bytes]])));
    const collided = await post(address, "/capture.register", token, {
      ...request,
      capture_id: rival.id,
      manifest_key: rival.key,
      manifest: rival.manifest,
    });
    expect(collided.status).toBe(409);
    expect(collided.json["reason"]).toBe("wrong-parent");
    expect(collided.json["head_n"]).toBe(1);
    expect(collided.json["head_capture_id"]).toBe(cap1.id);
    // A stale epoch never advances the chain, whatever the parent says.
    const cap2Stale = buildManifest({ worktreeId: WORKTREE, n: 2, parent: cap1.id, epoch: 1 });
    await run(uploadObjects(new Map([[cap2Stale.key, cap2Stale.bytes]])));
    const stale = await post(address, "/capture.register", token, {
      worktree_id: WORKTREE,
      epoch: 1,
      n: 2,
      parent: cap1.id,
      capture_id: cap2Stale.id,
      manifest_key: cap2Stale.key,
      manifest: cap2Stale.manifest,
    });
    expect(stale.status).toBe(409);
    expect(stale.json["reason"]).toBe("stale-epoch");
    expect(stale.json["live_epoch"]).toBe(2);
    // The id must be the digest of the bytes at manifest_key.
    const cap2 = buildManifest({ worktreeId: WORKTREE, n: 2, parent: cap1.id, epoch: 2 });
    await run(uploadObjects(new Map([[cap2.key, cap2.bytes]])));
    const forged = await post(address, "/capture.register", token, {
      worktree_id: WORKTREE,
      epoch: 2,
      n: 2,
      parent: cap1.id,
      capture_id: "f".repeat(64),
      manifest_key: cap2.key,
      manifest: cap2.manifest,
    });
    expect(forged.status).toBe(422);
    expect(forged.json["reason"]).toBe("capture-id-mismatch");
    // Timeout path: nothing registers → null, not a hang.
    const nobody = await run(
      Effect.gen(function* () {
        const hub = yield* CaptureChannel;
        return yield* hub.awaitRegister(WORKTREE, (row) => row.n === 99, Duration.millis(50));
      }),
    );
    expect(nobody).toBeNull();
  });

  it("change.summary lands in the bucket for the head only; heartbeat 409s once the lease is gone", async () => {
    const headId = memory.chains.get(WORKTREE)?.headCapture ?? "";
    const summary = {
      base_sha: "a".repeat(40),
      files: [{ path: "note.txt", additions: 1, deletions: 0 }],
      diff: "+edited",
    };
    const notHead = await post(address, "/change.summary", token, {
      worktree_id: WORKTREE,
      epoch: 2,
      capture_id: cap0.id,
      summary,
    });
    expect(notHead.status).toBe(409);
    expect(notHead.json["reason"]).toBe("not-head");
    const malformed = await post(address, "/change.summary", token, {
      worktree_id: WORKTREE,
      epoch: 2,
      capture_id: headId,
      summary: { nope: true },
    });
    expect(malformed.status).toBe(400);
    const accepted = await post(address, "/change.summary", token, {
      worktree_id: WORKTREE,
      epoch: 2,
      capture_id: headId,
      summary,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.json["key"]).toBe(changeSummaryKey(WORKTREE, 1));
    const stored = JSON.parse(
      fs.readFileSync(path.join(blobRoot, changeSummaryKey(WORKTREE, 1)), "utf8"),
    );
    expect(stored.files[0].path).toBe("note.txt");
    expect(memory.summaries.get(headId)?.state).toBe("claimed");
    const stale = await post(address, "/lease.heartbeat", token, {
      worktree_id: WORKTREE,
      epoch: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.json["reason"]).toBe("stale-epoch");
    // The final capture releases the lease: the next heartbeat finds nothing to renew? No —
    // release moves expires_at to now under the same epoch, and a heartbeat under that epoch
    // still matches the row (the executor that released is the one that knows it ended). What
    // is refused is a heartbeat after ANOTHER claim bumped the epoch.
    await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        yield* repo.release(WORKTREE, 2);
        yield* repo.claim(WORKTREE, "replacement");
      }),
    );
    const fenced = await post(address, "/lease.heartbeat", token, {
      worktree_id: WORKTREE,
      epoch: 2,
    });
    expect(fenced.status).toBe(409);
    expect(fenced.json["reason"]).toBe("stale-epoch");
    expect(fenced.json["live_epoch"]).toBe(3);
    // The lease row gone for good (a released worktree whose next claimer never came): 404,
    // which sealantd's registrar reads as "lease lost".
    memory.leases.delete(WORKTREE);
    const lost = await post(address, "/lease.heartbeat", token, {
      worktree_id: WORKTREE,
      epoch: 3,
    });
    expect(lost.status).toBe(404);
    expect(lost.json["reason"]).toBe("lease-lost");
    // And a booting second executor for a leased worktree is refused outright.
    const second = await post(address, "/plan.get", token, { epoch: 0 });
    expect(second.status).toBe(409);
    expect(second.json["reason"]).toBe("worktree-leased");
  });
});
