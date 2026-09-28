import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CaptureStoreRepo } from "@mend/db";
import { ProjectId, WorktreeId } from "@mend/domain";
import {
  BlobStoreFsLive,
  type CaptureManifest,
  captureKeys,
  type DirEntry,
  encodeDirObject,
  FORMAT_DIR_PACKS,
  listCaptureDir,
  sha256Hex,
  WORKTREE_TREE_REF,
  type WorktreeTreeKind,
} from "@mend/store";
import {
  buildManifest,
  sectionOf,
  snapshotDirectory,
  uploadObjects,
  writeCdcPack,
} from "@mend/store/testing";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import {
  CaptureChannel,
  CaptureChannelLive,
  MANIFEST_FEATURES,
  CaptureUploadPolicy,
  CaptureUploadPolicyDefault,
  dispatchCaptureRoute,
  resolveCaptureUploadPolicy,
  type SessionCaptureApi,
} from "../src/capture-channel.ts";
import { CaptureRemotesOff } from "../src/capture-remotes.ts";
import { CaptureSourcesOff } from "../src/capture-sources.ts";
import { CaptureGitVerifier, CaptureGitVerifierOff } from "../src/capture-verify.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";

/**
 * What `capture.register` and `plan.get` may acknowledge and hand out (review 2026-09-27 #19 and
 * the manifest-format rollback risk): a capture is registered only if Mend could restore it, and
 * a plan reaches only an executor that reads every section it holds.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-register-safety-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
let dirs = 0;
const freshDir = (label: string) => {
  dirs += 1;
  const at = path.join(scratch, `${label}-${dirs}`);
  fs.mkdirSync(at, { recursive: true });
  return at;
};

/** The worktree tree the metadata tests' manifests name (`WORKTREE_TREE_REF`). */
const WORKTREE_TREE = "e".repeat(40);
const gitWithTree = {
  packs: [],
  refs: { [WORKTREE_TREE_REF]: WORKTREE_TREE },
  head: "refs/heads/main",
  fsck: "unverified" as const,
};

/**
 * A git verifier that observed every git section verify and the worktree tree hold `tracked`
 * (path → kind): what the metadata document is checked against at register.
 */
const verifierObserving = (tracked: Readonly<Record<string, WorktreeTreeKind>>) =>
  Layer.succeed(CaptureGitVerifier, {
    verify: () => Effect.succeed({ outcome: "verified" as const, detail: null }),
    treePaths: () =>
      Effect.succeed(
        new Map(
          Object.entries(tracked).map(([at, kind]) => [Buffer.from(at).toString("hex"), kind]),
        ),
      ),
    // Every file one blob: a hardlink group of the tracked files holds one set of bytes.
    treeObjects: () =>
      Effect.succeed(
        new Map(
          Object.entries(tracked).map(([at, kind]) => [
            Buffer.from(at).toString("hex"),
            { kind, object: kind === "file" ? "f".repeat(40) : "d".repeat(40) },
          ]),
        ),
      ),
  });

/** What `plainDocument` names, as the worktree tree holds it. */
const plainTree: Readonly<Record<string, WorktreeTreeKind>> = {
  a: "file",
  b: "file",
  l: "symlink",
};

const worldOf = (
  manifestFormat: 1 | 2 = 2,
  verifier: Layer.Layer<CaptureGitVerifier> = CaptureGitVerifierOff,
) => {
  const memory = makeMemoryCaptureStore();
  const blobs = BlobStoreFsLive(freshDir("blobs"));
  const channel = CaptureChannelLive.pipe(
    Layer.provide(memory.layer),
    Layer.provide(blobs),
    Layer.provide(verifier),
    Layer.provide(CaptureSourcesOff),
    Layer.provide(CaptureRemotesOff),
    Layer.provide(
      manifestFormat === 2
        ? CaptureUploadPolicyDefault
        : Layer.succeed(CaptureUploadPolicy, {
            ...resolveCaptureUploadPolicy({}),
            manifestFormat,
          }),
    ),
  );
  return { memory, layer: Layer.mergeAll(channel, memory.layer, blobs) };
};

const apiOf = (wt: WorktreeId, executorId = "executor", launchId?: string) =>
  Effect.map(CaptureChannel, (channel) =>
    channel.apiFor({
      worktreeId: wt,
      projectId: ProjectId.make("p"),
      executorId,
      ...(launchId === undefined ? {} : { launchId }),
      footprintBytes: 0,
    }),
  );

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

const registerInput = (built: ReturnType<typeof buildManifest>) => ({
  worktree_id: built.manifest.worktree_id,
  epoch: built.manifest.epoch,
  n: built.manifest.n,
  parent: built.manifest.parent,
  capture_id: built.id,
  manifest_key: built.key,
  manifest: built.manifest,
});

/** A format-2 workspace over hand-written dir objects: whatever a test wants the tree to say. */
const handWorkspace = (
  wt: string,
  epoch: number,
  entries: ReadonlyArray<DirEntry>,
  chunks: ReadonlyArray<Uint8Array>,
) => {
  const keys = captureKeys(wt, epoch);
  const content = writeCdcPack(chunks);
  const contentKey = keys.pack(sha256Hex(content.bytes));
  const dirBytes = encodeDirObject(entries);
  const dirPack = writeCdcPack([dirBytes]);
  const dirPackKey = keys.pack(sha256Hex(dirPack.bytes));
  return {
    objects: new Map([
      [contentKey, content.bytes],
      [dirPackKey, dirPack.bytes],
    ]),
    workspace: {
      root: sha256Hex(dirBytes),
      packs: [contentKey],
      format: FORMAT_DIR_PACKS,
      dir_packs: [dirPackKey],
    } satisfies CaptureManifest["sections"]["workspace"],
  };
};

const utf8 = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));

