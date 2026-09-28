import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { PgClient } from "@effect/sql-pg";
import { CaptureStoreRepo, CaptureStoreRepoLive, MendDBLive, migrations } from "@mend/db";
import { ProjectId, WorktreeId } from "@mend/domain";
import {
  CaptureChannel,
  CaptureChannelLive,
  CaptureGitVerifierOff,
  CaptureRemotesOff,
  CaptureRuntimeLive,
  CaptureSourcesOff,
  CaptureUploadPolicyDefault,
} from "@mend/sessions";
import { makeMemoryCaptureStore } from "@mend/sessions/testing";
import { BlobStoreFsLive, captureKeys, readCaptureFileBytes } from "@mend/store";
import { buildManifest, sectionOf, snapshotDirectory, uploadObjects } from "@mend/store/testing";
import { Effect, Layer, Redacted } from "effect";
import * as Str from "effect/String";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CaptureRetention, CaptureRetentionLive } from "../src/capture-retention.ts";

/**
 * Retention against registers that land while it runs (review 2026-09-27 #4). A final capture
 * names packs only a capture retention is thinning named; whichever of the two writes first,
 * the capture that registers must read back — and a capture whose objects retention is deleting
 * is refused, never acknowledged. Driven through the real register (`CaptureChannelLive`) and
 * the real pass, over the in-memory pointer store and over Postgres.
 */

const DAY = 24 * 60 * 60 * 1000;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-retention-race-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
let dirs = 0;
const freshDir = (label: string) => {
  dirs += 1;
  const at = path.join(scratch, `${label}-${dirs}`);
  fs.mkdirSync(at, { recursive: true });
  return at;
};

/**
 * Three captures: 0 and 2 hold the same tree (2 reuses 0's packs), 1 another. The text names the
 * worktree, so no two scenarios' packs share a digest (`packs.id` is the digest).
 */
const chainOf = (wt: WorktreeId) => {
  const source = freshDir("source");
  fs.writeFileSync(path.join(source, "saved.txt"), `original work ${wt}`);
  const old = snapshotDirectory(source, captureKeys(wt, 1), { format: 2 });
  fs.writeFileSync(path.join(source, "saved.txt"), `new work ${wt}`);
  const fresh = snapshotDirectory(source, captureKeys(wt, 1), { format: 2 });
  const zero = buildManifest({
    worktreeId: wt,
    epoch: 1,
    n: 0,
    parent: null,
    kind: "auto",
    workspace: sectionOf(old),
  });
  const one = buildManifest({
    worktreeId: wt,
    epoch: 1,
    n: 1,
    parent: zero.id,
    kind: "auto",
    workspace: sectionOf(fresh),
  });
  const two = buildManifest({
    worktreeId: wt,
    epoch: 1,
    n: 2,
    parent: one.id,
    kind: "final",
    workspace: sectionOf(old),
  });
  const objects = new Map([
    ...old.objects,
    ...fresh.objects,
    [zero.key, zero.bytes],
    [one.key, one.bytes],
    [two.key, two.bytes],
  ]);
  return { old, zero, one, two, objects };
};

type Built = ReturnType<typeof chainOf>["two"];

/**
 * The world one scenario runs in: the channel and the pass over `repoLayer` (wrapped by `hook`
 * so a test can run something at an exact point of either), one directory bucket.
 */
const worldOf = (
  repoBase: Layer.Layer<CaptureStoreRepo>,
  hook: (inner: typeof CaptureStoreRepo.Service) => typeof CaptureStoreRepo.Service,
) => {
  const repoLayer = Layer.effect(CaptureStoreRepo, Effect.map(CaptureStoreRepo, hook)).pipe(
    Layer.provide(repoBase),
  );
  const blobRoot = freshDir("blobs");
  const blobs = BlobStoreFsLive(blobRoot);
  const channel = CaptureChannelLive.pipe(
    Layer.provide(repoLayer),
    Layer.provide(blobs),
    Layer.provide(CaptureGitVerifierOff),
    Layer.provide(CaptureSourcesOff),
    Layer.provide(CaptureRemotesOff),
    Layer.provide(CaptureUploadPolicyDefault),
  );
  const runtime = CaptureRuntimeLive.pipe(
    Layer.provide(channel),
    Layer.provide(repoLayer),
    Layer.provide(blobs),
  );
  const retention = CaptureRetentionLive.pipe(Layer.provide(runtime));
  return {
    blobRoot,
    layer: Layer.mergeAll(retention, channel, repoLayer, blobs),
  };
};

