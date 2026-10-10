import type { WorkspaceImageOs } from "@mend/domain";
import type {
  WorkspaceBind,
  WorkspaceBindOptions,
  CreateOptions,
  InferenceContinueOptions,
  InferenceRespondOptions,
  InferenceResponse,
  InteractiveSession,
  Run,
  RunChanges,
  RunCommand,
  RunFileChange,
  RunOptions,
  TimelineEntry,
  Workspace,
  WorkspaceCaptureReplanned,
  WorkspaceCaptureStatus,
  WorkspaceExecResult,
  WorkspaceForward,
  WorkspaceCaptureOwnerMap,
  WorkspaceImageInspection,
  SealantFeatures,
} from "@sealant/sdk";
import { Sealant, SealantApiError, SealantError } from "@sealant/sdk";
import type { Harness, SealantConfig } from "@sealant/sdk";
import type { SshKey, WorkspaceSshInfo } from "@sealant/sdk";
import {
  archiveConnectedAccountOp,
  createConnectedAccountOp,
  createRunOp,
  createSshKeyOp,
  expireWorkspaceOp,
  getSessionOutputOp,
  getSetupStateOp,
  inferenceRespondOp,
  listConnectedAccountsOp,
  listSshKeysOp,
  listWorkspacesOp,
  resolveInternalConfig,
  SealantApiClient,
  sealantApiClientLayer,
} from "@sealant/sdk/effect";
import { Clock, type Config, Effect, Fiber, Layer, Option, Redacted, Scope, Stream } from "effect";
import * as Context from "effect/Context";

import { ConnectedAccount, type ConnectAccountInput } from "./accounts.ts";
import { SealantEnv } from "./config.ts";
import { SealantConnection } from "./connection.ts";
import { SealantPlatformError } from "./errors.ts";
import { SealantIdentityStore } from "./identity.ts";
import {
  type PersonExecOptions,
  type PersonSessionOptions,
  personProcessRefusal,
  withProcessUser,
} from "./person-layout.ts";
import { SealantPrincipal } from "./principal.ts";

export interface SessionOutputPage {
  readonly sessionId: string;
  readonly chunks: ReadonlyArray<{
    readonly sequence: string;
    readonly dataBase64: string;
  }>;
  readonly nextFrom: string;
  readonly status: "exited" | "failed" | "running" | "starting";
}

export interface WorkspacePackageResolution {
  readonly requested: string;
  readonly normalized: string;
  readonly status: "resolved" | "ambiguous" | "unsupported" | "not-found" | "invalid";
  readonly canonicalId: string | null;
  readonly supported: boolean;
  readonly packageName: string | null;
  readonly alternatives: ReadonlyArray<string>;
}

/**
 * The Sealant platform behind an Effect service contract, on SDK 0.5.0.
 *
 * Two publics surfaces back this layer, deliberately split:
 * - Flat request/response calls (connection check, inference, exec-by-id) run
 *   on the `@sealant/sdk/effect` core — typed contract errors, no Promise hop.
 * - The stateful object model (workspace handles, harness start, record
 *   streams / commands / transcript, `run.wait`) stays on the facade: its
 *   composition logic is not exported through `/effect` yet, and duplicating
 *   it here would be exactly the workaround PLATFORM-FEEDBACK.md forbids
 *   (see the 0.5.0 entry, "composition layer not exported").
 */
/**
 * Which `capture.flush` an executor is asked for: `suspend` (processes keep running) or `final`
 * (the executor is ending: quiesce, snapshot both classes, ship everything).
 */
export type CaptureFlushKind = "suspend" | "final";

/**
 * What a stop came to, as the platform observed it (Core's `WorkspaceStopResult`): `stopped` the
 * runtime is gone — the only termination; `draining` the platform is saving the executor's
 * captures before it removes the runtime; `kept` it keeps the runtime because they did not save;
 * `requested` the stop was accepted and nothing more is known. SDK 0.37.2's `stop()` resolves with
 * nothing, which reads `requested`.
 */
export type WorkspaceStopState = "stopped" | "draining" | "kept" | "requested";

/**
 * `discardUnsaved`: the owner's audited "discard unsaved and stop" — the platform ends the
 * workspace without draining its captures. SDK 0.37.2's `stop()` takes no options and drains
 * (Core keeps a workspace whose queue does not move), so until the SDK carries it the option is
 * sent and ignored, and the stop reads what the platform did (PLATFORM-FEEDBACK.md 2026-09-27,
 * "A stop that discards").
 */
export interface WorkspaceStopOptions {
  readonly discardUnsaved?: boolean;
  /**
   * The control plane's attestation that this executor's final flush completed: the store's
   * sealed record of it (`final_seal`), by chain position, lease epoch and the executor the seal
   * names. Core keeps a capture-sourced executor's disk unless it observed `complete: true`
   * itself, this attestation says so, or the owner discarded. SDK 0.37.2 takes no stop options:
   * it is sent and ignored there, and Core keeps what it cannot confirm (PLATFORM-FEEDBACK.md
   * 2026-09-28, "A stop that carries the completion").
   */
  readonly completion?: CaptureCompletionAttestation;
}

/**
 * A completed final flush as the store sealed it: what a stop carries to Core. `executorId` is
 * the executor's runtime identity as the platform reports it (`workspace.details().runtime
 * .resourceId`: the Docker container, the Pod, the MicroVM) — never the Sealant workspace id.
 */
export interface CaptureCompletionAttestation {
  readonly captureN: number;
  readonly epoch: number;
  readonly executorId: string;
  /**
   * The launch the seal names (`final_seal.executor`, cross-repo decision 5): Core ignores an
   * attestation whose launch is not the one the executor's create named (Core's next SDK).
   */
  readonly launchId?: string;
  /**
   * When the store recorded the seal (ISO 8601), by the database's clock: for display. It orders
   * nothing (cross-repo decision 17): `origin` does.
   */
  readonly sealedAt?: string;
  /**
   * Where the executor sealed in its own order (`final_seal.boot_id`, `.boot_generation`,
   * `.observation`, with the seal's epoch, launch and `n`): what Core weighs the attestation
   * against its own latest observation of the executor by — an answer the executor made after
   * the seal, or one nothing orders against it, and the attestation does not stand (cross-repo
   * decisions 10 and 17). Absent when the seal carries no stamp (an older daemon); an SDK that
   * does not read it ignores it.
   */
  readonly origin?: CaptureCompletionOrigin;
}

/** A seal's stamp in the executor's own order, as Core's stop reads it (`completion.origin`). */
export interface CaptureCompletionOrigin {
  readonly epoch: number;
  readonly launch: string;
  readonly bootId: string;
  readonly bootGeneration: number;
  readonly observation: number;
  readonly headN?: number;
}

/**
 * What a stop came to, with what else Core said of it: `retained` when it keeps the executor for
 * recovery (its disk holds work not confirmed saved), and what became of a `completion`
 * attestation (`accepted` · `ignored`). Both null when the answer does not say (SDK 0.37.2).
 */
export interface WorkspaceStopAnswer {
  readonly state: WorkspaceStopState;
  readonly retained: {
    readonly reason: string | null;
    readonly recoverable: boolean | null;
  } | null;
  readonly completion: {
    readonly outcome: "accepted" | "ignored";
    readonly detail: string | null;
  } | null;
}

/** A workspace whose `stop` may take options: every SDK's, the older ones ignoring them. */
interface StoppableWorkspace {
  readonly stop: (options?: WorkspaceStopOptions) => Promise<unknown>;
}

/**
 * `workspace.stop(options)` as Mend sends it: the options exactly as given — the completion
 * attestation whole, `sealedAt` included — or no argument at all when there are none.
 */
export const stopWith = (
  workspace: StoppableWorkspace,
  options: WorkspaceStopOptions | undefined,
) => (options === undefined ? workspace.stop() : workspace.stop(options));

/** A capture surface that can read its status without flushing (Core's next SDK). */
interface CaptureStatusReadable {
  readonly status: () => Promise<unknown>;
}

const readsCaptureStatus = (capture: object): capture is CaptureStatusReadable =>
  "status" in capture && typeof capture.status === "function";

const numberIn = (value: object, key: string): boolean =>
  key in value && typeof Reflect.get(value, key) === "number";

/** An answer with every field `WorkspaceCaptureStatus` requires, of the type it requires. */
export const isCaptureStatus = (value: unknown): value is WorkspaceCaptureStatus =>
  typeof value === "object" &&
  value !== null &&
  ["epoch", "pending", "stagedBytes", "uploadedObjects", "uploadedBytes", "registered"].every(
    (key) => numberIn(value, key),
  ) &&
  "worktreeId" in value &&
  typeof value.worktreeId === "string" &&
  "fenced" in value &&
  typeof value.fenced === "boolean" &&
  "paused" in value &&
  typeof value.paused === "boolean";

/**
 * `workspace.capture.status()` when the SDK has it (Core's next SDK), checked for what Mend reads;
 * null on an SDK without it (0.37.2), where nothing is asked.
 */
