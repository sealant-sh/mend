import { isDeepStrictEqual } from "node:util";

import {
  type CaptureConflictError,
  CaptureStoreRepo,
  type CaptureRow,
  type PackRecord,
  type PutAuthorityRecord,
  type WorktreeLease,
} from "@mend/db";
import { type ProjectId, WorktreeId } from "@mend/domain";
import {
  BlobStore,
  bulkSectionFor,
  type BulkSectionReady,
  type CaptureManifest,
  captureKeyOwner,
  type CaptureReadError,
  CaptureSections,
  type ChunkedSection,
  changeSummaryKey,
  decodeChangeSummary,
  decodeManifest,
  captureIdOf,
  dirPacksOf,
  FORMAT_DIR_OBJECTS,
  FORMAT_DIR_PACKS,
  contentDigestOfKey,
  isCaptureObjectKey,
  keysNeededBy,
  keysOfSections,
  MAX_SECTION_FORMAT,
  packIdxKeyOf,
  sameBulkSection,
  sectionFormatOf,
  storedObjectProblem,
  type SectionFormat,
  treePrefixesOfSections,
  verifyPackPayloads,
  verifySectionRestorable,
  verifyWorktreeMeta,
  sectionHoldsRawNames,
  sectionHoldsWideTimes,
  worktreeMetaHoldsWideTimes,
  gitSectionHoldsRawNames,
  restoreNamespaceProblem,
  inodeMetadataProblem,
  crossLinksProblem,
  linkTopologyProblem,
  rawTreeOf,
  type RestoreTreePath,
  gitSectionHoldsTrees,
  type WorktreeMetaDocument,
  withCaptureReadPass,
} from "@mend/store";
import { Cause, Deferred, Duration, Effect, Exit, Layer, Option, Result, Schema } from "effect";
import * as Context from "effect/Context";

import { CaptureRemotes, type PlanRemote } from "./capture-remotes.ts";
import {
  SEAL_VERIFICATION_LIMIT,
  SEAL_VERIFICATION_LIMIT_WORDS,
  sealStandingOf,
  sealVerifications,
} from "./capture-seals.ts";
import { CaptureSources, type PlanSource } from "./capture-sources.ts";
import { CaptureGitVerifier, type GitVerification } from "./capture-verify.ts";
import { makeSingleFlight } from "./single-flight.ts";

/**
 * The capture half of the session channel (ADR-0002 "Session channel routes"): sealantd's
 * `Registrar` port as six POST routes — `plan.get`, `upload.urls`, `upload.complete`,
 * `capture.register`, `change.summary`, `lease.heartbeat` — each carrying the caller's `epoch`. Authentication is
 * the tunnel's (the per-session token, hash-verified before the session resolves); every closure
 * here is already scoped to ONE session's worktree, so the route table has nothing to check
 * beyond what the request says about itself.
 *
 * The wire shape mirrors sealantd's `crates/sealant-capture/src/registrar.rs` (snake_case
 * fields; a 409 body carries `reason` and, where it helps the executor decide, `live_epoch`,
 * the head it collided with, or the byte quota's `limit`/`used`/`requested`). The manifest and
 * the summary travel over this channel; bulk bytes never do — they go straight to the bucket
 * through presigned URLs minted here.
 */

// ─── Wire types ─────────────────────────────────────────────────────────────

export const PlanGetRequest = Schema.Struct({
  worktree_id: Schema.optional(Schema.NullOr(Schema.String)),
  /** 0 = "not claimed yet": the first plan of a booting executor claims the lease. */
  epoch: Schema.optional(Schema.Int),
  /**
   * The executor's `<os>-<arch>-<libc>` (sealantd follow-up, PLATFORM-FEEDBACK.md 2026-09-13;
   * the key its bulk class stamps on its captures). When named, the answer's bulk section is the
   * head's `bulk` if it was captured on that platform, else the section the head's `other_bulk`
   * carries for it (sealantd PR #101), else `"pending"` with no packs presigned: the executor
   * never restores a dependency tree built for another platform (decision 2), and the engine
   * runs the install command instead. Absent = the whole head, unchanged (an older sealantd).
   */
  platform: Schema.optional(Schema.String),
  /**
   * The highest section format the executor READS (the request's half of `manifest_format`;
   * a sealantd wire addition, `registrar.rs` "`manifest_format` on `plan.get`"). Absent = 1:
   * an executor that predates dir packs, or one that does not say. Mend never hands a plan
   * holding a section above it — `plan.get` answers 409 `manifest-format` before it claims the
   * lease or presigns anything, because an older reader takes a format-2 root digest for a key
   * and can rewrite the worktree's git state before it fails — and answers `manifest_format`
   * no higher than it, so an executor never writes what it could not restore.
   */
  manifest_format: Schema.optional(Schema.Int),
  /**
   * The manifest features the executor READS (`MANIFEST_FEATURES`), beside `manifest_format`:
   * the format gate negotiates how dir objects are stored, not what a manifest means. A head
   * holding a feature the executor does not list is refused (409 `manifest-features`, naming
   * them in `missing`) before the claim, because an executor that ignores one restores less
   * than was saved or drops it from the captures it writes next. Absent = none.
   */
  manifest_features: Schema.optional(Schema.Array(Schema.String)),
  /**
   * The launch the executor says it is (cross-repo decision 11; sealantd round 4), from its first
   * `plan.get` on: as its launcher named it, or as its own disk last recorded it. The token
   * already names a launch; a request naming another is refused (409 `launch-mismatch`, which
   * sealantd reads as a refusal of the boot) — an executor never plans, and so never holds a
   * lease or seals, as a launch its token was not issued for. Absent = the executor does not
   * say (an older daemon): the token alone decides.
   */
  launch: Schema.optional(Schema.String),
  /**
   * The `upload.urls` answer shapes the executor reads beyond `urls` and `multipart` (cross-repo
   * decision 20, review 2026-09-28 (7) #7; sealantd round 7): `present` — a key the bucket holds
   * is answered in `present`, with no URL. Absent (every older daemon, which requires a URL for
   * every key it asks about and reads a 412 as uploaded): a stored key is answered with a
   * write-once URL, as before, once its bytes are verified.
   */
  upload_answers: Schema.optional(Schema.Array(Schema.String)),
});
export type PlanGetRequest = typeof PlanGetRequest.Type;

/** The `upload.urls` answer shape an executor lists in `plan.get`'s `upload_answers` to read it. */
export const UPLOAD_ANSWER_PRESENT = "present";

/**
 * The executor sends `x-amz-checksum-sha256` on a PUT whose URL signs it, and declares in
 * `upload.urls` the SHA-256 of each key whose name does not say it (sealantd `registrar.rs`,
 * "Bytes-bound PUT URLs"). On a store that `bindsBytes` (Garage) its URLs are bound to their
 * bytes, and hold no authority to replace an object: no seal waits for them.
 */
export const UPLOAD_ANSWER_SHA256 = "sha256";

/**
 * 409 `launch-mismatch`: the request names a launch other than the one the token was issued
 * for. Nothing is claimed, planned or told.
 */
const refuseOtherLaunch = (input: PlanGetRequest, tokenLaunch: string) =>
  input.launch === undefined || input.launch === tokenLaunch
    ? Effect.void
    : Effect.fail(
        new CaptureRouteError({
          status: 409,
          reason: "launch-mismatch",
          message: "the request names a launch this token was not issued for",
        }),
      );

/**
 * What a manifest can say beyond its sections' formats, each of which a reader must act on:
 *
 * - `worktree_meta`: `sections.workspace.worktree_meta`, the metadata overlay a restore applies
 *   (modes, nanosecond mtimes, untracked directories, hardlink groups of the working tree).
 * - `symrefs`: `sections.git.symrefs`, symbolic refs other than `HEAD` a restore writes.
 * - `other_bulk`: `sections.other_bulk`, other platforms' bulk sections an executor carries into
 *   every capture it writes — and needed as soon as the head's own bulk section was captured on
 *   another platform than the executor's, which then carries it there.
 * - `raw_names`: `raw_name` / `raw_target` on dir entries, the bytes of names and symlink texts
 *   that are not UTF-8; and escaped keys (characters of `U+10FF80..=U+10FFFF`) among the git
 *   section's ref names, symbolic refs and targets, or `head`.
 * - `final_seal`: the manifest's `final_seal`, a completed final flush of the executor that wrote
 *   it.
 * - `git_trees`: `sections.git.worktree_tree` / `index_tree` / `raw_tree` (sealantd review 3):
 *   the trees in their own fields, `refs` the repository's refs whatever their names, and a raw
 *   tree a restore writes back without conversion. An executor that reads the trees from the
 *   pseudo-refs would restore neither the raw bytes nor a user ref under `refs/sealant/capture/`.
 * - `object_format`: `sections.git.object_format` (sealantd review 8 #10), the repository's object
 *   format when it is not `sha1`. An executor that does not read it would install a SHA-256 pack
 *   into a SHA-1 repository and fail its restore.
 * - `ref_format`: `sections.git.ref_format` (sealantd review 9 #1, cross-repo decision 24), the
 *   repository's ref backend when it is not `files` (`reftable`). An executor that does not read
 *   it would restore a files repository under a reftable one's tables.
 * - `wide_times` (sealantd review 10, 4c94bd4): a dir entry of the answered workspace or bulk
 *   section, or an entry of its worktree metadata document, has an `mtime` outside signed 64-bit
 *   nanoseconds — a time before 1677 or after 2262, a JSON integer outside i64. Mend keeps every
 *   integer mtime as the exact `bigint` its source text says (never a double, never clamped) and
 *   compares it exactly; an executor that does not read them would refuse the number or write a
 *   false time.
 */
export const MANIFEST_FEATURES = [
  "worktree_meta",
  "symrefs",
  "other_bulk",
  "raw_names",
  "final_seal",
  "git_trees",
  "object_format",
  "ref_format",
  "wide_times",
] as const;
export type ManifestFeature = (typeof MANIFEST_FEATURES)[number];

/**
 * The features a plan's head holds that the executor did not say it reads. `stored` is the head
 * as registered, `planned` as this executor would restore it; the dir objects are walked for raw
 * names, and they and the worktree metadata document for wide times, only when the executor does
 * not read them.
 */
export const missingManifestFeatures = (
  stored: CaptureManifest,
  planned: CaptureManifest,
  input: PlanGetRequest,
): Effect.Effect<ReadonlyArray<ManifestFeature>, CaptureReadError, BlobStore> =>
  Effect.gen(function* () {
    const reads = new Set(input.manifest_features ?? []);
    const held: Array<ManifestFeature> = [];
    const holds = (feature: ManifestFeature, present: boolean) => {
      if (present && !reads.has(feature)) held.push(feature);
    };
    holds("worktree_meta", planned.sections.workspace.worktree_meta !== undefined);
    holds("symrefs", Object.keys(planned.sections.git.symrefs ?? {}).length > 0);
    const storedBulk = stored.sections.bulk;
    holds(
      "other_bulk",
      Object.keys(stored.sections.other_bulk ?? {}).length > 0 ||
        (input.platform !== undefined &&
          storedBulk !== "pending" &&
          storedBulk.platform !== input.platform),
    );
    holds("final_seal", planned.final_seal !== undefined);
    holds("git_trees", gitSectionHoldsTrees(planned.sections.git));
    holds("object_format", planned.sections.git.object_format !== undefined);
    holds("ref_format", planned.sections.git.ref_format !== undefined);
    if (!reads.has("raw_names")) {
      const bulk = planned.sections.bulk;
      const raw =
        gitSectionHoldsRawNames(planned.sections.git) ||
        (yield* sectionHoldsRawNames(planned.sections.workspace)) ||
        (bulk !== "pending" && (yield* sectionHoldsRawNames(bulk)));
      holds("raw_names", raw);
    }
    if (!reads.has("wide_times")) {
      const bulk = planned.sections.bulk;
      const wide =
        (yield* sectionHoldsWideTimes(planned.sections.workspace)) ||
        (bulk !== "pending" && (yield* sectionHoldsWideTimes(bulk))) ||
        worktreeMetaHoldsWideTimes(yield* verifyWorktreeMeta(planned.sections.workspace));
      holds("wide_times", wide);
    }
    return held;
  });

/** 409 `manifest-features`: the plan holds manifest features the executor did not say it reads. */
const featuresRefusal = (missing: ReadonlyArray<ManifestFeature>) =>
  new CaptureRouteError({
    status: 409,
    reason: "manifest-features",
    message: `the head holds ${missing.join(", ")}; this executor does not say it reads ${missing.length === 1 ? "it" : "them"} (plan.get manifest_features) — run a sealantd that does`,
    missing,
  });

/** What an executor says it reads: 1 unless it names a higher format (capped at what Mend reads). */
export const readerFormatOf = (input: PlanGetRequest): SectionFormat =>
  input.manifest_format !== undefined && input.manifest_format >= FORMAT_DIR_PACKS
    ? MAX_SECTION_FORMAT
    : FORMAT_DIR_OBJECTS;

/** The format `plan.get` answers: the configured one, never above what the executor reads. */
const answeredFormat = (configured: SectionFormat, reads: SectionFormat): SectionFormat =>
  configured === FORMAT_DIR_PACKS && reads === FORMAT_DIR_PACKS
    ? FORMAT_DIR_PACKS
    : FORMAT_DIR_OBJECTS;

/** The highest section format a plan's manifest asks its reader to read: its workspace and bulk. */
export const planFormatOf = (manifest: CaptureManifest): SectionFormat => {
  const bulk = manifest.sections.bulk;
  return bulk !== "pending" && sectionFormatOf(bulk) === FORMAT_DIR_PACKS
    ? FORMAT_DIR_PACKS
    : sectionFormatOf(manifest.sections.workspace);
};

/** 409 `manifest-format`: the plan holds a section the executor did not say it reads. */
const formatRefusal = (reads: SectionFormat, holds: SectionFormat) =>
  new CaptureRouteError({
    status: 409,
    reason: "manifest-format",
    message: `the head holds a format-${holds} section; this executor reads format ${reads} (plan.get manifest_format) — run a sealantd that reads format ${holds}`,
  });

export interface PlanGetResponse {
  readonly worktree_id: string;
  /** The epoch the caller now holds; sealantd carries it on every later call. */
  readonly epoch: number;
  readonly head: {
    readonly n: number;
    readonly capture_id: string;
    readonly manifest_key: string;
    readonly manifest: CaptureManifest;
  } | null;
  readonly get_urls: Readonly<Record<string, string>>;
  /**
   * The highest section format this registrar reads (sealantd PR #99, `registrar.rs`
   * "`manifest_format` on `plan.get`"): at 2 the executor packs a section's dir objects into dir
   * packs and names them by digest; at 1 it writes one object per directory, as before. A
   * sealantd that predates dir packs ignores it. Either way Mend reads both formats: the answer
   * only decides what the executor writes next.
   */
  readonly manifest_format: SectionFormat;
  /**
   * Every manifest feature this registrar reads, validates and keeps (`MANIFEST_FEATURES`): an
   * executor may write any of them. A sealantd that predates the list ignores it.
   */
  readonly manifest_features: ReadonlyArray<ManifestFeature>;
  /**
   * The physical executor the session token was issued for — its launch identity
   * (`CaptureScope.launchId`, cross-repo decision 5): what a completed final flush's
   * `final_seal.executor` must name for register to record the seal. sealantd seals only when it
   * knows it (sealantd `registrar.rs` "`executor` on `plan.get`").
   */
  readonly executor: string;
  /**
   * Content to lay down beside the worktree — the project's folders and references, which a
   * captured workspace cannot bind-mount (`capture-sources.ts`). Absent when the project selected
   * none; a sealantd older than 0.16.0 ignores it.
   */
  readonly sources?: ReadonlyArray<PlanSource>;
  /**
   * The remotes the worktree's repository should have (`capture-remotes.ts`): sealantd builds
   * that repository itself, so it has none otherwise. Absent when the project has no origin; a
   * sealantd that predates plan remotes ignores it.
   */
  readonly remotes?: ReadonlyArray<PlanRemote>;
}

/**
 * `upload.urls` (sealantd `registrar.rs` "Wire additions"): `keys` is the plain list it always
 * was; `sizes` (key → bytes, a subset of `keys`) names the keys the executor would upload as
 * multipart. A registrar without `sizes` support answers `urls` alone and gets single PUTs.
 */
