import { isDeepStrictEqual } from "node:util";

import {
  type CaptureConflictError,
  CaptureStoreRepo,
  type CaptureRow,
  type PackRecord,
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
  gitSectionHoldsRawNames,
  restoreNamespaceProblem,
  inodeMetadataProblem,
  crossLinksProblem,
  linkTopologyProblem,
  rawTreeOf,
  type RestoreTreePath,
  gitSectionHoldsTrees,
  type WorktreeMetaDocument,
} from "@mend/store";
import { Duration, Effect, Layer, Option, Result, Schema } from "effect";
import * as Context from "effect/Context";

import { CaptureRemotes, type PlanRemote } from "./capture-remotes.ts";
import { sealStandingOf } from "./capture-seals.ts";
import { CaptureSources, type PlanSource } from "./capture-sources.ts";
import { CaptureGitVerifier } from "./capture-verify.ts";

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
 */
export const MANIFEST_FEATURES = [
  "worktree_meta",
  "symrefs",
  "other_bulk",
  "raw_names",
  "final_seal",
  "git_trees",
  "object_format",
] as const;
export type ManifestFeature = (typeof MANIFEST_FEATURES)[number];

/**
 * The features a plan's head holds that the executor did not say it reads. `stored` is the head
 * as registered, `planned` as this executor would restore it; the dir objects are walked for raw
 * names only when the executor does not read them.
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
    if (!reads.has("raw_names")) {
      const bulk = planned.sections.bulk;
      const raw =
        gitSectionHoldsRawNames(planned.sections.git) ||
        (yield* sectionHoldsRawNames(planned.sections.workspace)) ||
        (bulk !== "pending" && (yield* sectionHoldsRawNames(bulk)));
      holds("raw_names", raw);
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
});
export type RegisterRequest = typeof RegisterRequest.Type;

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
 *   back) or `verifying` (its objects could not be read back). Registering the same capture again
 *   (idempotent) answers it anew;
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
    | "incomplete"
    | "epoch"
    | "executor"
    | "unrestorable"
    | "not-recorded"
    | "void";
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
 * usable there: an S3 URL expires at its signing time plus its TTL by the bucket's clock.
 */
export const PUT_URL_CLOCK_MARGIN_SECONDS = 5 * 60;
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
 * Byte quota: `max(floor, 4× the project's compressed footprint)` per session, priced once per
 * object key. `upload.urls` is the enforcement point — a batch whose declared sizes would take
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
/** Heartbeat expiry the executor is told (ADR-0002: heartbeat every 10 s against 30 s). */
export const LEASE_EXPIRES_IN_SECS = 30;
/**
 * The lease Mend claims at launch must outlive the executor's boot (cold materialise ≈ 25–55 s,
 * ADR-0002 "Consequences"); the first heartbeat brings it back to the 30 s cadence.
 */
export const LAUNCH_CLAIM_TTL_SECONDS = 5 * 60;

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

