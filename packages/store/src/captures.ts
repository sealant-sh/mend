import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import * as zlib from "node:zlib";

import { Effect, Schema } from "effect";

import { BlobNotFoundError, BlobStore, type BlobStoreError, isValidBlobKey } from "./blob-store.ts";
import { git, type GitError } from "./git.ts";

/**
 * The capture format of sealantd ADR-0015 ("Capture format"), read-side only: Mend never writes
 * a capture (project promotion is a server-side copy of whole objects). Everything here is pure
 * over bytes except `materialize`, which fetches through `BlobStore` and writes a directory.
 *
 * Mend reads these manifest fields and no others (ADR-0002): `worktree_id`, `n`, `parent`,
 * `epoch`, `seq`, `kind`, `created_at`, `sections.git.{packs, refs, head, fsck}`,
 * `sections.workspace.{root, packs, format?, dir_packs?}`,
 * `sections.bulk.{root, packs, platform, format?, dir_packs?} | "pending"`,
 * `sections.other_bulk?.<platform>` (each a ready bulk section),
 * `checkpoint?.{ordinal, sha, ref}`, `sections.workspace.worktree_meta?` (validated at register),
 * `final_seal?.{complete, epoch, executor}`. Unknown fields are not decoded.
 *
 * The chunked sections are versioned one by one (sealantd `manifest.rs`, PR #99 "Dir packs"),
 * because one manifest can hold both: a capture staged over a head an older executor wrote
 * carries that head's bulk section as it is.
 *
 * - Format 1 (`format` absent): every dir object is its own object at `…/trees/<sha256>`, and
 *   `root` and every `child` are those keys. Every capture before dir packs.
 * - Format 2: dir objects travel in dir packs — the CDC pack container, one zstd entry per dir
 *   object, the entry hash being the dir object's sha256 — keyed `…/packs/<sha256>` and listed
 *   in `dir_packs`; `root` and every `child` are dir object digests, not keys.
 *
 * A section in a format above `MAX_SECTION_FORMAT` does not decode: nothing is read from, or
 * registered with, a capture Mend could not restore.
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
  /**
   * Symbolic refs other than `HEAD`, name → target (sealantd `manifest.rs`); each is in `refs`
   * too, by the sha it resolved to. Absent when there are none.
   */
  symrefs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type GitSection = typeof GitSection.Type;

/** Section format 1: one object per directory at `…/trees/<sha256>`, named by key. */
export const FORMAT_DIR_OBJECTS = 1;
/** Section format 2: dir objects in the dir packs a section lists, named by digest. */
export const FORMAT_DIR_PACKS = 2;
/** The highest section format Mend reads — and so the highest `plan.get` may announce. */
export const MAX_SECTION_FORMAT = FORMAT_DIR_PACKS;

/** A section's `format`: absent reads 1; anything but 1 or 2 does not decode. */
export const SectionFormat = Schema.Literals([FORMAT_DIR_OBJECTS, FORMAT_DIR_PACKS]);
export type SectionFormat = typeof SectionFormat.Type;

const chunkedSectionFields = {
  /** Format 1: the root dir object's key. Format 2: its digest. */
  root: Schema.String,
  packs: Schema.Array(Schema.String),
  format: Schema.optionalKey(SectionFormat),
  /** Format 2: every dir pack the tree needs, across epochs. Absent in format 1. */
  dir_packs: Schema.optionalKey(Schema.Array(Schema.String)),
};

/** The worktree metadata document format Mend reads (sealantd `WORKTREE_META_FORMAT`). */
export const WORKTREE_META_FORMAT = 1;

/**
 * `sections.workspace.worktree_meta` (sealantd `manifest.rs` `WorktreeMeta`): the worktree
 * metadata overlay — exact modes, nanosecond mtimes, untracked directories and hardlink groups of
 * the working tree the worktree pseudo-ref describes — a JSON document CDC chunked into the
 * workspace section's own packs. A restore needs it whenever it is present: sealantd's
 * materializer refuses a document whose chunks do not add up to `size` and `sha256`, or whose
 * format it does not read.
 */
export const WorktreeMeta = Schema.Struct({
  format: Schema.Int,
  size: Schema.Int,
  sha256: Schema.String,
  chunks: Schema.Array(Schema.String),
  packs: Schema.Array(Schema.String),
});
export type WorktreeMeta = typeof WorktreeMeta.Type;

export const WorkspaceSection = Schema.Struct({
  ...chunkedSectionFields,
  worktree_meta: Schema.optionalKey(WorktreeMeta),
});
export type WorkspaceSection = typeof WorkspaceSection.Type;

export const BulkSectionReady = Schema.Struct({
  ...chunkedSectionFields,
  platform: Schema.String,
});
export type BulkSectionReady = typeof BulkSectionReady.Type;
export const BulkSection = Schema.Union([BulkSectionReady, Schema.Literal("pending")]);
export type BulkSection = typeof BulkSection.Type;

/**
 * `sections.other_bulk` (sealantd PR #101, "`other_bulk` in a manifest"): the bulk sections
 * captured on OTHER platforms, keyed by `<os>-<arch>-<libc>`, each a bulk section as `bulk` is.
 * An executor that continues a head whose bulk section was built elsewhere carries that section
 * here, capture after capture, so moving a session between an arm64 and an amd64 executor never
 * drops the other platform's dependency tree. Absent when empty, so a manifest without one
 * decodes and encodes exactly as before.
 *
 * Readers ignore it — a capture's files are its `bulk` section's — except `plan.get`
 * (`bulkSectionFor`), register (it validates every entry like a bulk section), retention (it
 * keeps every object an entry names) and the engine's install decision.
 */
export const OtherBulkSections = Schema.Record(Schema.String, BulkSectionReady);
export type OtherBulkSections = typeof OtherBulkSections.Type;

/** A section whose files are CDC-chunked: the workspace section or a ready bulk section. */
export type ChunkedSection = WorkspaceSection | BulkSectionReady;

/** The section's format; absent is format 1, as every capture before dir packs. */
export const sectionFormatOf = (section: ChunkedSection): SectionFormat =>
  section.format ?? FORMAT_DIR_OBJECTS;

/** The dir packs a section lists — none in format 1. */
export const dirPacksOf = (section: ChunkedSection): ReadonlyArray<string> =>
  sectionFormatOf(section) === FORMAT_DIR_PACKS ? (section.dir_packs ?? []) : [];

export const CaptureCheckpoint = Schema.Struct({
  ordinal: Schema.Int,
  sha: Schema.String,
  ref: Schema.String,
});

export const CaptureSections = Schema.Struct({
  git: GitSection,
  workspace: WorkspaceSection,
  bulk: BulkSection,
  other_bulk: Schema.optionalKey(OtherBulkSections),
});
export type CaptureSections = typeof CaptureSections.Type;

/**
 * `final_seal` (cross-repo decision 1, 2026-09-28): sealantd, when a final flush completes —
 * everything shipped, writers stopped — registers a sealing capture carrying it. `executor` is the
 * executor sealantd was planned as, `epoch` the lease epoch it held. Register records it on the
 * chain only when it is complete and names the registering executor and epoch; it is then the
 * only store-side evidence that the executor's work is saved.
 */
export const FinalSeal = Schema.Struct({
  complete: Schema.Boolean,
  epoch: Schema.Int,
  executor: Schema.String,
});
export type FinalSeal = typeof FinalSeal.Type;

export const CaptureManifest = Schema.Struct({
  worktree_id: Schema.String,
  n: Schema.Int,
  parent: Schema.NullOr(Schema.String),
  epoch: Schema.Int,
  seq: Schema.Int,
  kind: CaptureKind,
  created_at: Schema.String,
  sections: CaptureSections,
  checkpoint: Schema.optionalKey(CaptureCheckpoint),
  final_seal: Schema.optionalKey(FinalSeal),
});
export type CaptureManifest = typeof CaptureManifest.Type;

/**
 * Every bulk section a manifest holds, by platform: each `other_bulk` entry stamped for the
 * platform it is keyed by, then `bulk` when captured, which wins over an entry of its own
 * platform (sealantd `Sections::bulk_by_platform`). An entry whose key and stamp disagree is no
 * platform's to restore and is left out.
 */
export const bulkSectionsByPlatform = (
  sections: CaptureSections,
): ReadonlyMap<string, BulkSectionReady> => {
  const all = new Map<string, BulkSectionReady>();
  for (const [platform, section] of Object.entries(sections.other_bulk ?? {})) {
    if (section.platform === platform) all.set(platform, section);
  }
  if (sections.bulk !== "pending") all.set(sections.bulk.platform, sections.bulk);
  return all;
};

/**
 * The bulk section an executor of `platform` may restore (sealantd PR #101, `registrar.rs`
 * "`platform` on `plan.get`"): `bulk` when it was captured on that platform, else the section
 * `other_bulk` carries for it, else `"pending"` — never a tree built for another platform.
 */