describe("capture.register acknowledges only what restores", () => {
  it("refuses a format-2 root no listed dir pack holds, and never plans it", async () => {
    const wt = WorktreeId.make("wt-invalid-root");
    const world = worldOf();
    const source = freshDir("invalid-root");
    fs.writeFileSync(path.join(source, "saved.txt"), "work product");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        yield* repo.init(wt);
        const api = yield* apiOf(wt);
        const plan = yield* api.planGet({ epoch: 0, manifest_format: 2 });
        const snapshot = snapshotDirectory(source, captureKeys(wt, plan.epoch), { format: 2 });
        const built = buildManifest({
          worktreeId: wt,
          epoch: plan.epoch,
          n: 0,
          parent: null,
          kind: "final",
          workspace: { ...sectionOf(snapshot), root: "f".repeat(64) },
        });
        yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]]));
        const registered = yield* outcome(api.register(registerInput(built)));
        const head = (yield* repo.headOf(wt))?.head;
        return { registered, head };
      }).pipe(Effect.provide(world.layer)),
    );
    expect(result.registered).toBe("CaptureRouteError:unrestorable");
    expect(result.head).toBeNull();
  });

  it("refuses a file whose chunk is in no listed pack, a missing format-1 dir object and a hardlink with no canonical member; accepts the same tree whole", async () => {
    const wt = WorktreeId.make("wt-closure");
    const world = worldOf();
    const body = utf8("the bytes of a file");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        yield* repo.init(wt);
        const api = yield* apiOf(wt);
        const { epoch } = yield* api.planGet({ epoch: 0, manifest_format: 2 });
        const file: DirEntry = {
          name: "a",
          kind: "file",
          mode: 0o100644,
          size: body.byteLength,
          mtime: 1,
          chunks: [sha256Hex(body)],
        };
        let seq = 0;
        const attempt = (workspace: CaptureManifest["sections"]["workspace"]) =>
          Effect.gen(function* () {
            seq += 1;
            const built = buildManifest({
              worktreeId: wt,
              epoch,
              n: 0,
              parent: null,
              seq,
              kind: "final",
              workspace,
            });
            yield* uploadObjects(new Map([[built.key, built.bytes]]));
            return yield* outcome(api.register(registerInput(built)));
          });
        // The chunk is in a pack the section does not list.
        const listed = handWorkspace(wt, epoch, [file], [body]);
        const unlisted = handWorkspace(wt, epoch, [file], [utf8("some other chunk")]);
        yield* uploadObjects(new Map([...listed.objects, ...unlisted.objects]));
        const chunkElsewhere = yield* attempt({
          ...listed.workspace,
          packs: unlisted.workspace.packs,
        });
        // A hardlink member whose canonical member does not exist.
        const orphan = handWorkspace(
          wt,
          epoch,
          [
            file,
            {
              name: "b",
              kind: "hardlink-group",
              mode: 0o100644,
              size: body.byteLength,
              mtime: 1,
              target: "gone",
            },
          ],
          [body],
        );
        yield* uploadObjects(orphan.objects);
        const hardlink = yield* attempt(orphan.workspace);
        // Format 1: a dir object below the root is not in the bucket.
        const source = freshDir("closure-v1");
        fs.mkdirSync(path.join(source, "dir"));
        fs.writeFileSync(path.join(source, "dir", "x"), "x");
        const v1 = snapshotDirectory(source, captureKeys(wt, epoch), { format: 1 });
        yield* uploadObjects(
          new Map([...v1.objects].filter(([key]) => !key.includes("/trees/") || key === v1.root)),
        );
        const missingDir = yield* attempt(sectionOf(v1));
        // The whole tree lands.
        const whole = yield* attempt(listed.workspace);
        return { chunkElsewhere, hardlink, missingDir, whole };
      }).pipe(Effect.provide(world.layer)),
    );
    expect(result).toEqual({
      chunkElsewhere: "CaptureRouteError:unrestorable",
      hardlink: "CaptureRouteError:unrestorable",
      missingDir: "CaptureRouteError:missing-objects",
      whole: "ok",
    });
  });
});

describe("plan.get hands a head only to an executor that reads it", () => {
  const withV2Head = (wt: WorktreeId) =>
    Effect.gen(function* () {
      const repo = yield* CaptureStoreRepo;
      yield* repo.init(wt);
      const writer = yield* apiOf(wt, "writer");
      const { epoch } = yield* writer.planGet({ epoch: 0, manifest_format: 2 });
      const source = freshDir("v2-head");
      fs.writeFileSync(path.join(source, "saved.txt"), "work product");
      const snapshot = snapshotDirectory(source, captureKeys(wt, epoch), { format: 2 });
      const built = buildManifest({
        worktreeId: wt,
        epoch,
        n: 0,
        parent: null,
        kind: "final",
        workspace: sectionOf(snapshot),
      });
      yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]]));
      yield* writer.register(registerInput(built));
      // The writer's executor ends: the lease is released for the next one.
      yield* repo.release(wt, epoch);
      return { built, epoch };
    });

  it("refuses an executor that does not say it reads format 2 before it claims anything, and answers one that does", async () => {
    const wt = WorktreeId.make("wt-v2-head");
    const world = worldOf();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { built, epoch } = yield* withV2Head(wt);
        const repo = yield* CaptureStoreRepo;
        const old = yield* apiOf(wt, "old-executor");
        const refused = yield* outcome(old.planGet({ epoch: 0 }));
        const saysOne = yield* outcome(old.planGet({ epoch: 0, manifest_format: 1 }));
        const leaseAfterRefusal = yield* repo.leaseOf(wt);
        const fresh = yield* apiOf(wt, "new-executor");
        const plan = yield* fresh.planGet({ epoch: 0, manifest_format: 2 });
        // What it was handed reads back.
        const listing = yield* listCaptureDir(
          plan.head?.manifest ?? built.manifest,
          "workspace",
          "",
        );
        return { refused, saysOne, leaseAfterRefusal, epoch, plan, listing, built };
      }).pipe(Effect.provide(world.layer)),
    );
    expect(result.refused).toBe("CaptureRouteError:manifest-format");
    expect(result.saysOne).toBe("CaptureRouteError:manifest-format");
    // Refused before the claim: the epoch did not move, nobody holds the lease.
    expect(result.leaseAfterRefusal?.epoch).toBe(result.epoch);
    expect(result.leaseAfterRefusal?.live).toBe(false);
    expect(result.plan.head?.capture_id).toBe(result.built.id);
    expect(result.plan.epoch).toBe(result.epoch + 1);
    expect(result.plan.manifest_format).toBe(2);
    expect(result.listing?.map((entry) => entry.name)).toEqual(["saved.txt"]);
  });

  it("answers manifest_format no higher than the executor reads or the operator allows", async () => {
    const answers = await Effect.runPromise(
      Effect.gen(function* () {
        const out: Array<number> = [];
        for (const [configured, reads] of [
          [2, undefined],
          [2, 1],
          [2, 2],
          [1, 2],
        ] as const) {
          const world = worldOf(configured);
          const wt = WorktreeId.make(`wt-answer-${configured}-${reads ?? "none"}`);
          const plan = yield* Effect.gen(function* () {
            yield* (yield* CaptureStoreRepo).init(wt);
            return yield* (yield* apiOf(wt)).planGet(
              reads === undefined ? { epoch: 0 } : { epoch: 0, manifest_format: reads },
            );
          }).pipe(Effect.provide(world.layer));
          out.push(plan.manifest_format);
        }
        return out;
      }),
    );
    expect(answers).toEqual([1, 1, 2, 1]);
  });

  it("refuses a standby plan holding a format-2 section to an executor that does not read it", async () => {
    const world = worldOf();
    const source = freshDir("standby");
    fs.writeFileSync(path.join(source, "saved.txt"), "base");
    const snapshot = snapshotDirectory(source, captureKeys("standby", 7), { format: 2 });
    const base = buildManifest({
      worktreeId: "standby",
      n: 0,
      parent: null,
      epoch: 7,
      workspace: sectionOf(snapshot),
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* uploadObjects(new Map([...snapshot.objects, [base.key, base.bytes]]));
        const channel = yield* CaptureChannel;
        const standby = channel.standbyApiFor({
          alias: "standby",
          projectId: ProjectId.make("p"),
          executorId: "standby-exec",
          epoch: 7,
          plan: () =>
            Effect.succeed({ captureId: base.id, manifestKey: base.key, manifest: base.manifest }),
        });
        const refused = yield* outcome(standby.planGet({}));
        const answered = yield* standby.planGet({ manifest_format: 2 });
        return { refused, answered: answered.head?.capture_id };
      }).pipe(Effect.provide(world.layer)),
    );
    expect(result.refused).toBe("CaptureRouteError:manifest-format");
    expect(result.answered).toBe(base.id);
  });

  it("names the executor the token was issued for, on an empty chain, over a head and on a standby — what final_seal.executor must name", async () => {
    const world = worldOf();
    const wt = WorktreeId.make("wt-plan-executor");
    const answers = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        yield* repo.init(wt);
        const api = yield* apiOf(wt, "exec-named");
        const empty = yield* api.planGet({ epoch: 0, manifest_format: 2 });
        const zero = buildManifest({ worktreeId: wt, epoch: empty.epoch, n: 0, parent: null });
        yield* uploadObjects(new Map([[zero.key, zero.bytes]]));
        yield* api.register(registerInput(zero));
        const overHead = yield* api.planGet({ epoch: empty.epoch, manifest_format: 2 });
        const standby = (yield* CaptureChannel).standbyApiFor({
          alias: "standby",
          projectId: ProjectId.make("p"),
          executorId: "standby-exec",
          epoch: 7,
          plan: () =>
            Effect.succeed({ captureId: zero.id, manifestKey: zero.key, manifest: zero.manifest }),
        });
        const onStandby = yield* standby.planGet({ manifest_format: 2 });
        return {
          empty: empty.executor,
          overHead: [overHead.head?.capture_id === zero.id, overHead.executor],
          onStandby: onStandby.executor,
        };
      }).pipe(Effect.provide(world.layer)),
    );
    expect(answers).toEqual({
      empty: "exec-named",
      overHead: [true, "exec-named"],
      onStandby: "standby-exec",
    });
  });
});