export const UploadUrlsRequest = Schema.Struct({
  worktree_id: Schema.String,
  epoch: Schema.Int,
  keys: Schema.Array(Schema.String),
  sizes: Schema.optional(Schema.Record(Schema.String, Schema.Int)),
  /** `final` once the executor began a final flush (`isFinalFlush`). */
  flush: Schema.optional(Schema.String),
  /**
   * The SHA-256 (hex) of keys whose name does not say it — a pack index (`UPLOAD_ANSWER_SHA256`).
   * Every other capture key ends in it.
   */
  sha256: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type UploadUrlsRequest = typeof UploadUrlsRequest.Type;

/** A multipart plan: part `i` (1-based) is PUT to `part_urls[i - 1]`, `part_size` bytes each but the last. */
export interface MultipartPlan {
  readonly upload_id: string;
  readonly part_size: number;
  readonly part_urls: ReadonlyArray<string>;
}

/**
 * `upload.urls` response. `urls` is unchanged — one PUT URL per single-part key. A key taken
 * as multipart is present in `multipart` and absent from `urls`. A key the bucket already holds,
 * with the bytes its name says (`storedObjectProblem`), is answered in `present` and in neither
 * of the others (cross-repo decision 19, review 2026-09-28 (6) #9) — but only to a launch whose
 * `plan.get` listed `present` in `upload_answers` (cross-repo decision 20, review 2026-09-28
 * (7) #7): an older daemon requires a URL for every key, so it gets one write-once PUT URL for
 * the stored key, as before, and reads the 412 of a bucket that honours `If-None-Match` as
 * uploaded. The executor reads a `present` key as already uploaded. Omitted when empty.
 */
export interface UploadUrlsResponse {
  readonly urls: Readonly<Record<string, string>>;
  readonly multipart: Readonly<Record<string, MultipartPlan>>;
  readonly present?: ReadonlyArray<string>;
}

/** How many keys `upload.urls` asks the bucket about at once. */
const PRESENT_HEADS_IN_FLIGHT = 16;

export const UploadCompleteRequest = Schema.Struct({
  worktree_id: Schema.String,
  epoch: Schema.Int,
  key: Schema.String,
  upload_id: Schema.String,
  parts: Schema.Array(Schema.Struct({ part_number: Schema.Int, etag: Schema.String })),
});
export type UploadCompleteRequest = typeof UploadCompleteRequest.Type;

export const RegisterRequest = Schema.Struct({
  worktree_id: Schema.String,
  epoch: Schema.Int,
  n: Schema.Int,
  parent: Schema.NullOr(Schema.String),
  capture_id: Schema.String,
  manifest_key: Schema.String,
  manifest: Schema.Unknown,
  /** `final` once the executor began a final flush (`isFinalFlush`). */
  flush: Schema.optional(Schema.String),
});
export type RegisterRequest = typeof RegisterRequest.Type;

/**
 * `flush` on `upload.urls` and `capture.register` (sealantd `registrar.rs`, cross-repo decision
 * 35, review 2026-09-28 (10) #6): from the moment an executor begins a final flush — whoever asked
 * for it: Mend's drain, Core's deadline, the daemon's own shutdown, a recovery boot — until its
 * process exits, every request it sends says `"flush":"final"`. It is ending, and what it ships is
 * work it already admitted: the request is exempt from the byte and call quotas, whether or not a
 * Mend drain is under way (`CaptureScope.unmetered` covers only the drains Mend itself runs), and
 * the bytes it takes past the byte quota are logged. There is no cap: a final flush ships what the
 * executor's disk holds, under its own epoch prefix, and a first final flush is never refused.
 * Absent from an older executor and before a final flush; any other value is metered.
 */
export const isFinalFlush = (input: { readonly flush?: string | undefined }): boolean =>
  input.flush === "final";

export const ChangeSummaryRequest = Schema.Struct({
  worktree_id: Schema.String,
  epoch: Schema.Int,
  capture_id: Schema.String,
  summary: Schema.Unknown,
});
export type ChangeSummaryRequest = typeof ChangeSummaryRequest.Type;

export const HeartbeatRequest = Schema.Struct({
  worktree_id: Schema.String,
  epoch: Schema.Int,
});
export type HeartbeatRequest = typeof HeartbeatRequest.Type;

/**
 * Refusal reasons; the executor pauses on every 409 and never kills. `quota-exceeded` is the
 * request quota (429: calls per hour, a retry later can pass); `byte-quota` is the byte quota
 * (413 on `upload.urls` before any URL is minted, 409 on `capture.register` as the backstop),
 * which no retry of the same bytes can pass — the body carries `limit`, `used` and `requested`.
 * `unrestorable` (422 on `capture.register`): a section's tree would not restore from what the
 * manifest names — nothing is registered. `manifest-format` (409 on `plan.get`): the head holds
 * a section format the executor did not say it reads — refused before the claim.
 * `manifest-features` (409 on `plan.get`): the head holds manifest features the executor did not
 * say it reads (`missing` names them) — refused before the claim. `launch-mismatch` (409 on
 * `plan.get`): the request names a launch its token was not issued for — sealantd refuses its
 * boot.
 */
export const CaptureRefusalReason = Schema.Literals([
  "launch-mismatch",
  "stale-epoch",
  "wrong-parent",
  "wrong-worktree",
  "worktree-leased",
  "lease-lost",
  "not-head",
  "missing-objects",
  "capture-id-mismatch",
  "bad-request",
  "quota-exceeded",
  "byte-quota",
  "exists",
  "size-mismatch",
  "unrestorable",
  "manifest-format",
  "manifest-features",
]);
export type CaptureRefusalReason = typeof CaptureRefusalReason.Type;

export class CaptureRouteError extends Schema.TaggedErrorClass<CaptureRouteError>()(
  "CaptureRouteError",
  {
    status: Schema.Int,
    reason: CaptureRefusalReason,
    message: Schema.String,
    live_epoch: Schema.optional(Schema.Int),
    head_n: Schema.optional(Schema.Int),
    head_capture_id: Schema.optional(Schema.String),
    missing: Schema.optional(Schema.Array(Schema.String)),
    /** `exists`: the key whose bytes are already there. */
    key: Schema.optional(Schema.String),
    /** `byte-quota`: the session's budget, what it has priced so far, and what this call asked for — bytes. */
    limit: Schema.optional(Schema.Int),
    used: Schema.optional(Schema.Int),
    requested: Schema.optional(Schema.Int),
  },
) {}

/**
 * What became of a registered manifest's `final_seal` (cross-repo decision 22, review 2026-09-28
 * (8) #5), answered as `seal` on `capture.register` whenever the manifest carries one — the
 * registrar's word, which the executor's own FINAL waits on before it answers complete:
 * - `recorded`: recorded, and it stands now — nothing handed out can replace what it names;
 * - `withheld`: recorded, but it does not stand yet. `reason`: `write-authority` (an upload URL of
 *   its epoch could still replace what it names, or one was handed out while its objects were read
 *   back), `verifying` (its objects are still being read back, or could not be) or `unavailable`
 *   (the checks could not finish: the store did not answer a read, or Mend failed to record the
 *   seal — nothing was observed wrong with the capture, and the next ask checks it again; review
 *   2026-09-28 (12) #4). Registering the same capture again (idempotent) answers it anew;
 * - `refused`: not recorded, or void — it never stands. `reason`: `incomplete` (not
 *   `complete`), `epoch` (another epoch than the register's), `executor` (another launch's),
 *   `unrestorable` (a section Mend did not observe restore), `not-recorded`, `void` (an object it
 *   names read back as other bytes). Answered on a lost-ack re-register too, as it stands then.
 * The shape is sealantd's `SealAnswer` (`registrar.rs`): `reason` is a short code; the detail is
 * logged here. Absent: the manifest carried no `final_seal`. An executor that does not read the
 * field ignores it (an unknown field), as before.
 */
export interface RegisterSealOutcome {
  readonly state: "recorded" | "withheld" | "refused";
  readonly reason?:
    | "write-authority"
    | "verifying"
    | "unavailable"
    | "incomplete"
    | "epoch"
    | "executor"
    | "unrestorable"
    | "not-recorded"
    | "void";
}

/** What `capture.register` answers. */
interface RegisterAnswer {
  readonly head_n: number;
  readonly head_capture_id: string;
  readonly epoch: number;
  readonly seal?: RegisterSealOutcome;
}

/**
 * What a sealing capture's read-back checks found (`sealChecks`): nothing, when the seal may stand.
 * `problems` are what the checks observed wrong with the capture — a verdict about its bytes,
 * kept for the re-asks. `unavailable` says the checks could not conclude (review 2026-09-28 (12)
 * #4): the store failed a read (a 503, a timeout — `BlobStoreError`), the checks died, or the seal
 * could not be recorded. Such a verdict says nothing about the capture: it is answered `withheld`
 * (`unavailable`), never kept, and the next ask checks again. It outranks `problems` — a problem
 * observed while the store was failing reads is not trusted as one.
 */
interface SealVerdict {
  readonly problems: ReadonlyArray<string>;
  readonly unavailable?: ReadonlyArray<string>;
}

/** Whether `verdict` concluded nothing (`SealVerdict.unavailable`). */
const verdictUnavailable = (verdict: SealVerdict): boolean =>
  (verdict.unavailable ?? []).length > 0;

/**
 * `blobs`, each read the store fails (`BlobStoreError`: a 503, a timeout, a reset) noted in
 * `failed` — whatever the reader then makes of it — for seal checks to tell the store not
 * answering from bytes that are wrong (review 2026-09-28 (12) #4).
 */
const noteStoreFailures = (
  blobs: typeof BlobStore.Service,
  failed: Array<string>,
): typeof BlobStore.Service => {
  const noted =
    (what: string) =>
    <A, E extends { readonly _tag: string }>(self: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      self.pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (error._tag === "BlobStoreError") failed.push(what);
          }),
        ),
      );
  return {
    ...blobs,
    get: (key) => blobs.get(key).pipe(noted(`get ${key}`)),
    getRange: (key, start, length) =>
      blobs.getRange(key, start, length).pipe(noted(`get ${key} @${start}+${length}`)),
    getStream: (key) => blobs.getStream(key).pipe(noted(`get ${key}`)),
    head: (key) => blobs.head(key).pipe(noted(`head ${key}`)),
    list: (prefix) => blobs.list(prefix).pipe(noted(`list ${prefix}`)),
  };
};

/**
 * One sealing capture's seal checks (e2e8 F2): `verdict` once they end; `settled` once nothing
 * is left to record on their account — the register's CAS carried the seal (or refused it) with
 * the verdict in hand, or the recorder that took over once the register answered `withheld`
 * finished (`recording`) — however it ended: a recorder that failed or died settles it
 * `unavailable`, and the job is dropped for the next ask to start again.
 */
interface SealJob {
  /** Its key in the channel's jobs (`sealKeyOf`). */
  readonly key: string;
  readonly verdict: Deferred.Deferred<SealVerdict>;
  readonly settled: Deferred.Deferred<SealVerdict>;
  recording: boolean;
}

/** What the network host serves for one session once the engine registers it. */
export interface SessionCaptureApi {
  readonly planGet: (input: PlanGetRequest) => Effect.Effect<PlanGetResponse, CaptureRouteError>;
  readonly uploadUrls: (
    input: UploadUrlsRequest,
  ) => Effect.Effect<UploadUrlsResponse, CaptureRouteError>;
  /**
   * Assemble a multipart upload write-once; 409 `exists` when the key already holds bytes.
   * `size` is the assembled object's, when the bucket reports it (the executor checks it).
   */
  readonly uploadComplete: (
    input: UploadCompleteRequest,
  ) => Effect.Effect<{ readonly size?: number }, CaptureRouteError>;
  readonly register: (input: RegisterRequest) => Effect.Effect<
    {
      readonly head_n: number;
      readonly head_capture_id: string;
      readonly seal?: RegisterSealOutcome;
    },
    CaptureRouteError
  >;
  readonly changeSummary: (
    input: ChangeSummaryRequest,
  ) => Effect.Effect<{ readonly accepted: true; readonly key: string }, CaptureRouteError>;
  readonly heartbeat: (
    input: HeartbeatRequest,
  ) => Effect.Effect<{ readonly expires_in_secs: number }, CaptureRouteError>;
}

// ─── Policy ─────────────────────────────────────────────────────────────────

/** Presigned URL lifetime; compaction's 30 min grace derives from it (ADR-0015). */
export const PRESIGN_TTL_SECONDS = 15 * 60;

/**
 * How far behind Mend's the bucket's clock may run, for how long a PUT URL it handed out stays
 * usable there: an S3 URL expires at its signing time plus its TTL by the bucket's clock. The
 * signer (Mend, which stamps `X-Amz-Date`) and the verifier (the bucket, which compares it with its
 * own clock) share no clock source Mend can name — the bucket is S3, R2 or a Garage on another
 * host — and Mend never observes the bucket's clock, so the margin is not shrunk to what one NTP
 * host would need (e2e8, kept at 5 min): a bucket whose clock lags by more than it would accept an
 * expired URL past the window a seal waits out, and the seal would stand over bytes a URL could
 * still replace.
 */
export const PUT_URL_CLOCK_MARGIN_SECONDS = 5 * 60;
/**
 * The shortest PUT URL Mend hands out (e2e8, the seal window on Garage). Every URL withholds its
 * epoch's seal until it expires plus `PUT_URL_CLOCK_MARGIN_SECONDS`; at a flat 15 minutes every
 * Stop on a bucket that ignores `If-None-Match` waited 20 minutes to seal. A URL now lives for
 * what its call uploads (`putUrlTtlSeconds`), but never less than this: sealantd reuses a PUT URL
 * it holds for up to 5 minutes after it was answered (`PUT_URL_REUSE`, `registrar.rs`) — a bulk
 * batch paused for a small capture resumes on it, a PUT the store refused for now retries on it —
 * and a bucket checks expiry when the PUT arrives, so a URL must still be good 5 minutes after it
 * left Mend; 30 s more covers the answer's way to the executor.
 */
export const PUT_URL_TTL_MIN_SECONDS = 5 * 60 + 30;
/**
 * The upload rate a PUT URL's lifetime assumes (`putUrlTtlSeconds`): conservative — e2e8's
 * executors shipped at 15 MB/s through a throttled link — so a URL outlives its upload on a slow
 * link. A link slower still only costs a refused PUT that sealantd mints again, never bytes.
 */
export const PUT_URL_ASSUMED_BYTES_PER_SECOND = 1024 * 1024;

/**
 * How long the PUT URLs of one `upload.urls` call live: `PUT_URL_TTL_MIN_SECONDS`, plus the time
 * the call's declared bytes take at `PUT_URL_ASSUMED_BYTES_PER_SECOND` — sealantd uploads a
 * call's objects a few at a time in no set order, so any of them may go last — capped at
 * `PRESIGN_TTL_SECONDS`. A call with a key of unknown size gets the cap.
 */
export const putUrlTtlSeconds = (bytes: number | null): number =>
  bytes === null
    ? PRESIGN_TTL_SECONDS
    : Math.min(
        PRESIGN_TTL_SECONDS,
        PUT_URL_TTL_MIN_SECONDS + Math.ceil(Math.max(0, bytes) / PUT_URL_ASSUMED_BYTES_PER_SECOND),
      );
/** The longest a bound URL could be used, by the bucket's clock: its longest life plus the margin. */
const BOUND_URL_LIFETIME_MS = (PRESIGN_TTL_SECONDS + PUT_URL_CLOCK_MARGIN_SECONDS) * 1000;

/**
 * How long after this process started it binds no pack index (`boundDigests`): until every URL a
 * process before it could have handed out is dead by the bucket's clock.
 */
export const BOUND_INDEX_TRUSTED_AFTER_MS = BOUND_URL_LIFETIME_MS;

/**
 * Request quota: `upload.urls` CALLS per session per rolling hour, and keys per call. Calls are
 * what cost the registrar (a presign is a local signature; the bucket is never asked); keys are
 * content-addressed dir objects and packs, tiny and many — the first bulk capture of a
 * Mend-size repository is 20,495 dir objects for 134,741 files (observed 2026-09-14), which
 * the daemon ships in batches of 500 keys per call. Counting keys, as the 2,000-URL quota did,
 * only ever punished a big tree; what a session can write is bounded by bytes, below.
 */
export const UPLOAD_CALLS_PER_HOUR = 600;
export const UPLOAD_KEYS_PER_CALL = 1_000;
/**
 * Byte quota: `max(floor, 4× the project's compressed footprint)` per executor launch, priced
 * once per object key. It bounds new work only: nothing a draining, kept or recovering executor
 * ships, no `final` capture's register, and no request an executor marks `flush: final`
 * (`isFinalFlush`), is refused for it (cross-repo decisions 30 and 35). `upload.urls` is the enforcement point — a batch whose declared sizes would take
 * the session over is refused with 413 `byte-quota` before any URL is minted, so refused bytes
 * never land; `capture.register` is the backstop for what did land (keys the daemon sends no
 * size for), refusing with 409 `byte-quota`. A key is priced when first reserved or first
 * registered and never again: a later manifest lists every pack of the epoch, and unchanged
 * dir objects are not re-uploaded, so the count is naturally incremental. The floor is sized
 * for decision 2 (dependency trees are captured): a Mend-size `node_modules` is 775 MB across
 * 134,103 files (observed 2026-09-14, on the 512 MiB floor it replaced), and a session installs
 * more than once. `MEND_CAPTURE_BYTE_QUOTA_FLOOR` overrides the floor.
 */
export const BYTE_QUOTA_MULTIPLIER = 4;
export const BYTE_QUOTA_FLOOR = 8 * 1024 * 1024 * 1024;
/** Byte ledgers kept in memory, one per launch, the least recently asked about dropped first. */
export const LEDGERS_KEPT = 512;
/** Heartbeat expiry the executor is told (ADR-0002: heartbeat every 10 s against 30 s). */
export const LEASE_EXPIRES_IN_SECS = 30;
/**
 * The lease Mend claims at launch must outlive the executor's boot (cold materialise ≈ 25–55 s,
 * ADR-0002 "Consequences"); the first heartbeat brings it back to the 30 s cadence.
 */
export const LAUNCH_CLAIM_TTL_SECONDS = 5 * 60;
/**
 * How long a register may spend before it answers (e2e8 F2). sealantd times a register out after
 * 60 s and sends it again; a sealing register on the Mend repository over Garage took 4 m 35 s,
 * so every attempt timed out and ran on beside the next. Within this budget the register answers
 * whatever its seal checks concluded; past it, the capture registers without the seal, the answer
 * says `withheld` (`verifying`), the checks go on, and the seal is recorded once they pass — the
 * executor's re-ask (the same register again) reads how it stands. 40 s leaves 20 s of sealantd's
 * 60 s for the store's CAS, the answer and the network.
 */
export const REGISTER_ANSWER_BUDGET_MS = 40_000;
/** The register's answer budget in force (`REGISTER_ANSWER_BUDGET_MS`; a test sets its own). */
export const CaptureRegisterBudget: Context.Reference<number> = Context.Reference<number>(
  "@mend/sessions/CaptureRegisterBudget",
  { defaultValue: () => REGISTER_ANSWER_BUDGET_MS },
);
/** How many seal verdicts reached after a register answered are remembered for its re-asks. */
const SEAL_VERDICTS_KEPT = 1_024;

// ─── Upload policy ──────────────────────────────────────────────────────────

/** Keys at or above this size are planned as multipart uploads. */
export const MULTIPART_THRESHOLD_BYTES = 16 * 1024 * 1024;
/** Part size; S3 and R2 refuse parts under 5 MiB except the last. */
export const MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;
/** S3's cap on parts per upload. */
export const MULTIPART_MAX_PARTS = 10_000;
const S3_MIN_PART_BYTES = 5 * 1024 * 1024;

/**
 * How `upload.urls` plans an upload — single PUT below the threshold, parts of `partSizeBytes`
 * above it — how many calls a session may make per rolling hour, of how many keys each, and
 * the floor of the session's byte quota. A test provides small numbers against the directory
 * store; production reads the environment for the sizes and the floor and the constants for
 * the request quota.
 */
export class CaptureUploadPolicy extends Context.Service<
  CaptureUploadPolicy,
  {
    readonly multipartThresholdBytes: number;
    readonly partSizeBytes: number;
    readonly callsPerHour: number;
    readonly keysPerCall: number;
    /** The byte quota is `max(byteQuotaFloorBytes, BYTE_QUOTA_MULTIPLIER × footprint)`. */
    readonly byteQuotaFloorBytes: number;
    /**
     * Refuse a key the executor does not size (docs/adr/0003, multi mode gate). With sizes, every
     * upload URL is signed for exactly the declared bytes and the stored size is verified.
     */
    readonly requireSizes: boolean;
    /**
     * The `manifest_format` both `plan.get`s answer (`MEND_CAPTURE_MANIFEST_FORMAT`): 2 lets
     * executors write dir packs, 1 rolls them back to one object per directory. Reading is
     * never switched off — captures already written in either format keep restoring.
     */
    readonly manifestFormat: SectionFormat;
    /**
     * How long after this process started it binds no pack index (`BOUND_INDEX_TRUSTED_AFTER_MS`
     * when absent): a test that starts its world fresh sets 0.
     */
    readonly boundIndexTrustedAfterMs?: number;
  }
