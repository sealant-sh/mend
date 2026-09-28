import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline as pipelinePromise } from "node:stream/promises";
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
  /**
   * The `git_trees` manifest feature (sealantd review 3): the working tree as `git add -A`
   * stages it — what a review diffs. When present, `refs` is the repository's refs whatever
   * their names (`refs/sealant/capture/*` included) and nothing in it is a tree of Mend's.
   */
  worktree_tree: Schema.optionalKey(Schema.String),
  /** `git_trees`: the index as a tree, when it could be written as one. */
  index_tree: Schema.optionalKey(Schema.String),
  /**
   * `git_trees`: the worktree tree with every regular file's blob holding the bytes on disk,
   * before any clean filter, end-of-line or encoding conversion — what a restore checks out and
   * writes back unsmudged.
   */
  raw_tree: Schema.optionalKey(Schema.String),
  /**
   * The `object_format` manifest feature (sealantd review 8 #10): the repository's object format
   * (`extensions.objectFormat`) when it is not `sha1` — `sha256`. Every object id the section
   * names is of that format (64 hex digits for `sha256`), and every repository that reads its
   * packs — the restore's, the verifier's — is made in it. Absent: `sha1`.
   */
  object_format: Schema.optionalKey(Schema.String),
  /**
   * The `ref_format` manifest feature (sealantd review 9 #1, cross-repo decision 24): the backend
   * the repository keeps its refs in (`extensions.refStorage`) when it is not `files` —
   * `reftable`. The capture read `HEAD`, the refs and the reflogs through git in that backend; a
   * restore initializes its repository with it, and the verifier reads the section's packs in a
   * repository of it. Absent: `files`.
   */
  ref_format: Schema.optionalKey(Schema.String),
});
export type GitSection = typeof GitSection.Type;

/** The ref backends Mend verifies and plans: a section's `ref_format`, `files` when absent. */
export type GitRefFormat = "files" | "reftable";

/** The section's ref backend; null when it names one Mend does not read. */
export const gitRefFormatOf = (section: GitSection): GitRefFormat | null => {
  const format = section.ref_format ?? "files";
  return format === "files" || format === "reftable" ? format : null;
};

/** The object formats Mend verifies and plans: a section's `object_format`, `sha1` when absent. */
export type GitObjectFormat = "sha1" | "sha256";

/** The section's object format; null when it names one Mend does not read. */
export const gitObjectFormatOf = (section: GitSection): GitObjectFormat | null => {
  const format = section.object_format ?? "sha1";
  return format === "sha1" || format === "sha256" ? format : null;
};

/** An object id of `format`: 40 hex digits for `sha1`, 64 for `sha256`. */
export const gitObjectIdPattern = (format: GitObjectFormat): RegExp =>
  format === "sha256" ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/;

/** An object id of either format. */
export const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The section names its trees in their own fields (`git_trees`) rather than as pseudo-refs. */
export const gitSectionHoldsTrees = (section: GitSection): boolean =>
  section.worktree_tree !== undefined;

/**
 * The worktree tree: `worktree_tree`, else the `refs/sealant/capture/worktree` pseudo-ref of a
 * section written before `git_trees`. Undefined when the section names none.
 */
export const worktreeTreeOf = (section: GitSection): string | undefined =>
  gitSectionHoldsTrees(section) ? section.worktree_tree : section.refs[WORKTREE_TREE_REF];

/** The index tree: `index_tree` in a `git_trees` section, else the index pseudo-ref. */
export const indexTreeOf = (section: GitSection): string | undefined =>
  gitSectionHoldsTrees(section) ? section.index_tree : section.refs[INDEX_TREE_REF];

/** The tree a restore checks out: `raw_tree` when the section has one, else the worktree tree. */
export const rawTreeOf = (section: GitSection): string | undefined =>
  section.raw_tree ?? worktreeTreeOf(section);

/**
 * Every tree the section names beside its refs (`worktree_tree`, `index_tree`, `raw_tree`, or
 * the two pseudo-refs of a section before `git_trees`): each is a pack closure tip.
 */
export const gitSectionTrees = (section: GitSection): ReadonlyArray<string> =>
  [worktreeTreeOf(section), indexTreeOf(section), section.raw_tree].filter(
    (tree): tree is string => tree !== undefined && tree !== "",
  );

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
  /**
   * The class's roots that were symlinks to a directory when captured (sealantd review 8 #1:
   * `.git` linked from beside the worktree, a harness home configured as a link), root name → the
   * link text, as a key. Informational: the class holds what the link named, and a restore writes
   * a real directory there. Carried as written, so a plan hands it on.
   */
  root_links: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
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
  /**
   * Where in the executor's own history it sealed (cross-repo decision 17), when sealantd stamps
   * it: the daemon process, which boot of the disk that was, and the number the seal took in
   * that boot's order (the answer to the flush that sealed comes after it). Absent (an older
   * daemon): nothing orders the seal against an answer.
   */
  boot_id: Schema.optionalKey(Schema.String),
  boot_generation: Schema.optionalKey(Schema.Int),
  observation: Schema.optionalKey(Schema.Int),
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
/**
 * Where the two pseudo-refs live in a section written before `git_trees`. Only the two exact
 * names above were ever trees; in a `git_trees` section every name here is a user ref.
 */
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

/**
 * Key layout, fixed with ADR-0015; `<sha256>` is the lowercase hex digest of the object. A
 * `generation` puts the objects under `captures/<worktree>/<epoch>/g<generation>/` (cross-repo
 * decision 6): content retention condemned is uploaded again under a key no condemnation named, so
 * a delete still in flight for the old key can only reach bytes no capture names. Both forms are
 * read and registered alike; the epoch is always the segment after the worktree.
 */
