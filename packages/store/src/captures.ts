import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import * as zlib from "node:zlib";

import { Effect, Schema } from "effect";

import { type BlobNotFoundError, BlobStore, type BlobStoreError } from "./blob-store.ts";
import { git, type GitError } from "./git.ts";

/**
 * The capture format of sealantd ADR-0015 ("Capture format"), read-side only: Mend never writes
 * a capture (project promotion is a server-side copy of whole objects). Everything here is pure
 * over bytes except `materialize`, which fetches through `BlobStore` and writes a directory.
 *
 * Mend reads these manifest fields and no others (ADR-0002): `worktree_id`, `n`, `parent`,
 * `epoch`, `seq`, `kind`, `created_at`, `sections.git.{packs, refs, head, fsck}`,
 * `sections.workspace.{root, packs}`, `sections.bulk.{root, packs, platform} | "pending"`,
 * `checkpoint?.{ordinal, sha, ref}`. Unknown fields pass through undecoded.
 */

// ─── Manifest ───────────────────────────────────────────────────────────────

export const CaptureKind = Schema.Literals(["auto", "turn", "checkpoint", "suspend", "final"]);
export type CaptureKind = typeof CaptureKind.Type;

export const GitFsckOutcome = Schema.Literals(["verified", "failed", "unverified"]);
export type GitFsckOutcome = typeof GitFsckOutcome.Type;

export const GitSection = Schema.Struct({
  packs: Schema.Array(Schema.String),
  refs: Schema.Record(Schema.String, Schema.String),
  head: Schema.String,
  fsck: GitFsckOutcome,
});
export type GitSection = typeof GitSection.Type;

export const WorkspaceSection = Schema.Struct({
  root: Schema.String,
  packs: Schema.Array(Schema.String),
});
export type WorkspaceSection = typeof WorkspaceSection.Type;

export const BulkSectionReady = Schema.Struct({
  root: Schema.String,
  packs: Schema.Array(Schema.String),
  platform: Schema.String,
});
export const BulkSection = Schema.Union([BulkSectionReady, Schema.Literal("pending")]);
export type BulkSection = typeof BulkSection.Type;

export const CaptureCheckpoint = Schema.Struct({
  ordinal: Schema.Int,
  sha: Schema.String,
  ref: Schema.String,
});

export const CaptureManifest = Schema.Struct({
  worktree_id: Schema.String,
  n: Schema.Int,
  parent: Schema.NullOr(Schema.String),
  epoch: Schema.Int,
  seq: Schema.Int,
  kind: CaptureKind,
  created_at: Schema.String,
  sections: Schema.Struct({
    git: GitSection,
    workspace: WorkspaceSection,
    bulk: BulkSection,
  }),
  checkpoint: Schema.optionalKey(CaptureCheckpoint),
});
export type CaptureManifest = typeof CaptureManifest.Type;

/** The two CDC-packed classes a manifest can materialize; git is served by the runner. */
export type CaptureClass = "workspace" | "bulk";

/**
 * Pseudo-refs sealantd adds beside the repository's refs (sealantd `manifest.rs`): a tree of
 * the working tree at snap time — tracked files with their uncommitted edits plus untracked,
 * non-ignored files — and the tree written from the index. Both are pack closure tips; Mend's
 * runner diffs against the first exactly where the co-located store ran `add -A; write-tree`.
 */
export const WORKTREE_TREE_REF = "refs/sealant/capture/worktree";
export const INDEX_TREE_REF = "refs/sealant/capture/index";
export const PSEUDO_REF_PREFIX = "refs/sealant/capture/";

/**
 * The change summary an executor posts after a `checkpoint` register (ADR-0002 "Review"):
 * the same shape the review page computes on a runner, so a claimed and an observed summary
 * are comparable field by field. Shape owned by Mend; sealantd sends it as opaque JSON.
 */
export const ChangeSummaryFile = Schema.Struct({
  path: Schema.String,
  additions: Schema.Int,
  deletions: Schema.Int,
});
export const ChangeSummary = Schema.Struct({
  base_sha: Schema.String,
  files: Schema.Array(ChangeSummaryFile),
  diff: Schema.String,
});
export type ChangeSummary = typeof ChangeSummary.Type;
export const decodeChangeSummary = Schema.decodeUnknownEffect(ChangeSummary);