const registerWith = (wt: WorktreeId) =>
  Effect.gen(function* () {
    const api = (yield* CaptureChannel).apiFor({
      worktreeId: wt,
      projectId: ProjectId.make("p"),
      executorId: "executor",
      footprintBytes: 0,
    });
    return (built: Built) =>
      api.register({
        worktree_id: wt,
        epoch: 1,
        n: built.manifest.n,
        parent: built.manifest.parent,
        capture_id: built.id,
        manifest_key: built.key,
        manifest: built.manifest,
      });
  });

const outcome = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.map(() => "ok"),
    Effect.catch((error) =>
      Effect.succeed(
        "reason" in error && typeof error.reason === "string"
          ? `${error._tag}:${error.reason}`
          : error._tag,
      ),
    ),
  );

/** Read `saved.txt` back from a registered manifest: "ok" + its text, or the failure. */
const readBack = (built: Built) =>
  readCaptureFileBytes(built.manifest, "workspace", "saved.txt").pipe(
    Effect.map((bytes) => `ok:${Buffer.from(bytes).toString("utf8")}`),
    Effect.catch((error) => Effect.succeed(error._tag)),
  );

/**
 * The scenarios, parameterised over the pointer store: `setup` makes the worktree's rows and
 * claims its lease for 20 days; `retentionNow` is the pass's clock once the thinned capture is
 * past seven days and every pack past the grace; `age` moves the store's own clock there too
 * (memory) or does nothing (Postgres ages rows through `retentionNow` alone).
 */
interface Store {
  readonly label: string;
  readonly repo: () => Layer.Layer<CaptureStoreRepo>;
  readonly setup: (wt: WorktreeId) => Effect.Effect<void, never, CaptureStoreRepo>;
  readonly retentionNow: () => number;
  readonly age: () => void;
}

const scenarios = (store: Store) => {
  it(`${store.label}: a final capture that registers while the pass runs keeps its packs`, async () => {
    const wt = WorktreeId.make(`wt-race-a-${process.pid}-${Date.now()}`);
    const chain = chainOf(wt);
    let onListPacks: Effect.Effect<unknown> = Effect.void;
    const world = worldOf(store.repo(), (inner) => ({
      ...inner,
      listPacks: (state) =>
        Effect.suspend(() => {
          const run = onListPacks;
          onListPacks = Effect.void;
          return run.pipe(Effect.andThen(inner.listPacks(state)));
        }),
    }));
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* uploadObjects(chain.objects);
        yield* store.setup(wt);
        const register = yield* registerWith(wt);
        yield* register(chain.zero);
        yield* register(chain.one);
        store.age();
        // The pass has read the chains and thinned capture 0; the final capture lands now.
        const landed: Array<string> = [];
        onListPacks = outcome(register(chain.two)).pipe(
          Effect.tap((said) => Effect.sync(() => landed.push(said))),
        );
        const retention = yield* CaptureRetention;
        yield* retention.run(store.retentionNow());
        const head = (yield* (yield* CaptureStoreRepo).headOf(wt))?.head?.id;
        const afterRace = yield* readBack(chain.two);
        // The next pass sees capture 2 as the head and keeps what it names.
        yield* retention.run(store.retentionNow());
        const nextPass = yield* readBack(chain.two);
        return { landed, head, afterRace, nextPass };
      }).pipe(Effect.provide(world.layer)),
    );
    expect(result.landed).toEqual(["ok"]);
    expect(result.head).toBe(chain.two.id);
    expect(result.afterRace).toBe(`ok:original work ${wt}`);
    expect(result.nextPass).toBe(`ok:original work ${wt}`);
    for (const key of [...chain.old.packs, ...chain.old.dirPacks]) {
      expect(fs.existsSync(path.join(world.blobRoot, key)), key).toBe(true);
    }
  });

  it(`${store.label}: a register whose packs the pass condemns after it looked is refused, and lands once the bytes are uploaded again`, async () => {
    const wt = WorktreeId.make(`wt-race-b-${process.pid}-${Date.now()}`);
    const chain = chainOf(wt);
    let armed = false;
    let retentionRun: Effect.Effect<unknown> = Effect.void;
    const world = worldOf(store.repo(), (inner) => ({
      ...inner,
      // The register has HEAD-ed its packs and is about to verify and CAS: the pass runs
      // now, condemns the packs only thinned capture 0 named, and deletes them.
      captureById: (captureId) =>
        Effect.suspend(() => {
          if (!armed || captureId !== chain.two.id) return inner.captureById(captureId);
          armed = false;
          return retentionRun.pipe(Effect.andThen(inner.captureById(captureId)));
        }),
    }));
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* uploadObjects(chain.objects);
        yield* store.setup(wt);
        const register = yield* registerWith(wt);
        yield* register(chain.zero);
        yield* register(chain.one);
        store.age();
        const retention = yield* CaptureRetention;
        retentionRun = retention.run(store.retentionNow());
        armed = true;
        const refused = yield* outcome(register(chain.two));
        const head = (yield* (yield* CaptureStoreRepo).headOf(wt))?.head?.id;
        const gone = chain.old.packs.every((key) => !fs.existsSync(path.join(world.blobRoot, key)));
        // The executor uploads the same objects again; the register sees them and lands.
        yield* uploadObjects(chain.old.objects);
        const again = yield* outcome(register(chain.two));
        const read = yield* readBack(chain.two);
        // Revived: the next pass keeps them, the head names them.
        yield* retention.run(store.retentionNow());
        const nextPass = yield* readBack(chain.two);
        return { refused, head, gone, again, read, nextPass };
      }).pipe(Effect.provide(world.layer)),
    );
    expect(result.gone).toBe(true);
    expect(result.refused).toBe("CaptureRouteError:missing-objects");
    expect(result.head).toBe(chain.one.id);
    expect(result.again).toBe("ok");
    expect(result.read).toBe(`ok:original work ${wt}`);
    expect(result.nextPass).toBe(`ok:original work ${wt}`);
  });
};