export const captureKeys = (worktreeId: string, epoch: number, generation?: number) => {
  const base =
    generation === undefined
      ? `captures/${worktreeId}/${epoch}`
      : `captures/${worktreeId}/${epoch}/g${generation}`;
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

/** The sha256 of `key`'s bytes, streamed (a bulk pack can be gigabytes). */
const sha256Of = (
  key: string,
): Effect.Effect<string, BlobNotFoundError | BlobStoreError, BlobStore> =>
  Effect.gen(function* () {
    const store = yield* BlobStore;
    const stream = yield* store.getStream(key);
    return yield* Effect.tryPromise({
      try: async () => {
        const hash = crypto.createHash("sha256");
        for await (const chunk of stream) hash.update(chunk);
        return hash.digest("hex");
      },
      catch: (cause) =>
        new CaptureIntegrityError({ key, expected: "readable", actual: String(cause) }),
    }).pipe(Effect.orElseSucceed(() => ""));
  });

/** A git pack index's two trailing SHA-1s: the pack's checksum, then its own. */
const GIT_IDX_TRAILER = 40;
const GIT_PACK_TRAILER = 20;

/**
 * Whether the object already stored under a capture key holds the bytes the key names (cross-repo
 * decision 19: an existing object is accepted only once its bytes are verified): a pack, a dir
 * pack, a tree or a manifest hashes to the sha256 its key ends in; a git pack index
 * (`packs/<sha>.idx`) checksums to its own trailer and names the checksum its pack ends in. The
 * reason it does not, or null when it does.
 */
export const storedObjectProblem = (
  key: string,
): Effect.Effect<string | null, BlobNotFoundError | BlobStoreError, BlobStore> =>
  Effect.gen(function* () {
    const store = yield* BlobStore;
    if (key.endsWith(".idx")) {
      const bytes = yield* store.get(key);
      if (bytes.byteLength < GIT_IDX_TRAILER) return `${key} is too short to be a pack index`;
      const body = bytes.subarray(0, bytes.byteLength - 20);
      const own = Buffer.from(bytes.subarray(bytes.byteLength - 20)).toString("hex");
      if (crypto.createHash("sha1").update(body).digest("hex") !== own) {
        return `${key} does not checksum to its own trailer`;
      }
      const packKey = key.slice(0, -".idx".length);
      const packHead = yield* store.head(packKey);
      if (packHead === null) return `${key} names a pack that is not stored`;
      const packTrailer = yield* store.getRange(
        packKey,
        Math.max(0, packHead.size - GIT_PACK_TRAILER),
        GIT_PACK_TRAILER,
      );
      const named = Buffer.from(
        bytes.subarray(bytes.byteLength - GIT_IDX_TRAILER, bytes.byteLength - 20),
      ).toString("hex");
      return Buffer.from(packTrailer).toString("hex") === named
        ? null
        : `${key} indexes another pack than ${packKey}`;
    }
    const expected = digestOfKey(key);
    if (expected === null) return `${key} names no sha256`;
    const actual = yield* sha256Of(key);
    return actual === expected
      ? null
      : `${key} holds bytes that hash to ${actual || "nothing readable"}`;
  });

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
  /** When the bytes were read from the store (ms), for `proofStands`. */
  readonly atMs: number;
}

/**
 * What a cache here holds about a key is a proof about one store's object (review 2026-09-28 (6)
 * #9, cross-repo decision 19): kept under the store's identity beside the key, and standing only
 * when it was taken once nothing could replace the bytes any more — at once on a store that
 * refuses to replace an object, otherwise after every PUT URL minted for the key has expired
 * (`BlobStore.replaceableUntil`). A proof taken earlier is taken again.
 */
const proofKey = (store: typeof BlobStore.Service, key: string) => `${store.identity}\u0000${key}`;

const proofStands = (
  store: typeof BlobStore.Service,
  key: string,
  atMs: number,
): Effect.Effect<boolean> => store.replaceableUntil(key).pipe(Effect.map((until) => atMs >= until));

/**
 * Dir packs already fetched, by store and key. A pack key is the sha256 of its bytes and every
 * pack is verified against it on fetch; an entry stands while `proofStands`. The cache is bounded
 * by bytes and drops the least recently used pack first. A restore, a harvest listing and the
 * file reads after it share one fetch of each dir pack instead of one per call.
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
    const store = yield* BlobStore;
    const cacheKey = proofKey(store, key);
    const cached = dirPackCache.get(cacheKey);
    if (cached !== undefined && (yield* proofStands(store, key, cached.atMs))) {
      // Touch: most recently used goes to the back of the map.
      dirPackCache.delete(cacheKey);
      dirPackCache.set(cacheKey, cached);
      return cached;
    }
    const atMs = Date.now();
    const bytes = yield* store.get(key);
    yield* verifyDigest(key, bytes);
    const entries = yield* readPackIndex(key, bytes);
    const opened = { bytes, entries, atMs };
    rememberDirPack(cacheKey, opened);
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
 * Chunk sizes by hash, per store and pack key, while the read stands (`proofStands`); bounded by
 * entries, the least recently used pack dropped first. A register whose section re-lists its
 * parent's packs reads only the new packs' indexes.
 */
const PACK_INDEX_CACHE_ENTRIES = 1_000_000;
interface PackIndexRead {
  readonly sizes: ReadonlyMap<string, number>;
  readonly atMs: number;
}
const packIndexCache = new Map<string, PackIndexRead>();
let packIndexCacheEntries = 0;