>()("@mend/sessions/CaptureUploadPolicy") {}

export const CaptureUploadPolicyDefault: Layer.Layer<CaptureUploadPolicy> = Layer.succeed(
  CaptureUploadPolicy,
  {
    multipartThresholdBytes: MULTIPART_THRESHOLD_BYTES,
    partSizeBytes: MULTIPART_PART_SIZE_BYTES,
    callsPerHour: UPLOAD_CALLS_PER_HOUR,
    keysPerCall: UPLOAD_KEYS_PER_CALL,
    byteQuotaFloorBytes: BYTE_QUOTA_FLOOR,
    requireSizes: false,
    manifestFormat: MAX_SECTION_FORMAT,
  },
);

export class CaptureUploadPolicyError extends Error {
  override readonly name = "CaptureUploadPolicyError";
}

export interface CaptureUploadPolicyEnvLike {
  readonly MEND_CAPTURE_MULTIPART_THRESHOLD?: string | undefined;
  readonly MEND_CAPTURE_MULTIPART_PART_SIZE?: string | undefined;
  readonly MEND_CAPTURE_BYTE_QUOTA_FLOOR?: string | undefined;
  readonly MEND_CAPTURE_REQUIRE_SIZES?: string | undefined;
  readonly MEND_CAPTURE_MANIFEST_FORMAT?: string | undefined;
}

/** `MEND_CAPTURE_MANIFEST_FORMAT`: `2` (the default) or `1`; anything else refuses to start. */
const manifestFormatOf = (raw: string | undefined): SectionFormat => {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return MAX_SECTION_FORMAT;
  if (trimmed === String(FORMAT_DIR_OBJECTS)) return FORMAT_DIR_OBJECTS;
  if (trimmed === String(FORMAT_DIR_PACKS)) return FORMAT_DIR_PACKS;
  throw new CaptureUploadPolicyError(
    `MEND_CAPTURE_MANIFEST_FORMAT must be ${FORMAT_DIR_OBJECTS} or ${FORMAT_DIR_PACKS}, got "${raw}".`,
  );
};

const positiveBytes = (name: string, raw: string | undefined, fallback: number): number => {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return fallback;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) {
    throw new CaptureUploadPolicyError(
      `${name} must be a positive integer of bytes, got "${raw}".`,
    );
  }
  return value;
};

/**
 * `MEND_CAPTURE_MULTIPART_THRESHOLD` (bytes, default 16 MiB),
 * `MEND_CAPTURE_MULTIPART_PART_SIZE` (bytes, default 16 MiB, at least 5 MiB for S3 and R2),
 * `MEND_CAPTURE_BYTE_QUOTA_FLOOR` (bytes, default 8 GiB), `MEND_CAPTURE_REQUIRE_SIZES`
 * (`true` refuses unsized upload keys) and `MEND_CAPTURE_MANIFEST_FORMAT` (`2` default, `1` to
 * stop executors writing dir packs).
 */
export const resolveCaptureUploadPolicy = (
  env: CaptureUploadPolicyEnvLike,
): typeof CaptureUploadPolicy.Service => {
  const partSizeBytes = positiveBytes(
    "MEND_CAPTURE_MULTIPART_PART_SIZE",
    env.MEND_CAPTURE_MULTIPART_PART_SIZE,
    MULTIPART_PART_SIZE_BYTES,
  );
  if (partSizeBytes < S3_MIN_PART_BYTES) {
    throw new CaptureUploadPolicyError(
      `MEND_CAPTURE_MULTIPART_PART_SIZE must be at least ${S3_MIN_PART_BYTES} (S3's minimum part).`,
    );
  }
  return {
    multipartThresholdBytes: positiveBytes(
      "MEND_CAPTURE_MULTIPART_THRESHOLD",
      env.MEND_CAPTURE_MULTIPART_THRESHOLD,
      MULTIPART_THRESHOLD_BYTES,
    ),
    partSizeBytes,
    callsPerHour: UPLOAD_CALLS_PER_HOUR,
    keysPerCall: UPLOAD_KEYS_PER_CALL,
    byteQuotaFloorBytes: positiveBytes(
      "MEND_CAPTURE_BYTE_QUOTA_FLOOR",
      env.MEND_CAPTURE_BYTE_QUOTA_FLOOR,
      BYTE_QUOTA_FLOOR,
    ),
    requireSizes: ["1", "true", "yes"].includes(
      (env.MEND_CAPTURE_REQUIRE_SIZES ?? "").trim().toLowerCase(),
    ),
    manifestFormat: manifestFormatOf(env.MEND_CAPTURE_MANIFEST_FORMAT),
  };
};

export const CaptureUploadPolicyLive: Layer.Layer<CaptureUploadPolicy> = Layer.effect(
  CaptureUploadPolicy,
  Effect.sync(() => resolveCaptureUploadPolicy(process.env)),
);

/**
 * What a plan tells the session beside its answer (review 2026-09-28 (13) #1, (14) #3): `waiting`
 * — the head's git section could not be verified now, and the executor was told to ask again;
 * `blocked` — git rejected the head's git section, and the executor was refused; `planned` — the
 * head was planned (whatever an earlier `waiting` or `blocked` said no longer holds). `launchId`:
 * the launch whose plan it is — the session hears only its current launch's (review 2026-09-28
 * (14) #1).
 */
export type CapturePlanNotice =
  | { readonly kind: "waiting"; readonly words: string; readonly launchId: string }
  | { readonly kind: "blocked"; readonly words: string; readonly launchId: string }
  | { readonly kind: "planned"; readonly launchId: string };

/** Every `waiting` notice's words begin with this — a launch's words, cleared once it starts. */
export const PLAN_WAITING_PREFIX = "launch waiting · ";

/** Every `blocked` notice's words begin with this — cleared once a plan goes ahead. */
export const PLAN_BLOCKED_PREFIX = "launch blocked · ";

/** The session's words while a plan waits for Mend to verify capture `n`'s git section. */
export const planWaitingWords = (n: number): string =>
  `${PLAN_WAITING_PREFIX}capture ${n}'s git section could not be verified on the Mend host · asked again`;

/** The session's words once a plan was refused because git rejected capture `n`'s git section. */
export const planBlockedWords = (n: number): string =>
  `${PLAN_BLOCKED_PREFIX}capture ${n}'s git section failed verification · discard or contact the operator`;

/**
 * How many checks in a row may end with the same unexplained git words before the row is
 * recorded `failed` (review 2026-09-28 (14) #4).
 */
export const UNEXPLAINED_CHECKS_BOUND = 5;

/** What `planManifest` decided. */
type PlanOf =
  | { readonly kind: "head"; readonly manifest: CaptureManifest }
  | { readonly kind: "wait"; readonly unverified: CaptureRow }
  | { readonly kind: "blocked"; readonly failed: CaptureRow; readonly detail: string | null };

export interface CaptureScope {
  readonly worktreeId: WorktreeId;
  readonly projectId: ProjectId;
  /**
   * The executor is being drained, kept or recovered (the session has a drain under way): its
   * `upload.urls` calls are not metered, and neither `upload.urls` nor `capture.register`
   * refuses its bytes for the byte quota — it is saving what only it holds (cross-repo decision
   * 30).
   */
  readonly unmetered?: boolean;
  /** Who a claim is recorded for — the session whose executor this is. */
  readonly executorId: string;
  /**
   * Which physical executor of that session is asking: its launch identity, the create's
   * idempotency key its channel token was issued for (cross-repo decision 5). `plan.get` names
   * it as the executor; a `final_seal` is recorded only when it names it. Absent: the session id,
   * what an executor launched before launch identities was planned as.
   */
  readonly launchId?: string;
  /** The project's compressed footprint in bytes (its base git packs); 0 = unknown, floor applies. */
  readonly footprintBytes: number;
  /**
   * Told what a plan did instead of restoring the head, or that it could not plan yet (review
   * 2026-09-28 (13) #1): the engine says it in the session's summary. Absent: logged only.
   */
  readonly planNotice?: (notice: CapturePlanNotice) => Effect.Effect<void>;
}

/** What a standby's `plan.get` is answered with: the base plan Mend prepared for it. */
export interface StandbyPlan {
  readonly captureId: string;
  readonly manifestKey: string;
  readonly manifest: CaptureManifest;
}

/**
 * The routes for a standby executor — no worktree, no lease, no chain (`hot-pool.ts`
 * "Capture-mode standby"). `plan.get` answers the base plan under the placeholder name and the
 * synthetic epoch (the daemon booted without a worktree id and takes both from the answer);
 * heartbeats are acknowledged so the daemon never pauses; anything that would write is refused
 * as `lease-lost` until a claim gives this executor a worktree and its replan asks again.
 */
export interface StandbyScope {
  readonly alias: string;
  readonly projectId: ProjectId;
  readonly executorId: string;
  /** The standby executor's launch identity (`CaptureScope.launchId`). */
  readonly launchId?: string;
  readonly epoch: number;
  /** The plan for the platform the executor names, when it names one. */
  readonly plan: (platform: string | undefined) => Effect.Effect<StandbyPlan, unknown>;
}

// ─── Register events (the checkpoint wait) ──────────────────────────────────

type RegisterListener = (row: CaptureRow) => void;

/**
 * One in-process hub both listeners share: a register on any worktree wakes whoever is waiting
 * for it. `awaitRegister` is how `SessionRepositoryCapturedLive.checkpoint` learns that the
 * executor's `checkpoint` capture landed — until the runtime client grows a `capture.now`
 * control command, waiting is the only ask Mend can make.
 */
export class CaptureChannel extends Context.Service<
  CaptureChannel,
  {
    readonly apiFor: (scope: CaptureScope) => SessionCaptureApi;
    readonly standbyApiFor: (scope: StandbyScope) => SessionCaptureApi;
    readonly awaitRegister: (
      worktreeId: WorktreeId,
      accept: (row: CaptureRow) => boolean,
      timeout: Duration.Duration,
    ) => Effect.Effect<CaptureRow | null>;
    /** Tests and the reaper: wake listeners for a register that happened elsewhere. */
    readonly publish: (row: CaptureRow) => void;
  }
>()("@mend/sessions/CaptureChannel") {}

const bad = (message: string) =>
  new CaptureRouteError({ status: 400, reason: "bad-request", message });

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Every pack and dir pack a bulk section names. */
const bulkKeysOf = (section: BulkSectionReady): ReadonlyArray<string> => [
  ...section.packs,
  ...dirPacksOf(section),
];

/** Bytes priced in a ledger (key → bytes). */
const sumOf = (ledger: ReadonlyMap<string, number>): number => {
  let total = 0;
  for (const bytes of ledger.values()) total += bytes;
  return total;
};

/**
 * The head as this executor may restore it: as `bulk`, the bulk section captured on its own
 * platform — the head's `bulk`, else the one `other_bulk` carries for it — else `"pending"`.
 * `other_bulk` is answered as stored: sealantd reads the head's stored manifest for what it
 * carries on, and takes only the bulk section from this answer (`boot/capture.rs`
 * `continue_bulk`), which it restores only when it is one of the head's own, stamped for its
 * platform.
 */
export const planForPlatform = (
  manifest: CaptureManifest,
  platform: string | undefined,
): CaptureManifest => {
  if (platform === undefined) return manifest;
  const bulk = bulkSectionFor(manifest.sections, platform);
  return bulk === manifest.sections.bulk
    ? manifest
    : { ...manifest, sections: { ...manifest.sections, bulk } };
};

/**
 * A bucket or pointer-store failure inside a route is a defect: 500, which the executor
 * retries. The key rides in the message, so the API log names what was asked of the bucket.
 */
const storeError =
  (operation: string, key?: string) =>
  (cause: { readonly _tag: string }): Effect.Effect<never> =>
    Effect.die(
      `capture channel: ${operation} failed${key === undefined ? "" : ` for ${key}`}: ${cause._tag}`,
    );

/** The kinds Mend verifies at register; `auto` captures are verified lazily, at the plan that would restore them. */
const VERIFIED_AT_REGISTER = new Set<CaptureManifest["kind"]>([
  "checkpoint",
  "turn",
  "suspend",
  "final",
]);

/** How many keys of one launch `upload.urls` remembers as handed out (re-mints of them are free). */
const MINTED_KEYS_REMEMBERED = 200_000;

/** How many times a register reads the guards again after retention moved one under it. */
const GUARD_ATTEMPTS = 3;

/** Retention condemned something a register names between its read and its CAS: read again. */
class GuardMovedError extends Schema.TaggedErrorClass<GuardMovedError>()("GuardMovedError", {}) {}

const WorktreeIdOf = (id: string): WorktreeId => WorktreeId.make(id);

const sameKeys = (x: ReadonlyArray<string>, y: ReadonlyArray<string>): boolean =>
  x.length === y.length && x.every((key, at) => key === y[at]);

/** Two chunked sections name the same tree from the same objects. */
const sameTree = (a: ChunkedSection, b: ChunkedSection): boolean =>
  a.root === b.root &&
  sectionFormatOf(a) === sectionFormatOf(b) &&
  sameKeys(a.packs, b.packs) &&
  sameKeys(dirPacksOf(a), dirPacksOf(b));

export const CaptureChannelLive: Layer.Layer<
  CaptureChannel,
  never,
  | CaptureStoreRepo
  | BlobStore
  | CaptureUploadPolicy
  | CaptureGitVerifier
  | CaptureSources
  | CaptureRemotes