// ─── In memory ─────────────────────────────────────────────────────────────

describe("retention racing a register (in memory)", () => {
  let memory = makeMemoryCaptureStore();
  let time = 0;
  scenarios({
    label: "memory",
    repo: () => {
      memory = makeMemoryCaptureStore();
      time = 0;
      memory.clock.now = () => time;
      return memory.layer;
    },
    setup: (wt) =>
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        yield* repo.init(wt);
        yield* repo.claim(wt, "executor", 20 * 86_400).pipe(Effect.orDie);
      }),
    retentionNow: () => 10 * DAY,
    age: () => {
      time = 9 * DAY;
    },
  });
});

// ─── Postgres ──────────────────────────────────────────────────────────────

const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_retention_race_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const reachable = await withAdmin(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`SELECT 1`;
  }).pipe(Effect.timeout("2 seconds")),
).then(
  () => true,
  () => false,
);
// The production client's name transforms (`@mend/db` `client.ts`).
const pgLayer = Layer.provideMerge(
  CaptureStoreRepoLive,
  MendDBLive.pipe(
    Layer.provideMerge(
      PgClient.layer({
        url: Redacted.make(scratchUrl),
        transformResultNames: Str.snakeToCamel,
        transformQueryNames: Str.camelToSnake,
      }),
    ),
  ),
);
describe.skipIf(!reachable)("retention racing a register (Postgres)", () => {
  const PROJECT = ProjectId.make("proj-race");
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        )) {
          yield* migration;
        }
        yield* sql`
          INSERT INTO projects (id, name, organization_id, origin_url, store_path, default_branch)
          VALUES (${PROJECT}, 'race-fixture', (SELECT id FROM organizations LIMIT 1), NULL,
                  '/store/race-fixture/repo.git', 'main')`;
      }).pipe(Effect.provide(pgLayer), Effect.scoped),
    );
  });
  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }),
    );
  });
  scenarios({
    label: "postgres",
    repo: () => pgLayer.pipe(Layer.orDie),
    setup: (wt) =>
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
            VALUES (${wt}, ${PROJECT}, ${wt}, ${wt}, ${`mend/wt/${wt}`}, ${"a".repeat(40)})`;
        }).pipe(Effect.provide(pgLayer), Effect.scoped, Effect.orDie);
        yield* repo.init(wt);
        yield* repo.claim(wt, "executor", 20 * 86_400).pipe(Effect.orDie);
      }),
    retentionNow: () => Date.now() + 10 * DAY,
    age: () => undefined,
  });
});