const rememberPackIndex = (cacheKey: string, read: PackIndexRead) => {
  if (read.sizes.size > PACK_INDEX_CACHE_ENTRIES) return;
  const previous = packIndexCache.get(cacheKey);
  if (previous !== undefined) {
    packIndexCache.delete(cacheKey);
    packIndexCacheEntries -= previous.sizes.size;
  }
  packIndexCache.set(cacheKey, read);
  packIndexCacheEntries += read.sizes.size;
  for (const [oldest, held] of packIndexCache) {
    if (packIndexCacheEntries <= PACK_INDEX_CACHE_ENTRIES) break;
    packIndexCache.delete(oldest);
    packIndexCacheEntries -= held.sizes.size;
  }
};

/** Chunk sizes by hash in one pack, from its index (ranged reads; cached by key). */
const chunkSizesOf = (
  key: string,
  knownSize: number | undefined,
): Effect.Effect<ReadonlyMap<string, number>, CaptureReadError, BlobStore> =>
  Effect.gen(function* () {
    const store = yield* BlobStore;
    const cacheKey = proofKey(store, key);
    const cached = packIndexCache.get(cacheKey);
    if (cached !== undefined && (yield* proofStands(store, key, cached.atMs))) {
      packIndexCache.delete(cacheKey);
      packIndexCache.set(cacheKey, cached);
      return cached.sizes;
    }
    const atMs = Date.now();
    const size = knownSize ?? (yield* store.head(key))?.size;
    if (size === undefined) return yield* new BlobNotFoundError({ key });
    const entries = yield* readPackIndexRemote(key, size);
    const sizes = new Map<string, number>();
    for (const entry of entries) sizes.set(entry.hash, entry.size);
    rememberPackIndex(cacheKey, { sizes, atMs });
    return sizes;
  });

/**
 * Pack keys whose every chunk was decompressed and hashed (`verifyPackPayloads`), by store and
 * key, with when the bytes were read. A key is the sha256 of the pack's bytes and a condemned key
 * is never written again, but a key is only as immutable as its store keeps it (review
 * 2026-09-28 (6) #9): the proof stands only while `proofStands` — taken from this very store once
 * no PUT URL could replace the bytes. Bounded, the oldest dropped first.
 */
const PAYLOAD_VERIFIED_KEYS = 200_000;
const payloadVerified = new Map<string, number>();

const rememberPayloadVerified = (cacheKey: string, atMs: number) => {
  payloadVerified.delete(cacheKey);
  payloadVerified.set(cacheKey, atMs);
  for (const oldest of payloadVerified.keys()) {
    if (payloadVerified.size <= PAYLOAD_VERIFIED_KEYS) break;
    payloadVerified.delete(oldest);
  }
};

/**
 * Establish that every chunk of every pack in `keys` is readable, without restoring anything:
 * the pack's bytes hash to its key, its index lies inside it, and every entry decompresses to
 * the size it states and hashes to the chunk it names (`readChunk`). What a restore needs of the
 * bytes, where `verifySectionRestorable` checks only the indexes: a pack can carry a valid index
 * and the right key while a frame inside it does not decode (review 2026-09-28 (4) #13). Packs
 * are read one at a time; a key verified before is not read again.
 */
export const verifyPackPayloads = (
  keys: ReadonlyArray<string>,
): Effect.Effect<
  { readonly packs: number; readonly chunks: number },
  CaptureReadError,
  BlobStore
