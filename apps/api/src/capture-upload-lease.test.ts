import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { PgClient } from "@effect/sql-pg";
import { CaptureStoreRepo, CaptureStoreRepoLive, MendDBLive, migrations } from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { ProjectId, WorktreeId } from "@mend/domain";
import {
  CaptureChannel,
  CaptureChannelLive,
  CaptureGitVerifier,
  CaptureGitVerifierOff,
  CaptureRemotesOff,
  CaptureSourcesOff,
  CaptureUploadPolicy,
  CaptureUploadPolicyDefault,
  MANIFEST_FEATURES,
  UPLOAD_ANSWER_PRESENT,
  UPLOAD_ANSWER_SHA256,
} from "@mend/sessions";
import { BlobStore, BlobStoreError, BlobStoreFsLive, captureKeys, sha256Hex } from "@mend/store";
import { buildManifest, uploadObjects } from "@mend/store/testing";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Redacted,
  Schema,
  String as Str,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const postgres = postgresTestConfig();
const database = `mend_upload_lease_${process.pid}_${Date.now()}`;
const scratchUrl = new URL(postgres.adminUrl);
scratchUrl.pathname = `/${database}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-upload-lease-"));
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const pg = PgClient.layer({
  url: Redacted.make(scratchUrl.toString()),
  maxConnections: 5,
  applicationName: database,
  transformResultNames: Str.snakeToCamel,
});
const databaseLayer = MendDBLive.pipe(Layer.provideMerge(pg));
let failCommit = false;
let gateLeaseCommit = false;
let gateRegisterCommit = false;
let gateRegisterVerify = false;
const actualRepoLayer = CaptureStoreRepoLive.pipe(Layer.provideMerge(databaseLayer));
const repoLayer = Layer.effect(
  CaptureStoreRepo,
  Effect.gen(function* () {
    const actual = yield* CaptureStoreRepo;
    const sql = yield* SqlClient.SqlClient;
    const withCurrentLease: CaptureStoreRepo["Service"]["withCurrentLease"] = (
      worktreeId,
      epoch,
      holder,
      prepare,
    ) =>
      Effect.suspend(() => {
        if (gateLeaseCommit) {
          gateLeaseCommit = false;
          return sql
            .withTransaction(
              actual.withCurrentLease(worktreeId, epoch, holder, prepare).pipe(
                Effect.tap(() => Deferred.succeed(entered, undefined)),
                Effect.tap(() => Deferred.await(resume)),
              ),
            )
            .pipe(Effect.orDie);
        }
        return failCommit
          ? // This helper joins the real outer transaction. The callback prepares facts, then a
            // test-only deferred constraint fails the actual PostgreSQL COMMIT.
            sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql`INSERT INTO upload_commit_fault (id) VALUES (1)`;
                  return yield* actual.withCurrentLease(worktreeId, epoch, holder, prepare);
                }),
              )
              .pipe(Effect.orDie)
          : actual.withCurrentLease(worktreeId, epoch, holder, prepare);
      });
    return CaptureStoreRepo.of({
      ...actual,
      withCurrentLease,
      register: (input) =>
        Effect.suspend(() => {
          if (!gateRegisterCommit) return actual.register(input);
          gateRegisterCommit = false;
          return Deferred.succeed(registerEntered, undefined).pipe(
            Effect.andThen(Deferred.await(registerResume)),
            Effect.andThen(actual.register(input)),
          );
        }),
    });
  }),
).pipe(Layer.provideMerge(actualRepoLayer));
type GateAt = "head" | "presign" | "part" | "create";
let abortFails = false;
let gateAt: GateAt | null = null;
let gateAllAt: GateAt | null = null;
let gateCount = 0;
let entered = Effect.runSync(Deferred.make<void>());
let resume = Effect.runSync(Deferred.make<void>());
let registerEntered = Effect.runSync(Deferred.make<void>());
let registerResume = Effect.runSync(Deferred.make<void>());
const signed: Array<{ readonly key: string; readonly digest: string | undefined }> = [];
const aborted: string[] = [];
const pause = (at: GateAt) =>
  Effect.suspend(() => {
    if (gateAllAt === at) {
      gateCount += 1;
      return (gateCount === 2 ? Deferred.succeed(entered, undefined) : Effect.void).pipe(
        Effect.andThen(Deferred.await(resume)),
      );
    }
    if (gateAt !== at) return Effect.void;
    gateAt = null;
    return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)));
  });
const blobs = Layer.effect(
  BlobStore,
  Effect.gen(function* () {
    const actual = yield* BlobStore;
    return BlobStore.of({
      ...actual,
      // The audited checksum-negotiated provider behavior, with a real disposable filesystem bucket.
      bindsBytes: Effect.succeed(true),
      head: (key) => pause("head").pipe(Effect.andThen(actual.head(key))),
      presign: (key, method, ttl, size, digest) =>
        actual.presign(key, method, ttl, size, digest).pipe(
          Effect.tap(() => Effect.sync(() => void signed.push({ key, digest }))),
          Effect.tap(() => pause("presign")),
        ),
      presignPart: (key, upload, part, ttl, size) =>
        actual.presignPart(key, upload, part, ttl, size).pipe(Effect.tap(() => pause("part"))),
      createMultipart: (key) => actual.createMultipart(key).pipe(Effect.tap(() => pause("create"))),
      abortMultipart: (key, upload) =>
        abortFails
          ? Effect.fail(
              new BlobStoreError({
                operation: "abortMultipart",
                key,
                cause: new Error("synthetic abort failure"),
              }),
            )
          : actual
              .abortMultipart(key, upload)
              .pipe(Effect.tap(() => Effect.sync(() => void aborted.push(upload)))),
    });
  }),
).pipe(Layer.provide(BlobStoreFsLive(root)));
const policy = Layer.effect(
  CaptureUploadPolicy,
  Effect.map(CaptureUploadPolicy, (defaults) => ({
    ...defaults,
    byteQuotaFloorBytes: 32,
    multipartThresholdBytes: 16,
    partSizeBytes: 16,
  })),
).pipe(Layer.provide(CaptureUploadPolicyDefault));
const verifier = Layer.effect(
  CaptureGitVerifier,
  Effect.map(CaptureGitVerifier, (actual) => ({
    ...actual,
    verify: (projectId, manifest) =>
      Effect.suspend(() => {
        if (!gateRegisterVerify) return actual.verify(projectId, manifest);
        gateRegisterVerify = false;
        return Deferred.succeed(registerEntered, undefined).pipe(
          Effect.andThen(Deferred.await(registerResume)),
          Effect.andThen(actual.verify(projectId, manifest)),
        );
      }),
  })),
).pipe(Layer.provide(CaptureGitVerifierOff));
const layer = CaptureChannelLive.pipe(
  Layer.provideMerge(repoLayer),
  Layer.provideMerge(blobs),
  Layer.provide(policy),
  Layer.provide(verifier),
  Layer.provide(CaptureRemotesOff),
  Layer.provide(CaptureSourcesOff),
);
const runtime = ManagedRuntime.make(layer);
const admin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer)));
let sequence = 0;
const setup = (bound = true) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* CaptureStoreRepo;
      sequence += 1;
      const worktreeId = WorktreeId.make(`wt-upload-${sequence}`);
      yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
    VALUES (${worktreeId},'p-upload',${worktreeId},${worktreeId},'mend/test',${"a".repeat(40)})`;
      yield* repo.init(worktreeId);
      const launchId = `launch-${sequence}`;
      const holder = { executorId: `executor-${sequence}`, launchId };
      const { epoch } = yield* repo.claim(worktreeId, holder.executorId, 3600, launchId);
      const api = (yield* CaptureChannel).apiFor({
        worktreeId,
        projectId: ProjectId.make("p-upload"),
        ...holder,
        footprintBytes: 0,
      });
      yield* api.planGet({
        epoch,
        manifest_format: 2,
        manifest_features: MANIFEST_FEATURES,
        upload_answers: bound
          ? [UPLOAD_ANSWER_PRESENT, UPLOAD_ANSWER_SHA256]
          : [UPLOAD_ANSWER_PRESENT],
      });
      const key = captureKeys(worktreeId, epoch).pack("a".repeat(64));
      return { worktreeId, epoch, holder, api, key };
    }),
  );