export const captureStatusOf = (workspace: {
  readonly capture: object;
}): Effect.Effect<WorkspaceCaptureStatus | null, SealantPlatformError> => {
  const capture = workspace.capture;
  if (!readsCaptureStatus(capture)) return Effect.succeed(null);
  return wrap(() => capture.status()).pipe(
    Effect.flatMap((answer) =>
      isCaptureStatus(answer)
        ? Effect.succeed(answer)
        : Effect.fail(
            new SealantPlatformError({
              code: "capture_status_unreadable",
              status: null,
              message: "the capture status answer is not one Mend can read",
              cause: null,
            }),
          ),
    ),
  );
};

/** A workspace that can say when its runtime ends it (Core's next SDK). */
interface RuntimeDeadlineReadable {
  readonly runtimeDeadline: () => Promise<unknown>;
}

const readsRuntimeDeadline = (workspace: object): workspace is RuntimeDeadlineReadable =>
  "runtimeDeadline" in workspace && typeof workspace.runtimeDeadline === "function";

/**
 * `workspace.runtimeDeadline()` when the SDK has it: the instant the runtime itself ends the
 * executor (a MicroVM's maximum duration), null where the runtime imposes none or none is
 * launched yet. Null on an SDK without it (0.37.2), where nothing is asked, and for an answer
 * that is not a readable time.
 */
export const runtimeDeadlineOf = (
  workspace: object,
): Effect.Effect<Date | null, SealantPlatformError> => {
  if (!readsRuntimeDeadline(workspace)) return Effect.succeed(null);
  return wrap(() => workspace.runtimeDeadline()).pipe(
    Effect.map((answer) => {
      if (typeof answer !== "string" || answer === "") return null;
      const at = new Date(answer);
      return Number.isNaN(at.getTime()) ? null : at;
    }),
  );
};

/**
 * A run's changes as Core read them. `available: false` means Core never read them (the run has
 * not ended, the reading failed, or none was recorded): the empty `files` and `diff` then say
 * nothing about what changed, and `unavailableReason` says why, when Core gave a reason.
 */
export interface RunChangesReading {
  readonly files: ReadonlyArray<RunFileChange>;
  readonly diff: string;
  readonly available: boolean;
  readonly unavailableReason: string | null;
}

/**
 * Reads a run's changes with `available` and `unavailableReason` kept. A missing `available` (an
 * SDK or control plane from before sealant#313) reads as `true`, as the SDK reads it.
 */
export const runChangesOf = (
  changes: RunChanges,
): Effect.Effect<RunChangesReading, SealantPlatformError> =>
  wrap(async () => ({
    files: changes.files,
    diff: await changes.diff(),
    available: changes.available ?? true,
    unavailableReason: changes.unavailableReason ?? null,
  }));

const STOP_STATES: ReadonlyArray<WorkspaceStopState> = ["stopped", "draining", "kept", "requested"];

/** The state a stop's answer carries, when it carries one Mend knows; `requested` otherwise. */
export const workspaceStopStateOf = (answer: unknown): WorkspaceStopState => {
  if (typeof answer !== "object" || answer === null || !("state" in answer)) return "requested";
  return STOP_STATES.find((state) => state === answer.state) ?? "requested";
};

const textIn = (value: object, key: string): string | null => {
  const found: unknown = Reflect.get(value, key);
  return typeof found === "string" && found !== "" ? found : null;
};

/** A stop's answer as Mend reads it (`WorkspaceStopAnswer`); anything unknown reads null. */
export const workspaceStopAnswerOf = (answer: unknown): WorkspaceStopAnswer => {
  const state = workspaceStopStateOf(answer);
  if (typeof answer !== "object" || answer === null) {
    return { state, retained: null, completion: null };
  }
  const drain: unknown = Reflect.get(answer, "drain");
  const retainedRaw: unknown =
    typeof drain === "object" && drain !== null ? Reflect.get(drain, "retained") : undefined;
  const retained =
    typeof retainedRaw === "object" && retainedRaw !== null
      ? {
          reason: textIn(retainedRaw, "reason"),
          recoverable:
            typeof Reflect.get(retainedRaw, "recoverable") === "boolean"
              ? Reflect.get(retainedRaw, "recoverable") === true
              : null,
        }
      : null;
  const completionRaw: unknown = Reflect.get(answer, "completion");
  const outcome =
    typeof completionRaw === "object" && completionRaw !== null
      ? Reflect.get(completionRaw, "outcome")
      : undefined;
  const completion =
    typeof completionRaw === "object" &&
    completionRaw !== null &&
    (outcome === "accepted" || outcome === "ignored")
      ? { outcome, detail: textIn(completionRaw, "detail") }
      : null;
  return { state, retained, completion };
};

/**
 * What Core last observed of a capture executor's drain, read without stopping anything (Core's
 * next SDK: `workspace.captureDrain()`): `unsupported` on an SDK without it (0.37.2), `none` when
 * Core recorded no drain, else its `state` (`draining` · `kept` · `saved` · `gone` · `stop-failed`
 * · `stopped` · `discarded`) and whether Core retains the executor for recovery.
 */
export type WorkspaceCaptureDrainReading =
  | { readonly kind: "unsupported" }
  | { readonly kind: "none" }
  | { readonly kind: "drain"; readonly state: string; readonly retained: boolean };

/** A workspace that reads its drain without stopping it (Core's next SDK). */
interface CaptureDrainReadable {
  readonly captureDrain: () => Promise<unknown>;
}

const readsCaptureDrain = (workspace: object): workspace is CaptureDrainReadable =>
  "captureDrain" in workspace && typeof workspace.captureDrain === "function";

/** `workspace.captureDrain()` as Mend reads it (`WorkspaceCaptureDrainReading`). */
export const captureDrainOf = (
  workspace: object,
): Effect.Effect<WorkspaceCaptureDrainReading, SealantPlatformError> => {
  if (!readsCaptureDrain(workspace)) return Effect.succeed({ kind: "unsupported" } as const);
  return wrap(() => workspace.captureDrain()).pipe(
    Effect.map((answer): WorkspaceCaptureDrainReading => {
      if (typeof answer !== "object" || answer === null) return { kind: "none" };
      const retained: unknown = Reflect.get(answer, "retained");
      return {
        kind: "drain",
        state: textIn(answer, "state") ?? "unknown",
        retained: typeof retained === "object" && retained !== null,
      };
    }),
  );
};

/** A workspace that reads its executor now (Core's next SDK: `workspace.runtime()`). */
interface RuntimeReadable {
  readonly runtime: () => Promise<unknown>;
}

const readsRuntime = (workspace: object): workspace is RuntimeReadable =>
  "runtime" in workspace && typeof workspace.runtime === "function";

/** `resourceId` of a runtime record (`WorkspaceRuntimeInfo`), when it carries one. */
const resourceIdIn = (runtime: unknown): string | null =>
  typeof runtime === "object" && runtime !== null ? textIn(runtime, "resourceId") : null;

/**
 * A runtime record's `resourceId`, when it is the executor `launchId` names: a record that names
 * another launch (`runtime.launchId`, Core's next SDK) is another physical executor, and a record
 * that names none (an SDK or a Core from before launch identities) is taken as it is.
 */
const resourceOfLaunch = (runtime: unknown, launchId: string | undefined): string | null => {
  const resourceId = resourceIdIn(runtime);
  if (resourceId === null || launchId === undefined) return resourceId;
  const named =
    typeof runtime === "object" && runtime !== null ? textIn(runtime, "launchId") : null;
  return named === null || named === launchId ? resourceId : null;
};

/**
 * The executor's runtime identity (`resourceId`: the Docker container, the Pod, the MicroVM) on
 * Core's next SDK: from the handle's `launch.runtime` (what `create()` saw become ready, or a
 * replayed create's executor), else `workspace.runtime()` read now. With `launchId`, only the
 * runtime of that launch (review 2026-09-28 (3) #1): another launch's runtime reads null. Null on
 * SDK 0.37.2, which has neither, and while no runtime is launched.
 */
export const runtimeResourceIdOf = (
  workspace: object,
  launchId?: string,
): Effect.Effect<string | null, SealantPlatformError> => {
  const launch: unknown = Reflect.get(workspace, "launch");
  const launched =
    typeof launch === "object" && launch !== null
      ? resourceOfLaunch(Reflect.get(launch, "runtime"), launchId)
      : null;
  if (launched !== null) return Effect.succeed(launched);
  if (!readsRuntime(workspace)) return Effect.succeed(null);
  return wrap(() => workspace.runtime()).pipe(
    Effect.map((runtime) => resourceOfLaunch(runtime, launchId)),
  );
};

/** Core's next SDK: `workspaces.findByIdempotencyKey(key)`. */
interface IdempotentLookup {
  readonly findByIdempotencyKey: (key: string) => Promise<unknown>;
}

const looksUpByKey = (workspaces: object): workspaces is IdempotentLookup =>
  "findByIdempotencyKey" in workspaces && typeof workspaces.findByIdempotencyKey === "function";

/**
 * Core's next SDK (review 3): `workspaces.createState(key)` — `{ state: "pending" | "found" |
 * "cancelled" | "none", workspaceId?, runId?, launchId? }`, what became of the create under the key.
 */