/** Where a posted summary lands: `changes/<worktree>/<n>/summary.json`, written by Mend. */
export const changeSummaryKey = (worktreeId: string, n: number) =>
  `changes/${worktreeId}/${n}/summary.json`;

// ─── Dir objects ────────────────────────────────────────────────────────────

export const DirEntryKind = Schema.Literals(["file", "symlink", "dir", "hardlink-group"]);
export type DirEntryKind = typeof DirEntryKind.Type;

/**
 * One entry of a directory listing. `mtime` is seconds since the epoch (fractional allowed);
 * an RFC 3339 string is accepted too — ADR-0015 fixes the field, not its unit, and both are
 * unambiguous to read. `chunks` for files, `target` for symlinks and hardlink groups (the
 * group's canonical path, relative to the class root), `child` for directories.
 */
export const DirEntry = Schema.Struct({
  name: Schema.String,
  kind: DirEntryKind,
  mode: Schema.Int,
  size: Schema.Int,
  mtime: Schema.Union([Schema.Number, Schema.String]),
  chunks: Schema.optionalKey(Schema.Array(Schema.String)),
  target: Schema.optionalKey(Schema.String),
  child: Schema.optionalKey(Schema.String),
  group: Schema.optionalKey(Schema.String),
});
export type DirEntry = typeof DirEntry.Type;

/** A dir object is its entries, sorted by name. */
export const DirObject = Schema.Array(DirEntry);
export type DirObject = typeof DirObject.Type;

/**
 * On the wire a dir object is `{"entries": [...]}` — sealantd's `tree::DirObject` (serde of a
 * struct with one field), the form every executor-written tree has (observed: the daemon's
 * materialiser rejects a bare array with "expected struct DirObject with 1 element"). The bare
 * array is still read, so nothing Mend wrote before this reading is unreadable.
 */
const DirObjectWire = Schema.Union([
  Schema.Struct({ entries: Schema.Array(DirEntry) }),
  Schema.Array(DirEntry),
]);

/** The bytes of a dir object as the daemon writes and reads them. */
export const encodeDirObject = (entries: DirObject): Uint8Array =>
  new Uint8Array(Buffer.from(JSON.stringify({ entries }), "utf8"));

// ─── Errors ─────────────────────────────────────────────────────────────────

export class CaptureFormatError extends Schema.TaggedErrorClass<CaptureFormatError>()(
  "CaptureFormatError",
  { key: Schema.String, reason: Schema.String },
) {}

/** Bytes did not hash to what their key or index promised. */
export class CaptureIntegrityError extends Schema.TaggedErrorClass<CaptureIntegrityError>()(
  "CaptureIntegrityError",
  { key: Schema.String, expected: Schema.String, actual: Schema.String },
) {}

export class ChunkNotFoundError extends Schema.TaggedErrorClass<ChunkNotFoundError>()(
  "ChunkNotFoundError",
  { hash: Schema.String },
) {}

export class CaptureSectionPendingError extends Schema.TaggedErrorClass<CaptureSectionPendingError>()(
  "CaptureSectionPendingError",
  { section: Schema.String },
) {}

/** A filesystem write under the target directory failed (permissions, a non-empty target…). */
export class MaterializeError extends Schema.TaggedErrorClass<MaterializeError>()(
  "MaterializeError",
  { at: Schema.String, cause: Schema.Defect() },
) {}

export type CaptureReadError =
  | CaptureFormatError
  | CaptureIntegrityError
  | ChunkNotFoundError
  | BlobNotFoundError
  | BlobStoreError;

// ─── Keys and digests ───────────────────────────────────────────────────────

export const sha256Hex = (bytes: Uint8Array): string =>
  crypto.createHash("sha256").update(bytes).digest("hex");

/** ADR-0015's capture id: the digest of the manifest's bytes as stored. */
export const captureIdOf = (manifestBytes: Uint8Array): string => sha256Hex(manifestBytes);

/** Key layout, fixed with ADR-0015; `<sha256>` is the lowercase hex digest of the object. */
export const captureKeys = (worktreeId: string, epoch: number) => {
  const base = `captures/${worktreeId}/${epoch}`;
  return {
    pack: (sha: string) => `${base}/packs/${sha}`,
    packIdx: (sha: string) => `${base}/packs/${sha}.idx`,
    tree: (sha: string) => `${base}/trees/${sha}`,
    manifest: (captureId: string) => `${base}/manifests/${captureId}`,
  };
};