const storeAutoPack = async (
  at: Awaited<ReturnType<typeof setup>>,
  kind: "auto" | "turn" = "auto",
) => {
  // A valid empty Git pack is exactly 32 bytes. Git builds its real index; the capture is
  // kept unverified by the test verifier; real register identity, bytes and CAS checks run.
  const header = Buffer.from("5041434b0000000200000000", "hex");
  const pack = Buffer.concat([header, createHash("sha1").update(header).digest()]);
  expect(pack.length).toBe(32);
  const packPath = path.join(root, "register-overlap.pack");
  const indexPath = path.join(root, "register-overlap.idx");
  fs.writeFileSync(packPath, pack);
  execFileSync("git", ["index-pack", "--strict", "-o", indexPath, packPath]);
  const registeredKey = captureKeys(at.worktreeId, at.epoch).pack(sha256Hex(pack));
  const built = buildManifest({
    worktreeId: at.worktreeId,
    epoch: at.epoch,
    n: 0,
    parent: null,
    kind,
    git: { packs: [registeredKey], refs: {}, head: "refs/heads/main", fsck: "unverified" },
  });
  await runtime.runPromise(
    uploadObjects(
      new Map([
        [registeredKey, pack],
        [`${registeredKey}.idx`, fs.readFileSync(indexPath)],
        [built.key, built.bytes],
      ]),
    ),
  );
  return built;
};
const handoff = (at: Awaited<ReturnType<typeof setup>>) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const repo = yield* CaptureStoreRepo;
      expect(yield* repo.release(at.worktreeId, at.epoch)).toBe(true);
      return yield* repo.claim(at.worktreeId, "replacement", 3600, "replacement-launch");
    }),
  );