describe("the launch is the executor (review 2026-09-28 (3) #1, cross-repo decision 5)", () => {
  it("plan.get names the launch its token was issued for, and a seal is recorded only when it names that launch", async () => {
    const world = worldOf(2, verifierObserving({}));
    const wt = WorktreeId.make("wt-launch-seal");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        yield* repo.init(wt);
        const api = yield* apiOf(wt, "session-1", "launch:session-1:1:a");
        const plan = yield* api.planGet({ epoch: 0, manifest_format: 2 });
        const zero = buildManifest({ worktreeId: wt, epoch: plan.epoch, n: 0, parent: null });
        yield* uploadObjects(new Map([[zero.key, zero.bytes]]));
        yield* api.register(registerInput(zero));
        const sealing = (n: number, parent: string, executor: string) => {
          const base = buildManifest({
            worktreeId: wt,
            epoch: plan.epoch,
            n,
            parent,
            kind: "final",
            bulk: { root: "", packs: [], platform: "linux-x86_64-glibc" },
          });
          const manifest = {
            ...base.manifest,
            final_seal: { complete: true, epoch: plan.epoch, executor },
          };
          const bytes = utf8(JSON.stringify(manifest));
          const id = sha256Hex(bytes);
          return { manifest, bytes, id, key: captureKeys(wt, plan.epoch).manifest(id) };
        };
        // A seal naming the session — another launch of it, or none at all — seals nothing.
        const bySession = sealing(1, zero.id, "session-1");
        const byLaunch = sealing(2, bySession.id, "launch:session-1:1:a");
        yield* uploadObjects(
          new Map([
            [bySession.key, bySession.bytes],
            [byLaunch.key, byLaunch.bytes],
          ]),
        );
        const register = (built: typeof bySession) =>
          api.register({
            worktree_id: wt,
            epoch: plan.epoch,
            n: built.manifest.n,
            parent: built.manifest.parent,
            capture_id: built.id,
            manifest_key: built.key,
            manifest: JSON.parse(JSON.stringify(built.manifest)),
          });
        yield* register(bySession);
        const afterSession = yield* repo.sealedCompletion(wt, "session-1", plan.epoch);
        yield* register(byLaunch);
        return {
          executor: plan.executor,
          afterSession,
          byLaunch: yield* repo.sealedCompletion(wt, "launch:session-1:1:a", plan.epoch),
          byLaunchId: byLaunch.id,
        };
      }).pipe(Effect.provide(world.layer)),
    );
    expect(result.executor).toBe("launch:session-1:1:a");
    expect(result.afterSession).toBeNull();
    expect(result.byLaunch).toMatchObject({
      executorId: "launch:session-1:1:a",
      captureId: result.byLaunchId,
      n: 2,
    });
  });
});

/** A workspace section whose pack holds `document` as one chunk, named by `worktree_meta`. */
const withMeta = (
  wt: string,
  document: Uint8Array,
  meta: (chunk: string, pack: string) => Partial<Record<string, unknown>> = () => ({}),
) => {
  const keys = captureKeys(wt, 1);
  const content = writeCdcPack([document]);
  const contentKey = keys.pack(sha256Hex(content.bytes));
  const chunk = sha256Hex(document);
  const worktree_meta = {
    format: 1,
    size: document.byteLength,
    sha256: sha256Hex(document),
    chunks: [chunk],
    packs: [contentKey],
    ...meta(chunk, contentKey),
  };
  return {
    objects: new Map([[contentKey, content.bytes]]),
    workspace: { root: "", packs: [contentKey], worktree_meta },
  };
};
const documentOf = (value: object) => utf8(JSON.stringify(value));
const plainDocument = {
  format: 1,
  entries: [
    { path: "", kind: "dir", mode: 0o755, mtime: 1_700_000_000_000_000_000 },
    { path: "a", kind: "file", mode: 0o640, mtime: 1_700_000_000_000_000_000 },
    { path: "b", kind: "file", mode: 0o644, mtime: 1_700_000_000_000_000_000 },
    { path: "l", kind: "symlink", mtime: 1_700_000_000_000_000_000 },
  ],
  hardlinks: [["a", "b"]],
};

