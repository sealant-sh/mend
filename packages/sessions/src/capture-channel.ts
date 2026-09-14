import {
  type CaptureConflictError,
  CaptureStoreRepo,
  type CaptureRow,
  type PackRecord,
} from "@mend/db";
import type { ProjectId, WorktreeId } from "@mend/domain";
import {
  BlobStore,
  type CaptureManifest,
  changeSummaryKey,
  decodeChangeSummary,
  decodeManifest,
  captureIdOf,
  isCaptureObjectKey,
  keysNeededBy,
  packIdxKeyOf,
} from "@mend/store";
import { Duration, Effect, Layer, Option, Schema } from "effect";
import * as Context from "effect/Context";

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
 * fields; a 409 body carries `reason` and, where it helps the executor decide, `live_epoch` or
 * the head it collided with). The manifest and the summary travel over this channel; bulk bytes
 * never do — they go straight to the bucket through presigned URLs minted here.
 */

// ─── Wire types ─────────────────────────────────────────────────────────────

export const PlanGetRequest = Schema.Struct({
  worktree_id: Schema.optional(Schema.NullOr(Schema.String)),
  /** 0 = "not claimed yet": the first plan of a booting executor claims the lease. */
  epoch: Schema.optional(Schema.Int),
  /**
   * The executor's `<os>-<arch>-<libc>` (sealantd follow-up, PLATFORM-FEEDBACK.md 2026-09-13).
   * When named and different from the head's bulk platform, the answer's bulk section is
   * `"pending"` and its packs are not presigned: the executor must not restore a dependency
   * tree built for another platform (decision 2); the engine runs the install command instead.
   * Absent = the whole head, unchanged (today's sealantd).
   */
  platform: Schema.optional(Schema.String),
});
export type PlanGetRequest = typeof PlanGetRequest.Type;

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
 * as multipart is present in `multipart` and absent from `urls`. A sized key the bucket already
 * holds is answered in `urls` like any other: the executor's single-PUT path is its own
 * already-present check, and the wire has no third answer (sealantd reads `multipart` as
 * plans only).
 */
export interface UploadUrlsResponse {
  readonly urls: Readonly<Record<string, string>>;
  readonly multipart: Readonly<Record<string, MultipartPlan>>;
}

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

/** Refusal reasons; the executor pauses on every 409 and never kills. */
export const CaptureRefusalReason = Schema.Literals([
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
  "exists",
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
  },
) {}

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
  readonly register: (
    input: RegisterRequest,
  ) => Effect.Effect<
    { readonly head_n: number; readonly head_capture_id: string },
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
 * Request quota: `upload.urls` CALLS per session per rolling hour, and keys per call. Calls are
 * what cost the registrar (a presign is a local signature; the bucket is never asked); keys are
 * content-addressed dir objects and packs, tiny and many — the first bulk capture of a
 * Mend-size repository is 20,495 dir objects for 134,741 files (observed 2026-09-14), which
 * the daemon ships in batches of 500 keys per call. Counting keys, as the 2,000-URL quota did,
 * only ever punished a big tree; what a session can write is bounded by bytes at register.
 */
export const UPLOAD_CALLS_PER_HOUR = 600;
export const UPLOAD_KEYS_PER_CALL = 1_000;
/** Byte quota multiplier over the project's compressed footprint, with a floor. */
export const BYTE_QUOTA_MULTIPLIER = 4;
export const BYTE_QUOTA_FLOOR = 512 * 1024 * 1024;
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
 * above it — and how many calls a session may make per rolling hour, of how many keys each. A
 * test provides small numbers against the directory store; production reads the environment
 * for the sizes and the constants for the request quota.
 */
export class CaptureUploadPolicy extends Context.Service<
  CaptureUploadPolicy,
  {
    readonly multipartThresholdBytes: number;
    readonly partSizeBytes: number;
    readonly callsPerHour: number;
    readonly keysPerCall: number;
  }
>()("@mend/sessions/CaptureUploadPolicy") {}

export const CaptureUploadPolicyDefault: Layer.Layer<CaptureUploadPolicy> = Layer.succeed(
  CaptureUploadPolicy,
  {
    multipartThresholdBytes: MULTIPART_THRESHOLD_BYTES,
    partSizeBytes: MULTIPART_PART_SIZE_BYTES,
    callsPerHour: UPLOAD_CALLS_PER_HOUR,
    keysPerCall: UPLOAD_KEYS_PER_CALL,
  },
);