interface CreateStateLookup {
  readonly createState: (key: string) => Promise<unknown>;
}

const readsCreateState = (workspaces: object): workspaces is CreateStateLookup =>
  "createState" in workspaces && typeof workspaces.createState === "function";

/**
 * A `WorkspaceCreateState` read as `WorkspaceCreateFence`: `cancelled`, `found` with its
 * workspace, `pending` / `none` as `open` (a point in time: the create may still arrive), anything
 * else `unknown` — never `none`.
 */
const createStateOf = (answer: unknown): WorkspaceCreateFence => {
  if (typeof answer !== "object" || answer === null) {
    return { kind: "unknown", detail: `an answer Mend does not read: ${shapeOf(answer)}` };
  }
  const state = Reflect.get(answer, "state");
  const workspaceId = textIn(answer, "workspaceId") ?? textIn(answer, "id");
  if (state === "cancelled" || Reflect.get(answer, "cancelled") === true) {
    return { kind: "cancelled" };
  }
  if ((state === "found" || state === undefined) && workspaceId !== null) {
    return { kind: "found", workspaceId };
  }
  if (state === "pending" || state === "none") return { kind: "open", state };
  return {
    kind: "unknown",
    detail: `a create state Mend does not read: ${typeof state === "string" ? state : shapeOf(answer)}`,
  };
};

/**
 * What an idempotent create's key finds: the workspace it made (`found`), that none is on record
 * as of the lookup (`none` — a point in time, never proof: the create may still be on its way,
 * review 2026-09-28 (3) #21), an answer Mend does not recognise (`unknown`), or that the SDK
 * cannot say (`unsupported`: 0.37.2, which neither sends the key nor looks it up).
 */
export type WorkspaceByKey =
  | { readonly kind: "found"; readonly workspaceId: string }
  | { readonly kind: "none" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "unknown"; readonly detail: string }
  | { readonly kind: "unsupported" };

/** An answer's shape, for a log line: never its contents. */
const shapeOf = (value: unknown): string =>
  typeof value === "object" && value !== null
    ? `object with ${Object.keys(value).toSorted().join(",") || "no fields"}`
    : typeof value;

/**
 * `findByIdempotencyKey` on any SDK's `workspaces`, read as `WorkspaceByKey`: null (or nothing)
 * is `none`, a workspace with an id is `found`, anything else is `unknown`.
 */
export const workspaceByKeyOf = (
  workspaces: object,
  key: string,
): Effect.Effect<WorkspaceByKey, SealantPlatformError> => {
  // `createState` says more (a cancelled key, a pending create) and says it of the key itself.
  if (readsCreateState(workspaces)) {
    return wrap(() => workspaces.createState(key)).pipe(
      Effect.map((answer): WorkspaceByKey => {
        const read = createStateOf(answer);
        switch (read.kind) {
          case "found":
            return { kind: "found", workspaceId: read.workspaceId };
          case "cancelled":
            return { kind: "cancelled" };
          case "open":
            return { kind: "none" };
          case "unknown":
            return read;
          case "unsupported":
            return read;
        }
      }),
    );
  }
  if (!looksUpByKey(workspaces)) return Effect.succeed({ kind: "unsupported" });
  return wrap(() => workspaces.findByIdempotencyKey(key)).pipe(
    Effect.map((found): WorkspaceByKey => {
      if (found === null || found === undefined) return { kind: "none" };
      const id = typeof found === "object" ? textIn(found, "id") : null;
      return id === null
        ? { kind: "unknown", detail: `an answer that names no workspace: ${shapeOf(found)}` }
        : { kind: "found", workspaceId: id };
    }),
  );
};

/**
 * Core's create fence (review 3): `workspaces.cancelCreate(idempotencyKey)` durably cancels the
 * key for the owner — a delayed original create under it is then refused (409
 * `create-cancelled`) — or answers `found` with the workspace a create under it already made.
 */
interface CreateFence {
  readonly cancelCreate: (key: string) => Promise<unknown>;
}

const fencesCreates = (workspaces: object): workspaces is CreateFence =>
  "cancelCreate" in workspaces && typeof workspaces.cancelCreate === "function";

/**
 * What fencing a create's key established: nothing will be made under it (`cancelled`), the
 * workspace one already made (`found`), a create still open under it (`open`: not a fence), an
 * answer Mend does not recognise (`unknown`), or that the SDK cannot fence (`unsupported`: 0.37.2).
 */
export type WorkspaceCreateFence =
  | { readonly kind: "cancelled" }
  | { readonly kind: "found"; readonly workspaceId: string }
  | { readonly kind: "open"; readonly state: "pending" | "none" }
  | { readonly kind: "unknown"; readonly detail: string }
  | { readonly kind: "unsupported" };

/** `cancelCreate` on any SDK's `workspaces`, read as `WorkspaceCreateFence`. */
export const fenceWorkspaceCreateOf = (
  workspaces: object,
  key: string,
): Effect.Effect<WorkspaceCreateFence, SealantPlatformError> => {
  if (!fencesCreates(workspaces)) return Effect.succeed({ kind: "unsupported" });
  return wrap(() => workspaces.cancelCreate(key)).pipe(Effect.map(createStateOf));
};

/**
 * What makes a create idempotent: the key Mend persisted before it asked (`idempotencyKey`), and
 * the launch identity of the one executor it makes (`launchId`, cross-repo decision 5 — the same
 * key), which Core records and reports as `runtime.launchId` (Core's next SDK).
 */
export interface WorkspaceCreateLaunch {
  readonly idempotencyKey: string;
  readonly launchId?: string;
  /**
   * `credentialsHome` (docs/adr/0016, decision 5; Core 0.39): the launcher's logins written into
   * their own home rather than `$HOME`, for a person-layout launch. The create runs before the
   * launcher's user exists, so it names the owner by number: Core makes a missing home for
   * `uid:gid` (0700, from `/etc/skel`) and writes every file and directory as them, and holds the
   * home for the launcher while the executor lives.
   */
  readonly credentialsHome?: CredentialsHome;
  /**
   * `sshAsOwner` (docs/adr/0016, decision 10; sealant#348): Core's SSH gateway runs the
   * workspace's SSH sessions, VS Code Remote-SSH included, as its owner's own Linux user, the uid
   * of `credentialsHome`, for a person-layout launch. The owner is its launcher, the person whose
   * launch this create is (after the workspace stops, whoever launches the next one). Mend names no
   * user: Core takes the owner's. It does not exist at create; until prepare makes it, the gateway
   * refuses a session rather than run it as root. Sent only where Core reports `workspaceSshUser`
   * (`PersonLayoutPlatform.sshUser`), and only with `credentialsHome`.
   */
  readonly sshAsOwner?: true;
}

/** A home and the numeric owner Core writes it as (docs/adr/0016, decision 5). */
export interface CredentialsHome {
  readonly path: string;
  readonly uid: number;
  readonly gid: number;
}