export interface CaptureScope {
  readonly worktreeId: WorktreeId;
  readonly projectId: ProjectId;
  /**
   * The executor is being drained, kept or recovered (the session has a drain under way): its
   * `upload.urls` calls are not metered — it is saving what only it holds.
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
    const noteUploadAnswers = (launch: string, input: PlanGetRequest) => {
      if (readsPresent.size > MINTED_KEYS_REMEMBERED) readsPresent.clear();
      readsPresent.set(launch, (input.upload_answers ?? []).includes(UPLOAD_ANSWER_PRESENT));
    };
    /**
     * The byte ledger, per session: object key → bytes priced for it, once. `upload.urls`
     * reserves a sized key at its declared size; `capture.register` prices every pack under the
     * caller's epoch at the size the bucket reports, replacing a reservation. A key never
     * counts twice, whatever the manifests that list it.
     */
    const ledgers = new Map<string, Map<string, number>>();
    const ledgerOf = (executorId: string): Map<string, number> => {
      const found = ledgers.get(executorId);
      if (found !== undefined) return found;
      const fresh = new Map<string, number>();
      ledgers.set(executorId, fresh);
      return fresh;
    };

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
      const ledger = ledgerOf(scope.executorId);
      const overByteQuota = (status: 409 | 413, used: number, requested: number) =>
        new CaptureRouteError({
          status,
          reason: "byte-quota",
          message: `byte quota: ${byteBudget} bytes per session (${used} priced, ${requested} more asked)`,
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

      /** Verify a row's git section now and record the outcome; `unverified` records nothing. */
      const verifyRow = (row: CaptureRow, manifest: CaptureManifest) =>
        Effect.gen(function* () {
          const verification = yield* verifier.verify(scope.projectId, manifest);
          if (verification.outcome === "unverified") return row.gitFsck;
          yield* repo.setGitFsck(row.id, verification.outcome);
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
          return verification.outcome;
        });

      /**
       * The manifest a plan restores: the head's, unless its git section fails verification —
       * then the head with the git section of the newest capture below it that verifies
       * (ADR-0002 16: pickup prefers the newest verified capture; the chain head is unchanged,
       * so the executor's next register still parents on the real head). A head still
       * `unverified` (an `auto` capture, or one registered before this check existed) is
       * verified here, once, at the moment it matters.
       */
      const planManifest = (head: CaptureRow, stored: CaptureManifest) =>
        Effect.gen(function* () {
          const headFsck =
            head.gitFsck === "unverified" ? yield* verifyRow(head, stored) : head.gitFsck;
          if (headFsck !== "failed") return stored;
          const older = (yield* repo.listChain(worktreeId))
            .filter((row) => row.n < head.n)
            .toSorted((a, b) => b.n - a.n);
          for (const row of older) {
            if (row.gitFsck === "failed") continue;
            const manifest = yield* readManifest(row);
            const fsck =
              row.gitFsck === "unverified" ? yield* verifyRow(row, manifest) : row.gitFsck;
            if (fsck !== "verified") continue;
            yield* Effect.logWarning(
              "capture channel: plan restores an older git section · the head's failed verification",
            ).pipe(
              Effect.annotateLogs({
                worktreeId,
                headN: head.n,
                headCaptureId: head.id,
                gitFromN: row.n,
                gitFromCaptureId: row.id,
              }),
            );
            // The head's seal says the head restores; this plan restores other git state, so
            // it carries no seal (review 2026-09-28 (3) #18).
            const { final_seal: _headSeal, ...unsealed } = stored;
            return {
              ...unsealed,
              sections: { ...stored.sections, git: manifest.sections.git },
            } satisfies CaptureManifest;
          }
          yield* Effect.logWarning(
            "capture channel: no capture below the head verifies · the plan restores the head as registered",
          ).pipe(Effect.annotateLogs({ worktreeId, headN: head.n, headCaptureId: head.id }));
          return stored;
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
        const manifest =
          head === null || stored === null
            ? null
            : yield* planSealStanding(
                head,
                planForPlatform(yield* planManifest(head, stored), input.platform),
              );
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
      const reserveCall = (keys: ReadonlyArray<string>): boolean => {
        if (scope.unmetered === true) return true;
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
        if (!reserveCall(input.keys)) {
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
        const present: Array<string> = [];
        /** Stored keys answered with a legacy URL: verified, and never priced again. */
        const storedLegacy = new Set<string>();
        const verifyStored = (key: string) =>
          Effect.gen(function* () {
            const problem = yield* storedObjectProblem(key).pipe(
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
        const plans: Array<{
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
          return yield* overByteQuota(413, used, requested);
        }
        for (const [key, size] of unpriced) ledger.set(key, size);
        // Write authority is recorded before it leaves Mend (review 2026-09-28 (7) #8): on a
        // bucket that ignores `If-None-Match` a URL handed out now could replace an object of
        // this epoch until it expires, and no seal of the epoch stands before then
        // (`CaptureSealsStoreLive`). The bucket judges expiry by its own clock: allowed a margin.
        if (plans.length > 0) {
          yield* repo.recordPutAuthority(
            worktreeId,
            input.epoch,
            new Date(Date.now() + (PRESIGN_TTL_SECONDS + PUT_URL_CLOCK_MARGIN_SECONDS) * 1000),
          );
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
            storedLegacy.add(plan.key);
            urls[plan.key] = yield* blobs
              .presign(plan.key, "PUT", PRESIGN_TTL_SECONDS, plan.size ?? undefined)
              .pipe(Effect.catch(storeError("presigning a PUT", plan.key)));
            continue;
          }
          if (created === null) {
            // Below the threshold: one PUT URL, write-once (`If-None-Match: *` signed in). A
            // declared size is signed into the URL: the bucket takes those bytes or none.
            urls[plan.key] = yield* blobs
              .presign(plan.key, "PUT", PRESIGN_TTL_SECONDS, plan.size ?? undefined)
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
                .presignPart(plan.key, created.uploadId, partNumber, PRESIGN_TTL_SECONDS, partBytes)
                .pipe(Effect.catch(storeError("presigning a part", plan.key))),
            );
          }
          multipart[plan.key] = {
            upload_id: created.uploadId,
            part_size: policy.partSizeBytes,
            part_urls: partUrls,
          };
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

      const register = Effect.fn("SessionCaptureApi.register")(function* (input: RegisterRequest) {
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
            return yield* overByteQuota(409, used, newBytes);
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
          // A seal says every section restores (review 2026-09-28 (4) #13): the chunk bytes
          // themselves, not only the indexes naming them — every chunk of every pack the chunked
          // sections list decompresses and hashes to what it names. A pack that does not is
          // kept (its bytes may still be salvaged) and registered; nothing is sealed on it.
          const payloads = !sealHolds
            ? null
            : yield* verifyPackPayloads(chunked.flatMap((section) => section.packs)).pipe(
                Effect.provideService(BlobStore, blobs),
                Effect.result,
              );
          if (payloads !== null && Result.isFailure(payloads)) {
            const error = payloads.failure;
            yield* Effect.logWarning(
              "capture channel: a final seal over a pack whose chunks do not read · registered without it",
            ).pipe(
              Effect.annotateLogs({
                worktreeId,
                n: input.n,
                captureId: input.capture_id,
                epoch: input.epoch,
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
          }
          const payloadsRead = payloads !== null && Result.isSuccess(payloads);
          // A seal says every class is captured (review 2026-09-28 (5) #10): a manifest whose bulk
          // class is still `"pending"` names work it does not hold. A class captured empty is a
          // ready section naming nothing, never pending.
          const bulkCaptured = manifest.sections.bulk !== "pending";
          // …and that the worktree metadata's cross-class hardlinks restore as declared (review
          // 2026-09-28 (5) #11): every member a file of its class, a group's members one set of
          // bytes. sealantd's apply leaves a missing or differing member unlinked without a word.
          const crossLinks =
            !sealHolds || metaDocument === null
              ? null
              : yield* crossLinksProblem(manifest, metaDocument).pipe(
                  Effect.provideService(BlobStore, blobs),
                );
          // …and that the tracked side's links restore too (review 2026-09-28 (6) #10): every
          // `hardlinks` group one blob of the tree the restore checks out, every `shared` link a
          // tracked file of that tree and a file of its class holding that blob's bytes. A tree
          // Mend could not list seals nothing.
          const trackedLinks = yield* Effect.gen(function* () {
            if (!sealHolds || metaDocument === null) return null;
            if (
              (metaDocument.hardlinks ?? []).length === 0 &&
              (metaDocument.shared ?? []).length === 0
            ) {
              return null;
            }
            if (restoreTree === null) return "the tree a restore checks out was not listed";
            return yield* linkTopologyProblem(manifest, metaDocument, restoreTree).pipe(
              Effect.provideService(BlobStore, blobs),
            );
          });
          // …and that every inode those links make is promised one mode and one mtime (review
          // 2026-09-28 (7) #10): the restore settles each entry on the shared inode in turn, so
          // of two differing promises only the last survives — the class entries a link names
          // promise the inode too (review 2026-09-28 (8) #9). Healthy captures stat one inode
          // for all its names; one that raced a writer is registered, and seals nothing.
          const inodeMeta =
            !sealHolds || metaDocument === null
              ? null
              : yield* inodeMetadataProblem(manifest, metaDocument).pipe(
                  Effect.provideService(BlobStore, blobs),
                );
          const sealed =
            sealHolds &&
            gitFsck === "verified" &&
            metaNamespace === "verified" &&
            payloadsRead &&
            bulkCaptured &&
            crossLinks === null &&
            trackedLinks === null &&
            inodeMeta === null;
          const sealProblem =
            !sealHolds || sealed
              ? null
              : [
                  gitFsck === "verified" ? null : `git section ${gitFsck}`,
                  metaNamespace === "verified" ? null : `worktree metadata ${metaNamespace}`,
                  payloadsRead ? null : "chunk payloads not read",
                  bulkCaptured ? null : "bulk class pending",
                  crossLinks === null ? null : `cross-class links: ${crossLinks}`,
                  trackedLinks === null ? null : `tracked links: ${trackedLinks}`,
                  inodeMeta === null ? null : `inode metadata: ${inodeMeta}`,
                ]
                  .filter((problem) => problem !== null)
                  .join("; ");
          if (sealHolds && !sealed) {
            yield* Effect.logWarning(
              "capture channel: a final seal over sections not verified restorable · registered without it",
            ).pipe(
              Effect.annotateLogs({
                worktreeId,
                n: input.n,
                captureId: input.capture_id,
                epoch: input.epoch,
                gitFsck,
                worktreeMeta: metaNamespace,
                chunkPayloads: payloadsRead ? "read" : "not read",
                bulk: bulkCaptured ? "captured" : "pending",
                crossLinks: crossLinks ?? "restore",
                trackedLinks: trackedLinks ?? "restore",
                inodeMetadata: inodeMeta ?? "one promise per inode",
              }),
            );
          }
          const outcome = yield* repo
            .register({
              ...(sealed
                ? {
                    seal: {
                      executorId: launchId,
                      holder: scope.executorId,
                      bootId: seal?.boot_id ?? null,
                      bootGeneration: seal?.boot_generation ?? null,
                      observation: seal?.observation ?? null,
                    },
                  }
                : {}),
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
          return { outcome, priced, records, sealProblem };
        });
        const { outcome, priced, records, sealProblem } = yield* attempt.pipe(
          Effect.retry({
            while: (error) => error._tag === "GuardMovedError",
            times: GUARD_ATTEMPTS - 1,
          }),
          Effect.catchTag("GuardMovedError", () =>
            Effect.die(
              `capture channel: retention kept moving the chains this capture names (${GUARD_ATTEMPTS} attempts)`,
            ),
          ),
        );
        if (!outcome.lostAck) {
          for (const [key, bytes] of priced) ledger.set(key, bytes);
          yield* repo.recordPacks(records);
          const row = yield* repo.captureById(input.capture_id);
          if (row !== null) publish(row);
        }
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
              : yield* registeredSealOutcome(input.epoch, input.capture_id, sealProblem);
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