const registerOnce = async (
  wt: WorktreeId,
  workspace: object,
  objects: ReadonlyMap<string, Uint8Array>,
  requestManifest?: (manifest: CaptureManifest) => unknown,
  tree: { readonly tracked: Readonly<Record<string, WorktreeTreeKind>> | null } = {
    tracked: plainTree,
  },
) => {
  const world = worldOf(
    2,
    tree.tracked === null ? CaptureGitVerifierOff : verifierObserving(tree.tracked),
  );
  const built = buildManifest({
    worktreeId: wt,
    epoch: 1,
    n: 0,
    parent: null,
    kind: "final",
    git: gitWithTree,
    // The schema's workspace type does not say every shape a writer may send; the bytes do.
    workspace: JSON.parse(JSON.stringify(workspace)),
  });
  return Effect.runPromise(
    Effect.gen(function* () {
      const repo = yield* CaptureStoreRepo;
      yield* repo.init(wt);
      yield* repo.claim(wt, "executor");
      yield* uploadObjects(new Map([...objects, [built.key, built.bytes]]));
      const api = yield* apiOf(wt);
      const input = registerInput(built);
      const said = yield* outcome(
        api.register(
          requestManifest === undefined
            ? input
            : { ...input, manifest: requestManifest(built.manifest) },
        ),
      );
      return { said, head: (yield* repo.headOf(wt))?.head?.id ?? null };
    }).pipe(Effect.provide(world.layer)),
  );
};

describe("capture.register reads the worktree metadata a restore needs (review 2026-09-28 #17)", () => {
  it("refuses a final manifest whose metadata document has no chunks behind its size and digest", async () => {
    const wt = WorktreeId.make("wt-meta-empty");
    const result = await registerOnce(
      wt,
      {
        root: "",
        packs: [],
        worktree_meta: { format: 1, size: 42, sha256: "a".repeat(64), chunks: [], packs: [] },
      },
      new Map(),
    );
    expect(result).toEqual({ said: "CaptureRouteError:unrestorable", head: null });
  });

  it("registers a metadata document that restores, and refuses every way one would not", async () => {
    const good = withMeta("wt-meta-good", documentOf(plainDocument));
    expect(
      (await registerOnce(WorktreeId.make("wt-meta-good"), good.workspace, good.objects)).said,
    ).toBe("ok");

    const cases: ReadonlyArray<readonly [string, ReturnType<typeof withMeta>, string]> = [
      [
        "a format Mend does not read",
        withMeta("wt-meta-format", documentOf(plainDocument), () => ({ format: 2 })),
        "unrestorable",
      ],
      [
        "a digest the bytes do not have",
        withMeta("wt-meta-digest", documentOf(plainDocument), () => ({ sha256: "b".repeat(64) })),
        "unrestorable",
      ],
      [
        "a size the chunks do not add up to",
        withMeta("wt-meta-size", documentOf(plainDocument), () => ({ size: 1 })),
        "unrestorable",
      ],
      [
        "a chunk in no listed pack",
        withMeta("wt-meta-chunk", documentOf(plainDocument), () => ({ chunks: ["c".repeat(64)] })),
        "unrestorable",
      ],
      [
        "a pack that is not the section's",
        withMeta("wt-meta-pack", documentOf(plainDocument), () => ({
          packs: [captureKeys("wt-meta-pack", 1).pack("d".repeat(64))],
        })),
        "unrestorable",
      ],
      [
        "a path that leaves the worktree",
        withMeta(
          "wt-meta-path",
          documentOf({
            format: 1,
            entries: [{ path: "../x", kind: "file", mode: 0o644, mtime: 1 }],
          }),
        ),
        "unrestorable",
      ],
      [
        "raw path bytes that disagree with the path",
        withMeta(
          "wt-meta-raw",
          documentOf({
            format: 1,
            entries: [
              {
                path: `caf${String.fromCodePoint(0x10_ffe9)}`,
                raw_path: "636166e8",
                kind: "file",
                mode: 0o644,
                mtime: 1,
              },
            ],
          }),
        ),
        "unrestorable",
      ],
      [
        "a hardlink group naming no file",
        withMeta("wt-meta-group", documentOf({ ...plainDocument, hardlinks: [["a", "missing"]] })),
        "unrestorable",
      ],
      ["a document that is not JSON", withMeta("wt-meta-json", utf8("not json")), "unrestorable"],
    ];
    for (const [label, section, reason] of cases) {
      const owner = section.workspace.packs[0]?.split("/")[1] ?? "";
      const wt = WorktreeId.make(owner);
      const result = await registerOnce(wt, section.workspace, section.objects);
      expect(result, label).toEqual({ said: `CaptureRouteError:${reason}`, head: null });
    }
  });

  it("reads cross_links under sealantd's rules: groups of two or more distinct plain members", async () => {
    const escapedMember = `ignored/caf${String.fromCodePoint(0x10_ffe9)}`;
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<ReadonlyArray<object>>, string]> = [
      [
        "a group across the classes",
        [
          [
            { class: "workspace", member: "tree/ignored/x" },
            { class: "bulk", member: "node_modules/pkg/x" },
          ],
        ],
        "ok",
      ],
      [
        "the same path in both classes",
        [
          [
            { class: "workspace", member: "a/x" },
            { class: "bulk", member: "a/x" },
          ],
        ],
        "ok",
      ],
      [
        "a member named by raw bytes that agree",
        [
          [
            { class: "workspace", member: escapedMember, raw_member: "69676e6f7265642f636166e9" },
            { class: "bulk", member: "node_modules/x" },
          ],
        ],
        "ok",
      ],
      ["a group of one", [[{ class: "workspace", member: "tree/x" }]], "unrestorable"],
      [
        "a member listed twice",
        [
          [
            { class: "bulk", member: "node_modules/x" },
            { class: "bulk", member: "node_modules/x" },
          ],
        ],
        "unrestorable",
      ],
      [
        "a member that leaves the class root",
        [
          [
            { class: "workspace", member: "../x" },
            { class: "bulk", member: "node_modules/x" },
          ],
        ],
        "unrestorable",
      ],
      [
        "an empty member",
        [
          [
            { class: "workspace", member: "" },
            { class: "bulk", member: "node_modules/x" },
          ],
        ],
        "unrestorable",
      ],
      [
        "raw bytes that disagree with the member",
        [
          [
            { class: "workspace", member: escapedMember, raw_member: "69676e6f7265642f636166e8" },
            { class: "bulk", member: "node_modules/x" },
          ],
        ],
        "unrestorable",
      ],
      [
        "an unknown class",
        [
          [
            { class: "harness", member: "x" },
            { class: "bulk", member: "node_modules/x" },
          ],
        ],
        "unrestorable",
      ],
    ];
    let index = 0;
    for (const [label, crossLinks, expected] of cases) {
      index += 1;
      const wt = WorktreeId.make(`wt-cross-links-${index}`);
      const section = withMeta(wt, documentOf({ ...plainDocument, cross_links: crossLinks }));
      const result = await registerOnce(wt, section.workspace, section.objects);
      expect(result.said, label).toBe(expected === "ok" ? "ok" : `CaptureRouteError:${expected}`);
    }
  });

  it("validates the manifest as stored: a request whose copy differs from the stored bytes is refused", async () => {
    const wt = WorktreeId.make("wt-meta-request-differs");
    // The stored manifest names an impossible metadata document; the request's copy leaves it
    // out, so a check of the request alone would pass.
    const result = await registerOnce(
      wt,
      {
        root: "",
        packs: [],
        worktree_meta: { format: 1, size: 42, sha256: "a".repeat(64), chunks: [], packs: [] },
      },
      new Map(),
      (manifest) => ({
        ...manifest,
        sections: { ...manifest.sections, workspace: { root: "", packs: [] } },
      }),
    );
    expect(result).toEqual({ said: "CaptureRouteError:bad-request", head: null });
  });
});