const opens = (worktreeId: WorktreeId) =>
  runtime.runPromise(
    Effect.flatMap(BlobStore, (bucket) => bucket.listMultipart(`captures/${worktreeId}/`)),
  );
const RouteError = Schema.Struct({ status: Schema.Number, reason: Schema.String });

describe.skipIf(postgres.skip)("upload publication with real PostgreSQL leases", () => {
  beforeAll(async () => {
    await admin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${database}`);
      }),
    );
    await runtime.runPromise(
      Effect.gen(function* () {
        for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        ))
          yield* migration;
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE TABLE upload_commit_fault (id int);
          CREATE FUNCTION reject_upload_commit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'synthetic deferred upload COMMIT failure'; END $$;
          CREATE CONSTRAINT TRIGGER upload_commit_failure AFTER INSERT ON upload_commit_fault
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_upload_commit()`);
        yield* sql`INSERT INTO organizations (id,name) VALUES ('org-upload','Upload fixture')`;
        yield* sql`INSERT INTO projects (id,name,organization_id,store_path,default_branch)
        VALUES ('p-upload','Upload fixture','org-upload','/synthetic-upload','main')`;
      }),
    );
  });
  afterAll(async () => {
    await runtime.dispose();
    await admin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      }),
    );
    fs.rmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    gateAt = null;
    gateAllAt = null;
    gateCount = 0;
    failCommit = false;
    gateLeaseCommit = false;
    gateRegisterCommit = false;
    gateRegisterVerify = false;
    abortFails = false;
    entered = Effect.runSync(Deferred.make<void>());
    resume = Effect.runSync(Deferred.make<void>());
    registerEntered = Effect.runSync(Deferred.make<void>());
    registerResume = Effect.runSync(Deferred.make<void>());
    signed.length = 0;
    aborted.length = 0;
  });

  for (const mode of [
    "pack-head",
    "pack-presign",
    "index-presign",
    "multipart-part",
    "mixed-presign",
  ]) {
    it(`refuses departed lease after ${mode} and releases only its request resources`, async () => {
      const at = await setup(mode !== "multipart-part");
      const index = `${at.key}.idx`;
      const keys =
        mode === "index-presign" ? [index] : mode === "mixed-presign" ? [at.key, index] : [at.key];
      const size = mode === "multipart-part" ? 32 : 12;
      gateAt = mode === "pack-head" ? "head" : mode === "multipart-part" ? "part" : "presign";
      const completion = runtime.runPromiseExit(
        at.api.uploadUrls({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          keys,
          sizes: Object.fromEntries(keys.map((key) => [key, size])),
          ...(mode === "index-presign" ? { sha256: { [index]: "b".repeat(64) } } : {}),
        }),
      );
      try {
        await Effect.runPromise(Deferred.await(entered));
        await handoff(at);
        Effect.runSync(Deferred.succeed(resume, undefined));
        const exit = await completion;
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.findErrorOption(exit.cause);
          expect(error._tag).toBe("Some");
          if (error._tag === "Some")
            expect(Schema.decodeUnknownSync(RouteError)(error.value)).toEqual({
              status: 409,
              reason: "lease-lost",
            });
        }
        expect(await opens(at.worktreeId)).toEqual([]);
        if (mode === "multipart-part") expect(aborted).toHaveLength(1);
        const authority = await runtime.runPromise(
          Effect.flatMap(CaptureStoreRepo, (repo) =>
            repo.putAuthorityUntil(at.worktreeId, at.epoch),
          ),
        );
        expect(authority === null).toBe(!["multipart-part", "mixed-presign"].includes(mode));
        if (mode === "index-presign") {
          const bindings = await runtime.runPromise(
            Effect.flatMap(CaptureStoreRepo, (repo) => repo.boundIndexesAmong([index], new Date())),
          );
          expect(bindings).toHaveLength(1);
          expect(bindings[0]?.sha256).toBe("b".repeat(64));
        }
        const next = await runtime.runPromise(
          Effect.gen(function* () {
            const repo = yield* CaptureStoreRepo;
            const lease = yield* repo.leaseOf(at.worktreeId);
            if (lease !== null) yield* repo.release(at.worktreeId, lease.epoch);
            return yield* repo.claim(at.worktreeId, at.holder.executorId, 3600, at.holder.launchId);
          }),
        );
        // Same launch, fresh epoch: refused bytes must not consume its full 32-byte allowance.
        const freshKey = captureKeys(at.worktreeId, next.epoch).pack("c".repeat(64));
        const answer = await runtime.runPromise(
          at.api.uploadUrls({
            worktree_id: at.worktreeId,
            epoch: next.epoch,
            keys: [freshKey],
            sizes: { [freshKey]: 32 },
          }),
        );
        expect(Object.keys(answer.urls).concat(Object.keys(answer.multipart))).toEqual([freshKey]);
      } finally {
        Effect.runSync(Deferred.succeed(resume, undefined));
        await completion;
      }
    });
  }

  it("aborts request-owned multipart resources on interruption while part signing waits", async () => {
    const at = await setup(false);
    gateAt = "part";
    const controller = new AbortController();
    const completion = runtime.runPromiseExit(
      at.api.uploadUrls({
        worktree_id: at.worktreeId,
        epoch: at.epoch,
        keys: [at.key],
        sizes: { [at.key]: 32 },
      }),
      { signal: controller.signal },
    );
    try {
      await Effect.runPromise(Deferred.await(entered));
      expect(await opens(at.worktreeId)).toHaveLength(1);
      controller.abort();
      const exit = await completion;
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(await opens(at.worktreeId)).toEqual([]);
      expect(aborted).toHaveLength(1);
    } finally {
      controller.abort();
      Effect.runSync(Deferred.succeed(resume, undefined));
      await completion;
    }
  });

  it("registers multipart cleanup even when interrupted while creation settles", async () => {
    const at = await setup(false);
    gateAt = "create";
    const controller = new AbortController();
    const completion = runtime.runPromiseExit(
      at.api.uploadUrls({
        worktree_id: at.worktreeId,
        epoch: at.epoch,
        keys: [at.key],
        sizes: { [at.key]: 32 },
      }),
      { signal: controller.signal },
    );
    try {
      await Effect.runPromise(Deferred.await(entered));
      expect(await opens(at.worktreeId)).toHaveLength(1);
      controller.abort();
      Effect.runSync(Deferred.succeed(resume, undefined));
      const exit = await completion;
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(await opens(at.worktreeId)).toEqual([]);
      expect(aborted).toHaveLength(1);
    } finally {
      controller.abort();
      Effect.runSync(Deferred.succeed(resume, undefined));
      await completion;
    }
  });

  it("an abort failure reports cleanup debt without replacing interruption", async () => {
    const at = await setup(false);
    gateAt = "part";
    abortFails = true;
    const controller = new AbortController();
    const completion = runtime.runPromiseExit(
      at.api.uploadUrls({
        worktree_id: at.worktreeId,
        epoch: at.epoch,
        keys: [at.key],
        sizes: { [at.key]: 32 },
      }),
      { signal: controller.signal },
    );
    try {
      await Effect.runPromise(Deferred.await(entered));
      controller.abort();
      const exit = await completion;
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      const debt = await opens(at.worktreeId);
      expect(debt).toHaveLength(1);
      abortFails = false;
      for (const resource of debt)
        await runtime.runPromise(
          Effect.flatMap(BlobStore, (bucket) =>
            bucket.abortMultipart(resource.key, resource.uploadId),
          ),
        );
      expect(await opens(at.worktreeId)).toEqual([]);
    } finally {
      abortFails = false;
      controller.abort();
      Effect.runSync(Deferred.succeed(resume, undefined));
      await completion;
    }
  });

  it("serializes publication across two APIs for the same launch without overspending", async () => {
    const at = await setup(false);
    const other = await runtime.runPromise(
      Effect.map(CaptureChannel, (channel) =>
        channel.apiFor({
          worktreeId: at.worktreeId,
          projectId: ProjectId.make("p-upload"),
          ...at.holder,
          footprintBytes: 0,
        }),
      ),
    );
    gateAllAt = "part";
    const keys = [at.key, captureKeys(at.worktreeId, at.epoch).pack("b".repeat(64))];
    const requests = [at.api, other].map((api, i) => {
      const key = keys[i];
      if (key === undefined) throw new Error("missing fixture key");
      return runtime.runPromiseExit(
        api.uploadUrls({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          keys: [key],
          sizes: { [key]: 32 },
        }),
      );
    });
    try {
      await Effect.runPromise(Deferred.await(entered));
      Effect.runSync(Deferred.succeed(resume, undefined));
      const results = await Promise.all(requests);
      expect(results.filter(Exit.isSuccess)).toHaveLength(1);
      const failure = results.find(Exit.isFailure);
      expect(failure).toBeDefined();
      if (failure !== undefined && Exit.isFailure(failure)) {
        const error = Cause.findErrorOption(failure.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some")
          expect(Schema.decodeUnknownSync(RouteError)(error.value)).toEqual({
            status: 413,
            reason: "byte-quota",
          });
      }
      expect(await opens(at.worktreeId)).toHaveLength(1);
      expect(aborted).toHaveLength(1);
    } finally {
      Effect.runSync(Deferred.succeed(resume, undefined));
      await Promise.all(requests);
    }
  });

  it("an interrupted same-key request cannot refund another request's successful charge", async () => {
    const at = await setup(false);
    gateAt = "part";
    const controller = new AbortController();
    const input = {
      worktree_id: at.worktreeId,
      epoch: at.epoch,
      keys: [at.key],
      sizes: { [at.key]: 32 },
    };
    const pending = runtime.runPromiseExit(at.api.uploadUrls(input), { signal: controller.signal });
    try {
      await Effect.runPromise(Deferred.await(entered));
      const successful = await runtime.runPromise(at.api.uploadUrls(input));
      expect(Object.keys(successful.multipart)).toEqual([at.key]);
      controller.abort();
      const interrupted = await pending;
      expect(Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause)).toBe(true);
      expect(await opens(at.worktreeId)).toHaveLength(1);
      const extraKey = captureKeys(at.worktreeId, at.epoch).pack("c".repeat(64));
      const extra = await runtime.runPromiseExit(
        at.api.uploadUrls({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          keys: [extraKey],
          sizes: { [extraKey]: 1 },
        }),
      );
      expect(Exit.isFailure(extra)).toBe(true);
      if (Exit.isFailure(extra)) {
        const error = Cause.findErrorOption(extra.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some")
          expect(Schema.decodeUnknownSync(RouteError)(error.value)).toEqual({
            status: 413,
            reason: "byte-quota",
          });
      }
      // A retry of the successful key is free and owns a different multipart resource.
      expect(Object.keys((await runtime.runPromise(at.api.uploadUrls(input))).multipart)).toEqual([
        at.key,
      ]);
    } finally {
      controller.abort();
      Effect.runSync(Deferred.succeed(resume, undefined));
      await pending;
    }
  });

  it("serializes register publication behind an upload whose real COMMIT waits", async () => {
    const at = await setup(false);
    const built = await storeAutoPack(at, "turn");
    gateLeaseCommit = true;
    const upload = runtime.runPromiseExit(
      at.api.uploadUrls({
        worktree_id: at.worktreeId,
        epoch: at.epoch,
        keys: [at.key],
        sizes: { [at.key]: 32 },
      }),
    );
    let registration: ReturnType<typeof runtime.runPromiseExit> | undefined;
    try {
      await Effect.runPromise(Deferred.await(entered));
      gateRegisterVerify = true;
      registration = runtime.runPromiseExit(
        at.api.register({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          n: 0,
          parent: null,
          capture_id: built.id,
          manifest_key: built.key,
          manifest: built.manifest,
        }),
      );
      // Its reads and initial quota check completed while upload COMMIT is still held.
      await Effect.runPromise(Deferred.await(registerEntered));
      Effect.runSync(Deferred.succeed(registerResume, undefined));
      Effect.runSync(Deferred.succeed(resume, undefined));
      expect(Exit.isSuccess(await upload)).toBe(true);
      const exit = await registration;
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some")
          expect(Schema.decodeUnknownSync(RouteError)(error.value)).toEqual({
            status: 409,
            reason: "byte-quota",
          });
      }
      expect(
        await runtime.runPromise(
          Effect.flatMap(CaptureStoreRepo, (repo) => repo.captureById(built.id)),
        ),
      ).toBeNull();
      expect(await opens(at.worktreeId)).toHaveLength(1);
      expect(aborted).toEqual([]);
    } finally {
      Effect.runSync(Deferred.succeed(resume, undefined));
      Effect.runSync(Deferred.succeed(registerResume, undefined));
      await upload;
      if (registration !== undefined) await registration;
    }
  });

  it("a register prepared during upload signing rechecks quota before its durable CAS", async () => {
    const at = await setup(false);
    const built = await storeAutoPack(at, "turn");
    gateAt = "part";
    const upload = runtime.runPromiseExit(
      at.api.uploadUrls({
        worktree_id: at.worktreeId,
        epoch: at.epoch,
        keys: [at.key],
        sizes: { [at.key]: 32 },
      }),
    );
    let registration: ReturnType<typeof runtime.runPromiseExit> | undefined;
    try {
      await Effect.runPromise(Deferred.await(entered));
      gateRegisterVerify = true;
      registration = runtime.runPromiseExit(
        at.api.register({
          worktree_id: at.worktreeId,
          epoch: at.epoch,
          n: 0,
          parent: null,
          capture_id: built.id,
          manifest_key: built.key,
          manifest: built.manifest,
        }),
      );
      await Effect.runPromise(Deferred.await(registerEntered));
      Effect.runSync(Deferred.succeed(resume, undefined));
      expect(Exit.isSuccess(await upload)).toBe(true);
      Effect.runSync(Deferred.succeed(registerResume, undefined));
      const exit = await registration;
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some")
          expect(Schema.decodeUnknownSync(RouteError)(error.value)).toEqual({
            status: 409,
            reason: "byte-quota",
          });
      }
      expect(
        await runtime.runPromise(
          Effect.flatMap(CaptureStoreRepo, (repo) => repo.captureById(built.id)),
        ),
      ).toBeNull();
    } finally {
      Effect.runSync(Deferred.succeed(resume, undefined));
      Effect.runSync(Deferred.succeed(registerResume, undefined));
      await upload;
      if (registration !== undefined) await registration;
    }
  });

  it("one launch's short register publication gate does not block an independent launch", async () => {
    const first = await setup(false);
    const built = await storeAutoPack(first);
    gateRegisterCommit = true;
    const registration = runtime.runPromiseExit(
      first.api.register({
        worktree_id: first.worktreeId,
        epoch: first.epoch,
        n: 0,
        parent: null,
        capture_id: built.id,
        manifest_key: built.key,
        manifest: built.manifest,
      }),
    );
    try {
      await Effect.runPromise(Deferred.await(registerEntered));
      const independent = await setup(false);
      const answer = await runtime.runPromise(
        independent.api.uploadUrls({
          worktree_id: independent.worktreeId,
          epoch: independent.epoch,
          keys: [independent.key],
          sizes: { [independent.key]: 32 },
        }),
      );
      expect(Object.keys(answer.multipart)).toEqual([independent.key]);
      Effect.runSync(Deferred.succeed(registerResume, undefined));
      expect(Exit.isSuccess(await registration)).toBe(true);
    } finally {
      Effect.runSync(Deferred.succeed(registerResume, undefined));
      await registration;
    }
  });

  it("a failed real COMMIT publishes no response or charge and aborts its multipart resource", async () => {
    const at = await setup(false);
    failCommit = true;
    const failed = await runtime.runPromiseExit(
      at.api.uploadUrls({
        worktree_id: at.worktreeId,
        epoch: at.epoch,
        keys: [at.key],
        sizes: { [at.key]: 32 },
      }),
    );
    expect(Exit.isFailure(failed)).toBe(true);
    if (Exit.isFailure(failed))
      expect(Cause.pretty(failed.cause)).toContain("synthetic deferred upload COMMIT failure");
    expect(await opens(at.worktreeId)).toEqual([]);
    expect(aborted).toHaveLength(1);
    const rows = await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT * FROM upload_commit_fault`),
    );
    expect(rows).toEqual([]);
    failCommit = false;
    const freshKey = captureKeys(at.worktreeId, at.epoch).pack("d".repeat(64));
    expect(
      Object.keys(
        (
          await runtime.runPromise(
            at.api.uploadUrls({
              worktree_id: at.worktreeId,
              epoch: at.epoch,
              keys: [freshKey],
              sizes: { [freshKey]: 32 },
            }),
          )
        ).multipart,
      ),
    ).toEqual([freshKey]);
  });

  it("publishes a valid checksum-bound holder without overwrite authority and keeps successful multipart ownership", async () => {
    const at = await setup();
    const answer = await runtime.runPromise(
      at.api.uploadUrls({
        worktree_id: at.worktreeId,
        epoch: at.epoch,
        keys: [at.key],
        sizes: { [at.key]: 12 },
      }),
    );
    expect(Object.keys(answer.urls)).toEqual([at.key]);
    expect(signed[0]?.digest).toBe("a".repeat(64));
    expect(
      await runtime.runPromise(
        Effect.flatMap(CaptureStoreRepo, (repo) => repo.putAuthorityUntil(at.worktreeId, at.epoch)),
      ),
    ).toBeNull();
    const multipartAt = await setup(false);
    const multipart = await runtime.runPromise(
      multipartAt.api.uploadUrls({
        worktree_id: multipartAt.worktreeId,
        epoch: multipartAt.epoch,
        keys: [multipartAt.key],
        sizes: { [multipartAt.key]: 32 },
      }),
    );
    expect(Object.keys(multipart.multipart)).toEqual([multipartAt.key]);
    expect(await opens(multipartAt.worktreeId)).toHaveLength(1);
    expect(aborted).toEqual([]);
  });
});