const HEX64 = /^[0-9a-f]{64}$/;

/** The digest a content-addressed key promises: its last path segment (minus `.idx`). */
export const digestOfKey = (key: string): string | null => {
  const last = key.slice(key.lastIndexOf("/") + 1).replace(/\.idx$/, "");
  return HEX64.test(last) ? last : null;
};

/** Git pack keys travel as `packs/<sha>` with the index at `packs/<sha>.idx`. */
export const packIdxKeyOf = (packKey: string): string => `${packKey}.idx`;

const verifyDigest = (key: string, bytes: Uint8Array) => {
  const expected = digestOfKey(key);
  if (expected === null) return Effect.void;
  const actual = sha256Hex(bytes);
  return actual === expected
    ? Effect.void
    : Effect.fail(new CaptureIntegrityError({ key, expected, actual }));
};

// ─── Codec ──────────────────────────────────────────────────────────────────

const decodeJson =
  <S extends Schema.Codec<unknown, unknown, never, unknown>>(schema: S, what: string) =>
  (key: string, bytes: Uint8Array): Effect.Effect<S["Type"], CaptureFormatError> =>
    Effect.try({
      try: () => Schema.decodeUnknownSync(schema)(JSON.parse(Buffer.from(bytes).toString("utf8"))),
      catch: (cause) =>
        new CaptureFormatError({
          key,
          reason: `${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });

export const decodeManifest = decodeJson(CaptureManifest, "manifest");
const decodeDirObjectWire = decodeJson(DirObjectWire, "dir object");
const isWrappedDirObject = (
  wire: typeof DirObjectWire.Type,
): wire is { readonly entries: DirObject } => !Array.isArray(wire);
export const decodeDirObject = (
  key: string,
  bytes: Uint8Array,
): Effect.Effect<DirObject, CaptureFormatError> =>
  decodeDirObjectWire(key, bytes).pipe(
    Effect.map((wire): DirObject => (isWrappedDirObject(wire) ? wire.entries : wire)),
  );

// ─── CDC packs ──────────────────────────────────────────────────────────────

export const CDC_PACK_MAGIC = "SLCP0001";
const MAGIC_BYTES = Buffer.from(CDC_PACK_MAGIC, "ascii");

export const PackIndexEntry = Schema.Struct({
  hash: Schema.String,
  /** Compressed offset and length inside the pack. */
  offset: Schema.Int,
  length: Schema.Int,
  /** Uncompressed size. */
  size: Schema.Int,
});
export type PackIndexEntry = typeof PackIndexEntry.Type;
const PackIndex = Schema.Array(PackIndexEntry);

/**
 * Parse the trailing index: `… | index JSON | u64 LE index length | "SLCP0001"`. Offsets are
 * checked against the pack's extent so a corrupt index cannot read past it.
 */
export const readPackIndex = (
  key: string,
  pack: Uint8Array,
): Effect.Effect<ReadonlyArray<PackIndexEntry>, CaptureFormatError> =>
  Effect.gen(function* () {
    const buffer = Buffer.from(pack.buffer, pack.byteOffset, pack.byteLength);
    if (buffer.length < 16) {
      return yield* new CaptureFormatError({ key, reason: "pack shorter than its trailer" });
    }
    const magic = buffer.subarray(buffer.length - 8);
    if (!magic.equals(MAGIC_BYTES)) {
      return yield* new CaptureFormatError({ key, reason: "bad pack magic" });
    }
    const indexLength = buffer.readBigUInt64LE(buffer.length - 16);
    const dataEnd = BigInt(buffer.length - 16) - indexLength;
    if (dataEnd < 0n) {
      return yield* new CaptureFormatError({ key, reason: "index length exceeds pack" });
    }
    const indexStart = Number(dataEnd);
    const entries = yield* decodeJson(PackIndex, "pack index")(
      key,
      buffer.subarray(indexStart, buffer.length - 16),
    );
    for (const entry of entries) {
      if (entry.offset < 0 || entry.length < 0 || entry.offset + entry.length > indexStart) {
        return yield* new CaptureFormatError({
          key,
          reason: `chunk ${entry.hash} lies outside the pack's data`,
        });
      }
    }
    return entries;
  });