export interface SealantClientShape {
  /**
   * `launch.idempotencyKey` makes the create idempotent for the owner on Core's next SDK: a
   * repeated create returns the workspace the first one made, and `findWorkspaceByKey` finds it
   * when the answer was lost. SDK 0.37.2 ignores it (PLATFORM-FEEDBACK.md 2026-09-28).
   */
  readonly createWorkspace: (
    options: CreateOptions,
    launch?: WorkspaceCreateLaunch,
    /**
     * Runs beside the wait for the workspace to be ready, given its handle as soon as the control
     * plane accepted the create, and is interrupted once it is ready or the create fails: what
     * lets a launch say whether the platform is still building the image or booting the executor.
     */
    watch?: (workspace: Workspace) => Effect.Effect<void>,
  ) => Effect.Effect<Workspace, SealantPlatformError>;
  /** The workspace a keyed create made (`workspaceByKeyOf`); `unsupported` on SDK 0.37.2. */
  readonly findWorkspaceByKey: (key: string) => Effect.Effect<WorkspaceByKey, SealantPlatformError>;
  /**
   * Fence a keyed create whose answer was lost (`fenceWorkspaceCreateOf`): after `cancelled`,
   * nothing is ever made under the key. `unsupported` on every SDK so far.
   */
  readonly fenceWorkspaceCreate: (
    key: string,
  ) => Effect.Effect<WorkspaceCreateFence, SealantPlatformError>;
  readonly getWorkspace: (id: string) => Effect.Effect<Workspace, SealantPlatformError>;
  /** Runs outlive workspaces — records are replayable long after close-out. */
  readonly getRun: (runId: string) => Effect.Effect<Run, SealantPlatformError>;
  /** BLOCKING: resolves once the harness terminally completed. */
  readonly runHarness: (
    workspace: Workspace,
    prompt: string,
    options?: RunOptions,
  ) => Effect.Effect<Run, SealantPlatformError>;
  /** NON-BLOCKING: a live handle for streaming via `recordStream`. */
  readonly startHarness: (
    workspace: Workspace,
    prompt: string,
    options?: RunOptions,
  ) => Effect.Effect<Run, SealantPlatformError>;
  /**
   * Starts a harness in a workspace BY ID — for runs on a workspace that
   * outlives the handle that created it (follow-ups, verification passes).
   * Re-fetched facade handles carry no harness (PLATFORM-FEEDBACK.md), so
   * this goes through the /effect ops and hand-assembles the run command.
   */
  readonly startHarnessInWorkspace: (
    workspaceId: string,
    harness: Harness,
    prompt: string,
  ) => Effect.Effect<Run, SealantPlatformError>;
  readonly waitRun: (run: Run) => Effect.Effect<Run, SealantPlatformError>;
  /** Open an interactive PTY session in a workspace (0.7.0) — a durable platform resource. */
  readonly openSession: (
    workspace: Workspace,
    argv: ReadonlyArray<string>,
    options?: PersonSessionOptions,
  ) => Effect.Effect<InteractiveSession, SealantPlatformError>;
  /**
   * A raw TCP byte pipe — or a UDP datagram pipe, where one WS frame is
   * exactly one datagram — into the workspace (host option 0.15.0) —
   * one held WebSocket per pipe. The target is a closed workspace-private
   * set: loopback (default) or `docker`, the workspace-scoped Docker
   * sidecar where inner compose publishes its ports. Fails when nothing
   * listens, which doubles as the reachability probe for Services.
   */
  readonly forward: (
    workspace: Workspace,
    port: number,
    host?: "127.0.0.1" | "docker",
    protocol?: "tcp" | "udp",
  ) => Effect.Effect<WorkspaceForward, SealantPlatformError>;
  /**
   * Ask the platform to stop the workspace, and say what it observed (`WorkspaceStopState`). Only
   * `stopped` is a termination; anything else is watched until the platform reports one.
   */
  readonly stopWorkspace: (
    workspace: Workspace,
    options?: WorkspaceStopOptions,
  ) => Effect.Effect<WorkspaceStopAnswer, SealantPlatformError>;
  /**
   * The executor's runtime identity (`runtimeResourceIdOf`: `launch.runtime`, else `runtime()`):
   * what a completion attestation names. Null where the SDK cannot say (0.37.2).
   */
  readonly runtimeResourceId: (
    workspace: Workspace,
    /** Only the runtime of this launch: another launch's reads null. */
    launchId?: string,
  ) => Effect.Effect<string | null, SealantPlatformError>;
  /**
   * Capture-sourced workspaces (0.31.0, sealantd ADR-0015): ship and register what the executor
   * holds. `suspend` (a checkpoint, a handoff) forces a small-class capture and ships the queue;
   * processes keep running. `final` is for an executor that is ending: sealantd stops admitting
   * processes, ends every managed one, snapshots the small and the bulk class, then ships until
   * nothing is pending, and says `complete: true` only when all of that happened.
   *
   * SDK 0.37.2's `capture.flush()` takes no kind and is the suspend kind, so a `final` request
   * reaches the executor as a suspend flush and its answer carries no `complete`: Mend reads that
   * as not saved (`captureSaved`), never as saved. Once the SDK takes the kind
   * (PLATFORM-FEEDBACK.md 2026-09-27, "A final flush with a deadline"), `final` is passed through
   * here and nowhere else changes.
   */
  readonly captureFlush: (
    workspace: Workspace,
    kind: CaptureFlushKind,
  ) => Effect.Effect<WorkspaceCaptureStatus, SealantPlatformError>;
  /**
   * Capture-sourced workspaces: the daemon's capture queue as it stands, nothing flushed and
   * nothing snapped — `pending`, what registered, and (from a daemon that reports them) a snap
   * that is failing (`lastSnapError`, `snapFailingSinceUnixMs`, `snapsFailed`), unreadable paths,
   * a bulk build under way. Cheap: what Mend polls while a session runs.
   *
   * SDK 0.37.2 has no `capture.status()`: this answers null there and Mend reads nothing between
   * flushes (PLATFORM-FEEDBACK.md 2026-09-27, "A capture status read"). Core's next SDK adds it,
   * and it is picked up here as it is, with nothing else changing.
   */
  readonly captureStatus: (
    workspace: Workspace,
  ) => Effect.Effect<WorkspaceCaptureStatus | null, SealantPlatformError>;
  /**
   * Capture-sourced workspaces (0.31.0, sealantd 0.15 `capture.replan`): the daemon asks the
   * session channel for its plan again with no worktree named, delta-materialises the answer
   * over its disk and captures under the answered worktree and epoch from then on. The claim
   * hook for a standby executor; idempotent (`unchanged: true`).
   */
  readonly captureReplan: (
    workspace: Workspace,
    /**
     * The owner map the claim needs, or null for none (sealant#333): Core refuses a standby
     * booted with another (`owner-map-mismatch`) before its daemon is reached. Absent: nothing is
     * compared.
     */
    options?: { readonly expectedOwnerMap: WorkspaceCaptureOwnerMap | null },
  ) => Effect.Effect<WorkspaceCaptureReplanned, SealantPlatformError>;
  /**
   * When the runtime itself ends this workspace's executor, whatever anyone asks
   * (`workspace.runtimeDeadline()`, Core's next SDK): what a planned drain ahead of the platform's
   * cap counts back from. Null where the runtime imposes no lifetime (Docker, Kubernetes), no
   * runtime is launched yet, or the SDK cannot say (0.37.2 — PLATFORM-FEEDBACK.md 2026-09-27,
   * "The runtime deadline").
   */
  readonly runtimeDeadline: (
    workspace: Workspace,
  ) => Effect.Effect<Date | null, SealantPlatformError>;
  /** Re-arm the workspace TTL and return the platform's exact resulting expiry. */
  readonly expireWorkspace: (
    workspaceId: string,
    ttlSeconds: number,
  ) => Effect.Effect<Date | null, SealantPlatformError>;
  readonly getSession: (
    workspace: Workspace,
    sessionId: string,
  ) => Effect.Effect<InteractiveSession, SealantPlatformError>;
  /** Sequence-addressed, read-only PTY output. Cursors remain decimal strings. */
  readonly sessionOutput: (
    sessionId: string,
    options: { readonly from: string; readonly limit: string },
  ) => Effect.Effect<SessionOutputPage, SealantPlatformError>;
  /**
   * Deterministic check run (0.5.0): commands executed verbatim, recorded
   * into a run record like any process. The exit code is a check datum, not
   * an error — the effect fails only when execution machinery broke.
   */
  readonly exec: (
    workspace: Workspace,
    argv: readonly string[],
    options?: PersonExecOptions,
  ) => Effect.Effect<WorkspaceExecResult, SealantPlatformError>;
  /**
   * Point a standby workspace's working directory (or a bindable extra mount) at one
   * subdirectory of its root (Mend ADR-0001, sealantd ADR-0014). Waits for the workspace to be
   * ready first: the daemon applies the bind over its control connection.
   */
  readonly bindWorkspace: (
    workspace: Workspace,
    options: WorkspaceBindOptions,
  ) => Effect.Effect<ReadonlyArray<WorkspaceBind>, SealantPlatformError>;
  /**
   * The committed diff between two shas, read from git in the workspace — the
   * source of truth for what a change contains. Mend prefers this to the
   * recording-derived `runChanges` diff, which today comes up empty because
   * the runtime is not recording file-change events (PLATFORM-FEEDBACK.md).
   */
  readonly diffCommits: (
    workspaceId: string,
    base: string,
    head: string,
  ) => Effect.Effect<
    {
      readonly diff: string;
      readonly files: ReadonlyArray<{
        readonly path: string;
        readonly additions: number;
        readonly deletions: number;
      }>;
    },
    SealantPlatformError
  >;
  /**
   * Inference on connected accounts (0.5.0): server-side via the official
   * agent SDKs; the tool loop is caller-executed via `sessionId`.
   */
  readonly inferenceRespond: (
    options: InferenceRespondOptions | InferenceContinueOptions,
  ) => Effect.Effect<InferenceResponse, SealantPlatformError>;
  /** The record's live event stream — typed entries, resumable for crash-resume. */
  readonly recordStream: (
    run: Run,
    options?: { readonly from?: bigint },
  ) => Stream.Stream<TimelineEntry, SealantPlatformError>;
  /** The full timeline as recorded so far — ends at the record's end, never waits for more. */
  readonly recordTimeline: (
    run: Run,
    options?: { readonly from?: bigint },
  ) => Stream.Stream<TimelineEntry, SealantPlatformError>;
  /** The terminal commands the run executed, reconstructed by the platform. */
  readonly recordCommands: (run: Run) => Effect.Effect<readonly RunCommand[], SealantPlatformError>;
  /**
   * Byte-exact scrollback for one process's output stream, concatenated.
   * "pty" is served by the control plane but missing from the SDK's
   * IoStream type (PLATFORM-FEEDBACK.md 2026-08-09) — verified live.
   */
  readonly recordScrollback: (
    run: Run,
    processId: string,
    stream: "pty" | "stdout" | "stderr",
  ) => Effect.Effect<Uint8Array, SealantPlatformError>;
  /** The before/after of what a run changed: file list, unified diff, and whether Core read it. */
  readonly runChanges: (run: Run) => Effect.Effect<RunChangesReading, SealantPlatformError>;
  /** Cheap authenticated round-trip for the settings page. Never fails — the failure is the content. */
  readonly connectionCheck: () => Effect.Effect<SealantConnection>;
  /** Resolve one package against the selected workspace OS through Sealant's public API. */
  readonly resolveWorkspacePackage: (
    packageName: string,
    os: WorkspaceImageOs,
  ) => Effect.Effect<WorkspacePackageResolution, SealantPlatformError>;
}