describe("capture.register checks the metadata against the tree it applies to (review 2026-09-28 (3) #20)", () => {
  it("refuses a final whose metadata names a file no captured class holds", async () => {
    const wt = WorktreeId.make("wt-review3-missing-meta-file");
    const section = withMeta(
      wt,
      documentOf({
        format: 1,
        entries: [{ path: "missing-work.txt", kind: "file", mode: 0o644, mtime: 0 }],
      }),
    );
    // Over the tree the git section names, observed without that path.
    const observed = await registerOnce(wt, section.workspace, section.objects, undefined, {
      tracked: {},
    });
    expect(observed).toEqual({ said: "CaptureRouteError:unrestorable", head: null });
  });

  it("refuses a file named as a symlink, and a directory over a file", async () => {
    for (const [label, entry] of [
      ["a file named as a symlink", { path: "a", kind: "symlink", mtime: 0 }],
      ["a directory over a file", { path: "b", kind: "dir", mode: 0o755, mtime: 0 }],
    ] as const) {
      const wt = WorktreeId.make(`wt-review3-kind-${label.length}`);
      const section = withMeta(wt, documentOf({ format: 1, entries: [entry] }));
      const result = await registerOnce(wt, section.workspace, section.objects);
      expect(result, label).toEqual({ said: "CaptureRouteError:unrestorable", head: null });
    }
  });

  it("registers, unsealed, a document it could not check (the tree could not be listed)", async () => {
    const wt = WorktreeId.make("wt-review3-meta-unlisted");
    const section = withMeta(wt, documentOf(plainDocument));
    const result = await registerOnce(wt, section.workspace, section.objects, undefined, {
      tracked: null,
    });
    expect(result.said).toBe("ok");
  });
});

describe("capture.register records a completed final flush on the chain (cross-repo decision 1)", () => {
  const sealedRegister = async (
    seal: object | undefined,
    options?: {
      readonly executorId?: string;
      readonly verifier?: Layer.Layer<CaptureGitVerifier>;
    },
  ) => {
    const wt = WorktreeId.make("wt-seal");
    // Mend observed the git section verify: a seal rests on nothing less (review 3 #18).
    const world = worldOf(2, options?.verifier ?? verifierObserving({}));
    const zero = buildManifest({ worktreeId: wt, epoch: 1, n: 0, parent: null, kind: "auto" });
    // Every class captured: a seal over a pending bulk class seals nothing (review 5 #10).
    const base = buildManifest({
      worktreeId: wt,
      epoch: 1,
      n: 1,
      parent: zero.id,
      kind: "final",
      bulk: { root: "", packs: [], platform: "linux-x86_64-glibc" },
    });
    // The sealing capture: the final capture's manifest, carrying `final_seal`.
    const manifest = seal === undefined ? base.manifest : { ...base.manifest, final_seal: seal };
    const bytes = utf8(JSON.stringify(manifest));
    const id = sha256Hex(bytes);
    const key = captureKeys(wt, 1).manifest(id);
    return Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        yield* repo.init(wt);
        yield* repo.claim(wt, options?.executorId ?? "executor");
        yield* uploadObjects(
          new Map([
            [zero.key, zero.bytes],
            [key, bytes],
          ]),
        );
        const api = yield* apiOf(wt, options?.executorId ?? "executor");
        yield* api.register(registerInput(zero));
        const said = yield* outcome(
          api.register({
            worktree_id: wt,
            epoch: 1,
            n: 1,
            parent: zero.id,
            capture_id: id,
            manifest_key: key,
            manifest: JSON.parse(JSON.stringify(manifest)),
          }),
        );
        return {
          said,
          head: (yield* repo.headOf(wt))?.head?.id,
          id,
          sealed: yield* repo.sealedCompletion(wt, options?.executorId ?? "executor", 1),
          newest: yield* repo.sealedCompletion(wt, options?.executorId ?? "executor"),
        };
      }).pipe(Effect.provide(world.layer)),
    );
  };

  it("records a complete seal naming this executor and epoch, against the sealing capture", async () => {
    const result = await sealedRegister({ complete: true, epoch: 1, executor: "executor" });
    expect(result.said).toBe("ok");
    expect(result.head).toBe(result.id);
    expect(result.sealed).toMatchObject({
      epoch: 1,
      executorId: "executor",
      captureId: result.id,
      n: 1,
    });
    expect(result.newest?.captureId).toBe(result.id);
  });

  it("registers the capture but seals nothing over a git section Mend did not observe verify (review 3 #18)", async () => {
    const result = await sealedRegister(
      { complete: true, epoch: 1, executor: "executor" },
      { verifier: CaptureGitVerifierOff },
    );
    expect(result.said).toBe("ok");
    expect(result.head).toBe(result.id);
    expect(result.sealed).toBeNull();
  });

  it("registers the capture but seals nothing when the seal is incomplete, of another epoch or another executor, or absent", async () => {
    for (const seal of [
      { complete: false, epoch: 1, executor: "executor" },
      { complete: true, epoch: 2, executor: "executor" },
      { complete: true, epoch: 1, executor: "someone-else" },
      undefined,
    ]) {
      const result = await sealedRegister(seal);
      expect(result.said, JSON.stringify(seal)).toBe("ok");
      expect(result.head).toBe(result.id);
      expect(result.sealed, JSON.stringify(seal)).toBeNull();
      expect(result.newest).toBeNull();
    }
  });
});