export const bulkSectionFor = (sections: CaptureSections, platform: string): BulkSection =>
  bulkSectionsByPlatform(sections).get(platform) ?? "pending";

const sameKeys = (x: ReadonlyArray<string>, y: ReadonlyArray<string>): boolean =>
  x.length === y.length && x.every((key, at) => key === y[at]);

/** Whether two bulk sections name the same tree: same platform, root, format, packs and dir packs. */
export const sameBulkSection = (a: BulkSectionReady, b: BulkSectionReady): boolean =>
  a.platform === b.platform &&
  a.root === b.root &&
  sectionFormatOf(a) === sectionFormatOf(b) &&
  sameKeys(a.packs, b.packs) &&
  sameKeys(dirPacksOf(a), dirPacksOf(b));

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
 * One entry of a directory listing. `mtime` is nanoseconds since the epoch, an i64 (sealantd
 * `tree.rs` `DirEntry.mtime`): decoded from a dir object's bytes it is a `bigint` holding the
 * integer exactly as written (`decodeDirObject`) — a double cannot hold today's nanosecond
 * counts — and written back the same digits (`encodeDirObject`). A `number` is nanoseconds too
 * (an entry built in memory); an RFC 3339 string is accepted as a time. `chunks` for files,
 * `target` for symlinks and hardlink groups (the group's canonical path, relative to the class
 * root), `child` for directories.
 *
 * `name` and `target` are keys (sealantd `tree.rs`, "Names that are not UTF-8"): a name that is
 * not UTF-8, or holds a character of `U+10FF80..=U+10FFFF`, is escaped byte by byte into that
 * range, and the entry carries the bytes themselves, hex, in `raw_name` (`raw_target` for a
 * symlink's text). A reader lays down the bytes (`nameBytesOf`, `symlinkTargetBytesOf`), never
 * the escaped key.
 */
export const DirEntry = Schema.Struct({
  name: Schema.String,
  kind: DirEntryKind,
  mode: Schema.Int,
  size: Schema.Int,
  mtime: Schema.Union([Schema.BigInt, Schema.Number, Schema.String]),
  chunks: Schema.optionalKey(Schema.Array(Schema.String)),
  target: Schema.optionalKey(Schema.String),
  child: Schema.optionalKey(Schema.String),
  group: Schema.optionalKey(Schema.String),
  raw_name: Schema.optionalKey(Schema.String),
  raw_target: Schema.optionalKey(Schema.String),
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
 *
 * sealantd ADR-0015 §Capture format describes the dir object as the bare sorted array; the
 * daemon writes the wrapped form and Mend writes what the daemon reads. That section is the
 * text to amend — the format on the wire does not change.
 */
const DirObjectWire = Schema.Union([
  Schema.Struct({ entries: Schema.Array(DirEntry) }),
  Schema.Array(DirEntry),
]);

/** `JSON.rawJSON` (ES2025, Node 21+), which TypeScript's lib does not type yet. */
interface JsonWithRawText {
  readonly rawJSON: (text: string) => unknown;
}
const writesRawText = (json: JSON): json is JSON & JsonWithRawText =>
  "rawJSON" in json && typeof Reflect.get(json, "rawJSON") === "function";

/** `JSON.stringify`, with every `bigint` written as its digits (an i64 nanosecond mtime). */
export const stringifyExact = (value: unknown): string => {
  const json = JSON;
  if (!writesRawText(json)) throw new Error("dir objects need JSON.rawJSON (Node 21 or later)");
  return JSON.stringify(value, (_key: string, field: unknown) =>
    typeof field === "bigint" ? json.rawJSON(field.toString()) : field,
  );
};

/** The bytes of a dir object as the daemon writes and reads them; a `bigint` goes out as its digits. */
export const encodeDirObject = (entries: DirObject): Uint8Array =>
  new Uint8Array(Buffer.from(stringifyExact({ entries }), "utf8"));

// ─── Names that are not UTF-8 ───────────────────────────────────────────────

/**
 * sealantd's key encoding (`tree.rs` `key_of` / `bytes_of`): a file name, a path or a symlink's
 * text is bytes; JSON strings are Unicode. The bytes read as UTF-8 when they are UTF-8 and hold no
 * character of the escape range `U+10FF80..=U+10FFFF`; otherwise every byte of an invalid
 * sequence, and every byte of an escape-range character, becomes the character `U+10FF00 + byte`.
 * The mapping is a bijection, `/` is never escaped, so a path keys component by component.
 */
const ESCAPE_BASE = 0x10_ff00;
const ESCAPE_FIRST = 0x10_ff80;

/** Length of the well-formed UTF-8 sequence starting at `at`, or 0 (Rust's `from_utf8` rules). */
const utf8SequenceAt = (bytes: Uint8Array, at: number): number => {
  const b0 = bytes[at] ?? -1;
  const inRange = (offset: number, low: number, high: number) => {
    const b = bytes[at + offset] ?? -1;
    return b >= low && b <= high;
  };
  const tail = (from: number, to: number) => {
    for (let offset = from; offset <= to; offset += 1) {
      if (!inRange(offset, 0x80, 0xbf)) return false;
    }
    return true;
  };
  if (b0 >= 0 && b0 < 0x80) return 1;
  if (b0 >= 0xc2 && b0 <= 0xdf) return tail(1, 1) ? 2 : 0;
  if (b0 === 0xe0) return inRange(1, 0xa0, 0xbf) && tail(2, 2) ? 3 : 0;
  if ((b0 >= 0xe1 && b0 <= 0xec) || b0 === 0xee || b0 === 0xef) return tail(1, 2) ? 3 : 0;
  if (b0 === 0xed) return inRange(1, 0x80, 0x9f) && tail(2, 2) ? 3 : 0;
  if (b0 === 0xf0) return inRange(1, 0x90, 0xbf) && tail(2, 3) ? 4 : 0;
  if (b0 >= 0xf1 && b0 <= 0xf3) return tail(1, 3) ? 4 : 0;
  if (b0 === 0xf4) return inRange(1, 0x80, 0x8f) && tail(2, 3) ? 4 : 0;
  return 0;
};

/** The key of a byte string: sealantd `key_of`. */
export const keyOfBytes = (bytes: Uint8Array): string => {
  let out = "";
  let at = 0;
  while (at < bytes.length) {
    const length = utf8SequenceAt(bytes, at);
    if (length === 0) {
      out += String.fromCodePoint(ESCAPE_BASE + (bytes[at] ?? 0));
      at += 1;
      continue;
    }
    const sequence = bytes.subarray(at, at + length);
    const char = Buffer.from(sequence).toString("utf8");
    if ((char.codePointAt(0) ?? 0) >= ESCAPE_FIRST) {
      for (const byte of sequence) out += String.fromCodePoint(ESCAPE_BASE + byte);
    } else {
      out += char;
    }
    at += length;
  }
  return out;
};

/** The bytes a key stands for: sealantd `bytes_of`, the inverse of `keyOfBytes`. */
export const bytesOfKey = (key: string): Buffer => {
  const out: Array<number> = [];
  for (const char of key) {
    const point = char.codePointAt(0) ?? 0;
    if (point >= ESCAPE_FIRST) out.push(point - ESCAPE_BASE);
    else out.push(...Buffer.from(char, "utf8"));
  }
  return Buffer.from(out);
};

/** Whether a key holds a character of the escape range: its bytes are not the key's UTF-8. */
export const isEscapedKey = (key: string): boolean => {
  for (const char of key) if ((char.codePointAt(0) ?? 0) >= ESCAPE_FIRST) return true;
  return false;
};

/**
 * Whether a git section names a ref, a symbolic ref or `HEAD` by an escaped key (sealantd
 * `gitpack.rs`: ref names and symbolic targets are keys of their bytes): a reader that does not
 * decode them writes the escaped text as the ref's name.
 */
export const gitSectionHoldsRawNames = (section: GitSection): boolean =>
  isEscapedKey(section.head) ||
  Object.keys(section.refs).some(isEscapedKey) ||
  Object.entries(section.symrefs ?? {}).some(
    ([name, target]) => isEscapedKey(name) || isEscapedKey(target),
  );

/** `raw_name` / `raw_target` for a key: the hex of its bytes when the key was escaped. */
export const rawOfKey = (key: string): string | undefined =>
  isEscapedKey(key) ? bytesOfKey(key).toString("hex") : undefined;

const HEX_BYTES = /^(?:[0-9a-fA-F]{2})*$/;

/**
 * The bytes a key and its raw field stand for: `raw` when present (hex, and it must be the bytes
 * the key encodes — sealantd's metadata reader refuses a disagreeing pair the same way); the
 * decoded key otherwise. Null when the raw field is not hex, the two disagree, or the key is not
 * one sealantd writes (a key that does not round-trip, such as one holding a lone surrogate).
 */
export const bytesOfPair = (key: string, raw: string | undefined): Buffer | null => {
  const bytes =
    raw === undefined ? bytesOfKey(key) : HEX_BYTES.test(raw) ? Buffer.from(raw, "hex") : null;
  if (bytes === null) return null;
  return keyOfBytes(bytes) === key ? bytes : null;
};

const SLASH = 0x2f;
const isSafeNameBytes = (name: Uint8Array) =>
  name.length > 0 &&
  !name.includes(SLASH) &&
  !name.includes(0) &&
  !(name.length === 1 && name[0] === 0x2e) &&
  !(name.length === 2 && name[0] === 0x2e && name[1] === 0x2e);

/** A dir entry's name as it is on disk; null when it is not one safe name. */
export const nameBytesOf = (entry: DirEntry): Buffer | null => {
  const bytes = bytesOfPair(entry.name, entry.raw_name);
  return bytes !== null && isSafeNameBytes(bytes) ? bytes : null;
};

/** A symlink's text as it is on disk; null without a target, or when it is malformed. */
export const symlinkTargetBytesOf = (entry: DirEntry): Buffer | null => {
  if (entry.target === undefined) return null;
  const bytes = bytesOfPair(entry.target, entry.raw_target);
  return bytes !== null && bytes.length > 0 && !bytes.includes(0) ? bytes : null;
};

/**
 * A class-root-relative path (a hardlink group's `target`, a key) as the bytes of each segment;
 * null when it could leave the root or names nothing: absolute, empty, an empty, `.` or `..`
 * segment, or a segment that is not a key sealantd writes.
 */
const pathSegmentBytes = (relPath: string): ReadonlyArray<Buffer> | null => {
  if (relPath === "" || relPath.startsWith("/")) return null;
  const out: Array<Buffer> = [];
  for (const segment of relPath.split("/")) {
    const bytes = bytesOfPair(segment, undefined);
    if (bytes === null || !isSafeNameBytes(bytes)) return null;
    out.push(bytes);
  }
  return out;
};

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

/**
 * Where one source archive lives for a session's epoch: content beside the worktree that Mend
 * publishes and sealantd lays down (`@mend/sessions/capture-sources.ts`). It sits under the
 * session's own epoch prefix, so the executor only ever holds URLs under that prefix and capture
 * retention sweeps it with the rest of the fenced epoch.
 */
export const captureSourceKey = (worktreeId: string, epoch: number, sha256: string): string =>
  `captures/${worktreeId}/${epoch}/sources/${sha256}.tar.gz`;

const SOURCE_KEY_TAIL = /\/sources\/[0-9a-f]{64}\.tar\.gz$/;

/**
 * Whether a key names a source archive. Kept apart from [`isCaptureObjectKey`]: an executor may
 * write and register capture objects, while a source is Mend's to publish and the executor's only
 * to read.
 */
export const isCaptureSourceKey = (key: string): boolean => SOURCE_KEY_TAIL.test(key);

const OBJECT_KEY_TAIL =
  /\/(packs\/[0-9a-f]{64}(\.idx)?|trees\/[0-9a-f]{64}|manifests\/[0-9a-f]{64})$/;

/**
 * Whether a key names one capture object — `…/packs/<sha256>`, `…/packs/<sha256>.idx`,
 * `…/trees/<sha256>` or `…/manifests/<sha256>` under some prefix — as opposed to a prefix, an
 * empty string, or anything else a manifest field could carry by mistake. Every HEAD, GET
 * presign and PUT presign the capture routes issue is gated on it: a bare `captures/<worktree>`
 * is never a request to the bucket.
 */
export const isCaptureObjectKey = (key: string): boolean =>
  isValidBlobKey(key) && OBJECT_KEY_TAIL.test(key);

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

/**
 * A dir object's JSON, with every integer `mtime` read from its source text as a `bigint`
 * (`JSON.parse` source text access, Node 21+): nanoseconds since the epoch overflow a double's
 * 53 bits, and a rounded mtime is a changed one.
 */
const parseDirObjectJson = (text: string): unknown =>
  JSON.parse(text, (key: string, value: unknown, context?: { readonly source?: string }) =>
    key === "mtime" &&
    typeof value === "number" &&
    context?.source !== undefined &&
    /^-?\d+$/.test(context.source)
      ? BigInt(context.source)
      : value,
  );

const decodeDirObjectWire = (
  key: string,
  bytes: Uint8Array,
): Effect.Effect<typeof DirObjectWire.Type, CaptureFormatError> =>
  Effect.try({
    try: () =>
      Schema.decodeUnknownSync(DirObjectWire)(
        parseDirObjectJson(Buffer.from(bytes).toString("utf8")),
      ),
    catch: (cause) =>
      new CaptureFormatError({
        key,
        reason: `dir object: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
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
const PACK_TRAILER_BYTES = 16;

/**
 * Where a pack's index lies, from its 16-byte trailer (`u64 LE index length | "SLCP0001"`) and
 * the pack's size: `[indexStart, packSize - 16)`.
 */
const packIndexExtent = (
  key: string,
  trailer: Buffer,
  packSize: number,
): Effect.Effect<number, CaptureFormatError> =>
  Effect.gen(function* () {
    if (packSize < PACK_TRAILER_BYTES || trailer.length !== PACK_TRAILER_BYTES) {
      return yield* new CaptureFormatError({ key, reason: "pack shorter than its trailer" });
    }
    if (!trailer.subarray(8).equals(MAGIC_BYTES)) {
      return yield* new CaptureFormatError({ key, reason: "bad pack magic" });
    }
    const dataEnd = BigInt(packSize - PACK_TRAILER_BYTES) - trailer.readBigUInt64LE(0);
    if (dataEnd < 0n) {
      return yield* new CaptureFormatError({ key, reason: "index length exceeds pack" });
    }
    return Number(dataEnd);
  });

/** Decode the index bytes and check every entry lies inside the pack's data (`[0, indexStart)`). */
const decodePackIndex = (
  key: string,
  index: Buffer,
  indexStart: number,
): Effect.Effect<ReadonlyArray<PackIndexEntry>, CaptureFormatError> =>
  Effect.gen(function* () {
    const entries = yield* decodeJson(PackIndex, "pack index")(key, index);
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
    const trailer = buffer.subarray(Math.max(0, buffer.length - PACK_TRAILER_BYTES));
    const indexStart = yield* packIndexExtent(key, trailer, buffer.length);
    return yield* decodePackIndex(
      key,
      buffer.subarray(indexStart, buffer.length - PACK_TRAILER_BYTES),
      indexStart,
    );
  });

/** How much of a pack's end one ranged GET asks for: the trailer and, usually, the whole index. */
const PACK_TAIL_BYTES = 256 * 1024;

/**
 * A pack's index without the pack: one ranged GET of its tail (a second when the index is
 * larger than the tail). `size` is the pack's, as a HEAD reported it.
 */
export const readPackIndexRemote = (
  key: string,
  size: number,
): Effect.Effect<ReadonlyArray<PackIndexEntry>, CaptureReadError, BlobStore> =>
  Effect.gen(function* () {
    const store = yield* BlobStore;
    const tailStart = Math.max(0, size - PACK_TAIL_BYTES);
    const tail = Buffer.from(yield* store.getRange(key, tailStart, size - tailStart));
    if (tail.length !== size - tailStart) {
      return yield* new CaptureFormatError({
        key,
        reason: `pack is ${tailStart + tail.length} bytes, not the ${size} its HEAD reported`,
      });
    }
    const indexStart = yield* packIndexExtent(
      key,
      tail.subarray(Math.max(0, tail.length - PACK_TRAILER_BYTES)),
      size,
    );
    const indexLength = size - PACK_TRAILER_BYTES - indexStart;
    const index =
      indexStart >= tailStart
        ? tail.subarray(indexStart - tailStart, tail.length - PACK_TRAILER_BYTES)
        : Buffer.from(yield* store.getRange(key, indexStart, indexLength));
    if (index.length !== indexLength) {
      return yield* new CaptureFormatError({ key, reason: "pack index cut short" });
    }
    return yield* decodePackIndex(key, index, indexStart);
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

// ─── Dir objects across a section's formats ─────────────────────────────────

/** Reads the dir objects of one chunked section, whatever its format. */
export interface DirReader {
  /**
   * The dir object a section names: by key in format 1 (`root`, `child` are keys), by digest in
   * format 2 (`root`, `child` are digests into the section's dir packs). Verified against its
   * digest either way.
   */
  readonly read: (ref: string) => Effect.Effect<DirObject, CaptureReadError>;
}

interface OpenedPack {
  readonly bytes: Uint8Array;
  readonly entries: ReadonlyArray<PackIndexEntry>;
}

/**
 * Dir packs already fetched, by key. A pack key is the sha256 of its bytes and every pack is
 * verified against it on fetch, so an entry can never go stale; the cache is bounded by bytes
 * and drops the least recently used pack first. A restore, a harvest listing and the file reads
 * after it share one fetch of each dir pack instead of one per call.
 */
const DIR_PACK_CACHE_BYTES = 64 * 1024 * 1024;
const dirPackCache = new Map<string, OpenedPack>();
let dirPackCacheBytes = 0;

const rememberDirPack = (key: string, pack: OpenedPack) => {
  if (pack.bytes.byteLength > DIR_PACK_CACHE_BYTES) return;
  const previous = dirPackCache.get(key);
  if (previous !== undefined) {
    dirPackCache.delete(key);
    dirPackCacheBytes -= previous.bytes.byteLength;
  }
  dirPackCache.set(key, pack);
  dirPackCacheBytes += pack.bytes.byteLength;
  for (const [oldest, held] of dirPackCache) {
    if (dirPackCacheBytes <= DIR_PACK_CACHE_BYTES) break;
    dirPackCache.delete(oldest);
    dirPackCacheBytes -= held.bytes.byteLength;
  }
};

/** Fetch (or reuse) one dir pack: verified against its key, its trailing index read. */
const openDirPack = (key: string): Effect.Effect<OpenedPack, CaptureReadError, BlobStore> =>
  Effect.gen(function* () {
    const cached = dirPackCache.get(key);
    if (cached !== undefined) {
      // Touch: most recently used goes to the back of the map.
      dirPackCache.delete(key);
      dirPackCache.set(key, cached);
      return cached;
    }
    const store = yield* BlobStore;
    const bytes = yield* store.get(key);
    yield* verifyDigest(key, bytes);
    const entries = yield* readPackIndex(key, bytes);
    const opened = { bytes, entries };
    rememberDirPack(key, opened);
    return opened;
  });

/** How many dir packs are fetched at once (sealantd's materializer fetches eight at a time). */
const DIR_PACK_GETS_IN_FLIGHT = 8;

/**
 * A reader for one section's dir objects. Format 1 GETs each dir object by its key as the walk
 * reaches it. Format 2 fetches every dir pack the section lists up front (in parallel, each at
 * most once, cached across readers) and resolves digests through their trailing indexes; a
 * digest no listed pack holds is a malformed capture, never a guess.
 */
export const makeDirReader = (
  section: ChunkedSection,
): Effect.Effect<DirReader, CaptureReadError, BlobStore> =>
  Effect.gen(function* () {
    const store = yield* BlobStore;
    if (sectionFormatOf(section) === FORMAT_DIR_OBJECTS) {
      const read = (key: string) =>
        Effect.gen(function* () {
          const bytes = yield* store.get(key);
          yield* verifyDigest(key, bytes);
          return yield* decodeDirObject(key, bytes);
        });
      return { read };
    }
    const packKeys = [...new Set(dirPacksOf(section))];
    const opened = yield* Effect.forEach(packKeys, openDirPack, {
      concurrency: DIR_PACK_GETS_IN_FLIGHT,
    });
    const where = new Map<string, { readonly key: string; readonly entry: PackIndexEntry }>();
    packKeys.forEach((key, at) => {
      for (const entry of opened[at]?.entries ?? []) {
        // First listing wins; a dir object in two packs carries the same bytes by definition.
        if (!where.has(entry.hash)) where.set(entry.hash, { key, entry });
      }
    });
    const bytesOf = new Map(packKeys.map((key, at) => [key, opened[at]?.bytes] as const));
    const read = (digest: string) =>
      Effect.gen(function* () {
        if (!HEX64.test(digest)) {
          return yield* new CaptureFormatError({
            key: digest,
            reason: "a format-2 section names dir objects by sha256 digest, not by key",
          });
        }
        const location = where.get(digest);
        const pack = location === undefined ? undefined : bytesOf.get(location.key);
        if (location === undefined || pack === undefined) {
          return yield* new CaptureFormatError({
            key: digest,
            reason: `dir object ${digest} is in no dir pack the section lists`,
          });
        }
        // `readChunk` verifies the bytes against the entry's hash, which is the digest asked.
        const bytes = yield* readChunk(location.key, pack, location.entry);
        return yield* decodeDirObject(digest, bytes);
      });
    return { read };
  });

/**
 * Whether any dir object of a section names an entry by raw bytes (`raw_name` / `raw_target`):
 * a reader that ignores those fields would lay down the escaped key instead. Walks every dir
 * object; stops at the first one found.
 */
export const sectionHoldsRawNames = (
  section: ChunkedSection,
): Effect.Effect<boolean, CaptureReadError, BlobStore> =>
  Effect.gen(function* () {
    if (section.root === "") return false;
    const dirs = yield* makeDirReader(section);
    const visited = new Set<string>();
    const queue = [section.root];
    while (queue.length > 0) {
      const ref = queue.pop();
      if (ref === undefined) break;
      if (visited.has(ref)) continue;
      visited.add(ref);
      for (const entry of yield* dirs.read(ref)) {
        if (entry.raw_name !== undefined || entry.raw_target !== undefined) return true;
        if (entry.kind === "dir" && entry.child !== undefined) queue.push(entry.child);
      }
    }
    return false;
  });

// ─── Materialize ────────────────────────────────────────────────────────────

export interface MaterializeStats {
  readonly dirs: number;
  readonly files: number;
  readonly symlinks: number;
  readonly hardlinks: number;
  readonly bytes: number;
}

const NS_PER_SECOND = 1_000_000_000n;

/** An entry's mtime in nanoseconds since the epoch, exact (`DirEntry.mtime`). */
export const mtimeNanos = (value: bigint | number | string): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0n : BigInt(ms) * 1_000_000n;
};

/**
 * Nanoseconds as the seconds `fs.utimesSync` takes. Node sets a time from a double of seconds,
 * which holds today's times to about a quarter of a microsecond: this reader lays a class down
 * for Mend to read, never to restore an executor's disk — sealantd's materializer is the restore
 * path, and it sets every nanosecond.
 */
const secondsOf = (ns: bigint): number =>
  Number(ns / NS_PER_SECOND) + Number(ns % NS_PER_SECOND) / 1e9;

const isSafeName = (name: string) =>
  name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0");

/** `dir` + `/` + `name`, as bytes: names that are not UTF-8 reach the filesystem unchanged. */
const joinBytes = (dir: Buffer, name: Uint8Array): Buffer =>
  Buffer.concat([dir, Buffer.from([SLASH]), name]);

/**
 * Write one class of a capture into `targetDir` (created; expected empty or absent): files
 * chunk by chunk with every chunk sha256-verified, symlinks by target (never followed),
 * hardlink groups as links to the canonical member, modes and mtimes as recorded. Directory
 * mtimes are applied last so the writes beneath do not disturb them. Every path is bytes: a name
 * or a symlink's text that is not UTF-8 is written as the bytes `raw_name` / `raw_target` carry,
 * never as its escaped key.
 *
 * Not a restore path: an mtime lands to within a microsecond of the recorded nanoseconds (what
 * Node's `utimes` can set, `secondsOf`), and no worktree metadata overlay or cross-class link is
 * applied. Restoring an executor's disk is sealantd's materializer.
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
    const source = yield* makeChunkSource(section.packs);
    // Dir packs are fetched before anything is written, as the content packs are.
    const dirs = yield* makeDirReader(section);
    const root = Buffer.from(path.resolve(targetDir));
    const io = <A>(at: Buffer, thunk: () => A) =>
      Effect.try({
        try: thunk,
        catch: (cause) => new MaterializeError({ at: at.toString("utf8"), cause }),
      });
    yield* io(root, () => fs.mkdirSync(root, { recursive: true }));

    const stats = { dirs: 0, files: 0, symlinks: 0, hardlinks: 0, bytes: 0 };
    const dirTimes: Array<{ readonly at: Buffer; readonly mtime: number }> = [];
    const deferredLinks: Array<{
      readonly at: Buffer;
      readonly target: string;
      readonly key: string;
    }> = [];

    const writeFile = (at: Buffer, entry: DirEntry, key: string) =>
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
        const mtime = secondsOf(mtimeNanos(entry.mtime));
        yield* io(at, () => fs.utimesSync(at, mtime, mtime));
        stats.files += 1;
        stats.bytes += written;
      });

    /** A hardlink group's canonical member below the root, as bytes; null when it would escape. */
    const canonicalOf = (target: string): Buffer | null => {
      const segments = pathSegmentBytes(target);
      return segments === null ? null : segments.reduce(joinBytes, root);
    };

    const link = (at: Buffer, target: string, key: string) =>
      Effect.gen(function* () {
        const canonical = canonicalOf(target);
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
      dir: Buffer,
    ): Effect.Effect<void, CaptureReadError | MaterializeError, never> =>
      Effect.gen(function* () {
        const entries = yield* dirs.read(key);
        for (const entry of entries) {
          const name = nameBytesOf(entry);
          if (name === null) {
            return yield* new CaptureFormatError({
              key,
              reason: `unsafe or malformed name "${entry.name}"`,
            });
          }
          const at = joinBytes(dir, name);
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
              dirTimes.push({ at, mtime: secondsOf(mtimeNanos(entry.mtime)) });
              break;
            }
            case "file": {
              yield* writeFile(at, entry, key);
              break;
            }
            case "symlink": {
              const target = symlinkTargetBytesOf(entry);
              if (target === null) {
                return yield* new CaptureFormatError({
                  key,
                  reason: `${entry.name}: symlink without a well-formed target`,
                });
              }
              const mtime = secondsOf(mtimeNanos(entry.mtime));
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
              if (canonicalOf(target)?.equals(at) === true) {
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

/**
 * Every object key a class's dir objects live in — what a plan must presign. Format 1: every
 * dir object's key, root first, found by walking the tree. Format 2: the section's dir packs,
 * with no walk (a digest is not a key; the packs are what the executor fetches).
 */
export const collectTreeKeys = (
  manifest: CaptureManifest,
  cls: CaptureClass,
  options?: { readonly limit?: number },
): Effect.Effect<ReadonlyArray<string>, CaptureReadError, BlobStore> =>
  Effect.gen(function* () {
    const section = manifest.sections[cls];
    if (section === "pending") return [];
    if (sectionFormatOf(section) === FORMAT_DIR_PACKS) return dirPacksOf(section);
    if (section.root === "") return [];
    const dirs = yield* makeDirReader(section);
    const limit = options?.limit ?? 50_000;
    const out: Array<string> = [];
    const queue = [section.root];
    while (queue.length > 0 && out.length < limit) {
      const key = queue.shift();
      if (key === undefined) break;
      out.push(key);
      const entries = yield* dirs.read(key);
      for (const entry of entries) {
        if (entry.kind === "dir" && entry.child !== undefined) queue.push(entry.child);
      }
    }
    return out;
  });

/**
 * Every blob key a manifest needs across its three sections: packs, indexes, dir objects (by
 * key in format 1, the dir packs holding them in format 2). Only
 * capture object keys (`isCaptureObjectKey`) are answered — a pending bulk section, an empty
 * root and a malformed entry contribute nothing, so nothing downstream presigns or HEADs a key
 * that names no object. `other_bulk` contributes nothing either: a plan presigns the one bulk
 * section it answers (`bulkSectionFor` puts it in `bulk` first).
 */
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
    return [...keys].filter(isCaptureObjectKey);
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
    const dirs = yield* makeDirReader(section);
    return yield* walkToDir(dirs, section.root, relPath);
  });

/**
 * The kernel refuses a path of this many bytes or more in one call (`PATH_MAX`). Git runs in the
 * worktree and passes each path whole, so it cannot reach a file whose worktree-relative path is
 * this long, nor anything under a directory one byte shorter (sealantd `GitRepo::beyond_reach`).
 */
export const GIT_PATH_MAX_BYTES = 4096;

/** Where the workspace class carries the worktree's files git does not: `tree/<path>`. */
const WORKSPACE_WORKTREE_DIR = "tree";

/** Paths beyond git's reach a capture carries: how many, and the first few (worktree-relative). */
export interface PathsBeyondGit {
  readonly count: number;
  readonly paths: ReadonlyArray<string>;
}

/**
 * A dir entry name's length on disk, in bytes. A byte that is not UTF-8 is carried as the
 * character `U+10FF00 + byte` (sealantd's name encoding, always `U+10FF80` and above): one byte.
 */
const nameBytes = (name: string): number => {
  let bytes = 0;
  for (const character of name) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point >= 0x10ff80 && point <= 0x10ffff ? 1 : Buffer.byteLength(character, "utf8");
  }
  return bytes;
};

/**
 * The worktree paths a capture carries that git cannot reach (`GIT_PATH_MAX_BYTES` or longer):
 * sealantd keeps them out of the git class and carries them in the workspace class under
 * `tree/`, saved and restored — but no diff git computes lists them. Every non-directory entry
 * under `tree/` whose worktree-relative path is that long counts; `limit` bounds the paths named.
 */
export const pathsBeyondGit = (
  manifest: CaptureManifest,
  options?: { readonly limit?: number },
): Effect.Effect<PathsBeyondGit, CaptureReadError, BlobStore> =>
  Effect.gen(function* () {
    const limit = options?.limit ?? 5;
    const section = manifest.sections.workspace;
    if (section.root === "") return { count: 0, paths: [] };
    const dirs = yield* makeDirReader(section);
    const top = (yield* dirs.read(section.root)).find(
      (entry) => entry.name === WORKSPACE_WORKTREE_DIR && entry.kind === "dir",
    );
    if (top?.child === undefined) return { count: 0, paths: [] };
    let count = 0;
    const paths: Array<string> = [];
    const pending: Array<{ readonly ref: string; readonly path: string; readonly bytes: number }> =
      [{ ref: top.child, path: "", bytes: 0 }];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      for (const entry of yield* dirs.read(next.ref)) {
        const relPath = next.path === "" ? entry.name : `${next.path}/${entry.name}`;
        const bytes = next.bytes + (next.path === "" ? 0 : 1) + nameBytes(entry.name);
        if (entry.kind === "dir") {
          if (entry.child !== undefined) pending.push({ ref: entry.child, path: relPath, bytes });
          continue;
        }
        if (bytes < GIT_PATH_MAX_BYTES) continue;
        count += 1;
        if (paths.length < limit) paths.push(relPath);
      }
    }
    return { count, paths: paths.toSorted() };
  });

/**
 * What the change view says of them: `3 paths outside git (too long) · saved, not shown in the
 * diff`. Null when there are none.
 */
export const pathsBeyondGitWords = (found: PathsBeyondGit): string | null =>
  found.count === 0
    ? null
    : `${found.count} ${found.count === 1 ? "path" : "paths"} outside git (too long) · saved, not shown in the diff`;

/** Follow `relPath` from the dir object `root` names; null when it names no directory. */
const walkToDir = (
  dirs: DirReader,
  root: string,
  relPath: string,
): Effect.Effect<DirObject | null, CaptureReadError> =>
  Effect.gen(function* () {
    let ref = root;
    for (const segment of relPath.split("/").filter((part) => part !== "")) {
      const entries = yield* dirs.read(ref);
      const next = entries.find((entry) => entry.name === segment);
      if (next === undefined || next.kind !== "dir" || next.child === undefined) return null;
      ref = next.child;
    }
    return yield* dirs.read(ref);
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
 * A class-root-relative path as its segments, or null when it could leave the root or names
 * nothing: absolute, empty, or with an empty, `.` or `..` segment. A hardlink group's `target`
 * is such a path (the group's canonical member, sealantd `tree.rs`).
 */
const captureSegments = (relPath: string): ReadonlyArray<string> | null => {
  if (relPath === "" || relPath.startsWith("/")) return null;
  const segments = relPath.split("/");
  return segments.every(isSafeName) ? segments : null;
};

/** The entry at `segments` below the dir object `root` names, or null. Symlinks are never followed. */
const entryAt = (
  dirs: DirReader,
  root: string,
  segments: ReadonlyArray<string>,
): Effect.Effect<DirEntry | null, CaptureReadError> =>
  Effect.gen(function* () {
    const name = segments.at(-1);
    if (name === undefined) return null;
    const parent = yield* walkToDir(dirs, root, segments.slice(0, -1).join("/"));
    return parent?.find((entry) => entry.name === name) ?? null;
  });

/**
 * The entry holding a file's bytes. A plain file holds its own. A hardlink group's member other
 * than the canonical one holds none (sealantd writes its `target` and no `chunks`): its bytes are
 * the canonical member's, found by path from the class root — a target that leaves the root,
 * names no file, or loops back through the group is a malformed capture, never an empty file.
 */
export const resolveCaptureFileEntry = (
  dirs: DirReader,
  root: string,
  relPath: string,
  entry: DirEntry,
): Effect.Effect<DirEntry, CaptureReadError> =>
  Effect.gen(function* () {
    let at = captureSegments(relPath)?.join("/") ?? relPath;
    let current = entry;
    const seen = new Set<string>([at]);
    while (current.kind === "hardlink-group") {
      const target = current.target;
      if (target === undefined) {
        return yield* new CaptureFormatError({
          key: root,
          reason: `${at}: hardlink without target`,
        });
      }
      const segments = captureSegments(target);
      if (segments === null) {
        return yield* new CaptureFormatError({
          key: root,
          reason: `${at}: hardlink target escapes the class root: ${target}`,
        });
      }
      const canonical = segments.join("/");
      // The canonical member listed as part of its own group holds the bytes (`materialize`).
      if (canonical === at) return current;
      if (seen.has(canonical)) {
        return yield* new CaptureFormatError({
          key: root,
          reason: `${at}: hardlink targets loop through ${canonical}`,
        });
      }
      seen.add(canonical);
      const next = yield* entryAt(dirs, root, segments);
      if (next === null || (next.kind !== "file" && next.kind !== "hardlink-group")) {
        return yield* new CaptureFormatError({
          key: root,
          reason: `${at}: hardlink canonical member missing: ${canonical}`,
        });
      }
      at = canonical;
      current = next;
    }
    if (current.kind !== "file") {
      return yield* new CaptureFormatError({ key: root, reason: `${at}: not a file` });
    }
    return current;
  });

/**
 * Stream one file of a class chunk by chunk, each chunk sha256-verified as it is decoded — a
 * 76 MB transcript never sits in memory whole. Fails before the first read when the path names
 * nothing or a non-file; a hardlink member streams its canonical member's bytes. The stream
 * fails, rather than ending, when the bytes it read are not the size the entry advertises.
 */
export const readCaptureFile = (
  manifest: CaptureManifest,
  cls: CaptureClass,
  relPath: string,
): Effect.Effect<Readable, CaptureReadError | CaptureSectionPendingError, BlobStore> =>
  Effect.gen(function* () {
    const section = manifest.sections[cls];
    if (section === "pending") return yield* new CaptureSectionPendingError({ section: cls });
    const notAFile = new CaptureFormatError({
      key: section.root,
      reason: `${relPath}: not a file in the ${cls} class`,
    });
    const segments = relPath.split("/").filter((part) => part !== "");
    if (section.root === "" || segments.length === 0) return yield* notAFile;
    const dirs = yield* makeDirReader(section);
    const entry = yield* entryAt(dirs, section.root, segments);
    if (entry === null || (entry.kind !== "file" && entry.kind !== "hardlink-group")) {
      return yield* notAFile;
    }
    const holder = yield* resolveCaptureFileEntry(dirs, section.root, segments.join("/"), entry);
    const expected = entry.size;
    if (holder.size !== expected) {
      return yield* new CaptureFormatError({
        key: section.root,
        reason: `${relPath}: ${expected} bytes advertised, its canonical member holds ${holder.size}`,
      });
    }
    const source = yield* makeChunkSource(section.packs);
    const chunks = [...(holder.chunks ?? [])];
    let at = 0;
    let read = 0;
    return new Readable({
      read() {
        const hash = chunks[at];
        if (hash === undefined) {
          if (read !== expected) {
            this.destroy(
              new CaptureFormatError({
                key: section.root,
                reason: `${relPath}: read ${read} bytes, entry says ${expected}`,
              }),
            );
            return;
          }
          this.push(null);
          return;
        }
        at += 1;
        Effect.runPromise(source.chunk(hash)).then(
          (bytes) => {
            read += bytes.byteLength;
            return this.push(Buffer.from(bytes));
          },
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
          cause instanceof CaptureFormatError
            ? cause
            : new CaptureFormatError({
                key: relPath,
                reason:
                  cause instanceof Error && cause.message !== "" ? cause.message : String(cause),
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
    const section = manifest.sections[cls];
    if (section === "pending" || section.root === "") return [];
    // One reader for the whole walk: in format 2 its dir packs are opened once.
    const dirs = yield* makeDirReader(section);
    const root = yield* walkToDir(dirs, section.root, under);
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
          queue.push({ at, entries: yield* dirs.read(entry.child) });
        } else if (entry.kind === "file" || entry.kind === "hardlink-group") {
          out.push({ path: at, entry });
        }
      }
    }
    return out.toSorted((a, b) => {
      const left = mtimeNanos(a.entry.mtime);
      const right = mtimeNanos(b.entry.mtime);
      return left === right ? 0 : right > left ? 1 : -1;
    });
  });

// ─── Restorability ──────────────────────────────────────────────────────────

/**
 * Chunk sizes by hash, per pack key. A pack key is the sha256 of its bytes, so an entry never
 * goes stale; the cache is bounded by entries and drops the least recently used pack first. A
 * register whose section re-lists its parent's packs reads only the new packs' indexes.
 */
const PACK_INDEX_CACHE_ENTRIES = 1_000_000;
const packIndexCache = new Map<string, ReadonlyMap<string, number>>();
let packIndexCacheEntries = 0;

const rememberPackIndex = (key: string, sizes: ReadonlyMap<string, number>) => {
  if (sizes.size > PACK_INDEX_CACHE_ENTRIES) return;
  const previous = packIndexCache.get(key);
  if (previous !== undefined) {
    packIndexCache.delete(key);
    packIndexCacheEntries -= previous.size;
  }
  packIndexCache.set(key, sizes);
  packIndexCacheEntries += sizes.size;
  for (const [oldest, held] of packIndexCache) {
    if (packIndexCacheEntries <= PACK_INDEX_CACHE_ENTRIES) break;
    packIndexCache.delete(oldest);
    packIndexCacheEntries -= held.size;
  }
};

/** Chunk sizes by hash in one pack, from its index (ranged reads; cached by key). */
const chunkSizesOf = (
  key: string,
  knownSize: number | undefined,
): Effect.Effect<ReadonlyMap<string, number>, CaptureReadError, BlobStore> =>
  Effect.gen(function* () {
    const cached = packIndexCache.get(key);
    if (cached !== undefined) {
      packIndexCache.delete(key);
      packIndexCache.set(key, cached);
      return cached;
    }
    const store = yield* BlobStore;
    const size = knownSize ?? (yield* store.head(key))?.size;
    if (size === undefined) return yield* new BlobNotFoundError({ key });
    const entries = yield* readPackIndexRemote(key, size);
    const sizes = new Map<string, number>();
    for (const entry of entries) sizes.set(entry.hash, entry.size);
    rememberPackIndex(key, sizes);
    return sizes;
  });

/** What a restorability check walked. */
export interface SectionCheck {
  readonly dirs: number;
  readonly files: number;
  readonly chunks: number;
  readonly hardlinks: number;
}

/** How many pack indexes are read at once. */
const PACK_INDEX_READS_IN_FLIGHT = 8;

/**
 * Establish that a chunked section restores, without restoring it: the root and every dir object
 * below it are where the section says (format 1: their keys; format 2: the dir packs it lists);
 * every entry is well formed (a safe, unique name; a dir's child, a symlink's target); every
 * chunk a file names is in a pack the section lists, and the chunk sizes the packs' indexes
 * give add up to the file's size; every hardlink member's canonical path names a file inside the
 * class, of the member's size. What the materializers need, checked before a register is
 * acknowledged (`capture-channel.ts`), so a capture Mend accepted is one it can restore.
 *
 * Chunk bytes are not decompressed: the packs are content-addressed and verified whole on every
 * restore; this check reads only their trailing indexes (cached by key), and the dir objects.
 */
export const verifySectionRestorable = (
  section: ChunkedSection,
  options?: {
    /** Pack sizes a HEAD just reported (the caller's), so the check does not HEAD them again. */
    readonly sizes?: ReadonlyMap<string, number>;
  },
): Effect.Effect<SectionCheck, CaptureReadError, BlobStore> =>
  Effect.gen(function* () {
    const stats = { dirs: 0, files: 0, chunks: 0, hardlinks: 0 };
    if (section.root === "") return stats;
    const dirs = yield* makeDirReader(section);
    const packs = [...new Set(section.packs)];
    const indexes = yield* Effect.forEach(
      packs,
      (key) => chunkSizesOf(key, options?.sizes?.get(key)),
      { concurrency: PACK_INDEX_READS_IN_FLIGHT },
    );
    const chunkSizes = new Map<string, number>();
    for (const sizes of indexes) {
      for (const [hash, size] of sizes) if (!chunkSizes.has(hash)) chunkSizes.set(hash, size);
    }
    const fail = (at: string, reason: string) =>
      Effect.fail(new CaptureFormatError({ key: section.root, reason: `${at || "/"}: ${reason}` }));
    const checkChunks = (entry: DirEntry, at: string) =>
      Effect.gen(function* () {
        let bytes = 0;
        for (const hash of entry.chunks ?? []) {
          const size = chunkSizes.get(hash);
          if (size === undefined) {
            return yield* fail(at, `chunk ${hash} is in no pack the section lists`);
          }
          bytes += size;
          stats.chunks += 1;
        }
        if (bytes !== entry.size) {
          return yield* fail(at, `its chunks hold ${bytes} bytes, the entry says ${entry.size}`);
        }
        stats.files += 1;
      });
    // Canonical path → the sizes its members advertise.
    const hardlinkTargets = new Map<string, Set<number>>();
    // A dir object reached twice (the same subtree at two paths) is checked once: its digest or
    // key names its bytes, and every path inside it is relative to it.
    const visited = new Set<string>();
    const queue: Array<{ readonly ref: string; readonly at: string }> = [
      { ref: section.root, at: "" },
    ];
    while (queue.length > 0) {
      const next = queue.pop();
      if (next === undefined) break;
      if (visited.has(next.ref)) continue;
      visited.add(next.ref);
      stats.dirs += 1;
      const entries = yield* dirs.read(next.ref);
      const names = new Set<string>();
      for (const entry of entries) {
        const at = next.at === "" ? entry.name : `${next.at}/${entry.name}`;
        // The bytes laid down: `raw_name` when present, agreeing with the key; never the key.
        if (nameBytesOf(entry) === null) {
          return yield* fail(
            next.at,
            `unsafe or malformed name "${entry.name}"${entry.raw_name === undefined ? "" : ` (raw_name ${entry.raw_name})`}`,
          );
        }
        if (names.has(entry.name)) return yield* fail(at, "listed twice");
        names.add(entry.name);
        switch (entry.kind) {
          case "dir": {
            if (entry.child === undefined) return yield* fail(at, "dir without child");
            queue.push({ ref: entry.child, at });
            break;
          }
          case "symlink": {
            if (entry.target === undefined) return yield* fail(at, "symlink without target");
            if (symlinkTargetBytesOf(entry) === null) {
              return yield* fail(
                at,
                `malformed symlink target${entry.raw_target === undefined ? "" : ` (raw_target ${entry.raw_target})`}`,
              );
            }
            break;
          }
          case "hardlink-group": {
            const target =
              entry.target === undefined || pathSegmentBytes(entry.target) === null
                ? null
                : captureSegments(entry.target);
            if (target === null) {
              return yield* fail(at, `hardlink target escapes or is missing: ${entry.target}`);
            }
            const canonical = target.join("/");
            const sizes = hardlinkTargets.get(canonical) ?? new Set<number>();
            sizes.add(entry.size);
            hardlinkTargets.set(canonical, sizes);
            stats.hardlinks += 1;
            // A member without chunks holds no bytes of its own; the canonical member does.
            if (entry.chunks === undefined) break;
            yield* checkChunks(entry, at);
            break;
          }
          case "file": {
            yield* checkChunks(entry, at);
            break;
          }
        }
      }
    }

    for (const [canonical, sizes] of hardlinkTargets) {
      const segments = canonical.split("/");
      const holder = yield* entryAt(dirs, section.root, segments);
      if (
        holder === null ||
        !(
          holder.kind === "file" ||
          (holder.kind === "hardlink-group" &&
            holder.chunks !== undefined &&
            captureSegments(holder.target ?? "")?.join("/") === canonical)
        )
      ) {
        return yield* fail(canonical, "a hardlink group's canonical member is not a file");
      }
      for (const size of sizes) {
        if (size !== holder.size) {
          return yield* fail(
            canonical,
            `a hardlink member advertises ${size} bytes, the canonical member holds ${holder.size}`,
          );
        }
      }
    }
    return stats;
  });

// ─── The worktree metadata overlay ──────────────────────────────────────────

const MetaDocument = Schema.Struct({
  format: Schema.Int,
  entries: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      raw_path: Schema.optionalKey(Schema.String),
      kind: Schema.Literals(["file", "symlink", "dir"]),
      mode: Schema.optionalKey(Schema.Int),
      mtime: Schema.Number,
    }),
  ),
  hardlinks: Schema.optionalKey(Schema.Array(Schema.Array(Schema.String))),
  shared: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        class: Schema.Literals(["workspace", "bulk"]),
        member: Schema.String,
        raw_member: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  /**
   * Inodes the workspace and bulk classes both name and no tracked file does (sealantd
   * `worktree_meta.rs` `cross_links`): each group every name those classes carry of one inode.
   */
  cross_links: Schema.optionalKey(
    Schema.Array(
      Schema.Array(
        Schema.Struct({
          class: Schema.Literals(["workspace", "bulk"]),
          member: Schema.String,
          raw_member: Schema.optionalKey(Schema.String),
        }),
      ),
    ),
  ),
});

/** The worktree metadata document (sealantd `worktree_meta.rs` `MetaDocument`), decoded. */
export type WorktreeMetaDocument = typeof MetaDocument.Type;

/** What a path of the worktree tree is, from its git mode: a blob, a symlink, a tree, a gitlink. */
export type WorktreeTreeKind = "file" | "symlink" | "dir" | "gitlink";

/**
 * Whether the worktree metadata document names only paths the restore will find as it says
 * (review 2026-09-28 (3) #20). sealantd applies the document after the git class checked out the
 * worktree tree (`worktree_meta.rs` `apply`): it creates a missing directory, but a file or a
 * symlink the document names must already be there, of that kind, or the materialize fails. The
 * document's scope is the worktree tree's own paths, so `tracked` — every path of that tree, hex
 * of its bytes → its kind — is the namespace a file, a symlink (and so every hardlink member) must
 * be found in; a directory the document names must not be a file or a link there. The reason, or
 * null when the document applies.
 */
export const metaNamespaceProblem = (
  document: WorktreeMetaDocument,
  tracked: ReadonlyMap<string, WorktreeTreeKind>,
): string | null => {
  for (const entry of document.entries) {
    const bytes = bytesOfPair(entry.path, entry.raw_path);
    if (bytes === null) return `path ${JSON.stringify(entry.path)}`;
    if (bytes.length === 0) continue;
    const found = tracked.get(bytes.toString("hex"));
    if (entry.kind === "dir") {
      if (found !== undefined && found !== "dir") {
        return `${JSON.stringify(entry.path)} is a directory in the document, a ${found} in the worktree tree`;
      }
      continue;
    }
    if (found !== entry.kind) {
      return `${JSON.stringify(entry.path)} is a ${entry.kind} in the document, ${
        found === undefined ? "absent from" : `a ${found} in`
      } the worktree tree`;
    }
  }
  return null;
};

/** `""` or a relative path of normal components (sealantd `worktree_meta.rs` `is_plain_relative`). */
const isPlainRelative = (bytes: Buffer): boolean => {
  if (bytes.length === 0) return true;
  let start = 0;
  for (let at = 0; at <= bytes.length; at += 1) {
    if (at < bytes.length && bytes[at] !== SLASH) continue;
    const component = bytes.subarray(start, at);
    if (
      component.length === 0 ||
      component.includes(0) ||
      (component.length === 1 && component[0] === 0x2e) ||
      (component.length === 2 && component[0] === 0x2e && component[1] === 0x2e)
    ) {
      return false;
    }
    start = at + 1;
  }
  return true;
};

/**
 * The document's own rules, as sealantd's `MetaDocument::decode` enforces them before a restore
 * writes anything: a format it reads, every path plain and relative with raw bytes that agree
 * with its key, a mode on everything but a symlink, hardlink groups of two or more files of the
 * document, shared links from a file of the document to a plain relative member, cross-class
 * groups of two or more distinct plain members. The reason, or null when the document restores.
 */
const decodeMetaDocument = (
  bytes: Uint8Array,
): { readonly document: WorktreeMetaDocument } | { readonly problem: string } => {
  let document: WorktreeMetaDocument;
  try {
    document = Schema.decodeUnknownSync(MetaDocument)(
      JSON.parse(Buffer.from(bytes).toString("utf8")),
    );
  } catch (cause) {
    return { problem: cause instanceof Error ? cause.message : String(cause) };
  }
  const problem = metaDocumentProblem(document);
  return problem === null ? { document } : { problem };
};

const metaDocumentProblem = (document: WorktreeMetaDocument): string | null => {
  if (document.format < 1 || document.format > WORKTREE_META_FORMAT) {
    return `format ${document.format}; Mend reads up to ${WORKTREE_META_FORMAT}`;
  }
  const kinds = new Map<string, string>();
  for (const entry of document.entries) {
    const bytesOfPath = bytesOfPair(entry.path, entry.raw_path);
    if (bytesOfPath === null || !isPlainRelative(bytesOfPath))
      return `path ${JSON.stringify(entry.path)}`;
    if (entry.kind !== "symlink" && entry.mode === undefined) {
      return `${JSON.stringify(entry.path)} has no mode`;
    }
    kinds.set(entry.path, entry.kind);
  }
  const isFile = (key: string) => kinds.get(key) === "file";
  for (const group of document.hardlinks ?? []) {
    if (group.length < 2 || !group.every(isFile)) {
      return `hardlink group ${JSON.stringify(group)} does not name files of the document`;
    }
  }
  for (const link of document.shared ?? []) {
    const member = bytesOfPair(link.member, link.raw_member);
    if (!isFile(link.path) || member === null || member.length === 0 || !isPlainRelative(member)) {
      return `shared link ${JSON.stringify(link)}`;
    }
  }
  // Each cross-class group: two or more distinct members (class and bytes), each a plain,
  // non-empty relative path whose raw bytes agree with its key.
  for (const group of document.cross_links ?? []) {
    const seen = new Set<string>();
    for (const link of group) {
      const member = bytesOfPair(link.member, link.raw_member);
      const id = member === null ? "" : `${link.class}:${member.toString("hex")}`;
      if (member === null || member.length === 0 || !isPlainRelative(member) || seen.has(id)) {
        return `cross-class link ${JSON.stringify(link)}`;
      }
      seen.add(id);
    }
    if (seen.size < 2) {
      return `cross-class link group ${JSON.stringify(group)} names fewer than two members`;
    }
  }
  return null;
};

/**
 * Establish that a workspace section's worktree metadata document restores, as sealantd's
 * materializer reads it: a format Mend reads, packs among the section's own, every chunk in one
 * of them, the chunks adding up to `size` bytes whose sha256 is `sha256`, and a document that
 * decodes under its own rules. Reads the listed packs' indexes and each chunk by ranged GET.
 * Answers the document (null when the section has none), for the caller to check it against the
 * worktree tree it applies to (`metaNamespaceProblem`).
 */
export const verifyWorktreeMeta = (
  section: WorkspaceSection,
  options?: { readonly sizes?: ReadonlyMap<string, number> },
): Effect.Effect<WorktreeMetaDocument | null, CaptureReadError, BlobStore> =>
  Effect.gen(function* () {
    const meta = section.worktree_meta;
    if (meta === undefined) return null;
    const key = `worktree_meta ${meta.sha256}`;
    const fail = (reason: string) => Effect.fail(new CaptureFormatError({ key, reason }));
    if (meta.format < 1 || meta.format > WORKTREE_META_FORMAT) {
      return yield* fail(`format ${meta.format}; Mend reads up to ${WORKTREE_META_FORMAT}`);
    }
    if (!Number.isSafeInteger(meta.size) || meta.size < 0) return yield* fail(`size ${meta.size}`);
    if (!HEX64.test(meta.sha256)) return yield* fail("sha256 is not a sha256 digest");
    const outside = meta.packs.filter((pack) => !section.packs.includes(pack));
    if (outside.length > 0) {
      return yield* fail(`packs not among the section's: ${outside.slice(0, 3).join(", ")}`);
    }
    const store = yield* BlobStore;
    const where = new Map<string, { readonly pack: string; readonly entry: PackIndexEntry }>();
    for (const pack of new Set(meta.packs)) {
      const size = options?.sizes?.get(pack) ?? (yield* store.head(pack))?.size;
      if (size === undefined) return yield* new BlobNotFoundError({ key: pack });
      for (const entry of yield* readPackIndexRemote(pack, size)) {
        if (!where.has(entry.hash)) where.set(entry.hash, { pack, entry });
      }
    }
    let total = 0;
    for (const hash of meta.chunks) {
      const location = where.get(hash);
      if (location === undefined) return yield* new ChunkNotFoundError({ hash });
      total += location.entry.size;
    }
    if (total !== meta.size) {
      return yield* fail(`its chunks hold ${total} bytes, the section says ${meta.size}`);
    }
    const parts: Array<Uint8Array> = [];
    for (const hash of meta.chunks) {
      const location = where.get(hash);
      if (location === undefined) return yield* new ChunkNotFoundError({ hash });
      const compressed = yield* store.getRange(
        location.pack,
        location.entry.offset,
        location.entry.length,
      );
      parts.push(yield* readChunk(location.pack, compressed, { ...location.entry, offset: 0 }));
    }
    const document = Buffer.concat(parts);
    const actual = sha256Hex(document);
    if (actual !== meta.sha256) {
      return yield* new CaptureIntegrityError({ key, expected: meta.sha256, actual });
    }
    const decoded = decodeMetaDocument(document);
    if ("problem" in decoded) return yield* fail(`document: ${decoded.problem}`);
    return decoded.document;
  });

// ─── What a capture row names ───────────────────────────────────────────────

/**
 * Read from a `captures` row's stored `sections` (JSON, decoded by nobody): what retention keeps
 * alive and what a register must find un-condemned. Leniently: whatever a section lists is named,
 * whatever its `format` says — keeping a listed object alive is never the loss.
 */
const stringsOf = (section: unknown, field: string): ReadonlyArray<string> => {
  if (typeof section !== "object" || section === null) return [];
  const value: unknown = Reflect.get(section, field);
  return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : [];
};

const rowPacksOf = (section: unknown): ReadonlyArray<string> => stringsOf(section, "packs");

/**
 * A chunked section's dir packs (format 2, sealantd PR #99). Read whatever the section lists,
 * whatever its `format` says: keeping a listed object alive is never the loss.
 */
const rowDirPacksOf = (section: unknown): ReadonlyArray<string> => stringsOf(section, "dir_packs");

/** A format-1 root is a key (`…/trees/<sha256>`); a format-2 root is a digest and names no object. */
const rowTreeOf = (section: unknown): ReadonlyArray<string> => {
  if (typeof section !== "object" || section === null) return [];
  const root: unknown = Reflect.get(section, "root");
  return typeof root === "string" && root.includes("/trees/") ? [root] : [];
};

/**
 * The bulk sections captured on other platforms that a row carries (`other_bulk`, sealantd PR
 * #101), whatever their keys say: each is another platform's dependency tree, restorable only
 * while every object it names lives, however many captures ago it was built.
 */
const otherBulkOf = (sections: object): ReadonlyArray<unknown> => {
  const other: unknown = Reflect.get(sections, "other_bulk");
  if (typeof other !== "object" || other === null || Array.isArray(other)) return [];
  const entries: ReadonlyArray<unknown> = Object.values(other);
  return entries;
};

/** Every chunked section a row names: the workspace, the bulk section, every other platform's. */
const chunkedSectionsOf = (sections: object): ReadonlyArray<unknown> => [
  Reflect.get(sections, "workspace"),
  Reflect.get(sections, "bulk"),
  ...otherBulkOf(sections),
];

/** Every object key a capture row's sections name. */
export const keysOfSections = (sections: unknown): ReadonlyArray<string> => {
  if (typeof sections !== "object" || sections === null) return [];
  return [
    ...rowPacksOf(Reflect.get(sections, "git")).flatMap((key) => [key, packIdxKeyOf(key)]),
    ...chunkedSectionsOf(sections).flatMap((section) => [
      ...rowPacksOf(section),
      ...rowTreeOf(section),
      ...rowDirPacksOf(section),
    ]),
    // The worktree metadata document's packs are the workspace section's own (sealantd), and
    // register refuses one that is not; named anyway, since keeping one alive is never the loss.
    ...rowPacksOf(worktreeMetaOf(sections)),
  ];
};

/** A row's `workspace.worktree_meta`, whatever it holds. */
const worktreeMetaOf = (sections: object): unknown => {
  const workspace: unknown = Reflect.get(sections, "workspace");
  return typeof workspace === "object" && workspace !== null
    ? Reflect.get(workspace, "worktree_meta")
    : undefined;
};

/**
 * The `…/trees/` prefixes a row's format-1 roots live under. A format-1 root names its children
 * by key, and sealantd writes every dir object of one tree under the prefix its root has (the
 * epoch that built it), so a root that lives keeps every `trees/` object under its prefix alive
 * — without reading one dir object. A section carried from an older epoch (a bulk section that
 * rides along until the next bulk snap, or another platform's in `other_bulk`, which rides along
 * for good) keeps its whole tree that way.
 */
export const treePrefixesOfSections = (sections: unknown): ReadonlyArray<string> => {
  if (typeof sections !== "object" || sections === null) return [];
  return chunkedSectionsOf(sections)
    .flatMap(rowTreeOf)
    .map((root) => root.slice(0, root.lastIndexOf("/trees/") + "/trees/".length));
};

/** The worktree a capture object key belongs to (`captures/<worktree>/…`), or null. */
export const captureKeyOwner = (key: string): string | null => {
  const match = /^captures\/([^/]+)\//.exec(key);
  return match?.[1] ?? null;
};

// ─── Git packs ──────────────────────────────────────────────────────────────

/**
 * `git index-pack --verify` over a pack whose `.idx` sits beside it (`<base>.pack` +
 * `<base>.idx`): the index must match the pack and every object must be intact.
 */
export const verifyGitPack = (packPath: string): Effect.Effect<void, GitError> =>
  git(["index-pack", "--verify", packPath], path.dirname(packPath)).pipe(Effect.asVoid);
