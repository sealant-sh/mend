import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

import { Effect } from "effect";

import { BlobStore } from "../src/blob-store.ts";
import {
  type CaptureManifest,
  type DirEntry,
  type PackIndexEntry,
  CDC_PACK_MAGIC,
  captureIdOf,
  captureKeys,
  encodeDirObject,
  FORMAT_DIR_PACKS,
  sha256Hex,
  type WorkspaceSection,
} from "../src/captures.ts";

/**
 * A minimal writer of ADR-0015's capture format, kept in the test tree so the reader is proven
 * against the specification rather than against sealantd's implementation. It chunks at a fixed
 * size (the reader does not care how a writer chose boundaries), packs chunks into `SLCP0001`
 * containers, writes dir objects sorted by name, and builds manifests.
 */

// ─── CDC packs ──────────────────────────────────────────────────────────────

export const chunkBytes = (bytes: Uint8Array, chunkSize: number): Array<Uint8Array> => {
  if (bytes.byteLength === 0) return [];
  const out: Array<Uint8Array> = [];
  for (let at = 0; at < bytes.byteLength; at += chunkSize) {
    out.push(bytes.subarray(at, Math.min(bytes.byteLength, at + chunkSize)));
  }
  return out;
};

/** `[zstd chunks…][index JSON][u64 LE index length]["SLCP0001"]`. */
export const writeCdcPack = (
  chunks: ReadonlyArray<Uint8Array>,
): { readonly bytes: Uint8Array; readonly index: ReadonlyArray<PackIndexEntry> } => {
  const parts: Array<Buffer> = [];
  const index: Array<PackIndexEntry> = [];
  let offset = 0;
  for (const chunk of chunks) {
    const compressed = zlib.zstdCompressSync(chunk);
    parts.push(compressed);
    index.push({
      hash: sha256Hex(chunk),
      offset,
      length: compressed.length,
      size: chunk.byteLength,
    });
    offset += compressed.length;
  }
  const indexJson = Buffer.from(JSON.stringify(index), "utf8");
  const trailer = Buffer.alloc(8);
  trailer.writeBigUInt64LE(BigInt(indexJson.length));
  parts.push(indexJson, trailer, Buffer.from(CDC_PACK_MAGIC, "ascii"));
  return { bytes: new Uint8Array(Buffer.concat(parts)), index };
};

// ─── Directory snapshots ────────────────────────────────────────────────────

export interface Snapshot {
  /** The root dir object: its key in format 1, its digest in format 2. */
  readonly root: string;
  /** Pack keys, in the order the manifest should list them. */
  readonly packs: ReadonlyArray<string>;
  /** The section format the snapshot was written in. */
  readonly format: 1 | 2;
  /** Format 2: the dir packs holding every dir object. Empty in format 1. */
  readonly dirPacks: ReadonlyArray<string>;
  /** Every object to upload: key → bytes. */
  readonly objects: ReadonlyMap<string, Uint8Array>;
}

/** The chunked section a snapshot stands for, in its format (format 1 omits `format`). */
export const sectionOf = (snapshot: Snapshot): WorkspaceSection =>
  snapshot.format === FORMAT_DIR_PACKS
    ? {
        root: snapshot.root,
        packs: snapshot.packs,
        format: FORMAT_DIR_PACKS,
        dir_packs: snapshot.dirPacks,
      }
    : { root: snapshot.root, packs: snapshot.packs };

interface PackBuilder {
  readonly chunks: Array<Uint8Array>;
  size: number;
}

/**
 * Snapshot `dir` into dir objects and CDC packs under `keys`' prefix. Hardlink groups are
 * detected by inode: the first member in path order is a plain `file`, later members are
 * `hardlink-group` entries pointing at it.
 *
 * `format: 1` (the default) writes one object per directory at `…/trees/<sha256>` as a bare
 * array, named by key. `format: 2` writes sealantd's dir packs: every dir object (in the
 * daemon's `{"entries": […]}` form) is one entry of a CDC pack container keyed by the dir
 * object's sha256, the packs split at `dirPackBudget` entries, and `root` and every `child` are
 * digests.
 */