describe("plan.get hands a head only to an executor that reads what it means (manifest_features)", () => {
  const escaped = `caf${String.fromCodePoint(0x10_ffe9)}`;
  /** A head (capture 0, registered by `writer`, lease released) holding one feature. */
  const headWith = (wt: WorktreeId, feature: string) =>
    Effect.gen(function* () {
      const repo = yield* CaptureStoreRepo;
      yield* repo.init(wt);
      const writer = yield* apiOf(wt, "writer");
      const { epoch } = yield* writer.planGet({
        epoch: 0,
        manifest_format: 2,
        manifest_features: [...MANIFEST_FEATURES],
      });
      const body = utf8("raw file");
      const plain: DirEntry = {
        name: "plain.txt",
        kind: "file",
        mode: 0o100644,
        size: body.byteLength,
        mtime: 1,
        chunks: [sha256Hex(body)],
      };
      const entries: ReadonlyArray<DirEntry> =
        feature === "raw_names" ? [{ ...plain, name: escaped, raw_name: "636166e9" }] : [plain];
      const hand = handWorkspace(wt, epoch, entries, [body]);
      const meta =
        feature === "worktree_meta"
          ? withMeta(
              wt,
              documentOf({
                format: 1,
                entries: [{ path: "", kind: "dir", mode: 0o755, mtime: 1 }],
              }),
            )
          : null;
      const workspace =
        meta === null
          ? hand.workspace
          : {
              ...hand.workspace,
              packs: [...hand.workspace.packs, ...meta.workspace.packs],
              worktree_meta: meta.workspace.worktree_meta,
            };
      const base = buildManifest({
        worktreeId: wt,
        epoch,
        n: 0,
        parent: null,
        kind: "final",
        workspace,
        ...(feature === "other_bulk"
          ? {
              otherBulk: {
                "linux-aarch64-gnu": { root: "", packs: [], platform: "linux-aarch64-gnu" },
              },
            }
          : {}),
        ...(feature === "symrefs"
          ? {
              git: {
                packs: [],
                refs: {},
                head: "refs/heads/main",
                fsck: "unverified" as const,
                symrefs: { "refs/remotes/origin/HEAD": "refs/remotes/origin/main" },
              },
            }
          : {}),
        ...(feature === "object_format"
          ? {
              git: {
                packs: [],
                refs: {},
                head: "refs/heads/main",
                fsck: "unverified" as const,
                object_format: "sha256",
              },
            }
          : {}),
        ...(feature === "ref_format"
          ? {
              git: {
                packs: [],
                refs: {},
                head: "refs/heads/main",
                fsck: "unverified" as const,
                ref_format: "reftable",
              },
            }
          : {}),
        ...(feature === "git_trees"
          ? {
              git: {
                packs: [],
                refs: { "refs/sealant/capture/my-work": "c".repeat(40) },
                head: "refs/heads/main",
                fsck: "unverified" as const,
                worktree_tree: "d".repeat(40),
                index_tree: "d".repeat(40),
                raw_tree: "e".repeat(40),
              },
            }
          : {}),
      });
      const manifest =
        feature === "final_seal"
          ? { ...base.manifest, final_seal: { complete: true, epoch, executor: "writer" } }
          : base.manifest;
      const bytes = utf8(JSON.stringify(manifest));
      const id = sha256Hex(bytes);
      const key = captureKeys(wt, epoch).manifest(id);
      yield* uploadObjects(new Map([...hand.objects, ...(meta?.objects ?? []), [key, bytes]]));
      yield* writer.register({
        worktree_id: wt,
        epoch,
        n: 0,
        parent: null,
        capture_id: id,
        manifest_key: key,
        manifest: JSON.parse(JSON.stringify(manifest)),
      });
      yield* repo.release(wt, epoch);
      return { id, epoch };
    });

  it("refuses each feature to an executor that does not list it, before the claim, and answers one that does", async () => {
    for (const feature of MANIFEST_FEATURES) {
      const wt = WorktreeId.make(`wt-feature-${feature}`);
      const world = worldOf();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const { id, epoch } = yield* headWith(wt, feature);
          const repo = yield* CaptureStoreRepo;
          const reader = yield* apiOf(wt, "reader");
          const others = MANIFEST_FEATURES.filter((other) => other !== feature);
          const refused = yield* reader
            .planGet({ epoch: 0, manifest_format: 2, manifest_features: others })
            .pipe(
              Effect.map(() => null),
              Effect.catch((error) => Effect.succeed(error)),
            );
          const lease = yield* repo.leaseOf(wt);
          const plan = yield* reader.planGet({
            epoch: 0,
            manifest_format: 2,
            manifest_features: [...MANIFEST_FEATURES],
          });
          return { refused, lease, epoch, id, plan };
        }).pipe(Effect.provide(world.layer)),
      );
      if (feature === "final_seal") {
        // A seal the store does not hold standing is never handed on (review 2026-09-28 (8) #5):
        // the plan carries the head without it, so it needs no reader. A standing seal is refused
        // to an executor that does not read it (capture-verify.test.ts, review 8 #5).
        expect(result.refused, feature).toBeNull();
        expect(result.plan.head?.manifest.final_seal, feature).toBeUndefined();
        continue;
      }
      expect(result.refused?.reason, feature).toBe("manifest-features");
      expect(result.refused?.status, feature).toBe(409);
      expect(result.refused?.missing, feature).toEqual([feature]);
      // Refused before the claim: the epoch did not move, nobody holds the lease.
      expect(result.lease?.epoch, feature).toBe(result.epoch);
      expect(result.lease?.live, feature).toBe(false);
      expect(result.plan.head?.capture_id, feature).toBe(result.id);
      expect(result.plan.manifest_features, feature).toEqual(MANIFEST_FEATURES);
    }
  });

  it("an escaped key in the git section — a ref name, a symbolic ref or its target, HEAD — holds raw_names", async () => {
    const escapedRef = `refs/heads/caf${String.fromCodePoint(0x10_ffe9)}`;
    const gits = {
      ref: { refs: { [escapedRef]: "a".repeat(40) } },
      "symref name": { symrefs: { [escapedRef]: "refs/heads/main" } },
      "symref target": { symrefs: { "refs/remotes/origin/HEAD": escapedRef } },
      head: { head: escapedRef },
    };
    const outcomes: Record<string, [string, string]> = {};
    for (const [label, git] of Object.entries(gits)) {
      const wt = WorktreeId.make(`wt-raw-ref-${label.replaceAll(" ", "-")}`);
      const world = worldOf();
      outcomes[label] = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* CaptureStoreRepo;
          yield* repo.init(wt);
          const writer = yield* apiOf(wt, "writer");
          const { epoch } = yield* writer.planGet({ epoch: 0, manifest_format: 2 });
          const built = buildManifest({
            worktreeId: wt,
            epoch,
            n: 0,
            parent: null,
            git: { packs: [], refs: {}, head: "refs/heads/main", fsck: "unverified", ...git },
          });
          yield* uploadObjects(new Map([[built.key, built.bytes]]));
          yield* writer.register(registerInput(built));
          yield* repo.release(wt, epoch);
          const reader = yield* apiOf(wt, "reader");
          const everything = MANIFEST_FEATURES.filter((feature) => feature !== "raw_names");
          const refused = yield* reader
            .planGet({ epoch: 0, manifest_format: 2, manifest_features: everything })
            .pipe(
              Effect.map(() => "ok"),
              Effect.catch((error) => Effect.succeed(`${error.reason}:${String(error.missing)}`)),
            );
          const answered = yield* outcome(
            reader.planGet({
              epoch: 0,
              manifest_format: 2,
              manifest_features: [...MANIFEST_FEATURES],
            }),
          );
          return [refused, answered] as [string, string];
        }).pipe(Effect.provide(world.layer)),
      );
    }
    for (const label of Object.keys(gits)) {
      expect(outcomes[label], label).toEqual(["manifest-features:raw_names", "ok"]);
    }
  });

  it("an executor that names no features is handed a head that holds none", async () => {
    const wt = WorktreeId.make("wt-feature-none");
    const world = worldOf();
    const plan = await Effect.runPromise(
      Effect.gen(function* () {
        yield* headWith(wt, "none");
        return yield* (yield* apiOf(wt, "reader")).planGet({ epoch: 0, manifest_format: 2 });
      }).pipe(Effect.provide(world.layer)),
    );
    expect(plan.head).not.toBeNull();
  });

  it("an executor on another platform than the head's bulk section must carry other_bulk", async () => {
    const wt = WorktreeId.make("wt-feature-platform");
    const world = worldOf();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        yield* repo.init(wt);
        const writer = yield* apiOf(wt, "writer");
        const { epoch } = yield* writer.planGet({ epoch: 0, manifest_format: 2 });
        const built = buildManifest({
          worktreeId: wt,
          epoch,
          n: 0,
          parent: null,
          kind: "final",
          bulk: { root: "", packs: [], platform: "linux-aarch64-gnu" },
        });
        yield* uploadObjects(new Map([[built.key, built.bytes]]));
        yield* writer.register(registerInput(built));
        yield* repo.release(wt, epoch);
        const reader = yield* apiOf(wt, "reader");
        const samePlatform = yield* outcome(
          reader.planGet({ epoch: 0, manifest_format: 2, platform: "linux-aarch64-gnu" }),
        );
        yield* repo.release(wt, epoch + 1);
        const otherPlatform = yield* outcome(
          reader.planGet({ epoch: 0, manifest_format: 2, platform: "linux-x86_64-gnu" }),
        );
        return { samePlatform, otherPlatform };
      }).pipe(Effect.provide(world.layer)),
    );
    expect(result).toEqual({
      samePlatform: "ok",
      otherPlatform: "CaptureRouteError:manifest-features",
    });
  });
});