/**
 * The platform for ONE principal. Which principal is the `SealantPrincipal`
 * reference in context (principal.ts); the live layer below dispatches every
 * call to the per-user client `SealantClients` holds for it.
 */
export class SealantClient extends Context.Service<SealantClient, SealantClientShape>()(
  "@mend/sealant/SealantClient",
) {}

type SealantEnvShape = Context.Service.Shape<typeof SealantEnv>;

const publicConfigOf = (env: SealantEnvShape, ownerUserId?: string): SealantConfig => ({
  baseUrl: env.baseUrl,
  ...(ownerUserId === undefined ? {} : { ownerUserId }),
  ...Option.match(env.serviceKey, {
    onNone: () => ({}),
    onSome: (key) => ({ apiKey: Redacted.value(key) }),
  }),
});

/** The client for one Sealant user: the SDK facade + Effect core, both bound to `ownerUserId`. */
const makeUserClient = (env: SealantEnvShape, ownerUserIdInput: string) =>
  Effect.gen(function* () {
    const publicConfig = publicConfigOf(env, ownerUserIdInput);

    // The facade, for the stateful object model.
    const sealant = yield* Effect.acquireRelease(
      Effect.sync(() => new Sealant(publicConfig)),
      (client) => Effect.promise(() => client.close()),
    );

    // The Effect core, for flat operations — built once, provided per call.
    const internalConfig = resolveInternalConfig(publicConfig);
    const apiContext = yield* Layer.build(sealantApiClientLayer(internalConfig));
    const ownerUserId = internalConfig.hostLocal.ownerUserId;

    const createWorkspace = Effect.fn("SealantClient.createWorkspace")((
      options: CreateOptions,
      launch?: WorkspaceCreateLaunch,
      watch?: (workspace: Workspace) => Effect.Effect<void>,
    ) => {
      // SDK 0.37.2 builds its request field by field and drops both; Core's next SDK sends them.
      // `credentialsHome` (Core 0.39): the launcher's logins written into their own home, owned
      // by the uid their user will have, instead of `$HOME` and the environment.
      const keyed: CreateOptions & {
        readonly idempotencyKey?: string;
        readonly launchId?: string;
        readonly sshAsOwner?: boolean;
      } =
        launch === undefined
          ? options
          : {
              ...options,
              idempotencyKey: launch.idempotencyKey,
              ...(launch.launchId === undefined ? {} : { launchId: launch.launchId }),
              ...(launch.credentialsHome === undefined
                ? {}
                : { credentialsHome: launch.credentialsHome }),
              ...(launch.sshAsOwner === true ? { sshAsOwner: true } : {}),
            };
      if (watch === undefined) {
        return wrap(() => sealant.workspaces.create(keyed)).pipe(
          Effect.mapError(imageBuildFailure),
        );
      }
      // The SDK's own `create` is exactly this: the create, then `ready()` on the handle it made
      // (whose readiness timeout still stops an abandoned launch). Split only so the handle can be
      // watched while it gets ready.
      return wrap(() => sealant.workspaces.create({ ...keyed, wait: false })).pipe(
        Effect.flatMap((workspace) =>
          Effect.gen(function* () {
            const watcher = yield* Effect.forkChild(watch(workspace));
            return yield* wrap(() => workspace.ready()).pipe(
              Effect.mapError(imageBuildFailure),
              Effect.ensuring(Fiber.interrupt(watcher)),
            );
          }),
        ),
      );
    });

    const findWorkspaceByKey = Effect.fn("SealantClient.findWorkspaceByKey")((key: string) =>
      workspaceByKeyOf(sealant.workspaces, key),
    );

    const fenceWorkspaceCreate = Effect.fn("SealantClient.fenceWorkspaceCreate")((key: string) =>
      fenceWorkspaceCreateOf(sealant.workspaces, key),
    );

    const getWorkspace = Effect.fn("SealantClient.getWorkspace")((id: string) =>
      wrap(() => sealant.workspaces.get(id)),
    );

    const getRun = Effect.fn("SealantClient.getRun")((runId: string) =>
      wrap(() => sealant.runs.get(runId)),
    );

    const runHarness = Effect.fn("SealantClient.runHarness")(
      (workspace: Workspace, prompt: string, options?: RunOptions) =>
        wrap(() => workspace.harness.run(prompt, options)),
    );

    const startHarness = Effect.fn("SealantClient.startHarness")(
      (workspace: Workspace, prompt: string, options?: RunOptions) =>
        wrap(() => workspace.harness.start(prompt, options)),
    );

    const waitRun = Effect.fn("SealantClient.waitRun")((run: Run) => wrap(() => run.wait()));

    // A process asked for as a user starts as that user (the SDK refuses where it cannot, before
    // anything starts), never as root in its place.
    const openSession = Effect.fn("SealantClient.openSession")(
      (workspace: Workspace, argv: ReadonlyArray<string>, options?: PersonSessionOptions) =>
        withProcessUser(options, (sdkOptions) =>
          wrap(() => workspace.sessions.open(argv, sdkOptions)),
        ).pipe(Effect.mapError(personProcessRefusal)),
    );

    const forward = Effect.fn("SealantClient.forward")(
      (
        workspace: Workspace,
        port: number,
        host?: "127.0.0.1" | "docker",
        protocol?: "tcp" | "udp",
      ) =>
        wrap(() =>
          workspace.forward(port, {
            ...(host === undefined ? {} : { host }),
            ...(protocol === "udp" ? { protocol } : {}),
          }),
        ),
    );

    // SDK 0.37.2 resolves `stop()` with nothing; Core's next SDK resolves what it observed. Both
    // are read through `workspaceStopStateOf`, so the newer answer needs no change here.
    const stopWorkspace = Effect.fn("SealantClient.stopWorkspace")(
      (workspace: Workspace, options?: WorkspaceStopOptions) =>
        wrap(() => stopWith(workspace, options)).pipe(Effect.map(workspaceStopAnswerOf)),
    );

    const captureFlush = Effect.fn("SealantClient.captureFlush")(
      (workspace: Workspace, kind: CaptureFlushKind) =>
        wrap(() => workspace.capture.flush({ kind })),
    );

    const captureStatus = Effect.fn("SealantClient.captureStatus")((workspace: Workspace) =>
      captureStatusOf(workspace),
    );

    const runtimeDeadline = Effect.fn("SealantClient.runtimeDeadline")((workspace: Workspace) =>
      runtimeDeadlineOf(workspace),
    );

    const runtimeResourceId = Effect.fn("SealantClient.runtimeResourceId")(
      (workspace: Workspace, launchId?: string) => runtimeResourceIdOf(workspace, launchId),
    );

    const captureReplan = Effect.fn("SealantClient.captureReplan")(
      (
        workspace: Workspace,
        options?: { readonly expectedOwnerMap: WorkspaceCaptureOwnerMap | null },
      ) => wrap(() => workspace.capture.replan(options)),
    );

    const expireWorkspace = Effect.fn("SealantClient.expireWorkspace")(
      (workspaceId: string, ttlSeconds: number) =>
        expireWorkspaceOp(workspaceId, { ownerUserId, ttlSeconds }).pipe(
          Effect.provideContext(apiContext),
          Effect.mapError(toPlatformError),
          Effect.flatMap(({ expiresAt }) => {
            if (expiresAt === null) return Effect.succeed(null);
            return Effect.try({
              try: () => {
                const parsed = new Date(expiresAt);
                if (Number.isNaN(parsed.getTime())) {
                  throw new Error(`Sealant returned an invalid workspace expiry: ${expiresAt}`);
                }
                return parsed;
              },
              catch: toPlatformError,
            });
          }),
        ),
    );

    const getSession = Effect.fn("SealantClient.getSession")(
      (workspace: Workspace, sessionId: string) => wrap(() => workspace.sessions.get(sessionId)),
    );

    const sessionOutput = Effect.fn("SealantClient.sessionOutput")(
      (sessionId: string, options: { readonly from: string; readonly limit: string }) =>
        getSessionOutputOp(sessionId, { ownerUserId, ...options }).pipe(
          Effect.provideContext(apiContext),
          Effect.mapError(toPlatformError),
        ),
    );

    // No idempotency on this path: `attemptId` is a workspace-attempt FK,
    // not a client key, and the wire op carries no idempotency header —
    // callers dedupe upstream (Mend routes each comment exactly once).
    const startHarnessInWorkspace = Effect.fn("SealantClient.startHarnessInWorkspace")(function* (
      workspaceId: string,
      harness: Harness,
      prompt: string,
    ) {
      const wire = yield* createRunOp({
        workspaceId,
        harnessId: harness.id,
        ownerUserId,
        mode: "one-shot",
        prompt,
        command: harness.buildRunCommand(prompt),
      }).pipe(Effect.provideContext(apiContext), Effect.mapError(toPlatformError));
      // The facade's run handle carries the record surface and wait().
      return yield* wrap(() => sealant.runs.get(wire.runId));
    });

    const exec = Effect.fn("SealantClient.exec")((
      workspace: Workspace,
      argv: readonly string[],
      options?: PersonExecOptions,
    ) => {
      return withProcessUser(options, (sdkOptions) =>
        wrap(() => workspace.exec(argv, sdkOptions)),
      ).pipe(Effect.mapError(personProcessRefusal));
    });
    const bindWorkspace = Effect.fn("SealantClient.bindWorkspace")(
      (workspace: Workspace, options: WorkspaceBindOptions) =>
        wrap(async () => {
          await workspace.ready();
          return workspace.bind(options);
        }),
    );

    const diffCommits = Effect.fn("SealantClient.diffCommits")(function* (
      workspaceId: string,
      base: string,
      head: string,
    ) {
      const workspace = yield* wrap(() => sealant.workspaces.get(workspaceId));
      const range = `${base}..${head}`;
      const unified = yield* wrap(() => workspace.exec(["git", "diff", range]));
      // `--numstat` gives exact per-file counts (tab-separated: adds, dels, path).
      const numstat = yield* wrap(() => workspace.exec(["git", "diff", "--numstat", range]));
      const files = numstat.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((line) => {
          const [adds, dels, ...rest] = line.split("\t");
          return {
            path: rest.join("\t"),
            additions: Number(adds) || 0,
            deletions: Number(dels) || 0,
          };
        })
        .filter((file) => file.path !== "");
      return { diff: unified.stdout, files };
    });

    const inferenceRespond = Effect.fn("SealantClient.inferenceRespond")(
      (options: InferenceRespondOptions | InferenceContinueOptions) =>
        "sessionId" in options
          ? inferenceRespondOp({
              ownerUserId,
              sessionId: options.sessionId,
              toolResults: options.toolResults,
            }).pipe(
              Effect.provideContext(apiContext),
              Effect.mapError(toPlatformError),
              Effect.map(toInferenceResponse),
            )
          : inferenceRespondOp({
              ownerUserId,
              prompt: options.prompt,
              system: options.system,
              model: options.model,
              maxTurns: options.maxTurns,
              tools: options.tools?.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })),
              responseFormat: options.responseFormat,
              credentials: {
                profileId: options.credentials.profile,
                claude: accountReference(options.credentials.claude),
                codex: accountReference(options.credentials.codex),
              },
            }).pipe(
              Effect.provideContext(apiContext),
              Effect.mapError(toPlatformError),
              Effect.map(toInferenceResponse),
            ),
    );

    const recordStream = (run: Run, options?: { readonly from?: bigint }) =>
      Stream.fromAsyncIterable(
        run.record.stream(options?.from === undefined ? {} : { from: options.from }),
        toPlatformError,
      );

    const recordTimeline = (run: Run, options?: { readonly from?: bigint }) =>
      Stream.fromAsyncIterable(
        run.record.timeline(options?.from === undefined ? {} : { from: options.from }),
        toPlatformError,
      );

    const recordCommands = Effect.fn("SealantClient.recordCommands")((run: Run) =>
      wrap(() => run.record.commands()),
    );

    const recordScrollback = Effect.fn("SealantClient.recordScrollback")(
      (run: Run, processId: string, stream: "pty" | "stdout" | "stderr") =>
        wrap(async () => {
          const chunks: Array<Uint8Array> = [];
          let total = 0;
          // The wire accepts "pty" (verified: 150KB+ served for a live PTY run);
          // only the SDK's IoStream type omits it. The cast bridges that gap
          // until the type widens upstream.
          for await (const chunk of run.record.scrollback(
            processId,
            stream as "stdout" | "stderr",
          )) {
            chunks.push(chunk);
            total += chunk.length;
          }
          const joined = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            joined.set(chunk, offset);
            offset += chunk.length;
          }
          return joined;
        }),
    );

    const runChanges = Effect.fn("SealantClient.runChanges")((run: Run) =>
      runChangesOf(run.changes),
    );

    const connectionCheck = Effect.fn("SealantClient.connectionCheck")(function* () {
      const now = yield* Clock.currentTimeMillis;
      return yield* listWorkspacesOp({ ownerUserId, limit: "1" }).pipe(
        Effect.provideContext(apiContext),
        Effect.map(
          () =>
            new SealantConnection({
              status: "connected",
              baseUrl: env.baseUrl,
              detail: null,
              checkedAt: new Date(now),
            }),
        ),
        Effect.catch((error) =>
          Effect.succeed(
            new SealantConnection({
              status: connectionStatusOf(error),
              baseUrl: env.baseUrl,
              detail: toPlatformError(error).message,
              checkedAt: new Date(now),
            }),
          ),
        ),
      );
    });

    const resolveWorkspacePackage = Effect.fn("SealantClient.resolveWorkspacePackage")(
      (packageName: string, os: WorkspaceImageOs) =>
        Effect.gen(function* () {
          const client = yield* SealantApiClient;
          const resolution = yield* client.packages.resolvePackage({
            query: { query: packageName, targetOs: os },
          });
          const osSupport = resolution.osSupport[os];
          return {
            requested: resolution.requested,
            normalized: resolution.normalized,
            status: resolution.status,
            canonicalId: resolution.canonicalId ?? null,
            supported: osSupport.supported,
            packageName: osSupport.packageName ?? null,
            alternatives: resolution.alternatives.map((alternative) => alternative.projectName),
          } satisfies WorkspacePackageResolution;
        }).pipe(Effect.provideContext(apiContext), Effect.mapError(toPlatformError)),
    );

    return {
      createWorkspace,
      findWorkspaceByKey,
      fenceWorkspaceCreate,
      getWorkspace,
      getRun,
      runHarness,
      startHarness,
      startHarnessInWorkspace,
      waitRun,
      openSession,
      forward,
      stopWorkspace,
      captureFlush,
      captureStatus,
      runtimeDeadline,
      runtimeResourceId,
      captureReplan,
      expireWorkspace,
      getSession,
      sessionOutput,
      exec,
      bindWorkspace,
      diffCommits,
      inferenceRespond,
      recordStream,
      recordTimeline,
      recordCommands,
      recordScrollback,
      runChanges,
      connectionCheck,
      resolveWorkspacePackage,
    } satisfies SealantClientShape;
  });