> =>
  Effect.gen(function* () {
    const store = yield* BlobStore;
    let packs = 0;
    let chunks = 0;
    for (const key of new Set(keys)) {
      const cacheKey = proofKey(store, key);
      const verifiedAt = payloadVerified.get(cacheKey);
      if (verifiedAt !== undefined && (yield* proofStands(store, key, verifiedAt))) continue;
      const atMs = Date.now();
      const bytes = yield* store.get(key);
      yield* verifyDigest(key, bytes);
      const entries = yield* readPackIndex(key, bytes);
      for (const entry of entries) {
        yield* readChunk(key, bytes, entry);
        chunks += 1;
      }
      packs += 1;
      rememberPayloadVerified(cacheKey, atMs);
    }
    return { packs, chunks };
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
 * restore; this check reads only their trailing indexes (cached by key), and the dir objects. A
 * register that would seal reads the bytes too (`verifyPackPayloads`).
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
      /**
       * Nanoseconds since the epoch. Read from the document's text as a `bigint` when it is an
       * integer (`parseMetaDocumentJson`): a double rounds nanoseconds, and two mtimes one apart
       * are two promises (review 2026-09-28 (7) #10).
       */
      mtime: Schema.Union([Schema.BigInt, Schema.Number]),
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
  treeName = "the worktree tree",
): string | null => {
  for (const entry of document.entries) {
    const bytes = bytesOfPair(entry.path, entry.raw_path);
    if (bytes === null) return `path ${JSON.stringify(entry.path)}`;
    if (bytes.length === 0) continue;
    const found = tracked.get(bytes.toString("hex"));
    if (entry.kind === "dir") {
      if (found !== undefined && found !== "dir") {
        return `${JSON.stringify(entry.path)} is a directory in the document, a ${found} in ${treeName}`;
      }
      continue;
    }
    if (found !== entry.kind) {
      return `${JSON.stringify(entry.path)} is a ${entry.kind} in the document, ${
        found === undefined ? "absent from" : `a ${found} in`
      } ${treeName}`;
    }
  }
  return null;
};

/**
 * `metaNamespaceProblem` over the namespace the restore actually lays down (review 2026-09-28 (7)
 * #9, (8) #8), in sealantd's order (`materialize.rs`): the git class checks out `raw_tree` when the
 * section has one (`rawTreeOf`), not the worktree tree; the workspace class is written over it —
 * a name it carries (`tree/<path>`) is what that class holds there, whatever the checkout wrote,
 * and a name it carries as anything but a directory removes every checkout path below it; the
 * bulk class writes only where the checkout tree has no such path; the document applies last.
 * `restoreTree` is every path of the restore tree (trees included), hex of its bytes → its kind and
 * object. Every name the document gives must also lie below directories: an ancestor the
 * namespace holds as a file, a symlink or a gitlink is a path the strict apply cannot create or
 * match (a directory it names there fails `NotADirectory`). The reason, or null when the document
 * applies.
 */
/**
 * What a complete restore lays down at a path before the worktree metadata document applies
 * (sealantd materializes the git class's checkout of `restoreTree`, then the workspace class's
 * `tree/…` overlay over it, then the bulk class where neither put anything): `effectiveKind` —
 * what is there, or null for nothing — and `effectiveFile` — the file there and where its bytes
 * come from (the checkout's blob, or a class member), or why it is not a file. The overlay wins
 * over the checkout, the checkout over the bulk, and an overlay entry that is not a directory
 * replaces everything below it.
 */
const makeRestoreNamespace = (
  manifest: CaptureManifest,
  restoreTree: ReadonlyMap<string, RestoreTreePath>,
) => {
  const members = makeClassMembers(manifest);
  const workspaceKinds = new Map<string, WorktreeTreeKind | null>();
  const workspaceKind = (bytes: Buffer) =>
    Effect.gen(function* () {
      const hex = bytes.toString("hex");
      const known = workspaceKinds.get(hex);
      if (known !== undefined) return known;
      const found = yield* members.kindOf("workspace", `tree/${keyOfBytes(bytes)}`);
      workspaceKinds.set(hex, found);
      return found;
    });
  /** Every proper ancestor of `bytes`, outermost first. */
  const ancestorsOf = (bytes: Buffer): Array<Buffer> => {
    const out: Array<Buffer> = [];
    for (let at = bytes.indexOf(SLASH); at > 0; at = bytes.indexOf(SLASH, at + 1)) {
      out.push(bytes.subarray(0, at));
    }
    return out;
  };
  const effective = new Map<string, WorktreeTreeKind | null>();
  /** What the restore leaves at `bytes` before the document applies; null: nothing. */
  const effectiveKind = (bytes: Buffer): Effect.Effect<WorktreeTreeKind | null, never, BlobStore> =>
    Effect.gen(function* () {
      const hex = bytes.toString("hex");
      const known = effective.get(hex);
      if (known !== undefined) return known;
      let found: WorktreeTreeKind | null = yield* workspaceKind(bytes);
      if (found === null) {
        let replaced = false;
        for (const ancestor of ancestorsOf(bytes)) {
          const over = yield* workspaceKind(ancestor);
          if (over !== null && over !== "dir") replaced = true;
        }
        const checkout = replaced ? undefined : restoreTree.get(hex)?.kind;
        found =
          checkout !== undefined
            ? checkout
            : replaced
              ? null
              : yield* members.kindOf("bulk", keyOfBytes(bytes));
      }
      effective.set(hex, found);
      return found;
    });
  const named = (bytes: Buffer) => JSON.stringify(keyOfBytes(bytes));
  /** The file the restore lays down at `bytes`, and where its bytes come from; or why none is. */
  const effectiveFile = (bytes: Buffer): Effect.Effect<RestoredFile | string, never, BlobStore> =>
    Effect.gen(function* () {
      for (const ancestor of ancestorsOf(bytes)) {
        const over = yield* effectiveKind(ancestor);
        if (over !== null && over !== "dir") {
          return `${named(bytes)} lies below ${named(ancestor)}, a ${over} in the files the restore lays down`;
        }
      }
      const kind = yield* effectiveKind(bytes);
      if (kind === null) return `${named(bytes)} is absent from the files the restore lays down`;
      if (kind !== "file") return `${named(bytes)} is a ${kind} in the files the restore lays down`;
      if ((yield* workspaceKind(bytes)) !== null) {
        const member = yield* members.fileOf("workspace", `tree/${keyOfBytes(bytes)}`);
        return typeof member === "string" ? member : { source: "class", member };
      }
      const checkout = restoreTree.get(bytes.toString("hex"));
      if (checkout !== undefined) return { source: "checkout", object: checkout.object };
      const member = yield* members.fileOf("bulk", keyOfBytes(bytes));
      return typeof member === "string" ? member : { source: "class", member };
    });
  return { members, ancestorsOf, effectiveKind, effectiveFile };
};

/** A file a restore lays down: the checkout's blob, or a class member's bytes. */
type RestoredFile =
  | { readonly source: "checkout"; readonly object: string }
  | { readonly source: "class"; readonly member: ClassMember };

/**
 * How files a restore lays down are compared: the checkout's objects are git's (sha1, or sha256
 * in a SHA-256 repository), so a class member is hashed as the git blob of the same bytes to
 * compare with one; class members alone compare by sha256.
 */
const restoredFileDigestOf = (
  files: ReadonlyArray<RestoredFile>,
): "sha256" | "git-sha1" | "git-sha256" => {
  const object = files.find((file) => file.source === "checkout");
  return object === undefined || object.source !== "checkout"
    ? "sha256"
    : object.object.length === 64
      ? "git-sha256"
      : "git-sha1";
};

export const restoreNamespaceProblem = (
  manifest: CaptureManifest,
  document: WorktreeMetaDocument,
  restoreTree: ReadonlyMap<string, RestoreTreePath>,
): Effect.Effect<string | null, never, BlobStore> =>
  Effect.gen(function* () {
    const { ancestorsOf, effectiveKind } = makeRestoreNamespace(manifest, restoreTree);
    const namespace = new Map<string, WorktreeTreeKind>();
    for (const entry of document.entries) {
      const bytes = bytesOfPair(entry.path, entry.raw_path);
      if (bytes === null || bytes.length === 0) continue;
      for (const ancestor of ancestorsOf(bytes)) {
        const over = yield* effectiveKind(ancestor);
        if (over !== null && over !== "dir") {
          return `${JSON.stringify(entry.path)} lies below ${JSON.stringify(keyOfBytes(ancestor))}, a ${over} in the namespace the restore lays down`;
        }
      }
      const found = yield* effectiveKind(bytes);
      if (found !== null) namespace.set(bytes.toString("hex"), found);
    }
    return metaNamespaceProblem(document, namespace, "the tree the restore checks out");
  });

/** An mtime as the exact text of its nanoseconds (a `bigint`, or a double's own digits). */
const exactMtime = (mtime: bigint | number): string =>
  typeof mtime === "bigint"
    ? mtime.toString()
    : Number.isSafeInteger(mtime)
      ? BigInt(mtime).toString()
      : String(mtime);

/** A tracked name of the document, as a node of `metaInodeProblem`'s inode groups. */
const trackedNode = (key: string) => `tracked:${key}`;
/** A class's name, as a node of `metaInodeProblem`'s inode groups. */
const memberNode = (cls: string, key: string, raw?: string) =>
  `${cls}:${bytesOfPair(key, raw)?.toString("hex") ?? key}`;

/** The inodes the document's links make: each name's group (`find`), and whether it has one. */
const inodeGroupsOf = (document: WorktreeMetaDocument) => {
  const parent = new Map<string, string>();
  const find = (node: string): string => {
    let root = node;
    while (true) {
      const up = parent.get(root);
      if (up === undefined || up === root) break;
      root = up;
    }
    parent.set(node, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const group of document.hardlinks ?? []) {
    const [first, ...rest] = group;
    if (first === undefined) continue;
    for (const other of rest) union(trackedNode(first), trackedNode(other));
  }
  for (const link of document.shared ?? []) {
    union(trackedNode(link.path), memberNode(link.class, link.member, link.raw_member));
  }
  for (const group of document.cross_links ?? []) {
    const [first, ...rest] = group;
    if (first === undefined) continue;
    for (const other of rest) {
      union(
        memberNode(first.class, first.member, first.raw_member),
        memberNode(other.class, other.member, other.raw_member),
      );
    }
  }
  return { empty: parent.size === 0, has: (node: string) => parent.has(node), find };
};

/** A mode and an mtime one name promises its inode, as text two promises compare by. */
const inodePromise = (mode: number | undefined, mtime: bigint | number | string) =>
  `mode ${mode === undefined ? "unset" : (mode & 0o7777).toString(8)} mtime ${
    typeof mtime === "string" ? mtime : exactMtime(mtime)
  }`;

/** One promise a name makes its inode: the name (for the reason), and the promise. */
interface InodePromise {
  readonly node: string;
  readonly name: string;
  readonly promise: string;
}

/** The first two differing promises one inode group is given, as a reason; null when none. */
const promisesProblem = (
  groups: ReturnType<typeof inodeGroupsOf>,
  promises: ReadonlyArray<InodePromise>,
): string | null => {
  const promised = new Map<string, { readonly name: string; readonly promise: string }>();
  for (const { node, name, promise } of promises) {
    if (!groups.has(node)) continue;
    const group = groups.find(node);
    const first = promised.get(group);
    if (first === undefined) {
      promised.set(group, { name, promise });
      continue;
    }
    if (first.promise !== promise) {
      return `${first.name} and ${name} are one inode, promised ${first.promise} and ${promise}`;
    }
  }
  return null;
};

/** The promises the document's own tracked file entries make. */
const trackedPromises = (document: WorktreeMetaDocument): Array<InodePromise> =>
  document.entries
    .filter((entry) => entry.kind === "file")
    .map((entry) => ({
      node: trackedNode(entry.path),
      name: JSON.stringify(entry.path),
      promise: inodePromise(entry.mode, entry.mtime),
    }));

/**
 * Whether every inode the document declares shared is promised one mode and one mtime (review
 * 2026-09-28 (7) #10), over the document's own tracked entries. A tracked `hardlinks` group, a
 * `shared` link from a tracked file to another class's name and a `cross_links` group each say
 * their names are one inode; groups that share a name are one inode too. sealantd links them,
 * then settles each entry the document names in turn — every one on the same inode — so of two
 * entries that promise the inode different modes or mtimes, the later one is what the restore
 * leaves and the earlier promise is broken. `inodeMetadataProblem` adds the class entries'
 * promises. The reason, or null when every connected group is promised one mode and one mtime.
 */
export const metaInodeProblem = (document: WorktreeMetaDocument): string | null => {
  const groups = inodeGroupsOf(document);
  return groups.empty ? null : promisesProblem(groups, trackedPromises(document));
};

/**
 * `metaInodeProblem` with every class name a link makes part of an inode (review 2026-09-28 (8)
 * #9): the entry its class lays that name down with — its mode and its mtime, the resolved file's
 * for a hardlink member — promises the inode too. sealantd writes each class name with its own
 * entry, then links the group onto its first member, so a class promise that differs from
 * another name's is broken by the restore — a group with no tracked member included. A class
 * name that does not resolve to a file of its class is a problem as well (never sealed on). The
 * reason, or null when every connected group is promised one mode and one mtime.
 */
export const inodeMetadataProblem = (
  manifest: CaptureManifest,
  document: WorktreeMetaDocument,
): Effect.Effect<string | null, never, BlobStore> =>
  Effect.gen(function* () {
    const groups = inodeGroupsOf(document);
    if (groups.empty) return null;
    const members = makeClassMembers(manifest);
    const named = [...(document.shared ?? []), ...(document.cross_links ?? []).flat()].map(
      (link) => ({ cls: link.class, member: link.member, raw: link.raw_member }),
    );
    const promises = trackedPromises(document);
    const seen = new Set<string>();
    for (const { cls, member, raw } of named) {
      const node = memberNode(cls, member, raw);
      if (seen.has(node)) continue;
      seen.add(node);
      const laid = yield* members.laidDownOf(cls, member);
      if (typeof laid === "string") return laid;
      promises.push({
        node,
        name: `${cls} member ${JSON.stringify(member)}`,
        promise: inodePromise(laid.mode, laid.mtime),
      });
    }
    return promisesProblem(groups, promises);
  });

/**
 * Whether every cross-class hardlink group the document declares is one the restore makes
 * (review 2026-09-28 (5) #11). sealantd's `apply` links a group's members onto the first one it
 * finds, but a member that is missing, is not a file, or holds other bytes is left as its class
 * restored it — no error, and the declared topology silently not restored. A seal says every
 * section restores as captured, so before one is recorded each member must be a file (a plain
 * file, or a hardlink member resolving to one) in its class's section — the workspace class's
 * `tree/…`, `.git/…`, `harness/…` namespace, the bulk class's worktree-relative one — and every
 * member of a group must hold the same bytes: the same chunks, or, chunked differently, the same
 * sha256 read back from the packs. The reason, or null when every group restores.
 */
export const crossLinksProblem = (
  manifest: CaptureManifest,
  document: WorktreeMetaDocument,
): Effect.Effect<string | null, never, BlobStore> =>
  Effect.gen(function* () {
    const groups = document.cross_links ?? [];
    if (groups.length === 0) return null;
    const members = makeClassMembers(manifest);
    for (const group of groups) {
      const found: Array<ClassMember> = [];
      for (const link of group) {
        const member = yield* members.fileOf(link.class, link.member);
        if (typeof member === "string") return member;
        found.push(member);
      }
      const [first, ...rest] = found;
      if (first === undefined) continue;
      if (rest.some((other) => other.size !== first.size)) {
        return `cross-class link group ${JSON.stringify(group)}: members hold different sizes`;
      }
      if (rest.every((other) => other.chunks === first.chunks)) continue;
      // Chunked differently: the bytes themselves decide.
      const digests = new Set<string>();
      for (const member of found) {
        const digest = yield* members.digestOf(member, "sha256");
        if (digest === null) {
          return `${member.cls} member ${JSON.stringify(member.member)} does not read`;
        }
        digests.add(digest);
      }
      if (digests.size > 1) {
        return `cross-class link group ${JSON.stringify(group)}: members hold different bytes`;
      }
    }
    return null;
  });

/** One file a class carries, as `makeClassMembers` found it. */
interface ClassMember {
  readonly cls: CaptureClass;
  /** Its path in the class, as the class names it. */
  readonly member: string;
  readonly size: number;
  /** Its chunk hashes, joined: two members with the same list hold the same bytes. */
  readonly chunks: string;
}

/**
 * The files a manifest's chunked classes carry, as a restore lays them down: `fileOf` finds a
 * member (a plain file, or a hardlink member resolving to one) in its class's section — the
 * workspace class's `tree/…`, `.git/…`, `harness/…` namespace, the bulk class's
 * worktree-relative one — or says why it is not one; `digestOf` reads its bytes back and hashes
 * them (sha256, or as the git blob object a checkout of the same bytes is). Dir readers are made
 * once per class.
 */
const makeClassMembers = (manifest: CaptureManifest) => {
  const readers = new Map<CaptureClass, DirReader>();
  const fileOf = (
    cls: CaptureClass,
    member: string,
  ): Effect.Effect<ClassMember | string, never, BlobStore> =>
    Effect.gen(function* () {
      const named = `${cls} member ${JSON.stringify(member)}`;
      const section = manifest.sections[cls];
      if (section === "pending") return `${named}: its class is pending`;
      const segments = captureSegments(member);
      if (segments === null || section.root === "") return `${named} is not in its class`;
      const reader =
        readers.get(cls) ?? (yield* makeDirReader(section).pipe(Effect.orElseSucceed(() => null)));
      if (reader === null) return `${named}: its class's dir objects do not read`;
      readers.set(cls, reader);
      const entry = yield* entryAt(reader, section.root, segments).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (entry === null || (entry.kind !== "file" && entry.kind !== "hardlink-group")) {
        return `${named} is not a file of its class`;
      }
      const holder = yield* resolveCaptureFileEntry(
        reader,
        section.root,
        segments.join("/"),
        entry,
      ).pipe(Effect.orElseSucceed(() => null));
      if (holder === null) return `${named} does not resolve to a file of its class`;
      return {
        cls,
        member: segments.join("/"),
        size: holder.size,
        chunks: (holder.chunks ?? []).join(","),
      };
    });
  /**
   * The entry `member`'s class lays that name down with — the resolved file's, for a hardlink
   * member — or why it is not a file of its class.
   */
  const laidDownOf = (
    cls: CaptureClass,
    member: string,
  ): Effect.Effect<DirEntry | string, never, BlobStore> =>
    Effect.gen(function* () {
      const named = `${cls} member ${JSON.stringify(member)}`;
      const section = manifest.sections[cls];
      if (section === "pending") return `${named}: its class is pending`;
      const segments = captureSegments(member);
      if (segments === null || section.root === "") return `${named} is not in its class`;
      const reader =
        readers.get(cls) ?? (yield* makeDirReader(section).pipe(Effect.orElseSucceed(() => null)));
      if (reader === null) return `${named}: its class's dir objects do not read`;
      readers.set(cls, reader);
      const entry = yield* entryAt(reader, section.root, segments).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (entry === null || (entry.kind !== "file" && entry.kind !== "hardlink-group")) {
        return `${named} is not a file of its class`;
      }
      const holder = yield* resolveCaptureFileEntry(
        reader,
        section.root,
        segments.join("/"),
        entry,
      ).pipe(Effect.orElseSucceed(() => null));
      return holder ?? `${named} does not resolve to a file of its class`;
    });
  /** What `member` is in its class, as a restore lays it down; null when the class has no such name. */
  const kindOf = (
    cls: CaptureClass,
    member: string,
  ): Effect.Effect<WorktreeTreeKind | null, never, BlobStore> =>
    Effect.gen(function* () {
      const section = manifest.sections[cls];
      if (section === "pending") return null;
      const segments = captureSegments(member);
      if (segments === null || section.root === "") return null;
      const reader =
        readers.get(cls) ?? (yield* makeDirReader(section).pipe(Effect.orElseSucceed(() => null)));
      if (reader === null) return null;
      readers.set(cls, reader);
      const entry = yield* entryAt(reader, section.root, segments).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (entry === null) return null;
      return entry.kind === "hardlink-group" ? "file" : entry.kind;
    });
  const digestOf = (
    member: ClassMember,
    as: "sha256" | "git-sha1" | "git-sha256",
  ): Effect.Effect<string | null, never, BlobStore> =>
    readCaptureFile(manifest, member.cls, member.member).pipe(
      Effect.flatMap((stream) =>
        Effect.tryPromise(async () => {
          const hash = crypto.createHash(as === "git-sha1" ? "sha1" : "sha256");
          // A git blob object: `blob <size>\0` then the bytes.
          if (as !== "sha256") hash.update(`blob ${member.size}\u0000`);
          for await (const chunk of stream) hash.update(chunk);
          return hash.digest("hex");
        }),
      ),
      Effect.orElseSucceed(() => null),
    );
  return { fileOf, laidDownOf, kindOf, digestOf };
};

/** A path of the tree a restore checks out: what it is, and the object git holds for it. */
export interface RestoreTreePath {
  readonly kind: WorktreeTreeKind;
  readonly object: string;
}

/**
 * Whether the tracked-side link topology the worktree metadata document declares is one the
 * complete restore makes (review 2026-09-28 (6) #10), over the files that restore lays down
 * (`makeRestoreNamespace`: the checkout of `restoreTree` — every path of the tree it checks out
 * (`rawTreeOf`), hex of its bytes → its kind and git object — the workspace class's overlay over
 * it and the bulk class where neither put anything; review 2026-09-28 (9) #7):
 * - each `hardlinks` group is files the restore lays down with the same bytes: every member a
 *   file there, every member the same bytes — sealantd relinks later members onto the first, so a
 *   member holding other bytes (in the checkout, or laid over it by the overlay) would be replaced
 *   by the first's;
 * - each `shared` link names a file the restore lays down and a file its class carries holding
 *   the same bytes (a member the class does not carry, or one holding other bytes, is a link the
 *   restore cannot make).
 * `cross_links` are checked by `crossLinksProblem`. The reason, or null when every link restores.
 */
export const linkTopologyProblem = (
  manifest: CaptureManifest,
  document: WorktreeMetaDocument,
  restoreTree: ReadonlyMap<string, RestoreTreePath>,
): Effect.Effect<string | null, never, BlobStore> =>
  Effect.gen(function* () {
    const { members, effectiveFile } = makeRestoreNamespace(manifest, restoreTree);
    const laidDown = (key: string, raw?: string) =>
      Effect.gen(function* () {
        const bytes = bytesOfPair(key, raw);
        if (bytes === null || bytes.length === 0) return `path ${JSON.stringify(key)}`;
        return yield* effectiveFile(bytes);
      });
    const bytesIdOf = (file: RestoredFile, as: "sha256" | "git-sha1" | "git-sha256") =>
      file.source === "checkout" ? Effect.succeed(file.object) : members.digestOf(file.member, as);
    for (const group of document.hardlinks ?? []) {
      const files: Array<RestoredFile> = [];
      for (const member of group) {
        const found = yield* laidDown(member);
        if (typeof found === "string") return `hardlink group ${JSON.stringify(group)}: ${found}`;
        files.push(found);
      }
      const as = restoredFileDigestOf(files);
      const ids = new Set<string>();
      for (const file of files) {
        const id = yield* bytesIdOf(file, as);
        if (id === null) return `hardlink group ${JSON.stringify(group)}: a member does not read`;
        ids.add(id);
      }
      if (ids.size > 1) {
        return `hardlink group ${JSON.stringify(group)}: members hold different bytes in the files the restore lays down`;
      }
    }
    for (const link of document.shared ?? []) {
      const named = `shared link ${JSON.stringify(link)}`;
      const tracked = yield* laidDown(link.path);
      if (typeof tracked === "string") return `${named}: ${tracked}`;
      const memberKey = bytesOfPair(link.member, link.raw_member);
      if (memberKey === null) return `${named}: its member does not decode`;
      const member = yield* members.fileOf(link.class, keyOfBytes(memberKey));
      if (typeof member === "string") return `${named}: ${member}`;
      const as = restoredFileDigestOf([tracked]);
      const trackedId = yield* bytesIdOf(tracked, as);
      if (trackedId === null) return `${named}: ${JSON.stringify(link.path)} does not read`;
      const digest = yield* members.digestOf(member, as);
      if (digest === null) return `${named}: its member does not read`;
      if (digest !== trackedId) {
        return `${named}: its member holds other bytes than ${JSON.stringify(link.path)}`;
      }
    }
    return null;
  });

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
 * The worktree metadata document's JSON, with every integer `mtime` read from its source text as
 * a `bigint` (as `parseDirObjectJson` reads a dir object's): nanoseconds since the epoch overflow
 * a double's 53 bits.
 */
const parseMetaDocumentJson = (text: string): unknown =>
  JSON.parse(text, (key: string, value: unknown, context?: { readonly source?: string }) =>
    key === "mtime" &&
    typeof value === "number" &&
    context?.source !== undefined &&
    /^-?\d+$/.test(context.source)
      ? BigInt(context.source)
      : value,
  );

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
      parseMetaDocumentJson(Buffer.from(bytes).toString("utf8")),
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
export const verifyGitPack = (
  packPath: string,
  format: GitObjectFormat = "sha1",
): Effect.Effect<void, GitError> =>
  git(
    ["index-pack", `--object-format=${format}`, "--verify", packPath],
    path.dirname(packPath),
  ).pipe(Effect.asVoid);

// ─── A sealed capture's bytes, read back ────────────────────────────────────

/**
 * Whether the git pack stored at `key` is still what register verified: it hashes to its name,
 * and `git index-pack --verify` over it and the index stored beside it passes — the index a
 * restore installs as it is (sealantd `install_pack`) must describe that very pack. The reason it
 * is not, or null.
 */
const storedGitPackProblem = (
  key: string,
  format: GitObjectFormat,
): Effect.Effect<string | null, BlobNotFoundError | BlobStoreError, BlobStore> =>
  Effect.gen(function* () {
    const own = yield* storedObjectProblem(key);
    if (own !== null) return own;
    const store = yield* BlobStore;
    const idxKey = packIdxKeyOf(key);
    const idx = yield* store.get(idxKey);
    const stream = yield* store.getStream(key);
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "mend-seal-pack-"))),
      (dir) =>
        Effect.gen(function* () {
          const packPath = path.join(dir, "pack.pack");
          yield* Effect.tryPromise({
            try: async () => {
              await pipelinePromise(stream, fs.createWriteStream(packPath));
              await fs.promises.writeFile(path.join(dir, "pack.idx"), idx);
            },
            catch: (cause) => cause,
          }).pipe(Effect.orDie);
          return yield* verifyGitPack(packPath, format).pipe(
            Effect.as(null),
            Effect.catchTag("GitError", (error) =>
              Effect.succeed(`${idxKey} does not index ${key}: ${error.stderr.trim()}`),
            ),
          );
        }),
      (dir) => Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
    );
  });