describe("a lease is held by a launch (review 2026-09-28 (4) #11, cross-repo decision 11)", () => {
  const planAsk = { epoch: 0, manifest_format: 2, manifest_features: MANIFEST_FEATURES };

  it("an older launch's token of the same session never learns, renews or registers under the replacement's epoch", async () => {
    const wt = WorktreeId.make("wt-stale-launch");
    const world = worldOf(2, verifierObserving({}));
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        yield* repo.init(wt);
        const oldApi = yield* apiOf(wt, "session-1", "launch-old");
        const newApi = yield* apiOf(wt, "session-1", "launch-new");
        const oldPlan = yield* oldApi.planGet(planAsk);
        // The old executor's end was observed: its lease released, the replacement claims.
        yield* repo.release(wt, oldPlan.epoch);
        const newPlan = yield* newApi.planGet(planAsk);
        // The old launch asks again, by zero and by the replacement's epoch.
        const staleByZero = yield* outcome(oldApi.planGet(planAsk));
        const staleByEpoch = yield* outcome(oldApi.planGet({ ...planAsk, epoch: newPlan.epoch }));
        const staleHeartbeat = yield* outcome(
          oldApi.heartbeat({ worktree_id: wt, epoch: newPlan.epoch }),
        );
        const staleUpload = yield* outcome(
          oldApi.uploadUrls({
            worktree_id: wt,
            epoch: newPlan.epoch,
            keys: [captureKeys(wt, newPlan.epoch).pack("a".repeat(64))],
          }),
        );
        // Its bytes, sealed as its own, registered under the replacement's epoch.
        const source = freshDir("stale-launch-content");
        fs.writeFileSync(path.join(source, "work.txt"), "bytes from the retired executor");
        const snapshot = snapshotDirectory(source, captureKeys(wt, newPlan.epoch), { format: 2 });
        const built = buildManifest({
          worktreeId: wt,
          epoch: newPlan.epoch,
          n: 0,
          parent: null,
          kind: "final",
          workspace: sectionOf(snapshot),
        });
        const manifest = {
          ...built.manifest,
          final_seal: { complete: true, epoch: newPlan.epoch, executor: "launch-old" },
        };
        const bytes = utf8(JSON.stringify(manifest));
        const id = sha256Hex(bytes);
        const key = captureKeys(wt, newPlan.epoch).manifest(id);
        yield* uploadObjects(new Map([...snapshot.objects, [key, bytes]]));
        const registered = yield* outcome(
          oldApi.register({
            worktree_id: wt,
            epoch: newPlan.epoch,
            n: 0,
            parent: null,
            capture_id: id,
            manifest_key: key,
            manifest,
          }),
        );
        const seal = yield* repo.sealedCompletion(wt, "launch-old", newPlan.epoch);
        // The replacement's own lease is untouched and renews.
        const newHeartbeat = yield* outcome(
          newApi.heartbeat({ worktree_id: wt, epoch: newPlan.epoch }),
        );
        return {
          oldEpoch: oldPlan.epoch,
          newEpoch: newPlan.epoch,
          staleByZero,
          staleByEpoch,
          staleHeartbeat,
          staleUpload,
          registered,
          seal,
          newHeartbeat,
          head: (yield* repo.headOf(wt))?.head ?? null,
        };
      }).pipe(Effect.provide(world.layer)),
    );
    expect(result.newEpoch).toBeGreaterThan(result.oldEpoch);
    expect(result.staleByZero).toBe("CaptureRouteError:worktree-leased");
    expect(result.staleByEpoch).toBe("CaptureRouteError:worktree-leased");
    expect(result.staleHeartbeat).toBe("CaptureRouteError:lease-lost");
    expect(result.staleUpload).toBe("CaptureRouteError:lease-lost");
    expect(result.registered).toBe("CaptureRouteError:lease-lost");
    expect(result.seal).toBeNull();
    expect(result.head).toBeNull();
    expect(result.newHeartbeat).toBe("ok");
  });

  it("the store refuses a register and a heartbeat of another launch under a held epoch, whoever calls it", async () => {
    const wt = WorktreeId.make("wt-store-launch");
    const world = worldOf(2, verifierObserving({}));
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        yield* repo.init(wt);
        // A claim that lapsed at once: only its own launch takes it again.
        yield* repo.claim(wt, "session-1", 0, "launch-new");
        const retake = yield* outcome(repo.claim(wt, "session-1", 30, "launch-old"));
        const claimed = yield* repo.claim(wt, "session-1", 30, "launch-new");
        const beat = yield* repo.heartbeat(wt, claimed.epoch, 30, {
          executorId: "session-1",
          launchId: "launch-old",
        });
        const own = yield* repo.heartbeat(wt, claimed.epoch, 30, {
          executorId: "session-1",
          launchId: "launch-new",
        });
        return { retake, claimed, beat, own, lease: yield* repo.leaseOf(wt) };
      }).pipe(Effect.provide(world.layer)),
    );
    expect(result.retake).toBe("WorktreeLeasedError");
    expect(result.claimed.epoch).toBe(2);
    expect(result.beat).toBe(false);
    expect(result.own).toBe(true);
    expect(result.lease?.launchId).toBe("launch-new");
  });
});