// ─── Per-user clients ────────────────────────────────────────────────────────

/** A Sealant user's credentials, as the settings page and `mend accounts` show them. */
export interface ConnectedAccountsApi {
  readonly list: () => Effect.Effect<ReadonlyArray<ConnectedAccount>, SealantPlatformError>;
  readonly connect: (
    input: ConnectAccountInput,
  ) => Effect.Effect<ConnectedAccount, SealantPlatformError>;
  readonly disconnect: (id: string) => Effect.Effect<ConnectedAccount, SealantPlatformError>;
}

/** A user's SSH public keys on the platform — what the workspace SSH gateway resolves. */
export interface SshKeysApi {
  /** Idempotent per owner: re-offering the same key returns the existing row. */
  readonly ensure: (input: {
    readonly publicKey: string;
    readonly name?: string;
  }) => Effect.Effect<SshKey, SealantPlatformError>;
  readonly list: () => Effect.Effect<ReadonlyArray<SshKey>, SealantPlatformError>;
}

/**
 * One client per Sealant user, built on first use and kept for the process
 * (docs/SEALANT-IDENTITY.md). Mend authenticates as a service principal; each
 * user's client is the same service key with that user's Sealant id as owner.
 * The Sealant user is provisioned on first use (`users.ensure`, idempotent on
 * the Mend account's email) and the mapping recorded in the identity store.
 */
export class SealantClients extends Context.Service<
  SealantClients,
  {
    /** The platform as a Mend user. Fails with code `UNKNOWN_USER` when the account is gone. */
    readonly forUser: (userId: string) => Effect.Effect<SealantClientShape, SealantPlatformError>;
    /** The platform for the principal in context. Fails with code `NO_PRINCIPAL` when unset. */
    readonly forPrincipal: () => Effect.Effect<SealantClientShape, SealantPlatformError>;
    /** The Sealant user id a Mend user acts as, provisioning it on first use. */
    readonly sealantUserId: (userId: string) => Effect.Effect<string, SealantPlatformError>;
    /** The user's Claude / Codex / GitHub accounts on the platform. */
    readonly connectedAccounts: (userId: string) => ConnectedAccountsApi;
    /** Workspace SSH gateway connect coordinates; null when the deployment exposes none. */
    readonly workspaceSshInfo: () => Effect.Effect<WorkspaceSshInfo | null, SealantPlatformError>;
    /** The user's SSH public keys — what the workspace SSH gateway resolves a connection to. */
    readonly sshKeys: (userId: string) => SshKeysApi;
    /**
     * The key Core keeps an image's per-person capability under (`workspaces.imageKey`): computed
     * from the create's image-shaping parts alone, with no call. The SDK builds the whole create
     * request to compute it, so options it would refuse at create fail here too, with its words.
     */
    readonly imageKey: (options: CreateOptions) => Effect.Effect<string, SealantPlatformError>;
    /**
     * What `create(options)` would build for the Mend user, read before the create
     * (`workspaces.inspectImage`, docs/adr/0016 decision 1): one call, nothing created.
     */
    readonly inspectImage: (
      userId: string,
      options: CreateOptions,
    ) => Effect.Effect<WorkspaceImageInspection, SealantPlatformError>;
    /**
     * What the control plane can do that an older one cannot (`sealant.features()`, Core
     * 0.39.0-next.706): its as-user routes, the dotfiles verb, partial puts, pi's and opencode's
     * logins and the capture owner map. Read once and kept five minutes by the SDK.
     */
    readonly controlPlaneFeatures: () => Effect.Effect<SealantFeatures, SealantPlatformError>;
  }