> = Layer.effect(
  CaptureChannel,
  Effect.gen(function* () {
    const repo = yield* CaptureStoreRepo;
    const blobs = yield* BlobStore;
    const policy = yield* CaptureUploadPolicy;
    const verifier = yield* CaptureGitVerifier;
    const sources = yield* CaptureSources;
    const remotes = yield* CaptureRemotes;
    /**
     * A GET URL per source archive, minted like the head's objects. A source whose URL cannot be
     * minted is dropped rather than named without one: sealantd would only skip it anyway.
     */
    const sourceUrls = (beside: ReadonlyArray<PlanSource>) =>
      Effect.gen(function* () {
        const urls: Record<string, string> = {};
        for (const source of beside) {
          urls[source.key] = yield* blobs.presign(source.key, "GET", PRESIGN_TTL_SECONDS);
        }
        return urls;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("capture sources: presigning a source GET failed")
            .pipe(Effect.annotateLogs({ cause: String(cause) }))
            .pipe(Effect.as<Record<string, string>>({})),
        ),
      );
    const listeners = new Map<string, Set<RegisterListener>>();
    const publish = (row: CaptureRow): void => {
      const set = listeners.get(row.worktreeId);
      if (set === undefined) return;
      // Snapshot first: a woken listener removes itself from the set while we iterate.
      const woken = Array.from(set);
      for (const listener of woken) listener(row);
    };
    const awaitRegister = (
      worktreeId: WorktreeId,
      accept: (row: CaptureRow) => boolean,
      timeout: Duration.Duration,
    ) =>
      Effect.callback<CaptureRow>((resume) => {
        const set = listeners.get(worktreeId) ?? new Set<RegisterListener>();
        listeners.set(worktreeId, set);
        const listener: RegisterListener = (row) => {
          if (!accept(row)) return;
          set.delete(listener);
          resume(Effect.succeed(row));
        };
        set.add(listener);
        return Effect.sync(() => {
          set.delete(listener);
          if (set.size === 0) listeners.delete(worktreeId);
        });
      }).pipe(
        Effect.timeoutOption(timeout),
        Effect.map((found) => Option.getOrNull(found)),
      );

    /**
     * Per-executor (per launch) rolling counters of `upload.urls` calls that asked for a key the
     * executor had not been handed before; a Mend restart forgets them, which only ever relaxes.
     * Keyed by launch, never by session: one executor's failed uploads never refuse the next
     * executor of the session (e2e run 5).
     */
    const urlLog = new Map<string, Array<number>>();
    /**
     * Per capture row: the words of the latest check that ended with git exiting on its own in
     * words nothing here explains (`GitVerification.unexplained`), and how many checks in a row
     * ended so (review 2026-09-28 (14) #4). Any other outcome forgets the row. A Mend restart
     * forgets them all, which only ever asks again.
     */
    const unexplainedChecks = new Map<
      string,
      { readonly detail: string; readonly count: number }
    >();
    /**
     * The keys each launch was handed URLs for (bounded): a call that asks only for those again
     * — an upload retried after its URLs lapsed or its PUT failed — costs no call.
     */
    const minted = new Map<string, Set<string>>();
    /**
     * Whether each launch's latest `plan.get` listed `present` in `upload_answers` (cross-repo
     * decision 20): only such a launch is answered `present`; any other — an older daemon, or a
     * launch this process never saw plan (a Mend restart) — gets the legacy answer, a write-once
     * URL for a stored key whose bytes were verified. Bound to the launch its token names.
     */
    const readsPresent = new Map<string, boolean>();
    /** Whether each launch's latest `plan.get` listed `sha256` (`UPLOAD_ANSWER_SHA256`). */
    const sendsSha256 = new Map<string, boolean>();
    const noteUploadAnswers = (launch: string, input: PlanGetRequest) => {
      if (readsPresent.size > MINTED_KEYS_REMEMBERED) readsPresent.clear();
      if (sendsSha256.size > MINTED_KEYS_REMEMBERED) sendsSha256.clear();
      readsPresent.set(launch, (input.upload_answers ?? []).includes(UPLOAD_ANSWER_PRESENT));
      sendsSha256.set(launch, (input.upload_answers ?? []).includes(UPLOAD_ANSWER_SHA256));
    };
    /**
     * The SHA-256 every bound URL of a key whose name does not say it (a pack index) was minted
     * for, and until when one of them could be used: every URL of the key while one lives must
     * name the same digest, so all of them write the same bytes. Reserved in the same
     * synchronous step that checks it (two calls cannot both pass the check); an entry goes only
     * once every URL it covers is dead, and a full map binds no more pack indexes (they record
     * authority, as an unbound URL does). Mend serves the channel from one process (the engine
     * holds live state; Helm pins one replica), so this map sees every URL handed out — except
     * those of a process before this one: until they are all dead (`BOUND_INDEX_TRUSTED_AFTER_MS`
     * after this process started) no pack index is bound.
     */
    const boundDigests = new Map<string, { readonly sha256: string; readonly until: number }>();
    const channelStartedAt = Date.now();
    /**
     * The byte ledger, per physical launch: object key → bytes priced for it, once. `upload.urls`
     * reserves a sized key at its declared size; `capture.register` prices every pack under the
     * caller's epoch at the size the bucket reports, replacing a reservation. A key never
     * counts twice, whatever the manifests that list it. A new launch — a new executor, under a
     * fresh epoch — starts a ledger of its own (review 2026-09-28 (10) #6): the budget bounds
     * the new work one executor admits, never what a session wrote across every executor it ever
     * had. Reservations that mint nothing are refunded. The ledgers of the launches least
     * recently asked about are dropped past `LEDGERS_KEPT`.
     */
    const ledgers = new Map<string, Map<string, number>>();
    const ledgerOf = (launch: string): Map<string, number> => {
      const found = ledgers.get(launch);
      if (found !== undefined) {
        ledgers.delete(launch);
        ledgers.set(launch, found);
        return found;
      }
      const fresh = new Map<string, number>();
      ledgers.set(launch, fresh);
      for (const oldest of ledgers.keys()) {
        if (ledgers.size <= LEDGERS_KEPT) break;
        ledgers.delete(oldest);
      }
      return fresh;
    };

    /**
     * Registers in flight, by worktree, launch, epoch, n and capture (e2e8 F2): sealantd's retry
     * of a register it timed out joins the one still running — same request, same answer —
     * instead of verifying the capture again beside it; a register whose caller gave up runs on
     * for the retry to join.
     */
    const registersInFlight = makeSingleFlight<
      RegisterAnswer,
      CaptureRouteError,
      RegisterRequest
    >();
    /**
     * Seal checks by the same key (`SealJob`): one verification per sealing capture at a time,
     * run detached from the register that started it, and kept once ended for the executor's
     * re-asks — a verdict about the capture only: one that concluded nothing (`unavailable`) is
     * dropped, and the next ask checks again (review 2026-09-28 (12) #4). The oldest dropped past
     * `SEAL_VERDICTS_KEPT`; a re-ask that finds none checks again.
     */
    const sealJobs = new Map<string, SealJob>();
    /** Forget `job`, unless another job already took its key. */
    const dropSealJob = (job: SealJob) =>
      Effect.sync(() => {
        if (sealJobs.get(job.key) === job) sealJobs.delete(job.key);
      });
    /**
     * The seal checks for `key`: the ones running (or, unless `fresh`, ended) — else `checks`,
     * started now. A register's own verification is always fresh: a verdict an earlier pass reached
     * is not a proof about the bytes now (`proofStands`). Checks that die, or are interrupted,
     * conclude nothing (`unavailable`): the job is dropped and its verdict settled all the same.
     */
    const sealJobFor = (key: string, checks: Effect.Effect<SealVerdict>, fresh: boolean) =>
      Effect.gen(function* () {
        const known = sealJobs.get(key);
        if (known !== undefined && (!fresh || !(yield* Deferred.isDone(known.verdict)))) {
          return known;
        }
        const job: SealJob = {
          key,
          verdict: yield* Deferred.make<SealVerdict>(),
          settled: yield* Deferred.make<SealVerdict>(),
          recording: false,
        };
        sealJobs.delete(key);
        sealJobs.set(key, job);
        for (const oldest of sealJobs.keys()) {
          if (sealJobs.size <= SEAL_VERDICTS_KEPT) break;
          sealJobs.delete(oldest);
        }
        // One seal verification at a time in this process (`sealVerifications`): a job waiting
        // for the permit is `verifying` to every ask, as a running one is. One that holds it past
        // `SEAL_VERIFICATION_LIMIT` concludes nothing and is dropped, asked again later.
        yield* Effect.forkDetach(
          checks.pipe(
            Effect.timeoutOrElse({
              duration: SEAL_VERIFICATION_LIMIT,
              orElse: () =>
                Effect.succeed<SealVerdict>({
                  problems: [],
                  unavailable: [
                    `the seal checks did not finish within ${SEAL_VERIFICATION_LIMIT_WORDS}`,
                  ],
                }),
            }),
            sealVerifications.withPermit,
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                const verdict: SealVerdict = Exit.isSuccess(exit)
                  ? exit.value
                  : {
                      problems: [],
                      unavailable: [
                        `the seal checks ended without a verdict: ${Cause.pretty(exit.cause)}`,
                      ],
                    };
                if (verdictUnavailable(verdict)) yield* dropSealJob(job);
                yield* Deferred.succeed(job.verdict, verdict);
              }),
            ),
          ),
        );
        return job;
      });
    /**
     * Once `job`'s checks end, record the seal they allowed (`CaptureStoreRepo.recordSeal`: the
     * capture still the chain's head, the lease still this launch's) and settle the job. Started
     * once per job; the register that answered `withheld` (`verifying`) no longer waits. The job
     * is settled on every exit of the recorder (review 2026-09-28 (12) #4): checks that concluded
     * nothing, or a record that failed or died (the database away), settle it `unavailable` and
     * drop it — never a job left `recording` with no recorder, which every later ask would wait
     * on — so the next ask checks and records again.
     */
    const recordWhenChecked = (
      job: SealJob,
      record: Parameters<typeof repo.recordSeal>[0],
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (job.recording) return Effect.void;
        job.recording = true;
        const annotations = {
          worktreeId: record.worktreeId,
          epoch: record.epoch,
          n: record.n,
          captureId: record.captureId,
        };
        const recorder = Effect.gen(function* () {
          const verdict = yield* Deferred.await(job.verdict);
          if (verdictUnavailable(verdict)) {
            yield* Effect.logWarning(
              "capture channel: a final seal whose checks could not finish · not recorded, checked again on the next ask",
            ).pipe(
              Effect.annotateLogs({
                ...annotations,
                unavailable: (verdict.unavailable ?? []).join("; "),
              }),
            );
          } else if (verdict.problems.length > 0) {
            yield* Effect.logWarning(
              "capture channel: a final seal over sections not verified restorable · not recorded",
            ).pipe(Effect.annotateLogs({ ...annotations, problems: verdict.problems.join("; ") }));
          } else {
            const recorded = yield* repo.recordSeal(record);
            yield* Effect.logInfo(
              recorded
                ? "capture channel: final seal · verified after the register answered · recorded"
                : "capture channel: final seal · verified after the register answered · not recorded (the chain or the lease moved)",
            ).pipe(Effect.annotateLogs(annotations));
          }
          return verdict;
        });
        return Effect.forkDetach(
          recorder.pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                const verdict: SealVerdict = Exit.isSuccess(exit)
                  ? exit.value
                  : {
                      problems: [],
                      unavailable: [`the seal was not recorded: ${Cause.pretty(exit.cause)}`],
                    };
                if (Exit.isFailure(exit)) {
                  yield* Effect.logWarning(
                    "capture channel: a final seal verified but not recorded · checked again on the next ask",
                  ).pipe(Effect.annotateLogs({ ...annotations, cause: Cause.pretty(exit.cause) }));
                }
                if (verdictUnavailable(verdict)) yield* dropSealJob(job);
                job.recording = false;
                yield* Deferred.succeed(job.settled, verdict);
              }),
            ),
          ),
        ).pipe(Effect.asVoid);
      });

    const standbyApiFor = (scope: StandbyScope): SessionCaptureApi => {
      const notClaimed = <A>(): Effect.Effect<A, CaptureRouteError> =>
        Effect.fail(
          new CaptureRouteError({
            status: 409,
            reason: "lease-lost",
            message:
              "a standby executor holds no worktree yet — nothing to ship until it is claimed",
          }),
        );
      const planGet = Effect.fn("StandbyCaptureApi.planGet")(function* (input: PlanGetRequest) {
        if (
          input.worktree_id !== undefined &&
          input.worktree_id !== null &&
          input.worktree_id !== scope.alias
        ) {
          return yield* new CaptureRouteError({
            status: 409,
            reason: "wrong-worktree",
            message: "this standby token is scoped to its placeholder worktree",
          });
        }
        yield* refuseOtherLaunch(input, scope.launchId ?? scope.executorId);
        noteUploadAnswers(scope.launchId ?? scope.executorId, input);
        const plan = yield* scope
          .plan(input.platform)
          .pipe(Effect.catch(() => storeError("preparing the standby plan")({ _tag: "plan" })));
        const reads = readerFormatOf(input);
        const holds = planFormatOf(plan.manifest);
        if (holds > reads) return yield* formatRefusal(reads, holds);
        const missing = yield* missingManifestFeatures(plan.manifest, plan.manifest, input).pipe(
          Effect.provideService(BlobStore, blobs),
          Effect.catch(storeError("reading the standby plan's features", plan.manifestKey)),
        );
        if (missing.length > 0) return yield* featuresRefusal(missing);
        const keys = yield* keysNeededBy(plan.manifest).pipe(
          Effect.provideService(BlobStore, blobs),
          Effect.catch(storeError("walking the standby plan", plan.manifestKey)),
        );
        const urls: Record<string, string> = {};
        for (const key of [...keys, plan.manifestKey]) {
          urls[key] = yield* blobs
            .presign(key, "GET", PRESIGN_TTL_SECONDS)
            .pipe(Effect.catch(storeError("presigning a GET", key)));
        }
        return {
          worktree_id: scope.alias,
          epoch: scope.epoch,
          head: {
            n: 0,
            capture_id: plan.captureId,
            manifest_key: plan.manifestKey,
            manifest: plan.manifest,
          },
          get_urls: urls,
          manifest_format: answeredFormat(policy.manifestFormat, reads),
          manifest_features: MANIFEST_FEATURES,
          executor: scope.launchId ?? scope.executorId,
        } satisfies PlanGetResponse;
      });
      return {
        planGet,
        uploadUrls: () => notClaimed(),
        uploadComplete: () => notClaimed(),
        register: () => notClaimed(),
        changeSummary: () => notClaimed(),
        heartbeat: () => Effect.succeed({ expires_in_secs: LEASE_EXPIRES_IN_SECS }),
      };
    };

    const apiFor = (scope: CaptureScope): SessionCaptureApi => {
      const worktreeId = scope.worktreeId;
      /** The physical executor asking (cross-repo decision 5). */
      const launchId = scope.launchId ?? scope.executorId;
      /** The one prefix this executor may write under: its worktree's, at the caller's epoch. */
      const underOwnPrefix = (key: string, epoch: number) =>
        key.startsWith(`captures/${worktreeId}/${epoch}/`);
      const underOwnWorktree = (key: string) => key.startsWith(`captures/${worktreeId}/`);
      const byteBudget = Math.max(
        policy.byteQuotaFloorBytes,
        BYTE_QUOTA_MULTIPLIER * Math.max(0, scope.footprintBytes),
      );
      const ledger = ledgerOf(launchId);
      /**
       * Preserving what an executor already holds is never refused for budget (cross-repo
       * decision 30, review 2026-09-28 (10) #6): while its session drains, keeps or recovers it
       * (`CaptureScope.unmetered`) — the FINAL, and a recovery boot's shipping — the byte quota
       * prices what it saves and refuses none of it. So does the register of a `final` capture:
       * the bytes are in the bucket, and the capture is what saves them.
       */
      const preserving = scope.unmetered === true;
      const overByteQuota = (status: 409 | 413, used: number, requested: number) =>
        new CaptureRouteError({
          status,
          reason: "byte-quota",
          message: `byte quota: ${byteBudget} bytes per executor launch (${used} priced, ${requested} more asked)`,
          limit: byteBudget,
          used,
          requested,
        });
      /** This executor as the store binds a lease holder: its session and its launch. */
      const holder = { executorId: scope.executorId, launchId };
      /**
       * The lease names another holder, or another launch of this one (cross-repo decision 11,
       * review 2026-09-28 (4) #11): nothing this executor holds is the lease's, and it is told
       * nothing of that lease's epoch. A lease bound to no launch (taken before leases were
       * bound, or by Mend itself) is its holder's, whichever launch asks.
       */
      const heldByAnother = (lease: WorktreeLease) =>
        lease.executorId !== scope.executorId ||
        ((lease.launchId ?? null) !== null && lease.launchId !== launchId);
      const leaseLost = () =>
        new CaptureRouteError({
          status: 409,
          reason: "lease-lost",
          message: "the worktree lease is not this executor's — stop shipping and pause",
        });
      /**
       * The lease predicate: live, held by this executor's own launch and under the caller's
       * epoch, else the 409 the caller needs.
       */
      const requireLease = (epoch: number) =>
        Effect.gen(function* () {
          const lease = yield* repo.leaseOf(worktreeId);
          if (lease !== null && lease.live && heldByAnother(lease)) return yield* leaseLost();
          if (lease === null || !lease.live) {
            return yield* new CaptureRouteError({
              status: 409,
              reason: "lease-lost",
              message: "the worktree lease is not live — stop shipping and pause",
              ...(lease === null ||
              lease.epoch === epoch ||
              (lease.executorId !== null && heldByAnother(lease))
                ? {}
                : { live_epoch: lease.epoch }),
            });
          }
          if (lease.epoch !== epoch) {
            return yield* new CaptureRouteError({
              status: 409,
              reason: "stale-epoch",
              message: `epoch ${epoch} is stale; the worktree is held under epoch ${lease.epoch}`,
              live_epoch: lease.epoch,
            });
          }
          return lease;
        });

      const requireWorktree = (claimed: string | null | undefined) =>
        claimed === undefined || claimed === null || claimed === worktreeId
          ? Effect.void
          : Effect.fail(
              new CaptureRouteError({
                status: 409,
                reason: "wrong-worktree",
                message: "this session token is scoped to another worktree",
              }),
            );

      const readManifest = (row: CaptureRow) =>
        blobs.get(row.manifestKey).pipe(
          Effect.catch(storeError("reading a manifest", row.manifestKey)),
          Effect.flatMap((bytes) =>
            decodeManifest(row.manifestKey, bytes).pipe(
              Effect.catch(storeError("decoding a manifest", row.manifestKey)),
            ),
          ),
        );

      /**
       * Git exiting on its own in words nothing here explains is not the content's on one ask; the
       * same words from the same row `UNEXPLAINED_CHECKS_BOUND` asks in a row are (review
       * 2026-09-28 (14) #4): `failed`, which a later check still re-reads. A signal, Node's own
       * failure, a host word or the bucket not answering never counts: those stay `unverified`.
       */
      const boundUnexplained = (
        row: CaptureRow,
        verification: GitVerification,
      ): GitVerification => {
        if (verification.unexplained !== true || verification.detail === null) {
          unexplainedChecks.delete(row.id);
          return verification;
        }
        const before = unexplainedChecks.get(row.id);
        const count = before?.detail === verification.detail ? before.count + 1 : 1;
        unexplainedChecks.set(row.id, { detail: verification.detail, count });
        if (count < UNEXPLAINED_CHECKS_BOUND) return verification;
        return {
          outcome: "failed",
          detail: `${verification.detail} (the same words on ${count} checks in a row)`,
        };
      };

      /**
       * Verify a row's git section now and record the outcome. `unverified` (the Mend host could
       * not finish the check) records nothing and answers `unverified` — never the row's older
       * word, which a check that concluded nothing does not confirm.
       */
      const checkRow = (row: CaptureRow, manifest: CaptureManifest) =>
        Effect.gen(function* () {
          const verification = boundUnexplained(
            row,
            yield* verifier.verify(scope.projectId, manifest),
          );
          if (verification.outcome === "unverified") {
            yield* Effect.logWarning(
              verification.transient === true
                ? "capture channel: git section not verified · the Mend host could not finish the check"
                : "capture channel: git section not verified · nothing here verifies it",
            ).pipe(
              Effect.annotateLogs({
                worktreeId,
                n: row.n,
                captureId: row.id,
                recorded: row.gitFsck,
                detail: verification.detail,
              }),
            );
            return verification;
          }
          if (verification.outcome !== row.gitFsck) {
            yield* repo.setGitFsck(row.id, verification.outcome);
          }
          if (verification.outcome === "failed") {
            yield* Effect.logWarning(
              "capture channel: git section failed verification · observed",
            ).pipe(
              Effect.annotateLogs({
                worktreeId,
                n: row.n,
                captureId: row.id,
                kind: row.kind,
                epoch: row.epoch,
                detail: verification.detail,
              }),
            );
          }
          return verification;
        });

      /** `checkRow`'s outcome alone. */
      const verifyRow = (row: CaptureRow, manifest: CaptureManifest) =>
        checkRow(row, manifest).pipe(Effect.map((verification) => verification.outcome));

      /** Tell the session what this plan did instead of restoring the head (`CaptureScope`). */
      const notePlan = (notice: CapturePlanNotice) =>
        scope.planNotice === undefined ? Effect.void : scope.planNotice(notice);

      /**
       * The manifest a plan restores (review 2026-09-28 (13) #1, (14) #3). A head whose git
       * section is not recorded `verified` — an `auto` capture, one registered while the Mend host
       * could not finish a check, or one recorded `failed`, checked once more — is verified now,
       * at the moment it matters. Then:
       * - verified: the head;
       * - still unverifiable (the Mend host could not finish the check): no plan. The executor is
       *   answered `worktree-leased`, the one `plan.get` answer sealantd waits on and asks again
       *   after, touching nothing, and the session says why (`PLAN_WAITING_PREFIX`);
       * - never verifiable here (a format Mend does not read): the head as registered;
       * - failed (git rejected its pack or its closure): no plan. The executor is refused, and the
       *   session says so (`PLAN_BLOCKED_PREFIX`). Never another capture under the head's
       *   identity: sealantd restores the head's own manifest from its key, so an older capture's
       *   sections planned in its place are not what it lays down — its boot fails part way and
       *   the session would name a restore that never happened.
       */
      const planManifest = (head: CaptureRow, stored: CaptureManifest) =>
        Effect.gen(function* () {
          if (head.gitFsck === "verified")
            return { kind: "head", manifest: stored } satisfies PlanOf;
          const headCheck = yield* checkRow(head, stored);
          if (headCheck.outcome === "verified") {
            return { kind: "head", manifest: stored } satisfies PlanOf;
          }
          if (headCheck.outcome === "unverified") {
            // Nothing here can verify it, whenever asked (a format Mend does not read, no
            // verifier): the head as registered, as before any check existed.
            return headCheck.transient === true
              ? ({ kind: "wait", unverified: head } satisfies PlanOf)
              : ({ kind: "head", manifest: stored } satisfies PlanOf);
          }
          return { kind: "blocked", failed: head, detail: headCheck.detail } satisfies PlanOf;
        });

      /**
       * The plan hands a seal on only while it stands (cross-repo decision 22, review 2026-09-28
       * (8) #5): the head's `final_seal` is answered when the store holds that very seal for the
       * head and `sealStandingOf` says it stands. Withheld, void or never recorded, the plan carries
       * the head without it — the bytes restore the same; nothing reads complete on them.
       */
      const planSealStanding = (head: CaptureRow, manifest: CaptureManifest) =>
        Effect.gen(function* () {
          const planned = manifest.final_seal;
          if (planned === undefined) return manifest;
          const { final_seal: _unstanding, ...unsealed } = manifest;
          const recorded = planned.complete
            ? yield* repo.sealedCompletion(worktreeId, planned.executor, planned.epoch)
            : null;
          const standing =
            recorded === null || recorded.captureId !== head.id
              ? null
              : yield* sealStandingOf(recorded, Date.now).pipe(
                  Effect.provideService(CaptureStoreRepo, repo),
                  Effect.provideService(BlobStore, blobs),
                );
          if (standing?.state === "standing") return manifest;
          yield* Effect.logInfo(
            "capture channel: plan carries the head without its final seal · not standing",
          ).pipe(
            Effect.annotateLogs({
              worktreeId,
              headN: head.n,
              headCaptureId: head.id,
              seal: standing === null ? "not recorded for this capture" : standing.state,
            }),
          );
          return unsealed satisfies CaptureManifest;
        });

      const planGet = Effect.fn("SessionCaptureApi.planGet")(function* (input: PlanGetRequest) {
        yield* requireWorktree(input.worktree_id);
        yield* refuseOtherLaunch(input, launchId);
        noteUploadAnswers(launchId, input);
        const asked = input.epoch ?? 0;
        const reads = readerFormatOf(input);
        const lease = yield* repo.leaseOf(worktreeId);
        let held: number | null = null;
        if (lease !== null && lease.live && heldByAnother(lease)) {
          // Another executor holds it: a second executor for a leased worktree is refused
          // (ADR-0002 "Decisions made here" 9); joins run inside the holder. Another launch of
          // this very session is another executor (cross-repo decision 11): an older launch's
          // token never learns or joins a newer launch's epoch, by asking zero or the epoch.
          return yield* new CaptureRouteError({
            status: 409,
            reason: "worktree-leased",
            message: "another executor holds this worktree's lease",
          });
        }
        if (lease !== null && lease.live && (asked === 0 || asked === lease.epoch)) {
          held = lease.epoch;
        } else if (lease !== null && lease.live) {
          return yield* new CaptureRouteError({
            status: 409,
            reason: "stale-epoch",
            message: `epoch ${asked} is stale; the worktree is held under epoch ${lease.epoch}`,
            live_epoch: lease.epoch,
          });
        }
        // The plan's head, decided before the claim: an executor that does not read a section
        // the plan holds is refused before it holds the lease, fences anyone, or is handed a
        // manifest it would misread. Nothing can register between this read and the claim — a
        // register needs the live lease the claim below is the only way to take.
        const chain = yield* repo.headOf(worktreeId);
        const head = chain?.head ?? null;
        const stored = head === null ? null : yield* readManifest(head);
        // Only a plan that lays the head down checks it (review 2026-09-28 (14) #2). The launch
        // that holds or last held the lease, asking about a head registered under that lease's
        // epoch — its own work — restores nothing from the plan: sealantd resumes its own disk (a
        // daemon restart, a recovery boot shipping what the disk holds, a re-plan). It gets the
        // head as it stands, verified or not, and never waits on a check it has no use for.
        const ownHead =
          head !== null && lease !== null && !heldByAnother(lease) && head.epoch === lease.epoch;
        const planned =
          head === null || stored === null
            ? null
            : ownHead
              ? ({ kind: "head", manifest: stored } satisfies PlanOf)
              : yield* planManifest(head, stored);
        if (planned !== null && planned.kind === "wait") {
          // Nothing is claimed and nothing is handed out: the executor waits and asks again, and
          // the session says why (review 2026-09-28 (13) #1).
          const words = planWaitingWords(planned.unverified.n);
          yield* notePlan({ kind: "waiting", words, launchId });
          return yield* new CaptureRouteError({
            status: 409,
            reason: "worktree-leased",
            message: `${words}: the plan waits until Mend can verify it, rather than restore an older capture — ask again`,
          });
        }
        if (planned !== null && planned.kind === "blocked") {
          // Git rejected the head's content: nothing is claimed and nothing is handed out, and
          // no other capture is planned in its place (review 2026-09-28 (14) #3). sealantd reads
          // a 422 on `plan.get` as a refusal of the boot, touching nothing.
          const words = planBlockedWords(planned.failed.n);
          yield* notePlan({ kind: "blocked", words, launchId });
          return yield* new CaptureRouteError({
            status: 422,
            reason: "unrestorable",
            message: `${words}: git rejected it${planned.detail === null ? "" : ` (${planned.detail})`} — nothing is planned`,
          });
        }
        const manifest =
          head === null || planned === null
            ? null
            : yield* planSealStanding(head, planForPlatform(planned.manifest, input.platform));
        yield* notePlan({ kind: "planned", launchId });
        if (manifest !== null && stored !== null && head !== null) {
          const holds = planFormatOf(manifest);
          if (holds > reads) {
            yield* Effect.logWarning(
              "capture channel: plan refused · the head holds a section format this executor does not read",
            ).pipe(Effect.annotateLogs({ worktreeId, reads, holds }));
            return yield* formatRefusal(reads, holds);
          }
          const missing = yield* missingManifestFeatures(stored, manifest, input).pipe(
            Effect.provideService(BlobStore, blobs),
            Effect.catch(storeError("reading the head's manifest features", head.manifestKey)),
          );
          if (missing.length > 0) {
            yield* Effect.logWarning(
              "capture channel: plan refused · the head holds manifest features this executor does not read",
            ).pipe(Effect.annotateLogs({ worktreeId, missing: missing.join(",") }));
            return yield* featuresRefusal(missing);
          }
        }
        let epoch: number;
        if (held !== null) {
          epoch = held;
        } else {
          // Not held: this plan is the claim (start, pickup, replacement — one path).
          const claimed = yield* repo.claim(worktreeId, scope.executorId, undefined, launchId).pipe(
            Effect.mapError(
              () =>
                new CaptureRouteError({
                  status: 409,
                  reason: "worktree-leased",
                  message: "another executor claimed this worktree first",
                }),
            ),
          );
          epoch = claimed.epoch;
        }
        // Folders and references travel with the plan, so a captured workspace has them beside
        // the worktree; an empty chain gets them too (the session still reads its folders).
        const beside = yield* sources.forProject(scope.projectId, worktreeId, epoch);
        const origin = yield* remotes.forProject(scope.projectId);
        const manifestFormat = answeredFormat(policy.manifestFormat, reads);
        if (head === null || manifest === null) {
          return {
            worktree_id: worktreeId,
            epoch,
            head: null,
            get_urls: yield* sourceUrls(beside),
            manifest_format: manifestFormat,
            manifest_features: MANIFEST_FEATURES,
            executor: launchId,
            ...(beside.length === 0 ? {} : { sources: beside }),
            ...(origin.length === 0 ? {} : { remotes: origin }),
          };
        }
        const keys = yield* keysNeededBy(manifest).pipe(
          Effect.provideService(BlobStore, blobs),
          Effect.catch(storeError("walking the head capture", head.manifestKey)),
        );
        const urls: Record<string, string> = yield* sourceUrls(beside);
        for (const key of [...keys, head.manifestKey]) {
          urls[key] = yield* blobs
            .presign(key, "GET", PRESIGN_TTL_SECONDS)
            .pipe(Effect.catch(storeError("presigning a GET", key)));
        }
        return {
          worktree_id: worktreeId,
          epoch,
          head: {
            n: head.n,
            capture_id: head.id,
            manifest_key: head.manifestKey,
            manifest,
          },
          get_urls: urls,
          manifest_format: manifestFormat,
          manifest_features: MANIFEST_FEATURES,
          executor: launchId,
          ...(beside.length === 0 ? {} : { sources: beside }),
          ...(origin.length === 0 ? {} : { remotes: origin }),
        } satisfies PlanGetResponse;
      });

      /**
       * Count this call against the executor's rolling hour; false = over quota (nothing minted,
       * not counted). Free: a call that asks only for keys this launch was handed before (a retry
       * of a failed upload), and every call of an executor that is being drained, kept or
       * recovered (`CaptureScope.unmetered`) — refusing it could only lose what it is saving.
       */
      const reserveCall = (keys: ReadonlyArray<string>, finalFlush: boolean): boolean => {
        if (scope.unmetered === true || finalFlush) return true;
        const handed = minted.get(launchId);
        if (keys.length > 0 && handed !== undefined && keys.every((key) => handed.has(key))) {
          return true;
        }
        const now = Date.now();
        const window = (urlLog.get(launchId) ?? []).filter((at) => now - at < 60 * 60 * 1000);
        if (window.length >= policy.callsPerHour) {
          urlLog.set(launchId, window);
          return false;
        }
        window.push(now);
        urlLog.set(launchId, window);
        return true;
      };

      /** Remember the keys this launch was handed URLs for (bounded per launch). */
      const noteMinted = (keys: Iterable<string>) => {
        let handed = minted.get(launchId);
        if (handed === undefined || handed.size > MINTED_KEYS_REMEMBERED) {
          handed = new Set();
          minted.set(launchId, handed);
        }
        for (const key of keys) handed.add(key);
      };

      const uploadUrls = Effect.fn("SessionCaptureApi.uploadUrls")(function* (
        input: UploadUrlsRequest,
      ) {
        yield* requireWorktree(input.worktree_id);
        yield* requireLease(input.epoch);
        // The request quota bounds calls, not keys: a call may carry up to `keysPerCall` keys
        // (the daemon batches 500), and a session gets `callsPerHour` calls. Bytes are bounded
        // below, before any URL is minted, by the sizes the call declares.
        if (input.keys.length > policy.keysPerCall) {
          return yield* bad(
            `${input.keys.length} keys in one call; the cap is ${policy.keysPerCall} per upload.urls call`,
          );
        }
        const finalFlush = isFinalFlush(input);
        if (!reserveCall(input.keys, finalFlush)) {
          return yield* new CaptureRouteError({
            status: 429,
            reason: "quota-exceeded",
            message: `request quota: ${policy.callsPerHour} upload.urls calls per hour per executor`,
          });
        }
        // Only under the caller's own epoch prefix, and only a key that names one capture
        // object; anything else is dropped, never minted — a prefix is not a key. A size is
        // only read for a key that is also listed; no size means a single PUT.
        const sizes = input.sizes ?? {};
        const wanted = new Map<string, number | null>();
        for (const key of input.keys) {
          if (!underOwnPrefix(key, input.epoch) || !isCaptureObjectKey(key)) continue;
          const size = sizes[key];
          wanted.set(key, size === undefined || size < 0 ? null : size);
        }
        // Write-once (cross-repo decision 19): a key the bucket already holds is verified against
        // its name first — an object that is there is accepted only as what the key says. Then,
        // negotiated (cross-repo decision 20, review 2026-09-28 (7) #7): a launch whose
        // `plan.get` listed `present` gets it answered `present`, no URL, never priced again; any
        // other gets the legacy answer an older daemon needs to finish — a write-once URL
        // (`If-None-Match: *`: a bucket that honours it answers 412, which such a daemon reads as
        // uploaded). On a bucket that ignores `If-None-Match` (Garage) that URL could replace the
        // verified bytes until it expires: its expiry is recorded, and no seal stands while it
        // lives (`CaptureSealsStoreLive`, review 2026-09-28 (7) #8).
        const answersPresent = readsPresent.get(launchId) === true;
        // Before any bucket read: an index binding judged live at this moment stays judged so
        // through the HEADs below, never later than it was.
        const callStartedAt = Date.now();
        // Bytes-bound URLs (`UPLOAD_ANSWER_SHA256`): an executor that sends the checksum, on a
        // store that checks it but cannot refuse an overwrite. Such a URL writes the bytes it was
        // minted for or nothing, so it carries no authority to replace an object.
        const bindable =
          answersPresent && sendsSha256.get(launchId) === true && (yield* blobs.bindsBytes);
        const present: Array<string> = [];
        /** Stored keys answered with a legacy URL: verified, and never priced again. */
        const storedLegacy = new Set<string>();
        const verifyStored = (key: string) =>
          Effect.gen(function* () {
            // A key this process already read whole and found what its name says, while that
            // proof stands (`proofStands`), is not read again.
            const problem = yield* storedObjectProblem(key, { reuseProofs: true }).pipe(
              Effect.provideService(BlobStore, blobs),
              Effect.catchTag("BlobNotFoundError", () => Effect.succeed(null)),
              Effect.catch(storeError("reading an object already stored", key)),
            );
            if (problem !== null) {
              return yield* new CaptureRouteError({
                status: 409,
                reason: "unrestorable",
                message: `the bucket already holds ${key}, and ${problem}`,
                key,
              });
            }
          });
        const heads = yield* Effect.forEach(
          [...wanted.keys()],
          (key) =>
            blobs.head(key).pipe(
              Effect.map((found) => [key, found !== null] as const),
              Effect.catch(storeError("asking the bucket for", key)),
            ),
          { concurrency: PRESENT_HEADS_IN_FLIGHT },
        );
        for (const [key, stored] of heads) {
          if (!stored) continue;
          yield* verifyStored(key);
          if (answersPresent) {
            present.push(key);
            wanted.delete(key);
          } else {
            storedLegacy.add(key);
          }
        }
        if (policy.requireSizes) {
          const unsized = [...wanted].find(([, size]) => size === null);
          if (unsized !== undefined) {
            return yield* bad(
              `${unsized[0]} has no declared size; this Mend signs every upload for its exact size`,
            );
          }
        }
        let plans: Array<{
          readonly key: string;
          readonly parts: number;
          readonly size: number | null;
        }> = [];
        for (const [key, size] of wanted) {
          // A stored key's legacy URL is one write-once PUT, whatever its size: there is nothing
          // to assemble, and a bucket that honours the precondition refuses it outright.
          if (size === null || size < policy.multipartThresholdBytes || storedLegacy.has(key)) {
            plans.push({ key, parts: 0, size });
            continue;
          }
          const parts = Math.ceil(size / policy.partSizeBytes);
          if (parts > MULTIPART_MAX_PARTS) {
            return yield* bad(
              `${key}: ${size} bytes is ${parts} parts of ${policy.partSizeBytes}; the cap is ${MULTIPART_MAX_PARTS}`,
            );
          }
          plans.push({ key, parts, size });
        }
        // What each single PUT is bound to: the SHA-256 its name says (a pack, tree or manifest),
        // or, for a pack index, the one the executor declared — the same for every URL of the key.
        const declared = input.sha256 ?? {};
        const boundTo = new Map<string, string>();
        if (bindable) {
          for (const plan of plans) {
            if (plan.parts > 0) continue;
            const named = contentDigestOfKey(plan.key);
            const said = declared[plan.key];
            if (said !== undefined && !/^[0-9a-f]{64}$/.test(said)) {
              return yield* bad(`${plan.key}: sha256 must be 64 lowercase hex characters`);
            }
            if (named !== null) {
              if (said !== undefined && said !== named) {
                return yield* bad(
                  `${plan.key}: its name says sha256 ${named}, the request ${said}`,
                );
              }
              boundTo.set(plan.key, named);
              continue;
            }
            if (said === undefined) continue;
            const now = callStartedAt;
            // URLs a process before this one handed out could still be live: not bound yet.
            const trustedAfter = policy.boundIndexTrustedAfterMs ?? BOUND_INDEX_TRUSTED_AFTER_MS;
            if (now < channelStartedAt + trustedAfter) continue;
            const first = boundDigests.get(plan.key);
            if (first !== undefined && first.until > now && first.sha256 !== said) {
              return yield* new CaptureRouteError({
                status: 409,
                reason: "exists",
                message: `${plan.key} was handed a URL for other bytes (sha256 ${first.sha256}); it is bound to those`,
                key: plan.key,
              });
            }
            if (first === undefined && boundDigests.size >= MINTED_KEYS_REMEMBERED) {
              for (const [key, entry] of boundDigests)
                if (entry.until <= now) boundDigests.delete(key);
              // Still full: this index records authority, as an unbound URL does.
              if (boundDigests.size >= MINTED_KEYS_REMEMBERED) continue;
            }
            // Reserved here, in the step that checked it: no other call passes the check for
            // other bytes while one of these URLs could live.
            boundDigests.set(plan.key, { sha256: said, until: Date.now() + BOUND_URL_LIFETIME_MS });
            boundTo.set(plan.key, said);
          }
        }
        // Every URL of the call bound to its bytes: the call carries no write authority. A part
        // URL is not bound (a part's bytes are not the object's), so a call with one records it,
        // as a call that is not bindable at all (an older daemon, another store) always does.
        const unbound = !bindable || plans.some((plan) => plan.parts > 0 || !boundTo.has(plan.key));
        // The byte quota, enforced here: every sized key not yet priced is charged at its
        // declared size, and a batch that would take the session over is refused whole — no
        // URL minted, no upload opened, so the refused bytes never reach the bucket. A key
        // priced before (an earlier batch, a retry, a register) costs nothing again; a key
        // without a size is priced at register, when the bucket reports what landed.
        const unpriced = new Map<string, number>();
        for (const [key, size] of wanted) {
          if (size === null || ledger.has(key) || storedLegacy.has(key)) continue;
          unpriced.set(key, size);
        }
        const requested = sumOf(unpriced);
        const used = sumOf(ledger);
        if (requested > 0 && used + requested > byteBudget) {
          if (!preserving && !finalFlush) return yield* overByteQuota(413, used, requested);
          yield* Effect.logInfo(
            "capture channel: over the byte quota while preserving what the executor holds · not refused",
          ).pipe(
            Effect.annotateLogs({
              worktreeId,
              epoch: input.epoch,
              launchId,
              limit: byteBudget,
              used,
              requested,
              exemptedBytes: used + requested - Math.max(byteBudget, used),
              exemptedFor: finalFlush ? "flush: final" : "drain",
            }),
          );
        }
        for (const [key, size] of unpriced) ledger.set(key, size);
        // Write authority is recorded before it leaves Mend (review 2026-09-28 (7) #8): on a
        // bucket that ignores `If-None-Match` a URL handed out now could replace an object of
        // this epoch until it expires, and no seal whose objects live under the epoch stands
        // before then (`CaptureSealsStoreLive`). The bucket judges expiry by its own clock:
        // allowed a margin. Recording it is serialized with a seal's acceptance on the epoch's
        // authority row (cross-repo decision 26, review 2026-09-28 (9) #6), and made only while
        // the lease is still this launch's, under this epoch (cross-repo decision 31, review
        // 2026-09-28 (10) #5): the lease was read before the bucket reads above, and a request
        // that waited through them past its epoch's end records nothing and mints nothing.
        // Once a seal is recorded whose objects live under this epoch — its own or a later
        // epoch's that carries this one's packs — no URL that could replace an object it names
        // is ever handed out. Every object a seal names was stored when it registered, so each
        // key about to get a URL is asked of the bucket again after the seal was seen: a stored
        // one is answered `present` (a launch that reads it) or refused (any other), never
        // handed a URL. Authority is then recorded only against the seals that check was made
        // for — a newer one is checked anew.
        let checkedSeals: ReadonlyArray<string> = [];
        let sealChecked = false;
        let recordedAt = Date.now();
        // Every URL of this call lives as long as the call's bytes need (e2e8): the authority
        // recorded below is that long plus the margin, and every URL is signed for it.
        const ttlSeconds = putUrlTtlSeconds(
          plans.some((plan) => plan.size === null)
            ? null
            : plans.reduce((total, plan) => total + (plan.size ?? 0), 0),
        );
        while (plans.length > 0) {
          // A call with nothing unbound records nothing: no URL of it can replace an object.
          if (!unbound) break;
          recordedAt = Date.now();
          const record: PutAuthorityRecord = yield* repo.recordPutAuthority(
            worktreeId,
            input.epoch,
            new Date(recordedAt + (ttlSeconds + PUT_URL_CLOCK_MARGIN_SECONDS) * 1000),
            checkedSeals,
            holder,
          );
          if (record.recorded) break;
          if (record.reason === "lease") {
            // Priced for nothing: no URL leaves.
            for (const key of unpriced.keys()) ledger.delete(key);
            yield* requireLease(input.epoch);
            return yield* leaseLost();
          }
          sealChecked = true;
          const again = yield* Effect.forEach(
            plans,
            (plan) =>
              blobs.head(plan.key).pipe(
                Effect.map((found) => [plan, found !== null] as const),
                Effect.catch(storeError("asking the bucket for", plan.key)),
              ),
            { concurrency: PRESENT_HEADS_IN_FLIGHT },
          );
          const storedNow = again.filter(([, stored]) => stored).map(([plan]) => plan);
          for (const plan of storedNow) {
            yield* verifyStored(plan.key);
            if (!answersPresent || storedLegacy.has(plan.key)) {
              return yield* new CaptureRouteError({
                status: 409,
                reason: "exists",
                message: `${plan.key} is stored and a final seal over epoch ${input.epoch}'s objects is recorded: no upload URL can be handed out for it`,
                key: plan.key,
              });
            }
            present.push(plan.key);
            // Answered present, not uploaded: never priced for this call.
            if (unpriced.has(plan.key)) ledger.delete(plan.key);
          }
          const answered = new Set(storedNow.map((plan) => plan.key));
          plans = plans.filter((plan) => !answered.has(plan.key));
          checkedSeals = record.sealedCaptures;
        }
        const urls: Record<string, string> = {};
        const multipart: Record<string, MultipartPlan> = {};
        for (const plan of plans) {
          const created =
            plan.parts === 0
              ? null
              : yield* blobs
                  .createMultipart(plan.key)
                  .pipe(Effect.catch(storeError("creating a multipart upload", plan.key)));
          if (created !== null && created.kind === "exists") {
            // Stored since the HEAD above: verified, and answered like any stored key.
            yield* verifyStored(plan.key);
            if (answersPresent) {
              present.push(plan.key);
              continue;
            }
            // A seal over the epoch's objects was seen: no URL that could replace a stored one.
            if (sealChecked) {
              return yield* new CaptureRouteError({
                status: 409,
                reason: "exists",
                message: `${plan.key} is stored and a final seal over epoch ${input.epoch}'s objects is recorded: no upload URL can be handed out for it`,
                key: plan.key,
              });
            }
            storedLegacy.add(plan.key);
            urls[plan.key] = yield* blobs
              .presign(plan.key, "PUT", ttlSeconds, plan.size ?? undefined)
              .pipe(Effect.catch(storeError("presigning a PUT", plan.key)));
            continue;
          }
          if (created === null) {
            // Below the threshold: one PUT URL, write-once (`If-None-Match: *` signed in). A
            // declared size is signed into the URL: the bucket takes those bytes or none. Bound
            // to its bytes where it can be (`boundTo`): the bucket takes exactly those or none.
            urls[plan.key] = yield* blobs
              .presign(plan.key, "PUT", ttlSeconds, plan.size ?? undefined, boundTo.get(plan.key))
              .pipe(Effect.catch(storeError("presigning a PUT", plan.key)));
            continue;
          }
          const partUrls: Array<string> = [];
          for (let partNumber = 1; partNumber <= plan.parts; partNumber += 1) {
            const partBytes =
              plan.size === null
                ? undefined
                : partNumber < plan.parts
                  ? policy.partSizeBytes
                  : plan.size - policy.partSizeBytes * (plan.parts - 1);
            partUrls.push(
              yield* blobs
                .presignPart(plan.key, created.uploadId, partNumber, ttlSeconds, partBytes)
                .pipe(Effect.catch(storeError("presigning a part", plan.key))),
            );
          }
          multipart[plan.key] = {
            upload_id: created.uploadId,
            part_size: policy.partSizeBytes,
            part_urls: partUrls,
          };
        }
        // The authority recorded above covers a URL for its lifetime plus the margin, counted
        // from when it was recorded: URLs minted later than the margin allows could outlive it,
        // so none of them leaves Mend — the executor asks again (review 2026-09-28 (10) #5).
        if (
          plans.length > 0 &&
          unbound &&
          Date.now() - recordedAt > (PUT_URL_CLOCK_MARGIN_SECONDS * 1000) / 2
        ) {
          for (const key of unpriced.keys()) ledger.delete(key);
          return yield* Effect.die(
            "capture channel: upload URLs were signed too long after their write authority was recorded · none handed out",
          );
        }
        const answeredPresent = new Set(present);
        noteMinted(plans.map((plan) => plan.key).filter((key) => !answeredPresent.has(key)));
        return (
          present.length === 0 ? { urls, multipart } : { urls, multipart, present }
        ) satisfies UploadUrlsResponse;
      });

      const uploadComplete = Effect.fn("SessionCaptureApi.uploadComplete")(function* (
        input: UploadCompleteRequest,
      ) {
        yield* requireWorktree(input.worktree_id);
        yield* requireLease(input.epoch);
        if (!underOwnPrefix(input.key, input.epoch) || !isCaptureObjectKey(input.key)) {
          return yield* bad(
            "key must name one capture object (…/packs/<sha256> or …/trees/<sha256>) under the caller's epoch prefix",
          );
        }
        if (input.upload_id === "") return yield* bad("upload_id is empty");
        const numbers = new Set(input.parts.map((part) => part.part_number));
        if (
          input.parts.length === 0 ||
          numbers.size !== input.parts.length ||
          input.parts.some((part) => part.part_number < 1 || part.etag === "")
        ) {
          return yield* bad("parts must be non-empty, distinct by part_number, each with an etag");
        }
        // A declared size fixes how many parts assemble the object: each part URL was signed
        // for its bytes, so a missing or extra part is refused before the bucket assembles it.
        const declared = ledger.get(input.key);
        if (declared !== undefined) {
          const expected = Math.max(1, Math.ceil(declared / policy.partSizeBytes));
          if (
            input.parts.length !== expected ||
            !input.parts.every((part) => part.part_number <= expected)
          ) {
            return yield* bad(
              `${input.key} was declared as ${declared} bytes: ${expected} parts numbered 1 to ${expected}`,
            );
          }
        }
        const parts = input.parts.map((part) => ({
          partNumber: part.part_number,
          etag: part.etag,
        }));
        // Any failure that is not the write-once refusal aborts the upload before the 500, so
        // the executor's retry starts from fresh URLs rather than an upload in an unknown state.
        const outcome = yield* blobs
          .completeMultipart(input.key, input.upload_id, parts)
          .pipe(
            Effect.catch((error) =>
              blobs
                .abortMultipart(input.key, input.upload_id)
                .pipe(
                  Effect.ignore,
                  Effect.andThen(storeError("completing a multipart upload", input.key)(error)),
                ),
            ),
          );
        if (!outcome.written) {
          return yield* new CaptureRouteError({
            status: 409,
            reason: "exists",
            message: "the key already holds bytes; the upload was discarded",
            key: input.key,
          });
        }
        // The assembled size, when the bucket reports it: the executor compares it with the
        // file it cut into parts instead of ranging a GET for it.
        const assembled = yield* blobs
          .head(input.key)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (assembled !== null && declared !== undefined && assembled.size !== declared) {
          // Nothing references the object before register, so removing it is safe.
          yield* blobs.remove(input.key).pipe(Effect.ignore);
          ledger.delete(input.key);
          return yield* new CaptureRouteError({
            status: 409,
            reason: "size-mismatch",
            message: `${input.key} holds ${assembled.size} bytes, not the ${declared} declared; the object was removed`,
            key: input.key,
          });
        }
        return assembled === null ? {} : { size: assembled.size };
      });

      const conflictToRoute = (error: CaptureConflictError) =>
        Effect.gen(function* () {
          if (error.reason === "stale_epoch") {
            const lease = yield* repo.leaseOf(worktreeId);
            return new CaptureRouteError({
              status: 409,
              reason: "stale-epoch",
              message: "the capture was registered under a stale epoch",
              ...(lease === null || lease.epoch === error.n ? {} : { live_epoch: lease.epoch }),
            });
          }
          const chain = yield* repo.headOf(worktreeId);
          return new CaptureRouteError({
            status: 409,
            reason: "wrong-parent",
            message: `the chain head is n=${chain?.headN ?? -1}, not the register's parent`,
            head_n: chain?.headN ?? -1,
            head_capture_id: chain?.head?.id ?? "",
          });
        });

      /**
       * Every bulk section the capture a register names as its parent holds, whatever its
       * platform; none for capture 0, a parent that is not on this chain, or a row that does not
       * decode (then nothing counts as carried and everything is checked).
       */
      const parentBulkSections = (parent: string | null) =>
        Effect.gen(function* () {
          if (parent === null) return [];
          const row = yield* repo.captureById(parent);
          if (row === null || row.worktreeId !== worktreeId) return [];
          const decoded = Schema.decodeUnknownOption(CaptureSections)(row.sections);
          if (Option.isNone(decoded)) return [];
          const { bulk, other_bulk } = decoded.value;
          return [...(bulk === "pending" ? [] : [bulk]), ...Object.values(other_bulk ?? {})];
        });

      /**
       * Every chunked section the parent capture holds — its workspace, its bulk, every
       * `other_bulk` entry — for the restorability check to skip what is carried unchanged.
       */
      const parentChunkedSections = (parent: string | null) =>
        Effect.gen(function* () {
          if (parent === null) return [];
          const row = yield* repo.captureById(parent);
          if (row === null || row.worktreeId !== worktreeId) return [];
          const decoded = Schema.decodeUnknownOption(CaptureSections)(row.sections);
          if (Option.isNone(decoded)) return [];
          const { workspace, bulk, other_bulk } = decoded.value;
          const trees: Array<ChunkedSection> = [workspace];
          if (bulk !== "pending") trees.push(bulk);
          trees.push(...Object.values(other_bulk ?? {}));
          return trees;
        });

      /** A section's tree failed the restorability check: 422, and what was missing when known. */
      const unrestorable =
        (section: ChunkedSection) =>
        (error: CaptureReadError): Effect.Effect<never, CaptureRouteError> =>
          error._tag === "BlobStoreError"
            ? storeError("checking a section restores", section.root)(error)
            : error._tag === "BlobNotFoundError"
              ? Effect.fail(
                  new CaptureRouteError({
                    status: 422,
                    reason: "missing-objects",
                    message: `an object the section rooted at ${section.root} needs is not in the bucket`,
                    missing: [error.key],
                  }),
                )
              : Effect.fail(
                  new CaptureRouteError({
                    status: 422,
                    reason: "unrestorable",
                    message: `the section rooted at ${section.root} would not restore: ${
                      error._tag === "ChunkNotFoundError"
                        ? `chunk ${error.hash} is in no listed pack`
                        : error._tag === "CaptureIntegrityError"
                          ? `${error.key} does not hash to ${error.expected}`
                          : `${error.key}: ${error.reason}`
                    }`,
                  }),
                );

      /** A sealing register's key: its worktree, launch, epoch, n and capture (e2e8 F2). */
      const sealKeyOf = (input: RegisterRequest) =>
        [worktreeId, launchId, input.epoch, input.n, input.capture_id].join("\u0000");
      const verifyingAnswer = {
        outcome: { state: "withheld", reason: "verifying" } satisfies RegisterSealOutcome,
        detail:
          "its objects are still being read back; registering the same capture again reads how the seal stands",
      };
      /** A seal whose checks concluded nothing (`SealVerdict.unavailable`): asked again, checked again. */
      const unavailableAnswer = (verdict: SealVerdict) => ({
        outcome: { state: "withheld", reason: "unavailable" } satisfies RegisterSealOutcome,
        detail: `its checks could not finish (${(verdict.unavailable ?? []).join("; ")}); registering the same capture again checks it again`,
      });

      /**
       * `checks` over the store, every read the store failed noted (review 2026-09-28 (12) #4): a
       * `BlobStoreError` — a 503, a timeout — is the store not answering, never a fact about the
       * capture, so checks that met one conclude nothing (`unavailable`), whatever they made of
       * the reads that failed. A missing object (`BlobNotFoundError`) or other bytes are facts.
       */
      const againstStore = (
        checks: Effect.Effect<SealVerdict, never, BlobStore>,
      ): Effect.Effect<SealVerdict> =>
        Effect.suspend(() => {
          const failed: Array<string> = [];
          return checks.pipe(
            Effect.provideService(BlobStore, noteStoreFailures(blobs, failed)),
            Effect.map((verdict) =>
              failed.length === 0
                ? verdict
                : {
                    problems: verdict.problems,
                    unavailable: [
                      ...(verdict.unavailable ?? []),
                      `the store failed ${failed.length} read(s), first ${failed[0]}`,
                    ],
                  },
            ),
          );
        });

      /**
       * What a seal needs read back from the store, beyond what the register already knows: every
       * chunk of every pack the chunked sections list decompresses and hashes to what it names
       * (review 2026-09-28 (4) #13) — a pack that does not is kept and registered, and nothing is
       * sealed on it; the worktree metadata's cross-class hardlinks restore as declared (review
       * 2026-09-28 (5) #11) — sealantd's apply leaves a missing or differing member unlinked without
       * a word; the tracked side's links restore too (review 2026-09-28 (6) #10) — every
       * `hardlinks` group one blob of the tree the restore checks out, every `shared` link a
       * tracked file of that tree and a file of its class holding that blob's bytes, and a tree
       * Mend could not list seals nothing; and every inode those links make is promised one mode
       * and one mtime (review 2026-09-28 (7) #10, (8) #9). One verification pass: each object
       * read at most once (`withCaptureReadPass`, e2e8 F2). No problems: the seal may stand. A
       * read the store failed makes the verdict `unavailable` (`againstStore`).
       */
      const sealChecks = (
        manifest: CaptureManifest,
        chunked: ReadonlyArray<ChunkedSection>,
        metaDocument: WorktreeMetaDocument | null,
        restoreTree: ReadonlyMap<string, RestoreTreePath> | null,
        annotations: Readonly<Record<string, unknown>>,
      ): Effect.Effect<SealVerdict> =>
        againstStore(
          withCaptureReadPass(
            Effect.gen(function* () {
              const problems: Array<string> = [];
              const payloads = yield* verifyPackPayloads(
                chunked.flatMap((section) => section.packs),
              ).pipe(Effect.result);
              if (Result.isFailure(payloads)) {
                const error = payloads.failure;
                yield* Effect.logWarning(
                  "capture channel: a final seal over a pack whose chunks do not read · registered without it",
                ).pipe(
                  Effect.annotateLogs({
                    ...annotations,
                    error: error._tag,
                    detail:
                      error._tag === "CaptureFormatError"
                        ? `${error.key}: ${error.reason}`
                        : error._tag === "CaptureIntegrityError"
                          ? `${error.key} does not hash to ${error.expected}`
                          : error._tag === "ChunkNotFoundError"
                            ? error.hash
                            : error._tag === "BlobNotFoundError"
                              ? error.key
                              : error.message,
                  }),
                );
                problems.push("chunk payloads not read");
              }
              if (metaDocument === null) return { problems };
              const crossLinks = yield* crossLinksProblem(manifest, metaDocument);
              if (crossLinks !== null) problems.push(`cross-class links: ${crossLinks}`);
              if (
                (metaDocument.hardlinks ?? []).length > 0 ||
                (metaDocument.shared ?? []).length > 0
              ) {
                const trackedLinks =
                  restoreTree === null
                    ? "the tree a restore checks out was not listed"
                    : yield* linkTopologyProblem(manifest, metaDocument, restoreTree);
                if (trackedLinks !== null) problems.push(`tracked links: ${trackedLinks}`);
              }
              const inodeMeta = yield* inodeMetadataProblem(manifest, metaDocument);
              if (inodeMeta !== null) problems.push(`inode metadata: ${inodeMeta}`);
              return { problems };
            }),
          ),
        );

      /**
       * `sealChecks` for a capture registered before — by a register whose checks this process no
       * longer holds (Mend restarted, or the verdict was dropped): what that register knew is read
       * again first — the git section's recorded verification, the worktree metadata against the
       * namespace it applies to — then the rest.
       */
      const lateSealChecks = (
        manifest: CaptureManifest,
        chunked: ReadonlyArray<ChunkedSection>,
        row: CaptureRow,
        annotations: Readonly<Record<string, unknown>>,
      ): Effect.Effect<SealVerdict> =>
        withCaptureReadPass(
          Effect.gen(function* () {
            if (manifest.sections.bulk === "pending") return { problems: ["bulk class pending"] };
            // A git section the register could not verify is verified again now (review
            // 2026-09-28 (12) #4), and so is one recorded `failed` (review 2026-09-28 (13) #1: a
            // re-ask checks once more before it refuses); still not verifiable, the checks
            // conclude nothing.
            const gitFsck =
              row.gitFsck === "verified" ? row.gitFsck : yield* verifyRow(row, manifest);
            if (gitFsck === "unverified") {
              return { problems: [], unavailable: ["the git section could not be verified"] };
            }
            if (gitFsck !== "verified") return { problems: [`git section ${gitFsck}`] };
            const meta = yield* verifyWorktreeMeta(manifest.sections.workspace).pipe(Effect.result);
            if (Result.isFailure(meta)) {
              return { problems: [`worktree metadata unrestorable: ${meta.failure._tag}`] };
            }
            const metaDocument = meta.success;
            if (metaDocument === null) {
              return yield* sealChecks(manifest, chunked, null, null, annotations);
            }
            const tree = rawTreeOf(manifest.sections.git);
            const restoreTree =
              tree === undefined
                ? new Map<string, RestoreTreePath>()
                : yield* verifier.treeObjects(scope.projectId, manifest, tree);
            if (restoreTree === null) {
              return {
                problems: [],
                unavailable: ["the tree a restore checks out could not be listed"],
              };
            }
            const namespace = yield* restoreNamespaceProblem(manifest, metaDocument, restoreTree);
            if (namespace !== null) return { problems: [`worktree metadata: ${namespace}`] };
            return yield* sealChecks(manifest, chunked, metaDocument, restoreTree, annotations);
          }),
        ).pipe(
          againstStore,
          Effect.catchCause((cause) =>
            Effect.succeed({
              problems: [],
              unavailable: [`the seal checks ended without a verdict: ${Cause.pretty(cause)}`],
            }),
          ),
        );

      /**
       * Where the seal of a capture registered before stands, for the executor's re-ask (the same
       * register again): recorded for it — as `sealStandingOf` says; its checks still running —
       * `withheld` (`verifying`), waited for within what is left of the budget; its checks found
       * problems — refused; nothing known here (Mend restarted), or its checks or its record
       * concluded nothing (`unavailable`: the store failed a read, the database failed the record)
       * — checked again, the seal recorded if they pass.
       */
      const reAsked = Effect.fn("SessionCaptureApi.reAsked")(function* (
        input: RegisterRequest,
        manifest: CaptureManifest,
        chunked: ReadonlyArray<ChunkedSection>,
        names: ReadonlyArray<string>,
        waitMs: number,
      ) {
        const recorded = yield* repo.sealedCompletion(worktreeId, launchId, input.epoch);
        if (recorded !== null && recorded.captureId === input.capture_id) {
          return yield* registeredSealOutcome(input.epoch, input.capture_id, null);
        }
        const row = yield* repo.captureById(input.capture_id);
        if (row === null) return yield* registeredSealOutcome(input.epoch, input.capture_id, null);
        const key = sealKeyOf(input);
        const annotations = {
          worktreeId,
          n: input.n,
          captureId: input.capture_id,
          epoch: input.epoch,
        };
        const job = yield* sealJobFor(
          key,
          lateSealChecks(manifest, chunked, row, annotations),
          false,
        );
        if (!(yield* Deferred.isDone(job.settled))) {
          yield* recordWhenChecked(job, {
            worktreeId,
            epoch: input.epoch,
            captureId: input.capture_id,
            n: input.n,
            manifestKey: input.manifest_key,
            names,
            seal: {
              executorId: launchId,
              holder: scope.executorId,
              bootId: manifest.final_seal?.boot_id ?? null,
              bootGeneration: manifest.final_seal?.boot_generation ?? null,
              observation: manifest.final_seal?.observation ?? null,
            },
          });
        }
        const settled = yield* Deferred.await(job.settled).pipe(Effect.timeoutOption(waitMs));
        if (Option.isNone(settled)) return verifyingAnswer;
        // Checks or a record that concluded nothing (review 2026-09-28 (12) #4): the job is
        // dropped, and the next ask checks and records again — unless the record went through.
        if (verdictUnavailable(settled.value)) {
          const sealed = yield* repo.sealedCompletion(worktreeId, launchId, input.epoch);
          if (sealed === null || sealed.captureId !== input.capture_id) {
            return unavailableAnswer(settled.value);
          }
          return yield* registeredSealOutcome(input.epoch, input.capture_id, null);
        }
        return yield* registeredSealOutcome(
          input.epoch,
          input.capture_id,
          settled.value.problems.length === 0 ? null : settled.value.problems.join("; "),
        );
      });

      const registerOnce = Effect.fn("SessionCaptureApi.register")(function* (
        input: RegisterRequest,
      ) {
        const startedAt = Date.now();
        const budget = yield* CaptureRegisterBudget;
        const remaining = () => Math.max(0, budget - (Date.now() - startedAt));
        yield* requireWorktree(input.worktree_id);
        const lease = yield* requireLease(input.epoch);
        if (
          !underOwnPrefix(input.manifest_key, input.epoch) ||
          !isCaptureObjectKey(input.manifest_key)
        ) {
          return yield* bad(
            "manifest_key must be …/manifests/<sha256> under the caller's epoch prefix",
          );
        }
        // The id is the digest of the bytes AS STORED — read them back rather than trust the
        // request's copy; a lost-ack retry re-registers the same id from identical bytes.
        const stored = yield* blobs.get(input.manifest_key).pipe(
          Effect.catchTag("BlobNotFoundError", () =>
            Effect.fail(
              new CaptureRouteError({
                status: 422,
                reason: "missing-objects",
                message: "the manifest has not landed in the bucket",
                missing: [input.manifest_key],
              }),
            ),
          ),
          Effect.catch((error) =>
            error._tag === "CaptureRouteError"
              ? Effect.fail(error)
              : storeError("reading the manifest", input.manifest_key)(error),
          ),
        );
        if (captureIdOf(stored) !== input.capture_id) {
          return yield* new CaptureRouteError({
            status: 422,
            reason: "capture-id-mismatch",
            message: "capture_id is not the sha256 of the manifest bytes at manifest_key",
          });
        }
        // Everything below reads the manifest AS STORED — what a restore will read — and the
        // request's copy must be that same document: a register never validates one manifest
        // and acknowledges another (review 2026-09-28 #17).
        const storedJson = yield* Effect.try({
          try: (): unknown => JSON.parse(Buffer.from(stored).toString("utf8")),
          catch: () => bad("the manifest at manifest_key is not JSON"),
        });
        if (!isDeepStrictEqual(storedJson, input.manifest)) {
          return yield* bad("the request's manifest is not the manifest stored at manifest_key");
        }
        const manifest = yield* decodeManifest(input.manifest_key, stored).pipe(
          Effect.mapError((error) => bad(`manifest: ${error.reason}`)),
        );
        if (
          manifest.worktree_id !== worktreeId ||
          manifest.epoch !== input.epoch ||
          manifest.n !== input.n ||
          manifest.parent !== input.parent
        ) {
          return yield* bad("the manifest's identity fields disagree with the request");
        }
        // Every key the manifest names must be one capture object — a pack, its index, a dir
        // pack, a format-1 dir object root — before anything below asks the bucket about it: a
        // prefix, an empty entry or a stray word in a packs list is refused here, never HEAD-ed.
        // A format-2 root is a dir object digest, not a key (its bytes are in the dir packs),
        // and must be one. A pending bulk section names nothing and needs nothing. Every bulk
        // section captured on another platform (`other_bulk`, sealantd PR #101) is checked the
        // same way.
        const bulk = manifest.sections.bulk === "pending" ? null : manifest.sections.bulk;
        const otherBulk = Object.values(manifest.sections.other_bulk ?? {});
        const chunked = [
          manifest.sections.workspace,
          ...(bulk === null ? [] : [bulk]),
          ...otherBulk,
        ];
        const rootKeys = chunked
          .filter((section) => sectionFormatOf(section) === FORMAT_DIR_OBJECTS)
          .map((section) => section.root)
          .filter((root) => root !== "");
        const malformed = [
          ...manifest.sections.git.packs,
          ...manifest.sections.workspace.packs,
          ...dirPacksOf(manifest.sections.workspace),
          ...(bulk === null ? [] : bulkKeysOf(bulk)),
          ...otherBulk.flatMap(bulkKeysOf),
          ...rootKeys,
        ].filter((key) => !isCaptureObjectKey(key));
        if (malformed.length > 0) {
          return yield* bad(
            `the manifest names ${malformed.length} key(s) that are not capture objects (…/packs/<sha256>, …/trees/<sha256>): ${malformed
              .slice(0, 3)
              .map((key) => JSON.stringify(key))
              .join(", ")}`,
          );
        }
        const badDigests = chunked
          .filter((section) => sectionFormatOf(section) === FORMAT_DIR_PACKS)
          .filter(
            (section) =>
              section.root !== "" &&
              (!SHA256_HEX.test(section.root) || dirPacksOf(section).length === 0),
          )
          .map((section) => section.root);
        if (badDigests.length > 0) {
          return yield* bad(
            `a format-2 section names its root dir object by sha256 digest and lists the dir packs holding it: ${badDigests
              .slice(0, 2)
              .map((root) => JSON.stringify(root))
              .join(", ")}`,
          );
        }
        // Another platform's bulk section the parent already holds — as its `bulk` or in its
        // `other_bulk` — was registered with the parent or before it: HEAD-ed, priced and
        // recorded then, and kept alive by retention since through every row that names it. It
        // is carried, not new, and asks nothing more of the bucket or the byte budget. One the
        // parent does not hold is checked below like a bulk section.
        const held = yield* parentBulkSections(input.parent);
        const newOtherBulk = otherBulk.filter(
          (section) => !held.some((parentSection) => sameBulkSection(parentSection, section)),
        );
        // HEAD every pack the manifest names (across epochs) before the CAS, and price the
        // ones under this epoch against the session's byte budget — once per key, at the size
        // the bucket reports (a reservation `upload.urls` took at the declared size is replaced;
        // a pack priced by an earlier register of this epoch costs nothing again).
        const bulkPackKeys = (section: BulkSectionReady) =>
          bulkKeysOf(section).map((key) => ({
            key,
            cls: "bulk" as const,
            platform: section.platform,
          }));
        const named: Array<{
          readonly key: string;
          readonly cls: PackRecord["class"];
          readonly platform: string | null;
        }> = [
          ...manifest.sections.git.packs.flatMap((key) => [
            { key, cls: "git" as const, platform: null },
            { key: packIdxKeyOf(key), cls: "git" as const, platform: null },
          ]),
          // Dir packs are packs like any other: HEAD-ed, priced, recorded (and so kept alive by
          // retention through their row) under their section's class.
          ...[...manifest.sections.workspace.packs, ...dirPacksOf(manifest.sections.workspace)].map(
            (key) => ({ key, cls: "workspace" as const, platform: null }),
          ),
          ...(bulk === null ? [] : bulkPackKeys(bulk)),
          ...newOtherBulk.flatMap(bulkPackKeys),
        ];
        // A key two sections share is asked about, priced and recorded once.
        const seen = new Set<string>();
        const packKeys = named.filter(({ key }) => {
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        // Every chunked section the parent holds: one this capture holds unchanged was checked
        // restorable when the parent registered, and the parent — the head — keeps its objects
        // alive; only what is new is walked.
        const parentTrees = yield* parentChunkedSections(input.parent);
        // Everything the capture names, carried sections included, and the chains those objects
        // belong to: retention may condemn any of them (`capture-retention.ts`).
        const referenced = [
          ...new Set([
            ...keysOfSections(manifest.sections),
            ...treePrefixesOfSections(manifest.sections),
          ]),
        ];
        const owners = [
          ...new Set([
            worktreeId,
            ...referenced.flatMap((key) => {
              const owner = captureKeyOwner(key);
              return owner === null ? [] : [WorktreeIdOf(owner)];
            }),
          ]),
        ];

        // `final_seal` (cross-repo decision 1): sealantd's word that this executor's final flush
        // completed. It is recorded with the CAS — so only on a capture that lands on a chain
        // registered up to it — and only when complete and naming the executor this token is
        // scoped to and the epoch it registers under, and only once Mend observed every section
        // restore: the chunked ones walked below, the git section verified, the worktree
        // metadata checked against the tree it applies to (`sealed`, in the attempt). Anything
        // else registers the capture and seals nothing: the bytes are kept, and no completion is
        // claimed on their behalf.
        const seal = manifest.final_seal ?? null;
        const sealHolds =
          seal !== null &&
          seal.complete &&
          seal.epoch === input.epoch &&
          seal.executor === launchId;
        if (seal !== null && !sealHolds) {
          yield* Effect.logWarning(
            "capture channel: a final seal that does not hold · registered without it",
          ).pipe(
            Effect.annotateLogs({
              worktreeId,
              n: input.n,
              captureId: input.capture_id,
              epoch: input.epoch,
              executorId: scope.executorId,
              launchId,
              seal: JSON.stringify(seal),
            }),
          );
        }

        const sealKey = sealKeyOf(input);
        const annotations = {
          worktreeId,
          n: input.n,
          captureId: input.capture_id,
          epoch: input.epoch,
        };
        /** This register's seal checks, kept across its guard retries. */
        let job: SealJob | undefined;
        /** What the store records of the seal, with the CAS or once its checks pass. */
        const sealFields = {
          executorId: launchId,
          holder: scope.executorId,
          bootId: seal?.boot_id ?? null,
          bootGeneration: seal?.boot_generation ?? null,
          observation: seal?.observation ?? null,
        };

        // One attempt: read the guards and the tombstones, check the bucket and the trees, then
        // the CAS under those guards. A retention pass that condemned anything named here after
        // the read makes the CAS miss (`guard_moved`), and the next attempt sees its tombstones.
        const attempt = Effect.gen(function* () {
          const state = yield* repo.referenceState(owners, referenced);
          const ownerless = referenced.filter((key) => {
            const owner = captureKeyOwner(key);
            return owner !== null && !state.guards.has(WorktreeIdOf(owner));
          });
          if (ownerless.length > 0 || !state.guards.has(worktreeId)) {
            return yield* new CaptureRouteError({
              status: 422,
              reason: "missing-objects",
              message: `${ownerless.length} object(s) the manifest names belong to a worktree that is gone`,
              missing: ownerless,
            });
          }
          // A key retention condemned is never registered again, whatever became of its bytes
          // since (cross-repo decision 6): a pass that checked, stalled and deleted after its
          // claim lapsed can still remove the bytes at that key, so bytes uploaded there again
          // are never a capture's. The executor uploads the content under a new key — a new
          // generation (`captures/<worktree>/<epoch>/g<generation>/…`) — and registers that.
          if (state.tombstones.length > 0) {
            return yield* new CaptureRouteError({
              status: 422,
              reason: "missing-objects",
              message: `retention condemned ${state.tombstones.length} object(s) the manifest names: a condemned key is never registered again — upload the content under a new key`,
              missing: state.tombstones.map((tombstone) => tombstone.key),
            });
          }
          const missing: Array<string> = [];
          const records: Array<PackRecord> = [];
          const sizes = new Map<string, number>();
          const priced = new Map(ledger);
          let newBytes = 0;
          for (const { key, cls, platform } of packKeys) {
            const head = yield* blobs
              .head(key)
              .pipe(Effect.catch(storeError("HEAD on a pack", key)));
            if (head === null) {
              missing.push(key);
              continue;
            }
            sizes.set(key, head.size);
            if (key.endsWith(".idx")) continue;
            if (underOwnPrefix(key, input.epoch)) {
              const reserved = ledger.get(key);
              if (reserved !== undefined && reserved !== head.size) {
                // Refuse without removing: an earlier register of this epoch may already
                // reference the object, and the manifest never commits past this point.
                return yield* new CaptureRouteError({
                  status: 409,
                  reason: "size-mismatch",
                  message: `${key} holds ${head.size} bytes, not the ${reserved} declared`,
                  key,
                });
              }
              if (reserved === undefined) newBytes += head.size;
              priced.set(key, head.size);
            }
            records.push({
              key,
              class: cls,
              bytes: head.size,
              worktreeId: underOwnWorktree(key) ? worktreeId : null,
              epoch: underOwnPrefix(key, input.epoch) ? input.epoch : null,
              platform,
            });
          }
          if (missing.length > 0) {
            return yield* new CaptureRouteError({
              status: 422,
              reason: "missing-objects",
              message: `${missing.length} pack(s) the manifest names are not in the bucket`,
              missing,
            });
          }
          const already = yield* repo.captureById(input.capture_id);
          let metaDocument: WorktreeMetaDocument | null = null;
          // Restorability before acknowledgement: every chunked section this capture brings —
          // one the parent did not hold — must restore from what it names: its root and every
          // dir object below it, every chunk in a listed pack, every hardlink's canonical member.
          // A register acknowledges preservation; a capture Mend could not restore is refused,
          // never registered.
          if (already === null) {
            for (const section of chunked) {
              if (parentTrees.some((parent) => sameTree(parent, section))) continue;
              yield* verifySectionRestorable(section, { sizes }).pipe(
                Effect.provideService(BlobStore, blobs),
                Effect.catch(unrestorable(section)),
              );
            }
            // The worktree metadata document is walked whatever the parent held: a restore
            // needs it whenever the manifest names it, and a parent's row does not say it held
            // this very document (review 2026-09-28 #17).
            metaDocument = yield* verifyWorktreeMeta(manifest.sections.workspace, { sizes }).pipe(
              Effect.provideService(BlobStore, blobs),
              Effect.catch(unrestorable(manifest.sections.workspace)),
            );
          }
          // The backstop for bytes that landed unpriced (keys the daemon sent no size for): a
          // 409 the executor's registrar reads as a refusal of THIS capture, not a transport
          // failure to retry — the bytes are in the bucket and the same register can never
          // pass. What landed is off-chain and retires with its epoch prefix.
          const used = sumOf(ledger);
          if (already === null && sumOf(priced) > byteBudget) {
            const finalFlush = isFinalFlush(input);
            if (!preserving && manifest.kind !== "final" && !finalFlush) {
              return yield* overByteQuota(409, used, newBytes);
            }
            yield* Effect.logInfo(
              "capture channel: register over the byte quota while preserving what the executor holds · not refused",
            ).pipe(
              Effect.annotateLogs({
                worktreeId,
                n: input.n,
                epoch: input.epoch,
                kind: manifest.kind,
                launchId,
                limit: byteBudget,
                used,
                requested: newBytes,
                exemptedBytes: sumOf(priced) - byteBudget,
                exemptedFor: preserving ? "drain" : finalFlush ? "flush: final" : "final capture",
              }),
            );
          }
          // `git_fsck` records Mend's observation, never the executor's claim: the kinds a
          // pickup or a review would restore are verified before the CAS (index-pack --verify
          // and a connectivity walk on the runner); `auto` captures land `unverified` and are
          // verified by the first plan that would restore them. A failed section is accepted
          // and marked — the chain advances, the plan and the reads route around it.
          const verification =
            already !== null || !VERIFIED_AT_REGISTER.has(manifest.kind)
              ? null
              : yield* verifier.verify(scope.projectId, manifest);
          const gitFsck = already?.gitFsck ?? verification?.outcome ?? "unverified";
          if (verification !== null && verification.outcome !== "verified") {
            yield* Effect.logWarning(
              `capture channel: git section ${verification.outcome === "failed" ? "failed verification" : "not verified"} at register · observed`,
            ).pipe(
              Effect.annotateLogs({
                worktreeId,
                n: input.n,
                captureId: input.capture_id,
                kind: manifest.kind,
                epoch: input.epoch,
                claimed: manifest.sections.git.fsck,
                detail: verification.detail,
              }),
            );
          }
          // The tree a restore checks out (`rawTreeOf`: `raw_tree` when the section has one, else
          // the worktree tree), listed once from the packs the verification installed: what the
          // worktree metadata document and its links are checked against. Null when Mend could
          // not list it (git not verified, the runner unavailable); an empty map when the capture
          // names no tree (nothing tracked).
          const restoreTree = yield* Effect.gen(function* () {
            if (metaDocument === null) return null;
            const tree = rawTreeOf(manifest.sections.git);
            if (tree === undefined) return new Map<string, RestoreTreePath>();
            return verification?.outcome === "verified"
              ? yield* verifier.treeObjects(scope.projectId, manifest, tree)
              : null;
          });
          // The worktree metadata document against the namespace it applies to (review
          // 2026-09-28 (3) #20, (7) #9): sealantd applies it over the tree the git class checked
          // out — the raw tree, not the worktree tree, when the section has one — and the classes
          // restored over it, and fails the whole materialize on a file or a symlink it names
          // that is not there. A document that names what that namespace does not hold is
          // refused (422 `unrestorable`); one Mend could not list registers unchecked and seals
          // nothing.
          const metaNamespace = yield* Effect.gen(function* () {
            if (metaDocument === null) return "verified" as const;
            if (restoreTree === null) return "unverified" as const;
            const problem = yield* restoreNamespaceProblem(
              manifest,
              metaDocument,
              restoreTree,
            ).pipe(Effect.provideService(BlobStore, blobs));
            if (problem !== null) {
              return yield* new CaptureRouteError({
                status: 422,
                reason: "unrestorable",
                message: `the worktree metadata would not apply over the tree the restore checks out: ${problem}`,
              });
            }
            return "verified" as const;
          });
          // A seal needs, first, what is already known here: the git section verified, the
          // worktree metadata verified against the namespace it applies to, and every class
          // captured — a manifest whose bulk class is still `"pending"` names work it does not
          // hold (review 2026-09-28 (5) #10); a class captured empty is a ready section naming
          // nothing, never pending.
          const bulkCaptured = manifest.sections.bulk !== "pending";
          const factProblems = [
            gitFsck === "failed" ? "git section failed" : null,
            bulkCaptured ? null : "bulk class pending",
          ].filter((problem) => problem !== null);
          // What could not be observed is no fact about the capture (review 2026-09-28 (12) #4):
          // a git section the verifier could not walk (its cache not prepared, the bucket not
          // answering), a tree it could not list. Withheld (`unavailable`); the re-ask verifies
          // again (`lateSealChecks`).
          const factUnavailable = [
            gitFsck === "unverified" ? "the git section could not be verified" : null,
            gitFsck !== "failed" && metaNamespace === "unverified"
              ? "the tree a restore checks out could not be listed"
              : null,
          ].filter((reason) => reason !== null);
          // Then what reads the objects back (`sealChecks`): the chunk payloads, the cross-class
          // links, the tracked links, the inode promises. One verification per sealing capture
          // at a time (`sealJobFor`, e2e8 F2), waited for only within the register's budget: past
          // it, the capture registers without the seal and the checks go on.
          if (
            already === null &&
            sealHolds &&
            factProblems.length === 0 &&
            factUnavailable.length === 0
          ) {
            job ??= yield* sealJobFor(
              sealKey,
              sealChecks(manifest, chunked, metaDocument, restoreTree, annotations),
              true,
            );
          }
          const verdict =
            job === undefined
              ? null
              : yield* Deferred.await(job.verdict).pipe(Effect.timeoutOption(remaining()));
          const pendingSeal = verdict !== null && Option.isNone(verdict);
          // Checks that concluded nothing (the store failed a read, review 2026-09-28 (12) #4):
          // registered without the seal, answered `withheld` (`unavailable`), checked again on
          // the next ask — never a verdict about the capture.
          const unavailable: SealVerdict | null =
            factProblems.length === 0 && factUnavailable.length > 0
              ? { problems: [], unavailable: factUnavailable }
              : verdict !== null && Option.isSome(verdict) && verdictUnavailable(verdict.value)
                ? verdict.value
                : null;
          const problems = [
            ...factProblems,
            ...(verdict !== null && Option.isSome(verdict) ? verdict.value.problems : []),
          ];
          const sealed =
            sealHolds &&
            already === null &&
            !pendingSeal &&
            unavailable === null &&
            problems.length === 0;
          const sealProblem =
            !sealHolds || sealed || pendingSeal || unavailable !== null || already !== null
              ? null
              : problems.join("; ");
          if (sealProblem !== null) {
            yield* Effect.logWarning(
              "capture channel: a final seal over sections not verified restorable · registered without it",
            ).pipe(Effect.annotateLogs({ ...annotations, problems: sealProblem }));
          }
          const outcome = yield* repo
            .register({
              ...(sealed ? { seal: sealFields } : {}),
              holder,
              worktreeId,
              id: input.capture_id,
              n: input.n,
              parent: input.parent,
              epoch: input.epoch,
              seq: BigInt(manifest.seq),
              kind: manifest.kind,
              manifestKey: input.manifest_key,
              sections: manifest.sections,
              gitFsck,
              guards: owners.map((owner) => ({
                worktreeId: owner,
                guard: state.guards.get(owner) ?? 0,
              })),
              names: referenced,
            })
            .pipe(
              Effect.catch(
                (error): Effect.Effect<never, CaptureRouteError | GuardMovedError> =>
                  error.reason === "guard_moved"
                    ? Effect.fail(new GuardMovedError())
                    : conflictToRoute(error).pipe(Effect.flatMap(Effect.fail)),
              ),
            );
          return {
            outcome,
            priced,
            records,
            sealProblem,
            pendingSeal,
            unavailable,
            verdict,
            already,
          };
        });
        // One verification pass (e2e8 F2): whatever the attempts read — dir packs, pack indexes,
        // pack payloads, the chunks a member's digest needs — is read once for all of them.
        const {
          outcome,
          priced,
          records,
          sealProblem,
          pendingSeal,
          unavailable,
          verdict,
          already,
        } = yield* attempt.pipe(
          Effect.retry({
            while: (error) => error._tag === "GuardMovedError",
            times: GUARD_ATTEMPTS - 1,
          }),
          Effect.catchTag("GuardMovedError", () =>
            Effect.die(
              `capture channel: retention kept moving the chains this capture names (${GUARD_ATTEMPTS} attempts)`,
            ),
          ),
          withCaptureReadPass,
          Effect.provideService(BlobStore, blobs),
        );
        if (!outcome.lostAck) {
          for (const [key, bytes] of priced) ledger.set(key, bytes);
          yield* repo.recordPacks(records);
          const row = yield* repo.captureById(input.capture_id);
          if (row !== null) publish(row);
        }
        // A verdict that concluded nothing is not kept: the next ask checks again.
        if (unavailable !== null && job !== undefined) yield* dropSealJob(job);
        // The seal's outcome, as the store holds it now (cross-repo decision 22): the executor
        // answers its FINAL complete only on `recorded`. A lost-answer retry reads it anew.
        const sealAnswer =
          seal === null
            ? null
            : !sealHolds
              ? {
                  outcome: {
                    state: "refused",
                    reason: !seal.complete
                      ? "incomplete"
                      : seal.epoch !== input.epoch
                        ? "epoch"
                        : "executor",
                  } satisfies RegisterSealOutcome,
                  detail: `the seal is not this launch's completed final flush under epoch ${input.epoch}`,
                }
              : pendingSeal && !outcome.lostAck && job !== undefined
                ? yield* Effect.gen(function* () {
                    // Past the budget: registered without the seal, which is recorded once the
                    // checks pass. The executor's re-ask (this register again) reads it then.
                    if (job !== undefined) {
                      yield* recordWhenChecked(job, {
                        worktreeId,
                        epoch: input.epoch,
                        captureId: input.capture_id,
                        n: input.n,
                        manifestKey: input.manifest_key,
                        names: referenced,
                        seal: sealFields,
                      });
                    }
                    return verifyingAnswer;
                  })
                : already !== null || outcome.lostAck
                  ? yield* reAsked(input, manifest, chunked, referenced, remaining())
                  : unavailable !== null
                    ? unavailableAnswer(unavailable)
                    : yield* Effect.gen(function* () {
                        // Answered within the budget: the CAS carried the seal, or its problems
                        // kept it out. Re-asks read that.
                        if (job !== undefined && verdict !== null && Option.isSome(verdict)) {
                          yield* Deferred.succeed(job.settled, verdict.value);
                        }
                        return yield* registeredSealOutcome(
                          input.epoch,
                          input.capture_id,
                          sealProblem,
                        );
                      });
        if (sealAnswer !== null && sealAnswer.outcome.state !== "recorded") {
          yield* Effect.logInfo(`capture channel: final seal · ${sealAnswer.outcome.state}`).pipe(
            Effect.annotateLogs({
              worktreeId,
              n: input.n,
              captureId: input.capture_id,
              epoch: input.epoch,
              reason: sealAnswer.outcome.reason,
              detail: sealAnswer.detail,
            }),
          );
        }
        return {
          head_n: input.n,
          head_capture_id: input.capture_id,
          epoch: lease.epoch,
          ...(sealAnswer === null ? {} : { seal: sealAnswer.outcome }),
        };
      });

      /**
       * `registerOnce`, single-flight (e2e8 F2): a register identical to one still running — the
       * executor's retry of a register it timed out — joins it and gets its answer.
       */
      const register = (input: RegisterRequest) =>
        registersInFlight.run(sealKeyOf(input), input, registerOnce(input), (running) =>
          isDeepStrictEqual(running, input),
        );

      /**
       * How the seal of `captureId` under `epoch` stands for this launch now: `recorded` only when
       * the store holds it for that very capture and it stands (`sealStandingOf`).
       */
      const registeredSealOutcome = Effect.fn("SessionCaptureApi.registeredSealOutcome")(function* (
        epoch: number,
        captureId: string,
        problem: string | null,
      ) {
        const recorded = yield* repo.sealedCompletion(worktreeId, launchId, epoch);
        if (recorded === null || recorded.captureId !== captureId) {
          return problem === null
            ? {
                outcome: { state: "refused", reason: "not-recorded" } satisfies RegisterSealOutcome,
                detail: "not recorded when this capture registered",
              }
            : {
                outcome: { state: "refused", reason: "unrestorable" } satisfies RegisterSealOutcome,
                detail: `not observed restorable: ${problem}`,
              };
        }
        const standing = yield* sealStandingOf(recorded, Date.now).pipe(
          Effect.provideService(CaptureStoreRepo, repo),
          Effect.provideService(BlobStore, blobs),
        );
        return standing.state === "standing"
          ? { outcome: { state: "recorded" } satisfies RegisterSealOutcome, detail: null }
          : {
              outcome: {
                state: standing.state === "void" ? "refused" : "withheld",
                reason: standing.code,
              } satisfies RegisterSealOutcome,
              detail: standing.reason,
            };
      });

      const changeSummary = Effect.fn("SessionCaptureApi.changeSummary")(function* (
        input: ChangeSummaryRequest,
      ) {
        yield* requireWorktree(input.worktree_id);
        yield* requireLease(input.epoch);
        const summary = yield* decodeChangeSummary(input.summary).pipe(
          Effect.mapError((error) => bad(`summary: ${error.message}`)),
        );
        const capture = yield* repo.captureById(input.capture_id);
        if (capture === null || capture.worktreeId !== worktreeId) {
          return yield* new CaptureRouteError({
            status: 409,
            reason: "not-head",
            message: "the summary names a capture that never landed on this chain",
          });
        }
        const key = changeSummaryKey(worktreeId, capture.n);
        yield* blobs
          .put(key, new Uint8Array(Buffer.from(JSON.stringify(summary), "utf8")))
          .pipe(Effect.catch(storeError("writing the summary", key)));
        yield* repo.acceptSummary(worktreeId, input.capture_id, key).pipe(
          Effect.mapError(
            () =>
              new CaptureRouteError({
                status: 409,
                reason: "not-head",
                message: "summaries are accepted only for the chain head",
              }),
          ),
        );
        return { accepted: true as const, key };
      });

      const heartbeat = Effect.fn("SessionCaptureApi.heartbeat")(function* (
        input: HeartbeatRequest,
      ) {
        yield* requireWorktree(input.worktree_id);
        const renewed = yield* repo.heartbeat(worktreeId, input.epoch, undefined, holder);
        if (renewed) return { expires_in_secs: LEASE_EXPIRES_IN_SECS };
        const lease = yield* repo.leaseOf(worktreeId);
        // Another launch's lease: nothing of it is told (cross-repo decision 11).
        if (lease !== null && lease.executorId !== null && heldByAnother(lease)) {
          return yield* new CaptureRouteError({
            status: 404,
            reason: "lease-lost",
            message: "the worktree lease is not this executor's — stop shipping and pause",
          });
        }
        if (lease !== null && lease.epoch !== input.epoch) {
          return yield* new CaptureRouteError({
            status: 409,
            reason: "stale-epoch",
            message: `epoch ${input.epoch} is stale; the worktree is held under epoch ${lease.epoch}`,
            live_epoch: lease.epoch,
          });
        }
        // sealantd's registrar reads 404 on lease.heartbeat as "lease lost" (pause, never kill).
        return yield* new CaptureRouteError({
          status: 404,
          reason: "lease-lost",
          message: "no lease row renewed — stop shipping and pause",
        });
      });

      return { planGet, uploadUrls, uploadComplete, register, changeSummary, heartbeat };
    };

    return { apiFor, standbyApiFor, awaitRegister, publish };
  }),
);