describe("a seal rests on chunk bytes that read (review 2026-09-28 (4) #13)", () => {
  const sealedRegister = (wt: WorktreeId, corrupt: boolean) =>
    Effect.gen(function* () {
      const body = utf8(`irreplaceable content ${corrupt ? "damaged" : "intact"}`);
      const entry: DirEntry = {
        name: "unique.txt",
        kind: "file",
        mode: 0o100644,
        size: body.length,
        mtime: 1,
        chunks: [sha256Hex(body)],
      };
      const source = handWorkspace(wt, 1, [entry], [body]);
      const packKey = source.workspace.packs[0] ?? "";
      const packBytes = source.objects.get(packKey);
      if (packBytes === undefined) throw new Error("no content pack");
      const objects = new Map(source.objects);
      let workspace = source.workspace;
      if (corrupt) {
        // The frame's first byte flipped, the index intact, the whole pack keyed by its new
        // digest: content addressing alone holds.
        const damaged = new Uint8Array(packBytes);
        damaged[0] = (damaged[0] ?? 0) ^ 0xff;
        const damagedKey = captureKeys(wt, 1).pack(sha256Hex(damaged));
        objects.delete(packKey);
        objects.set(damagedKey, damaged);
        workspace = { ...source.workspace, packs: [damagedKey] };
      }
      const base = buildManifest({
        worktreeId: wt,
        epoch: 1,
        n: 0,
        parent: null,
        kind: "final",
        workspace,
        bulk: { root: "", packs: [], platform: "linux-x86_64-glibc" },
      });
      const manifest = {
        ...base.manifest,
        final_seal: { complete: true, epoch: 1, executor: "executor" },
      };
      const bytes = utf8(JSON.stringify(manifest));
      const id = sha256Hex(bytes);
      const key = captureKeys(wt, 1).manifest(id);
      const repo = yield* CaptureStoreRepo;
      yield* repo.init(wt);
      yield* repo.claim(wt, "executor");
      const api = yield* apiOf(wt);
      yield* uploadObjects(new Map([...objects, [key, bytes]]));
      const registered = yield* outcome(
        api.register({
          worktree_id: wt,
          epoch: 1,
          n: 0,
          parent: null,
          capture_id: id,
          manifest_key: key,
          manifest,
        }),
      );
      const seal = yield* repo.sealedCompletion(wt, "executor", 1);
      const head = (yield* repo.headOf(wt))?.head ?? null;
      return { registered, sealed: seal?.captureId === id, headId: head?.id ?? null, id };
    });

  it("a content-addressed pack whose compressed frame does not decode registers (kept for salvage) and seals nothing", async () => {
    const world = worldOf(2, verifierObserving({}));
    const result = await Effect.runPromise(
      sealedRegister(WorktreeId.make("wt-bad-chunk"), true).pipe(Effect.provide(world.layer)),
    );
    expect(result.registered).toBe("ok");
    expect(result.headId).toBe(result.id);
    expect(result.sealed).toBe(false);
  });

  it("the same capture over intact bytes is sealed", async () => {
    const world = worldOf(2, verifierObserving({}));
    const result = await Effect.runPromise(
      sealedRegister(WorktreeId.make("wt-good-chunk"), false).pipe(Effect.provide(world.layer)),
    );
    expect(result.registered).toBe("ok");
    expect(result.sealed).toBe(true);
  });
});

/** One route through the dispatcher: the request decoded as it arrives off the wire. */
const routedPlan = (api: SessionCaptureApi, body: unknown) =>
  Effect.promise(
    () =>
      new Promise<{ status: number; json: Record<string, unknown> }>((resolve) => {
        void dispatchCaptureRoute(api, "/plan.get", body, (status, payload) =>
          resolve({ status, json: JSON.parse(JSON.stringify(payload)) }),
        );
      }),
  );

describe("plan.get, as sealantd round 4 asks it", () => {
  it("every answer lists all seven manifest features — sealantd answers `store-fidelity` to any FINAL otherwise", async () => {
    const world = worldOf();
    const wt = WorktreeId.make("wt-plan-features");
    const answers = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        yield* repo.init(wt);
        const api = yield* apiOf(wt, "exec-features", "launch-features");
        const empty = yield* routedPlan(api, { epoch: 0, manifest_format: 2 });
        const zero = buildManifest({ worktreeId: wt, epoch: 1, n: 0, parent: null });
        yield* uploadObjects(new Map([[zero.key, zero.bytes]]));
        yield* api.register(registerInput(zero));
        const overHead = yield* routedPlan(api, { epoch: 1, manifest_format: 2 });
        const standby = (yield* CaptureChannel).standbyApiFor({
          alias: "standby",
          projectId: ProjectId.make("p"),
          executorId: "standby-exec",
          epoch: 7,
          plan: () =>
            Effect.succeed({ captureId: zero.id, manifestKey: zero.key, manifest: zero.manifest }),
        });
        const onStandby = yield* routedPlan(standby, { manifest_format: 2 });
        return [empty, overHead, onStandby];
      }).pipe(Effect.provide(world.layer)),
    );
    for (const answer of answers) {
      expect(answer.status).toBe(200);
      expect(answer.json["manifest_features"]).toEqual([
        "worktree_meta",
        "symrefs",
        "other_bulk",
        "raw_names",
        "final_seal",
        "git_trees",
        "object_format",
        "ref_format",
      ]);
    }
  });

  it("a request naming a launch its token was not issued for is refused 409 `launch-mismatch`, before any claim; its own launch, or none, plans", async () => {
    const world = worldOf();
    const wt = WorktreeId.make("wt-plan-launch");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        yield* repo.init(wt);
        const api = yield* apiOf(wt, "session-1", "launch-a");
        const other = yield* routedPlan(api, { epoch: 0, manifest_format: 2, launch: "launch-b" });
        const leaseAfterRefusal = yield* repo.leaseOf(wt);
        const own = yield* routedPlan(api, { epoch: 0, manifest_format: 2, launch: "launch-a" });
        const unnamed = yield* routedPlan(api, { epoch: 0, manifest_format: 2 });
        const standby = (yield* CaptureChannel).standbyApiFor({
          alias: "standby",
          projectId: ProjectId.make("p"),
          executorId: "standby-exec",
          launchId: "standby-launch",
          epoch: 7,
          plan: () => Effect.die("never planned"),
        });
        const standbyOther = yield* routedPlan(standby, { manifest_format: 2, launch: "launch-a" });
        return { other, leaseAfterRefusal, own, unnamed, standbyOther };
      }).pipe(Effect.provide(world.layer)),
    );
    expect(result.other.status).toBe(409);
    expect(result.other.json["reason"]).toBe("launch-mismatch");
    expect(result.other.json["live_epoch"]).toBeUndefined();
    expect(result.leaseAfterRefusal?.executorId ?? null).toBeNull();
    expect(result.own.status).toBe(200);
    expect(result.own.json["executor"]).toBe("launch-a");
    expect(result.unnamed.status).toBe(200);
    expect(result.standbyOther.status).toBe(409);
    expect(result.standbyOther.json["reason"]).toBe("launch-mismatch");
  });
});