>()("@mend/sealant/SealantClients") {}

const toConnectedAccount = (wire: {
  readonly connectedAccountId: string;
  readonly provider: ConnectedAccount["provider"];
  readonly name: string;
  readonly kind: string;
  readonly status: ConnectedAccount["status"];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly connectedAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt: string | null;
}) =>
  new ConnectedAccount({
    id: wire.connectedAccountId,
    provider: wire.provider,
    name: wire.name,
    kind: wire.kind,
    status: wire.status,
    metadata: wire.metadata,
    connectedAt: new Date(wire.connectedAt),
    updatedAt: new Date(wire.updatedAt),
    lastUsedAt: wire.lastUsedAt === null ? null : new Date(wire.lastUsedAt),
  });

const platformFailure = (code: string, message: string) =>
  new SealantPlatformError({ code, status: null, message, cause: null });

const toSshKey = (wire: {
  readonly sshKeyId: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly algorithm: string;
  readonly fingerprint: string;
  readonly createdAt: string;
}): SshKey => ({
  sshKeyId: wire.sshKeyId,
  ownerUserId: wire.ownerUserId,
  name: wire.name,
  algorithm: wire.algorithm,
  fingerprint: wire.fingerprint,
  createdAt: wire.createdAt,
});

export const SealantClientsLive: Layer.Layer<
  SealantClients,
  never,
  SealantEnv | SealantIdentityStore
> = Layer.effect(
  SealantClients,
  Effect.gen(function* () {
    const env = yield* SealantEnv;
    const identities = yield* SealantIdentityStore;
    const scope = yield* Effect.scope;

    // The service-level client: provisions users. Bound to no owner on purpose.
    const adminConfig = publicConfigOf(env);
    const admin = yield* Effect.acquireRelease(
      Effect.sync(() => new Sealant(adminConfig)),
      (client) => Effect.promise(() => client.close()),
    );
    const adminContext = yield* Layer.build(
      sealantApiClientLayer(resolveInternalConfig(adminConfig)),
    );

    // Per-Sealant-user clients, built once for the process. A failed build is
    // not kept, so a transient outage at first use does not poison the user.
    const clients = new Map<string, SealantClientShape>();
    const building = new Map<string, Effect.Effect<SealantClientShape, SealantPlatformError>>();
    const clientFor = Effect.fn("SealantClients.clientFor")(function* (sealantUserId: string) {
      const ready = clients.get(sealantUserId);
      if (ready !== undefined) return ready;
      const inFlight = building.get(sealantUserId);
      if (inFlight !== undefined) return yield* inFlight;
      const build = makeUserClient(env, sealantUserId).pipe(
        Effect.mapError(toPlatformError),
        Effect.provideService(Scope.Scope, scope),
        Effect.tap((client) => Effect.sync(() => clients.set(sealantUserId, client))),
        Effect.ensuring(Effect.sync(() => building.delete(sealantUserId))),
        Effect.cached,
        Effect.flatten,
      );
      building.set(sealantUserId, build);
      return yield* build;
    });

    const sealantUserIdFor = Effect.fn("SealantClients.sealantUserId")(function* (userId: string) {
      const recorded = yield* identities.sealantUserId(userId);
      if (recorded !== null) return recorded;
      const user = yield* identities.user(userId);
      if (user === null) {
        return yield* platformFailure("UNKNOWN_USER", `Mend user ${userId} does not exist`);
      }
      const ensured = yield* wrap(() => admin.users.ensure({ email: user.email, name: user.name }));
      yield* identities.record(userId, ensured.userId);
      yield* Effect.logInfo("sealant identity: mapped user").pipe(
        Effect.annotateLogs({
          userId,
          sealantUserId: ensured.userId,
          created: ensured.created,
        }),
      );
      return ensured.userId;
    });

    const forUser = Effect.fn("SealantClients.forUser")(function* (userId: string) {
      const sealantUserId = yield* sealantUserIdFor(userId);
      return yield* clientFor(sealantUserId);
    });

    const forPrincipal = Effect.fn("SealantClients.forPrincipal")(function* () {
      const principal = yield* SealantPrincipal;
      switch (principal.kind) {
        case "user":
          return yield* forUser(principal.userId);
        case "none":
          return yield* platformFailure(
            "NO_PRINCIPAL",
            "Sealant call made without a principal (docs/SEALANT-IDENTITY.md)",
          );
      }
    });

    const connectedAccounts = (userId: string): ConnectedAccountsApi => {
      const withOwner = <A>(
        run: (ownerUserId: string) => Effect.Effect<A, unknown, SealantApiClient>,
      ): Effect.Effect<A, SealantPlatformError> =>
        sealantUserIdFor(userId).pipe(
          Effect.flatMap((ownerUserId) =>
            run(ownerUserId).pipe(
              Effect.provideContext(adminContext),
              Effect.mapError(toPlatformError),
            ),
          ),
        );
      return {
        list: () =>
          withOwner((ownerUserId) =>
            listConnectedAccountsOp(ownerUserId).pipe(
              Effect.map((response) => response.items.map(toConnectedAccount)),
            ),
          ),
        connect: (input) =>
          withOwner((ownerUserId) =>
            createConnectedAccountOp({
              ownerUserId,
              provider: input.provider,
              secret: input.secret,
              ...(input.name === undefined ? {} : { name: input.name }),
            }).pipe(Effect.map(toConnectedAccount)),
          ),
        disconnect: (id) =>
          withOwner((ownerUserId) =>
            archiveConnectedAccountOp(id, ownerUserId).pipe(Effect.map(toConnectedAccount)),
          ),
      };
    };

    const workspaceSshInfo = Effect.fn("SealantClients.workspaceSshInfo")(function* () {
      const state = yield* getSetupStateOp().pipe(
        Effect.provideContext(adminContext),
        Effect.mapError(toPlatformError),
      );
      return state.sshGateway === null
        ? null
        : {
            host: state.sshGateway.host,
            port: state.sshGateway.port,
            usernamePrefix: state.sshGateway.usernamePrefix,
          };
    });

    const sshKeys = (userId: string): SshKeysApi => {
      const withOwner = <A>(
        run: (ownerUserId: string) => Effect.Effect<A, unknown, SealantApiClient>,
      ): Effect.Effect<A, SealantPlatformError> =>
        sealantUserIdFor(userId).pipe(
          Effect.flatMap((ownerUserId) =>
            run(ownerUserId).pipe(
              Effect.provideContext(adminContext),
              Effect.mapError(toPlatformError),
            ),
          ),
        );
      return {
        ensure: (input) =>
          withOwner((ownerUserId) =>
            createSshKeyOp({
              ownerUserId,
              publicKey: input.publicKey,
              ...(input.name === undefined ? {} : { name: input.name }),
            }).pipe(Effect.map(toSshKey)),
          ),
        list: () =>
          withOwner((ownerUserId) =>
            listSshKeysOp(ownerUserId).pipe(Effect.map((response) => response.items.map(toSshKey))),
          ),
      };
    };

    // One facade per Sealant user for reads the Effect core does not carry (`inspectImage`),
    // made on first use and kept for the process.
    const facades = new Map<string, Sealant>();
    const facadeFor = (sealantUserId: string) =>
      Effect.suspend(() => {
        const known = facades.get(sealantUserId);
        if (known !== undefined) return Effect.succeed(known);
        return Effect.acquireRelease(
          Effect.sync(() => {
            const made = new Sealant(publicConfigOf(env, sealantUserId));
            facades.set(sealantUserId, made);
            return made;
          }),
          (client) =>
            Effect.promise(() => client.close()).pipe(
              Effect.ensuring(Effect.sync(() => facades.delete(sealantUserId))),
            ),
        ).pipe(Effect.provideService(Scope.Scope, scope));
      });

    const imageKey = (options: CreateOptions) =>
      Effect.try({ try: () => admin.workspaces.imageKey(options), catch: toPlatformError });

    const inspectImage = Effect.fn("SealantClients.inspectImage")(function* (
      userId: string,
      options: CreateOptions,
    ) {
      const facade = yield* facadeFor(yield* sealantUserIdFor(userId));
      return yield* wrap(() => facade.workspaces.inspectImage(options));
    });

    const controlPlaneFeatures = Effect.fn("SealantClients.controlPlaneFeatures")(function* () {
      return yield* wrap(() => admin.features());
    });

    return {
      forUser,
      forPrincipal,
      sealantUserId: sealantUserIdFor,
      connectedAccounts,
      workspaceSshInfo,
      sshKeys,
      imageKey,
      inspectImage,
      controlPlaneFeatures,
    };
  }),
);