// ─── Route dispatch (shared by both listeners) ──────────────────────────────

const decodeBody =
  <S extends Schema.Codec<unknown, unknown, never, unknown>>(schema: S) =>
  (body: unknown): Effect.Effect<S["Type"], CaptureRouteError> =>
    Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError((error) => bad(`request: ${error.message}`)),
    );

/** The fields of a registrar request worth a log line: never the manifest, never a URL. */
const asRequestSummary = (body: unknown): Record<string, string | number> => {
  if (typeof body !== "object" || body === null) return {};
  const record = body as Record<string, unknown>;
  const out: Record<string, string | number> = {};
  for (const key of ["worktree_id", "epoch", "n", "capture_id", "key", "upload_id"] as const) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") out[key] = value;
  }
  if (Array.isArray(record["keys"])) out["keys"] = record["keys"].length;
  if (Array.isArray(record["parts"])) out["parts"] = record["parts"].length;
  return out;
};

/** The POST route names, exactly as sealantd's `HttpRegistrar` appends them to the endpoint. */
export const CAPTURE_ROUTES = new Set([
  "/plan.get",
  "/upload.urls",
  "/upload.complete",
  "/capture.register",
  "/change.summary",
  "/lease.heartbeat",
]);

/**
 * Serve one capture route. `api` is undefined for a session whose deployment is not in capture
 * mode — the routes then answer 404, exactly like any unknown route.
 */