export class CaptureUploadPolicyError extends Error {
  override readonly name = "CaptureUploadPolicyError";
}

export interface CaptureUploadPolicyEnvLike {
  readonly MEND_CAPTURE_MULTIPART_THRESHOLD?: string | undefined;
  readonly MEND_CAPTURE_MULTIPART_PART_SIZE?: string | undefined;
}

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
 * `MEND_CAPTURE_MULTIPART_THRESHOLD` (bytes, default 16 MiB) and
 * `MEND_CAPTURE_MULTIPART_PART_SIZE` (bytes, default 16 MiB, at least 5 MiB for S3 and R2).
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
  };
};

export const CaptureUploadPolicyLive: Layer.Layer<CaptureUploadPolicy> = Layer.effect(
  CaptureUploadPolicy,
  Effect.sync(() => resolveCaptureUploadPolicy(process.env)),
);

export interface CaptureScope {
  readonly worktreeId: WorktreeId;
  readonly projectId: ProjectId;
  /** Who a claim is recorded for — the session whose executor this is. */
  readonly executorId: string;
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

/** The head as this executor may restore it: its bulk section only for its own platform. */
export const planForPlatform = (
  manifest: CaptureManifest,
  platform: string | undefined,
): CaptureManifest =>
  platform === undefined ||
  manifest.sections.bulk === "pending" ||
  manifest.sections.bulk.platform === platform
    ? manifest
    : { ...manifest, sections: { ...manifest.sections, bulk: "pending" } };

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

export const CaptureChannelLive: Layer.Layer<
  CaptureChannel,
  never,
  CaptureStoreRepo | BlobStore | CaptureUploadPolicy | CaptureGitVerifier
> = Layer.effect(
  CaptureChannel,
  Effect.gen(function* () {
    const repo = yield* CaptureStoreRepo;
    const blobs = yield* BlobStore;
    const policy = yield* CaptureUploadPolicy;
    const verifier = yield* CaptureGitVerifier;
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

    /** Per-session rolling counters; a Mend restart forgets them, which only ever relaxes. */
    const urlLog = new Map<string, Array<number>>();
    const bytesUsed = new Map<string, number>();

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
        const plan = yield* scope
          .plan(input.platform)
          .pipe(Effect.catch(() => storeError("preparing the standby plan")({ _tag: "plan" })));
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
      /** The one prefix this executor may write under: its worktree's, at the caller's epoch. */
      const underOwnPrefix = (key: string, epoch: number) =>
        key.startsWith(`captures/${worktreeId}/${epoch}/`);
      const underOwnWorktree = (key: string) => key.startsWith(`captures/${worktreeId}/`);
      const byteBudget = Math.max(
        BYTE_QUOTA_FLOOR,
        BYTE_QUOTA_MULTIPLIER * Math.max(0, scope.footprintBytes),
      );
      /** The lease predicate: live and under the caller's epoch, else the 409 the caller needs. */
      const requireLease = (epoch: number) =>
        Effect.gen(function* () {
          const lease = yield* repo.leaseOf(worktreeId);
          if (lease === null || !lease.live) {
            return yield* new CaptureRouteError({
              status: 409,
              reason: "lease-lost",
              message: "the worktree lease is not live — stop shipping and pause",
              ...(lease === null || lease.epoch === epoch ? {} : { live_epoch: lease.epoch }),
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
            return {
              ...stored,
              sections: { ...stored.sections, git: manifest.sections.git },
            } satisfies CaptureManifest;
          }
          yield* Effect.logWarning(
            "capture channel: no capture below the head verifies · the plan restores the head as registered",
          ).pipe(Effect.annotateLogs({ worktreeId, headN: head.n, headCaptureId: head.id }));
          return stored;
        });

      const planGet = Effect.fn("SessionCaptureApi.planGet")(function* (input: PlanGetRequest) {
        yield* requireWorktree(input.worktree_id);
        const asked = input.epoch ?? 0;
        const lease = yield* repo.leaseOf(worktreeId);
        let epoch: number;
        if (lease !== null && lease.live && (asked === 0 || asked === lease.epoch)) {
          if (asked === 0 && lease.executorId !== scope.executorId) {
            // Another executor holds it: a second executor for a leased worktree is refused
            // (ADR-0002 "Decisions made here" 9); joins run inside the holder.
            return yield* new CaptureRouteError({
              status: 409,
              reason: "worktree-leased",
              message: "another executor holds this worktree's lease",
              live_epoch: lease.epoch,
            });
          }
          epoch = lease.epoch;
        } else if (lease !== null && lease.live) {
          return yield* new CaptureRouteError({
            status: 409,
            reason: "stale-epoch",
            message: `epoch ${asked} is stale; the worktree is held under epoch ${lease.epoch}`,
            live_epoch: lease.epoch,
          });
        } else {
          // Not held: this plan is the claim (start, pickup, replacement — one path).
          const claimed = yield* repo.claim(worktreeId, scope.executorId).pipe(
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
        const chain = yield* repo.headOf(worktreeId);
        const head = chain?.head ?? null;
        if (head === null) {
          return { worktree_id: worktreeId, epoch, head: null, get_urls: {} };
        }
        const stored = yield* readManifest(head);
        const manifest = planForPlatform(yield* planManifest(head, stored), input.platform);
        const keys = yield* keysNeededBy(manifest).pipe(
          Effect.provideService(BlobStore, blobs),
          Effect.catch(storeError("walking the head capture", head.manifestKey)),
        );
        const urls: Record<string, string> = {};
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
        } satisfies PlanGetResponse;
      });

      /** Count this call against the rolling hour; false = over quota (nothing minted, not counted). */
      const reserveCall = (): boolean => {
        const now = Date.now();
        const window = (urlLog.get(scope.executorId) ?? []).filter(
          (at) => now - at < 60 * 60 * 1000,
        );
        if (window.length >= policy.callsPerHour) {
          urlLog.set(scope.executorId, window);
          return false;
        }
        window.push(now);
        urlLog.set(scope.executorId, window);
        return true;
      };

      const uploadUrls = Effect.fn("SessionCaptureApi.uploadUrls")(function* (
        input: UploadUrlsRequest,
      ) {
        yield* requireWorktree(input.worktree_id);
        yield* requireLease(input.epoch);
        // The request quota bounds calls, not keys: a call may carry up to `keysPerCall` keys
        // (the daemon batches 500), and a session gets `callsPerHour` calls. Bytes are bounded
        // at register, where the packs a capture adds are priced against the footprint.
        if (input.keys.length > policy.keysPerCall) {
          return yield* bad(
            `${input.keys.length} keys in one call; the cap is ${policy.keysPerCall} per upload.urls call`,
          );
        }
        if (!reserveCall()) {
          return yield* new CaptureRouteError({
            status: 429,
            reason: "quota-exceeded",
            message: `request quota: ${policy.callsPerHour} upload.urls calls per hour per session`,
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
        const plans: Array<{ readonly key: string; readonly parts: number }> = [];
        for (const [key, size] of wanted) {
          if (size === null || size < policy.multipartThresholdBytes) {
            plans.push({ key, parts: 0 });
            continue;
          }
          const parts = Math.ceil(size / policy.partSizeBytes);
          if (parts > MULTIPART_MAX_PARTS) {
            return yield* bad(
              `${key}: ${size} bytes is ${parts} parts of ${policy.partSizeBytes}; the cap is ${MULTIPART_MAX_PARTS}`,
            );
          }
          plans.push({ key, parts });
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
          if (created === null || created.kind === "exists") {
            // Below the threshold, or the bucket already holds the key: one PUT URL. For an
            // existing key the PUT carries the same bytes by construction; no plan is opened.
            urls[plan.key] = yield* blobs
              .presign(plan.key, "PUT", PRESIGN_TTL_SECONDS)
              .pipe(Effect.catch(storeError("presigning a PUT", plan.key)));
            continue;
          }
          const partUrls: Array<string> = [];
          for (let partNumber = 1; partNumber <= plan.parts; partNumber += 1) {
            partUrls.push(
              yield* blobs
                .presignPart(plan.key, created.uploadId, partNumber, PRESIGN_TTL_SECONDS)
                .pipe(Effect.catch(storeError("presigning a part", plan.key))),
            );
          }
          multipart[plan.key] = {
            upload_id: created.uploadId,
            part_size: policy.partSizeBytes,
            part_urls: partUrls,
          };
        }
        return { urls, multipart } satisfies UploadUrlsResponse;
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
        const manifest = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(Schema.Unknown)(input.manifest),
          catch: () => bad("manifest is not JSON"),
        }).pipe(
          Effect.flatMap((raw) =>
            decodeManifest(
              input.manifest_key,
              new Uint8Array(Buffer.from(JSON.stringify(raw), "utf8")),
            ).pipe(Effect.mapError((error) => bad(`manifest: ${error.reason}`))),
          ),
        );
        if (
          manifest.worktree_id !== worktreeId ||
          manifest.epoch !== input.epoch ||
          manifest.n !== input.n ||
          manifest.parent !== input.parent
        ) {
          return yield* bad("the manifest's identity fields disagree with the request");
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
        // Every key the manifest names must be one capture object — a pack, its index, a dir
        // object root — before anything below asks the bucket about it: a prefix, an empty
        // entry or a stray word in a packs list is refused here, never HEAD-ed. A pending bulk
        // section names nothing and needs nothing.
        const bulkPacks = manifest.sections.bulk === "pending" ? [] : manifest.sections.bulk.packs;
        const roots = [
          manifest.sections.workspace.root,
          ...(manifest.sections.bulk === "pending" ? [] : [manifest.sections.bulk.root]),
        ].filter((root) => root !== "");
        const malformed = [
          ...manifest.sections.git.packs,
          ...manifest.sections.workspace.packs,
          ...bulkPacks,
          ...roots,
        ].filter((key) => !isCaptureObjectKey(key));
        if (malformed.length > 0) {
          return yield* bad(
            `the manifest names ${malformed.length} key(s) that are not capture objects (…/packs/<sha256>, …/trees/<sha256>): ${malformed
              .slice(0, 3)
              .map((key) => JSON.stringify(key))
              .join(", ")}`,
          );
        }
        // HEAD every pack the manifest names (across epochs) before the CAS, and price the
        // ones new to this epoch against the session's byte budget.
        const packKeys: Array<{ readonly key: string; readonly cls: PackRecord["class"] }> = [
          ...manifest.sections.git.packs.flatMap((key) => [
            { key, cls: "git" as const },
            { key: packIdxKeyOf(key), cls: "git" as const },
          ]),
          ...manifest.sections.workspace.packs.map((key) => ({ key, cls: "workspace" as const })),
          ...bulkPacks.map((key) => ({ key, cls: "bulk" as const })),
        ];
        const missing: Array<string> = [];
        const records: Array<PackRecord> = [];
        let newBytes = 0;
        for (const { key, cls } of packKeys) {
          const head = yield* blobs.head(key).pipe(Effect.catch(storeError("HEAD on a pack", key)));
          if (head === null) {
            missing.push(key);
            continue;
          }
          if (key.endsWith(".idx")) continue;
          if (underOwnPrefix(key, input.epoch)) newBytes += head.size;
          records.push({
            key,
            class: cls,
            bytes: head.size,
            worktreeId: underOwnWorktree(key) ? worktreeId : null,
            epoch: underOwnPrefix(key, input.epoch) ? input.epoch : null,
            platform:
              cls === "bulk" && manifest.sections.bulk !== "pending"
                ? manifest.sections.bulk.platform
                : null,
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
        const used = bytesUsed.get(scope.executorId) ?? 0;
        if (already === null && used + newBytes > byteBudget) {
          return yield* new CaptureRouteError({
            status: 413,
            reason: "quota-exceeded",
            message: `byte quota: ${byteBudget} bytes per session (${used} used)`,
          });
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
        const outcome = yield* repo
          .register({
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
          })
          .pipe(Effect.catch((error) => conflictToRoute(error).pipe(Effect.flatMap(Effect.fail))));
        if (!outcome.lostAck) {
          bytesUsed.set(scope.executorId, used + newBytes);
          yield* repo.recordPacks(records);
          const row = yield* repo.captureById(input.capture_id);
          if (row !== null) publish(row);
        }
        return { head_n: input.n, head_capture_id: input.capture_id, epoch: lease.epoch };
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
        const renewed = yield* repo.heartbeat(worktreeId, input.epoch);
        if (renewed) return { expires_in_secs: LEASE_EXPIRES_IN_SECS };
        const lease = yield* repo.leaseOf(worktreeId);
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