/**
 * Whether every object the capture at `manifestKey` names is still what its name says, read back
 * from the store now (review 2026-09-28 (7) #8): the manifest, every pack, dir pack and format-1
 * dir object of its chunked classes (the worktree metadata document's packs are the workspace
 * class's own), and every git pack with the index a restore installs beside it. Every capture key
 * is content-addressed, so objects that read back as their names are the bytes register verified,
 * and what the seal said of them still holds. The reason one is not (missing, other bytes, an
 * index of another pack), or null. Fails only when the store could not be read (`BlobStoreError`):
 * nothing is concluded then.
 */
export const storedCaptureProblem = (
  manifestKey: string,
): Effect.Effect<string | null, BlobStoreError, BlobStore> =>
  Effect.gen(function* () {
    const store = yield* BlobStore;
    const own = yield* storedObjectProblem(manifestKey);
    if (own !== null) return own;
    const manifest = yield* store.get(manifestKey).pipe(
      Effect.flatMap((bytes) => decodeManifest(manifestKey, bytes)),
      Effect.result,
    );
    if (manifest._tag === "Failure") {
      const error = manifest.failure;
      if (error._tag === "BlobStoreError") return yield* Effect.fail(error);
      return error._tag === "BlobNotFoundError"
        ? `${manifestKey} is not stored`
        : `${manifestKey} does not decode`;
    }
    const sections = manifest.success.sections;
    const keys = new Set(keysOfSections(sections));
    for (const cls of ["workspace", "bulk"] as const) {
      const trees = yield* collectTreeKeys(manifest.success, cls, {
        limit: Number.POSITIVE_INFINITY,
      }).pipe(Effect.result);
      if (trees._tag === "Failure") {
        const error = trees.failure;
        if (error._tag === "BlobStoreError") return yield* Effect.fail(error);
        return `the ${cls} class's dir objects do not read back: ${error._tag}`;
      }
      for (const key of trees.success) keys.add(key);
    }
    const gitPacks = new Set(sections.git.packs);
    const format = gitObjectFormatOf(sections.git);
    if (format === null && gitPacks.size > 0) {
      return `the git section's object format ${JSON.stringify(sections.git.object_format)} is not one Mend reads`;
    }
    for (const key of keys) {
      if (key.endsWith(".idx") && gitPacks.has(key.slice(0, -".idx".length))) continue;
      const problem = yield* (
        gitPacks.has(key) ? storedGitPackProblem(key, format ?? "sha1") : storedObjectProblem(key)
      ).pipe(Effect.catchTag("BlobNotFoundError", () => Effect.succeed(`${key} is not stored`)));
      if (problem !== null) return problem;
    }
    return null;
  }).pipe(
    Effect.catchTag("BlobNotFoundError", (error) => Effect.succeed(`${error.key} is not stored`)),
  );