export const dispatchCaptureRoute = (
  api: SessionCaptureApi | undefined,
  pathname: string,
  body: unknown,
  respond: (status: number, payload: unknown) => void,
): Promise<void> => {
  if (api === undefined) {
    respond(404, { message: `unknown route: POST ${pathname}` });
    return Promise.resolve();
  }
  // One line per registrar call, so an operator can watch an executor claim, ship and register
  // from the API log alone (`POST /plan.get`, `POST /capture.register n=3 … 200`).
  const requested = asRequestSummary(body);
  const observed = (status: number, detail: string) =>
    Effect.logInfo("session channel: capture route").pipe(
      Effect.annotateLogs({ route: `POST ${pathname}`, ...requested, status, detail }),
    );
  const run = <A>(effect: Effect.Effect<A, CaptureRouteError>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.tap(() => observed(200, "ok")),
        Effect.map((value) => respond(200, value)),
        Effect.catchTag("CaptureRouteError", (error) =>
          observed(error.status, `${error.reason}: ${error.message}`).pipe(
            Effect.andThen(
              Effect.sync(() =>
                respond(error.status, {
                  reason: error.reason,
                  message: error.message,
                  ...(error.live_epoch === undefined ? {} : { live_epoch: error.live_epoch }),
                  ...(error.head_n === undefined ? {} : { head_n: error.head_n }),
                  ...(error.head_capture_id === undefined
                    ? {}
                    : { head_capture_id: error.head_capture_id }),
                  ...(error.missing === undefined ? {} : { missing: error.missing }),
                  ...(error.key === undefined ? {} : { key: error.key }),
                  ...(error.limit === undefined ? {} : { limit: error.limit }),
                  ...(error.used === undefined ? {} : { used: error.used }),
                  ...(error.requested === undefined ? {} : { requested: error.requested }),
                }),
              ),
            ),
          ),
        ),
      ),
    ).catch((error: unknown) => {
      respond(500, { message: error instanceof Error ? error.message : String(error) });
    });
  switch (pathname) {
    case "/plan.get":
      return run(decodeBody(PlanGetRequest)(body).pipe(Effect.flatMap(api.planGet)));
    case "/upload.urls":
      return run(decodeBody(UploadUrlsRequest)(body).pipe(Effect.flatMap(api.uploadUrls)));
    case "/upload.complete":
      return run(decodeBody(UploadCompleteRequest)(body).pipe(Effect.flatMap(api.uploadComplete)));
    case "/capture.register":
      return run(decodeBody(RegisterRequest)(body).pipe(Effect.flatMap(api.register)));
    case "/change.summary":
      return run(decodeBody(ChangeSummaryRequest)(body).pipe(Effect.flatMap(api.changeSummary)));
    case "/lease.heartbeat":
      return run(decodeBody(HeartbeatRequest)(body).pipe(Effect.flatMap(api.heartbeat)));
    default:
      respond(404, { message: `unknown route: POST ${pathname}` });
      return Promise.resolve();
  }
};

/** Largest capture-route body: a manifest lists every pack across epochs, so more than 64 KiB. */
export const MAX_CAPTURE_BODY_BYTES = 16 * 1024 * 1024;
