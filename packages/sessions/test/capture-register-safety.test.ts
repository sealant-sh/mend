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
  resolveCaptureUploadPolicy,
} from "../src/capture-channel.ts";
import { CaptureRemotesOff } from "../src/capture-remotes.ts";
import { CaptureSourcesOff } from "../src/capture-sources.ts";
import { CaptureGitVerifierOff } from "../src/capture-verify.ts";
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

const worldOf = (manifestFormat: 1 | 2 = 2) => {
  const memory = makeMemoryCaptureStore();
  const blobs = BlobStoreFsLive(freshDir("blobs"));
  const channel = CaptureChannelLive.pipe(
    Layer.provide(memory.layer),
    Layer.provide(blobs),
    Layer.provide(CaptureGitVerifierOff),
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

const apiOf = (wt: WorktreeId, executorId = "executor") =>
  Effect.map(CaptureChannel, (channel) =>
    channel.apiFor({
      worktreeId: wt,
      projectId: ProjectId.make("p"),
      executorId,
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
) => {
  const world = worldOf();
  const built = buildManifest({
    worktreeId: wt,
    epoch: 1,
    n: 0,
    parent: null,
    kind: "final",
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

describe("capture.register records a completed final flush on the chain (cross-repo decision 1)", () => {
  const sealedRegister = async (
    seal: object | undefined,
    options?: { readonly executorId?: string },
  ) => {
    const wt = WorktreeId.make("wt-seal");
    const world = worldOf();
    const zero = buildManifest({ worktreeId: wt, epoch: 1, n: 0, parent: null, kind: "auto" });
    const base = buildManifest({ worktreeId: wt, epoch: 1, n: 1, parent: zero.id, kind: "final" });
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