/** Decompress one chunk and verify its hash and size against the index entry. */
export const readChunk = (
  key: string,
  pack: Uint8Array,
  entry: PackIndexEntry,
): Effect.Effect<Uint8Array, CaptureFormatError | CaptureIntegrityError> =>
  Effect.gen(function* () {
    const compressed = pack.subarray(entry.offset, entry.offset + entry.length);
    const bytes = yield* Effect.try({
      try: () =>
        // `maxOutputLength` must be ≥ 1; an empty chunk still decompresses to nothing.
        new Uint8Array(
          zlib.zstdDecompressSync(compressed, { maxOutputLength: Math.max(1, entry.size) }),
        ),
      catch: (cause) =>
        new CaptureFormatError({
          key,
          reason: `chunk ${entry.hash}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });
    if (bytes.byteLength !== entry.size) {
      return yield* new CaptureFormatError({
        key,
        reason: `chunk ${entry.hash}: size ${bytes.byteLength}, index says ${entry.size}`,
      });
    }
    const actual = sha256Hex(bytes);
    if (actual !== entry.hash) {
      return yield* new CaptureIntegrityError({ key, expected: entry.hash, actual });
    }
    return bytes;
  });

// ─── Chunk resolution across a manifest's packs ─────────────────────────────

export interface ChunkSource {
  /** The chunk's bytes, decompressed and verified. */
  readonly chunk: (hash: string) => Effect.Effect<Uint8Array, CaptureReadError>;
  /** Which pack holds a chunk; null when none of the listed packs does. */
  readonly locate: (
    hash: string,
  ) => { readonly pack: string; readonly entry: PackIndexEntry } | null;
}

/**
 * Index every pack a section lists (a chunk may sit in any of them, across epochs) and serve
 * chunks from at most `maxResident` fully fetched packs at a time, least recently used first.
 * Packs are sha256-verified on fetch, so a prior epoch's bytes are trusted only by content.
 */
export const makeChunkSource = (
  packKeys: ReadonlyArray<string>,
  options?: { readonly maxResident?: number },
): Effect.Effect<ChunkSource, CaptureReadError, BlobStore> =>
  Effect.gen(function* () {
    const store = yield* BlobStore;
    const maxResident = Math.max(1, options?.maxResident ?? 4);
    const where = new Map<string, { readonly pack: string; readonly entry: PackIndexEntry }>();
    const resident = new Map<string, Uint8Array>();

    const fetchPack = (key: string) =>
      Effect.gen(function* () {
        const bytes = yield* store.get(key);
        yield* verifyDigest(key, bytes);
        resident.delete(key);
        resident.set(key, bytes);
        while (resident.size > maxResident) {
          const oldest = resident.keys().next().value;
          if (oldest === undefined) break;
          resident.delete(oldest);
        }
        return bytes;
      });

    for (const key of packKeys) {
      const bytes = yield* fetchPack(key);
      const entries = yield* readPackIndex(key, bytes);
      for (const entry of entries) {
        // First listing wins; a chunk present in two packs carries the same bytes by definition.
        if (!where.has(entry.hash)) where.set(entry.hash, { pack: key, entry });
      }
    }

    const locate = (hash: string) => where.get(hash) ?? null;

    const chunk = (hash: string) =>
      Effect.gen(function* () {
        const location = where.get(hash);
        if (location === undefined) return yield* new ChunkNotFoundError({ hash });
        const cached = resident.get(location.pack);
        if (cached !== undefined) {
          // Touch: most recently used goes to the back of the map.
          resident.delete(location.pack);
          resident.set(location.pack, cached);
        }
        const bytes = cached ?? (yield* fetchPack(location.pack));
        return yield* readChunk(location.pack, bytes, location.entry);
      });

    return { chunk, locate };
  });

// ─── Materialize ────────────────────────────────────────────────────────────

export interface MaterializeStats {
  readonly dirs: number;
  readonly files: number;
  readonly symlinks: number;
  readonly hardlinks: number;
  readonly bytes: number;
}

const mtimeSeconds = (value: number | string): number =>
  typeof value === "number" ? value : Date.parse(value) / 1000;

const isSafeName = (name: string) =>
  name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0");

/** Never leave the root: resolve the relative path and check it stays inside. */
const insideRoot = (root: string, relative: string): string | null => {
  const resolved = path.resolve(root, relative);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
};

/**
 * Write one class of a capture into `targetDir` (created; expected empty or absent): files
 * chunk by chunk with every chunk sha256-verified, symlinks by target (never followed),
 * hardlink groups as links to the canonical member, modes and mtimes as recorded. Directory
 * mtimes are applied last so the writes beneath do not disturb them.
 */
export const materialize = (
  manifest: CaptureManifest,
  cls: CaptureClass,
  targetDir: string,
): Effect.Effect<
  MaterializeStats,
  CaptureReadError | CaptureSectionPendingError | MaterializeError,
  BlobStore
> =>
  Effect.gen(function* () {
    const section = manifest.sections[cls];
    if (section === "pending") return yield* new CaptureSectionPendingError({ section: cls });
    const store = yield* BlobStore;
    const source = yield* makeChunkSource(section.packs);
    const root = path.resolve(targetDir);
    const io = <A>(at: string, thunk: () => A) =>
      Effect.try({ try: thunk, catch: (cause) => new MaterializeError({ at, cause }) });
    yield* io(root, () => fs.mkdirSync(root, { recursive: true }));

    const stats = { dirs: 0, files: 0, symlinks: 0, hardlinks: 0, bytes: 0 };
    const dirTimes: Array<{ readonly at: string; readonly mtime: number }> = [];
    const deferredLinks: Array<{
      readonly at: string;
      readonly target: string;
      readonly key: string;
    }> = [];

    const readTree = (key: string) =>
      Effect.gen(function* () {
        const bytes = yield* store.get(key);
        yield* verifyDigest(key, bytes);
        return yield* decodeDirObject(key, bytes);
      });

    const writeFile = (at: string, entry: DirEntry, key: string) =>
      Effect.gen(function* () {
        const fd = yield* io(at, () => fs.openSync(at, "w"));
        let written = 0;
        const body = Effect.gen(function* () {
          for (const hash of entry.chunks ?? []) {
            const chunk = yield* source.chunk(hash);
            yield* io(at, () => fs.writeSync(fd, chunk));
            written += chunk.byteLength;
          }
          yield* io(at, () => fs.fchmodSync(fd, entry.mode & 0o7777));
        });
        yield* body.pipe(Effect.ensuring(Effect.sync(() => fs.closeSync(fd))));
        if (written !== entry.size) {
          return yield* new CaptureFormatError({
            key,
            reason: `${entry.name}: wrote ${written} bytes, entry says ${entry.size}`,
          });
        }
        const mtime = mtimeSeconds(entry.mtime);
        yield* io(at, () => fs.utimesSync(at, mtime, mtime));
        stats.files += 1;
        stats.bytes += written;
      });

    const link = (at: string, target: string, key: string) =>
      Effect.gen(function* () {
        const canonical = insideRoot(root, target);
        if (canonical === null) {
          return yield* new CaptureFormatError({
            key,
            reason: `hardlink target escapes: ${target}`,
          });
        }
        if (!fs.existsSync(canonical)) return false;
        yield* io(at, () => fs.linkSync(canonical, at));
        stats.hardlinks += 1;
        return true;
      });

    const walk = (
      key: string,
      dir: string,
    ): Effect.Effect<void, CaptureReadError | MaterializeError, never> =>
      Effect.gen(function* () {
        const entries = yield* readTree(key);
        for (const entry of entries) {
          if (!isSafeName(entry.name)) {
            return yield* new CaptureFormatError({ key, reason: `unsafe name "${entry.name}"` });
          }
          const at = path.join(dir, entry.name);
          const mode = entry.mode & 0o7777;
          switch (entry.kind) {
            case "dir": {
              const child = entry.child;
              if (child === undefined) {
                return yield* new CaptureFormatError({
                  key,
                  reason: `${entry.name}: dir without child`,
                });
              }
              yield* io(at, () => fs.mkdirSync(at, { mode }));
              stats.dirs += 1;
              yield* walk(child, at);
              yield* io(at, () => fs.chmodSync(at, mode));
              dirTimes.push({ at, mtime: mtimeSeconds(entry.mtime) });
              break;
            }
            case "file": {
              yield* writeFile(at, entry, key);
              break;
            }
            case "symlink": {
              const target = entry.target;
              if (target === undefined) {
                return yield* new CaptureFormatError({
                  key,
                  reason: `${entry.name}: symlink without target`,
                });
              }
              const mtime = mtimeSeconds(entry.mtime);
              yield* io(at, () => {
                fs.symlinkSync(target, at);
                fs.lutimesSync(at, mtime, mtime);
              });
              stats.symlinks += 1;
              break;
            }
            case "hardlink-group": {
              const target = entry.target;
              if (target === undefined) {
                return yield* new CaptureFormatError({
                  key,
                  reason: `${entry.name}: hardlink without target`,
                });
              }
              if (path.relative(root, at) === target) {
                // A writer that lists the canonical member as part of the group too.
                yield* writeFile(at, entry, key);
                break;
              }
              const linked = yield* link(at, target, key);
              if (!linked) deferredLinks.push({ at, target, key });
              break;
            }
          }
        }
      });

    yield* walk(section.root, root);
    // A member listed before its canonical path (a writer not in path order) links now.
    for (const pending of deferredLinks) {
      const linked = yield* link(pending.at, pending.target, pending.key);
      if (!linked) {
        return yield* new CaptureFormatError({
          key: pending.key,
          reason: `hardlink canonical member missing: ${pending.target}`,
        });
      }
    }
    // Post-order: every directory after everything beneath it.
    for (const { at, mtime } of dirTimes) yield* io(at, () => fs.utimesSync(at, mtime, mtime));
    return stats;
  });

// ─── Reading a class without materializing it ───────────────────────────────

const readTree = (key: string) =>
  Effect.gen(function* () {
    const store = yield* BlobStore;
    const bytes = yield* store.get(key);
    yield* verifyDigest(key, bytes);
    return yield* decodeDirObject(key, bytes);
  });

/** Every object key a class's dir objects name, root first — what a plan must presign. */
export const collectTreeKeys = (
  manifest: CaptureManifest,
  cls: CaptureClass,
  options?: { readonly limit?: number },
): Effect.Effect<ReadonlyArray<string>, CaptureReadError, BlobStore> =>
  Effect.gen(function* () {
    const section = manifest.sections[cls];
    if (section === "pending" || section.root === "") return [];
    const limit = options?.limit ?? 50_000;
    const out: Array<string> = [];
    const queue = [section.root];
    while (queue.length > 0 && out.length < limit) {
      const key = queue.shift();
      if (key === undefined) break;
      out.push(key);
      const entries = yield* readTree(key);
      for (const entry of entries) {
        if (entry.kind === "dir" && entry.child !== undefined) queue.push(entry.child);
      }
    }
    return out;
  });

/** Every blob key a manifest needs across its three sections: packs, indexes, dir objects. */
export const keysNeededBy = (
  manifest: CaptureManifest,
): Effect.Effect<ReadonlyArray<string>, CaptureReadError, BlobStore> =>
  Effect.gen(function* () {
    const keys = new Set<string>();
    for (const pack of manifest.sections.git.packs) {
      keys.add(pack);
      keys.add(packIdxKeyOf(pack));
    }
    for (const pack of manifest.sections.workspace.packs) keys.add(pack);
    const bulk = manifest.sections.bulk;
    if (bulk !== "pending") for (const pack of bulk.packs) keys.add(pack);
    for (const key of yield* collectTreeKeys(manifest, "workspace")) keys.add(key);
    for (const key of yield* collectTreeKeys(manifest, "bulk")) keys.add(key);
    return [...keys];
  });

/**
 * The dir object at `relPath` inside a class (`""` = the root), or null when the path names
 * nothing or a non-directory. Symlinks are never followed.
 */
export const listCaptureDir = (
  manifest: CaptureManifest,
  cls: CaptureClass,
  relPath: string,
): Effect.Effect<DirObject | null, CaptureReadError, BlobStore> =>
  Effect.gen(function* () {
    const section = manifest.sections[cls];
    if (section === "pending" || section.root === "") return null;
    let key = section.root;
    for (const segment of relPath.split("/").filter((part) => part !== "")) {
      const entries = yield* readTree(key);
      const next = entries.find((entry) => entry.name === segment);
      if (next === undefined || next.kind !== "dir" || next.child === undefined) return null;
      key = next.child;
    }
    return yield* readTree(key);
  });

/** The entry at `relPath` inside a class, or null. */
export const statCaptureEntry = (
  manifest: CaptureManifest,
  cls: CaptureClass,
  relPath: string,
): Effect.Effect<DirEntry | null, CaptureReadError, BlobStore> =>
  Effect.gen(function* () {
    const parts = relPath.split("/").filter((part) => part !== "");
    const name = parts.pop();
    if (name === undefined) return null;
    const parent = yield* listCaptureDir(manifest, cls, parts.join("/"));
    return parent?.find((entry) => entry.name === name) ?? null;
  });

/**
 * Stream one file of a class chunk by chunk, each chunk sha256-verified as it is decoded — a
 * 76 MB transcript never sits in memory whole. Fails before the first read when the path names
 * nothing or a non-file.
 */
export const readCaptureFile = (
  manifest: CaptureManifest,
  cls: CaptureClass,
  relPath: string,
): Effect.Effect<Readable, CaptureReadError | CaptureSectionPendingError, BlobStore> =>
  Effect.gen(function* () {
    const section = manifest.sections[cls];
    if (section === "pending") return yield* new CaptureSectionPendingError({ section: cls });
    const entry = yield* statCaptureEntry(manifest, cls, relPath);
    if (entry === null || (entry.kind !== "file" && entry.kind !== "hardlink-group")) {
      return yield* new CaptureFormatError({
        key: section.root,
        reason: `${relPath}: not a file in the ${cls} class`,
      });
    }
    const source = yield* makeChunkSource(section.packs);
    const chunks = [...(entry.chunks ?? [])];
    let at = 0;
    return new Readable({
      read() {
        const hash = chunks[at];
        if (hash === undefined) {
          this.push(null);
          return;
        }
        at += 1;
        Effect.runPromise(source.chunk(hash)).then(
          (bytes) => this.push(Buffer.from(bytes)),
          (error: unknown) =>
            this.destroy(error instanceof Error ? error : new Error(String(error))),
        );
      },
    });
  });

/** Read a whole capture file into memory — for small files only (manifests, summaries). */
export const readCaptureFileBytes = (
  manifest: CaptureManifest,
  cls: CaptureClass,
  relPath: string,
): Effect.Effect<Uint8Array, CaptureReadError | CaptureSectionPendingError, BlobStore> =>
  readCaptureFile(manifest, cls, relPath).pipe(
    Effect.flatMap((stream) =>
      Effect.tryPromise({
        try: () => collectStream(stream),
        catch: (cause) =>
          new CaptureFormatError({
            key: relPath,
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
      }),
    ),
  );

const collectStream = (stream: Readable): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const parts: Array<Buffer> = [];
    stream.on("data", (chunk: Buffer | string) =>
      parts.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
    );
    stream.on("error", reject);
    stream.on("end", () => resolve(new Uint8Array(Buffer.concat(parts))));
  });

/**
 * Walk a class and return every file path (class-root-relative) with its entry, newest mtime
 * first — how the harvest finds the newest transcript without a shell.
 */
export const listCaptureFiles = (
  manifest: CaptureManifest,
  cls: CaptureClass,
  under: string,
  options?: { readonly limit?: number },
): Effect.Effect<
  ReadonlyArray<{ readonly path: string; readonly entry: DirEntry }>,
  CaptureReadError,
  BlobStore
> =>
  Effect.gen(function* () {
    const limit = options?.limit ?? 20_000;
    const out: Array<{ readonly path: string; readonly entry: DirEntry }> = [];
    const root = yield* listCaptureDir(manifest, cls, under);
    if (root === null) return [];
    const prefix = under
      .split("/")
      .filter((part) => part !== "")
      .join("/");
    const queue: Array<{ readonly at: string; readonly entries: DirObject }> = [
      { at: prefix, entries: root },
    ];
    while (queue.length > 0 && out.length < limit) {
      const next = queue.shift();
      if (next === undefined) break;
      for (const entry of next.entries) {
        const at = next.at === "" ? entry.name : `${next.at}/${entry.name}`;
        if (entry.kind === "dir" && entry.child !== undefined) {
          queue.push({ at, entries: yield* readTree(entry.child) });
        } else if (entry.kind === "file" || entry.kind === "hardlink-group") {
          out.push({ path: at, entry });
        }
      }
    }
    return out.toSorted((a, b) => mtimeSeconds(b.entry.mtime) - mtimeSeconds(a.entry.mtime));
  });

// ─── Git packs ──────────────────────────────────────────────────────────────

/**
 * `git index-pack --verify` over a pack whose `.idx` sits beside it (`<base>.pack` +
 * `<base>.idx`): the index must match the pack and every object must be intact.
 */
export const verifyGitPack = (packPath: string): Effect.Effect<void, GitError> =>
  git(["index-pack", "--verify", packPath], path.dirname(packPath)).pipe(Effect.asVoid);