export const snapshotDirectory = (
  dir: string,
  keys: ReturnType<typeof captureKeys>,
  options?: {
    readonly chunkSize?: number;
    readonly packBudget?: number;
    readonly format?: 1 | 2;
    readonly dirPackBudget?: number;
  },
): Snapshot => {
  const format = options?.format ?? 1;
  const dirObjects = new Map<string, Uint8Array>();
  const chunkSize = options?.chunkSize ?? 256 * 1024;
  const packBudget = options?.packBudget ?? 8 * 1024 * 1024;
  const objects = new Map<string, Uint8Array>();
  const packs: Array<string> = [];
  const seenChunks = new Set<string>();
  const canonicalByInode = new Map<string, string>();
  let building: PackBuilder = { chunks: [], size: 0 };

  const flush = () => {
    if (building.chunks.length === 0) return;
    const pack = writeCdcPack(building.chunks);
    const key = keys.pack(sha256Hex(pack.bytes));
    objects.set(key, pack.bytes);
    packs.push(key);
    building = { chunks: [], size: 0 };
  };

  const addChunk = (chunk: Uint8Array): string => {
    const hash = sha256Hex(chunk);
    if (!seenChunks.has(hash)) {
      seenChunks.add(hash);
      building.chunks.push(chunk);
      building.size += chunk.byteLength;
      if (building.size >= packBudget) flush();
    }
    return hash;
  };

  // Path order over the whole tree decides hardlink canonicals.
  const allPaths: Array<string> = [];
  const collect = (at: string, rel: string) => {
    for (const name of fs.readdirSync(at).toSorted()) {
      const full = path.join(at, name);
      const relPath = rel === "" ? name : `${rel}/${name}`;
      const stat = fs.lstatSync(full);
      allPaths.push(relPath);
      if (stat.isDirectory()) collect(full, relPath);
    }
  };
  collect(dir, "");
  for (const relPath of allPaths) {
    const stat = fs.lstatSync(path.join(dir, relPath));
    if (stat.isFile() && stat.nlink > 1) {
      const inode = `${stat.dev}:${stat.ino}`;
      if (!canonicalByInode.has(inode)) canonicalByInode.set(inode, relPath);
    }
  }

  const snapshotTree = (at: string, rel: string): string => {
    const entries: Array<DirEntry> = [];
    for (const name of fs.readdirSync(at).toSorted()) {
      const full = path.join(at, name);
      const relPath = rel === "" ? name : `${rel}/${name}`;
      const stat = fs.lstatSync(full);
      const mtime = stat.mtimeMs / 1000;
      if (stat.isDirectory()) {
        const child = snapshotTree(full, relPath);
        entries.push({ name, kind: "dir", mode: stat.mode, size: 0, mtime, child });
      } else if (stat.isSymbolicLink()) {
        entries.push({
          name,
          kind: "symlink",
          mode: stat.mode,
          size: 0,
          mtime,
          target: fs.readlinkSync(full),
        });
      } else if (stat.isFile()) {
        const canonical =
          stat.nlink > 1 ? canonicalByInode.get(`${stat.dev}:${stat.ino}`) : undefined;
        if (canonical !== undefined && canonical !== relPath) {
          entries.push({
            name,
            kind: "hardlink-group",
            mode: stat.mode,
            size: stat.size,
            mtime,
            target: canonical,
          });
          continue;
        }
        const bytes = new Uint8Array(fs.readFileSync(full));
        const chunks = chunkBytes(bytes, chunkSize).map(addChunk);
        entries.push({ name, kind: "file", mode: stat.mode, size: stat.size, mtime, chunks });
      }
    }
    if (format === FORMAT_DIR_PACKS) {
      const bytes = encodeDirObject(entries);
      const digest = sha256Hex(bytes);
      dirObjects.set(digest, bytes);
      return digest;
    }
    const json = new Uint8Array(Buffer.from(JSON.stringify(entries), "utf8"));
    const key = keys.tree(sha256Hex(json));
    objects.set(key, json);
    return key;
  };

  const root = snapshotTree(dir, "");
  flush();
  const dirPacks: Array<string> = [];
  if (format === FORMAT_DIR_PACKS) {
    // Digest order, as sealantd packs them, so the same tree packs to the same bytes.
    const digests = [...dirObjects.keys()].toSorted();
    const budget = Math.max(1, options?.dirPackBudget ?? digests.length);
    for (let at = 0; at < digests.length; at += budget) {
      const pack = writeCdcPack(
        digests.slice(at, at + budget).map((digest) => dirObjects.get(digest) ?? new Uint8Array()),
      );
      const key = keys.pack(sha256Hex(pack.bytes));
      objects.set(key, pack.bytes);
      dirPacks.push(key);
    }
  }
  return { root, packs, format, dirPacks, objects };
};

// ─── Manifests ──────────────────────────────────────────────────────────────

export interface ManifestInput {
  readonly worktreeId: string;
  readonly n: number;
  readonly parent: string | null;
  readonly epoch: number;
  readonly seq?: number;
  readonly kind?: CaptureManifest["kind"];
  readonly git?: CaptureManifest["sections"]["git"];
  readonly workspace?: CaptureManifest["sections"]["workspace"];
  readonly bulk?: CaptureManifest["sections"]["bulk"];
  readonly checkpoint?: { readonly ordinal: number; readonly sha: string; readonly ref: string };
}

export const emptyGitSection: CaptureManifest["sections"]["git"] = {
  packs: [],
  refs: {},
  head: "refs/heads/main",
  fsck: "unverified",
};

/** Manifest bytes plus the id (sha256 of exactly those bytes) and its key. */
export const buildManifest = (
  input: ManifestInput,
): {
  readonly bytes: Uint8Array;
  readonly id: string;
  readonly key: string;
  readonly manifest: CaptureManifest;
} => {
  const manifest: CaptureManifest = {
    worktree_id: input.worktreeId,
    n: input.n,
    parent: input.parent,
    epoch: input.epoch,
    seq: input.seq ?? 0,
    kind: input.kind ?? "auto",
    created_at: new Date().toISOString(),
    sections: {
      git: input.git ?? emptyGitSection,
      workspace: input.workspace ?? { root: "", packs: [] },
      bulk: input.bulk ?? "pending",
    },
    ...(input.checkpoint === undefined ? {} : { checkpoint: input.checkpoint }),
  };
  const bytes = new Uint8Array(Buffer.from(JSON.stringify(manifest), "utf8"));
  const id = captureIdOf(bytes);
  return { bytes, id, key: captureKeys(input.worktreeId, input.epoch).manifest(id), manifest };
};

/** Upload every object of a snapshot (and any extra) into the provided blob store. */
export const uploadObjects = (objects: ReadonlyMap<string, Uint8Array>) =>
  Effect.gen(function* () {
    const store = yield* BlobStore;
    yield* Effect.forEach(
      [...objects.entries()],
      ([key, bytes]) => store.put(key, bytes, { ifAbsent: true }),
      { discard: true },
    );
  });
