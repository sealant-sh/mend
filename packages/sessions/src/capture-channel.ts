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
  isValidBlobKey,
  keysNeededBy,
  packIdxKeyOf,
} from "@mend/store";
import { Duration, Effect, Layer, Option, Schema } from "effect";
import * as Context from "effect/Context";

/**
 * The capture half of the session channel (ADR-0002 "Session channel routes"): sealantd's
 * `Registrar` port as five POST routes — `plan.get`, `upload.urls`, `capture.register`,
 * `change.summary`, `lease.heartbeat` — each carrying the caller's `epoch`. Authentication is
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

export const UploadUrlsRequest = Schema.Struct({
  worktree_id: Schema.String,
  epoch: Schema.Int,
  keys: Schema.Array(Schema.String),
});
export type UploadUrlsRequest = typeof UploadUrlsRequest.Type;

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
  },
) {}

/** What the network host serves for one session once the engine registers it. */
export interface SessionCaptureApi {
  readonly planGet: (input: PlanGetRequest) => Effect.Effect<PlanGetResponse, CaptureRouteError>;
  readonly uploadUrls: (
    input: UploadUrlsRequest,
  ) => Effect.Effect<{ readonly urls: Readonly<Record<string, string>> }, CaptureRouteError>;
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
/** URL quota per session per rolling hour. */
export const URL_QUOTA_PER_HOUR = 2_000;
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

export interface CaptureScope {
  readonly worktreeId: WorktreeId;
  readonly projectId: ProjectId;
  /** Who a claim is recorded for — the session whose executor this is. */
  readonly executorId: string;
  /** The project's compressed footprint in bytes (its base git packs); 0 = unknown, floor applies. */
  readonly footprintBytes: number;
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

/** A bucket or pointer-store failure inside a route is a defect: 500, which the executor retries. */
const storeError = (operation: string) => (cause: { readonly _tag: string }) =>
  Effect.die(`capture channel: ${operation} failed: ${cause._tag}`);

export const CaptureChannelLive: Layer.Layer<CaptureChannel, never, CaptureStoreRepo | BlobStore> =
  Layer.effect(
    CaptureChannel,
    Effect.gen(function* () {
      const repo = yield* CaptureStoreRepo;
      const blobs = yield* BlobStore;
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

      const apiFor = (scope: CaptureScope): SessionCaptureApi => {
        const worktreeId = scope.worktreeId;
        const prefixFor = (epoch: number) => `captures/${worktreeId}/${epoch}/`;
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
          const manifestBytes = yield* blobs
            .get(head.manifestKey)
            .pipe(Effect.catch(storeError("reading the head manifest")));
          const manifest = yield* decodeManifest(head.manifestKey, manifestBytes).pipe(
            Effect.catch(storeError("decoding the head manifest")),
          );
          const keys = yield* keysNeededBy(manifest).pipe(
            Effect.provideService(BlobStore, blobs),
            Effect.catch(storeError("walking the head capture")),
          );
          const urls: Record<string, string> = {};
          for (const key of [...keys, head.manifestKey]) {
            urls[key] = yield* blobs
              .presign(key, "GET", PRESIGN_TTL_SECONDS)
              .pipe(Effect.catch(storeError("presigning a GET")));
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

        const uploadUrls = Effect.fn("SessionCaptureApi.uploadUrls")(function* (
          input: UploadUrlsRequest,
        ) {
          yield* requireWorktree(input.worktree_id);
          yield* requireLease(input.epoch);
          const prefix = prefixFor(input.epoch);
          // Only under the caller's own epoch prefix; anything else is dropped, never minted.
          const keys = [...new Set(input.keys)].filter(
            (key) => key.startsWith(prefix) && isValidBlobKey(key),
          );
          const now = Date.now();
          const window = (urlLog.get(scope.executorId) ?? []).filter(
            (at) => now - at < 60 * 60 * 1000,
          );
          if (window.length + keys.length > URL_QUOTA_PER_HOUR) {
            urlLog.set(scope.executorId, window);
            return yield* new CaptureRouteError({
              status: 429,
              reason: "quota-exceeded",
              message: `URL quota: ${URL_QUOTA_PER_HOUR} per hour per session`,
            });
          }
          for (let index = 0; index < keys.length; index += 1) window.push(now);
          urlLog.set(scope.executorId, window);
          const urls: Record<string, string> = {};
          for (const key of keys) {
            urls[key] = yield* blobs
              .presign(key, "PUT", PRESIGN_TTL_SECONDS)
              .pipe(Effect.catch(storeError("presigning a PUT")));
          }
          return { urls };
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

        const register = Effect.fn("SessionCaptureApi.register")(function* (
          input: RegisterRequest,
        ) {
          yield* requireWorktree(input.worktree_id);
          const lease = yield* requireLease(input.epoch);
          const prefix = prefixFor(input.epoch);
          if (!input.manifest_key.startsWith(prefix) || !isValidBlobKey(input.manifest_key)) {
            return yield* bad("manifest_key must sit under the caller's epoch prefix");
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
                : storeError("reading the manifest")(error),
            ),
          );
          if (captureIdOf(stored) !== input.capture_id) {
            return yield* new CaptureRouteError({
              status: 422,
              reason: "capture-id-mismatch",
              message: "capture_id is not the sha256 of the manifest bytes at manifest_key",
            });
          }
          // HEAD every pack the manifest names (across epochs) before the CAS, and price the
          // ones new to this epoch against the session's byte budget.
          const packKeys: Array<{ readonly key: string; readonly cls: PackRecord["class"] }> = [
            ...manifest.sections.git.packs.flatMap((key) => [
              { key, cls: "git" as const },
              { key: packIdxKeyOf(key), cls: "git" as const },
            ]),
            ...manifest.sections.workspace.packs.map((key) => ({ key, cls: "workspace" as const })),
            ...(manifest.sections.bulk === "pending"
              ? []
              : manifest.sections.bulk.packs.map((key) => ({ key, cls: "bulk" as const }))),
          ];
          const missing: Array<string> = [];
          const records: Array<PackRecord> = [];
          let newBytes = 0;
          for (const { key, cls } of packKeys) {
            const head = yield* blobs.head(key).pipe(Effect.catch(storeError("HEAD on a pack")));
            if (head === null) {
              missing.push(key);
              continue;
            }
            if (key.endsWith(".idx")) continue;
            if (key.startsWith(prefix)) newBytes += head.size;
            records.push({
              key,
              class: cls,
              bytes: head.size,
              worktreeId: key.startsWith(`captures/${worktreeId}/`) ? worktreeId : null,
              epoch: key.startsWith(prefix) ? input.epoch : null,
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
              gitFsck: manifest.sections.git.fsck,
            })
            .pipe(
              Effect.catch((error) => conflictToRoute(error).pipe(Effect.flatMap(Effect.fail))),
            );
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
            .pipe(Effect.catch(storeError("writing the summary")));
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

        return { planGet, uploadUrls, register, changeSummary, heartbeat };
      };

      return { apiFor, awaitRegister, publish };
    }),
  );

// ─── Route dispatch (shared by both listeners) ──────────────────────────────

const decodeBody =
  <S extends Schema.Codec<unknown, unknown, never, unknown>>(schema: S) =>
  (body: unknown): Effect.Effect<S["Type"], CaptureRouteError> =>
    Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError((error) => bad(`request: ${error.message}`)),
    );

/** The POST route names, exactly as sealantd's `HttpRegistrar` appends them to the endpoint. */
export const CAPTURE_ROUTES = new Set([
  "/plan.get",
  "/upload.urls",
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
  const run = <A>(effect: Effect.Effect<A, CaptureRouteError>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.map((value) => respond(200, value)),
        Effect.catchTag("CaptureRouteError", (error) =>
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
            }),
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