// ─── The dispatching client ──────────────────────────────────────────────────

/**
 * `SealantClient` for whichever principal is in context. Every method resolves
 * the principal's client at call time, so one layer serves every request and
 * every session fiber. Streams unwrap the same way.
 */
export const SealantClientLive: Layer.Layer<SealantClient, never, SealantClients> = Layer.effect(
  SealantClient,
  Effect.gen(function* () {
    const clients = yield* SealantClients;
    const current = clients.forPrincipal();
    const via = <A>(
      call: (client: SealantClientShape) => Effect.Effect<A, SealantPlatformError>,
    ): Effect.Effect<A, SealantPlatformError> => Effect.flatMap(current, call);
    const viaStream = <A>(
      call: (client: SealantClientShape) => Stream.Stream<A, SealantPlatformError>,
    ): Stream.Stream<A, SealantPlatformError> => Stream.unwrap(Effect.map(current, call));

    return {
      createWorkspace: (options, launch, watch) =>
        via((c) => c.createWorkspace(options, launch, watch)),
      findWorkspaceByKey: (key) => via((c) => c.findWorkspaceByKey(key)),
      fenceWorkspaceCreate: (key) => via((c) => c.fenceWorkspaceCreate(key)),
      getWorkspace: (id) => via((c) => c.getWorkspace(id)),
      getRun: (runId) => via((c) => c.getRun(runId)),
      runHarness: (workspace, prompt, options) =>
        via((c) => c.runHarness(workspace, prompt, options)),
      startHarness: (workspace, prompt, options) =>
        via((c) => c.startHarness(workspace, prompt, options)),
      startHarnessInWorkspace: (workspaceId, harness, prompt) =>
        via((c) => c.startHarnessInWorkspace(workspaceId, harness, prompt)),
      waitRun: (run) => via((c) => c.waitRun(run)),
      openSession: (workspace, argv, options) =>
        via((c) => c.openSession(workspace, argv, options)),
      forward: (workspace, port, host, protocol) =>
        via((c) => c.forward(workspace, port, host, protocol)),
      stopWorkspace: (workspace, options) => via((c) => c.stopWorkspace(workspace, options)),
      captureFlush: (workspace, kind) => via((c) => c.captureFlush(workspace, kind)),
      captureStatus: (workspace) => via((c) => c.captureStatus(workspace)),
      runtimeDeadline: (workspace) => via((c) => c.runtimeDeadline(workspace)),
      runtimeResourceId: (workspace, launchId) =>
        via((c) => c.runtimeResourceId(workspace, launchId)),
      captureReplan: (workspace, options) => via((c) => c.captureReplan(workspace, options)),
      expireWorkspace: (workspaceId, ttlSeconds) =>
        via((c) => c.expireWorkspace(workspaceId, ttlSeconds)),
      getSession: (workspace, sessionId) => via((c) => c.getSession(workspace, sessionId)),
      sessionOutput: (sessionId, options) => via((c) => c.sessionOutput(sessionId, options)),
      exec: (workspace, argv, options) => via((c) => c.exec(workspace, argv, options)),
      bindWorkspace: (workspace, options) => via((c) => c.bindWorkspace(workspace, options)),
      diffCommits: (workspaceId, base, head) => via((c) => c.diffCommits(workspaceId, base, head)),
      inferenceRespond: (options) => via((c) => c.inferenceRespond(options)),
      recordStream: (run, options) => viaStream((c) => c.recordStream(run, options)),
      recordTimeline: (run, options) => viaStream((c) => c.recordTimeline(run, options)),
      recordCommands: (run) => via((c) => c.recordCommands(run)),
      recordScrollback: (run, processId, stream) =>
        via((c) => c.recordScrollback(run, processId, stream)),
      runChanges: (run) => via((c) => c.runChanges(run)),
      // Never fails: a missing principal or identity is reported as the observation.
      connectionCheck: () =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          return yield* current.pipe(
            Effect.flatMap((c) => c.connectionCheck()),
            Effect.catch((error) =>
              Effect.succeed(
                new SealantConnection({
                  status: connectionStatusOf(error.cause ?? error),
                  baseUrl: "",
                  detail: error.message,
                  checkedAt: new Date(now),
                }),
              ),
            ),
          );
        }),
      resolveWorkspacePackage: (packageName, os) =>
        via((c) => c.resolveWorkspacePackage(packageName, os)),
    } satisfies SealantClientShape;
  }),
);

/** Both live layers over the process environment, for the application composition root. */
export const SealantLiveFromEnv: Layer.Layer<
  SealantClient | SealantClients,
  Config.ConfigError,
  SealantIdentityStore
> = SealantClientLive.pipe(Layer.provideMerge(SealantClientsLive), Layer.provide(SealantEnv.layer));

/** The facade's `true` means "the account named default"; the wire wants a name or nothing. */
const accountReference = (value: boolean | string | undefined) =>
  typeof value === "string" ? value : value === true ? "default" : undefined;

/** The wire's optional `usage` needs re-narrowing under exactOptionalPropertyTypes. */
const toInferenceResponse = (wire: {
  readonly sessionId: string;
  readonly turn: InferenceResponse["turn"];
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } | undefined;
}): InferenceResponse => ({
  sessionId: wire.sessionId,
  turn: wire.turn,
  ...(wire.usage === undefined ? {} : { usage: wire.usage }),
});

/** The tag of a typed contract error, when the value carries one. */
const tagOf = (value: unknown): string | null => {
  if (typeof value === "object" && value !== null && "_tag" in value) {
    const tag: unknown = value["_tag"];
    return typeof tag === "string" ? tag : null;
  }
  return null;
};

/**
 * The stable code a typed contract error carries in its body (`runtime-env-references-unsupported`,
 * `workspace-docker-unsupported`), when there is one. The SDK's `SealantApiError.code` is the
 * error's TAG (`WorkspaceDockerServiceUnsupportedError`) and keeps the decoded contract error as its
 * `cause`; the body code is the capability probe the engine branches on, so it wins over the tag.
 */
const stableCodeOf = (value: unknown): string | null => {
  const record = value instanceof SealantError ? value.cause : value;
  if (typeof record === "object" && record !== null && "code" in record) {
    const code: unknown = record["code"];
    return typeof code === "string" && code !== "" ? code : null;
  }
  return null;
};

/**
 * The code `SealantPlatformError` carries: the body's stable code (`SealantApiError.reason`, or the
 * decoded contract error's own), else the SDK/tag code.
 */
export const platformErrorCode = (cause: unknown): string =>
  (cause instanceof SealantApiError && cause.reason !== undefined && cause.reason !== ""
    ? cause.reason
    : null) ??
  stableCodeOf(cause) ??
  (cause instanceof SealantError ? cause.code : (tagOf(cause) ?? "UNKNOWN"));

/**
 * A launch whose image build Core gave up on (sealant#342), in words a person can act on, with the
 * SDK's own (which name the step it stopped on) after them. Any other failure as it is.
 */
export const imageBuildFailure = (error: SealantPlatformError): SealantPlatformError => {
  const lead =
    error.code === "workspace_image_build_stalled"
      ? "the workspace image build stopped making progress, so nothing was started"
      : error.code === "workspace_image_build_timeout"
        ? "the workspace image build ran past its time limit, so nothing was started"
        : null;
  return lead === null
    ? error
    : new SealantPlatformError({
        code: error.code,
        status: error.status,
        message: `${lead}: ${error.message}`,
        cause: error,
      });
};

export const toPlatformError = (cause: unknown) => {
  const provider = cause instanceof SealantApiError ? cause.provider : undefined;
  return new SealantPlatformError({
    code: platformErrorCode(cause),
    status: cause instanceof SealantApiError ? (cause.status ?? null) : null,
    message: cause instanceof Error ? cause.message : String(cause),
    ...(provider === undefined ? {} : { provider }),
    cause,
  });
};

/**
 * Maps a typed contract failure onto what the settings page reports. A typed
 * error means the control plane answered; only a transport-level failure is
 * "unreachable".
 */
const connectionStatusOf = (error: unknown) => {
  switch (tagOf(error)) {
    case "WorkspaceUnauthorizedError":
    case "WorkspaceForbiddenError":
      return "unauthorized" as const;
    case "HttpClientError":
      return "unreachable" as const;
    default:
      return "mismatched" as const;
  }
};

const wrap = <A>(run: () => Promise<A>): Effect.Effect<A, SealantPlatformError> =>
  Effect.tryPromise({ try: run, catch: toPlatformError });
