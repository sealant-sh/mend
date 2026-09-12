import type { WorkspaceImageOs } from "@mend/domain";
import type {
  WorkspaceBind,
  WorkspaceBindOptions,
  CreateOptions,
  InferenceContinueOptions,
  InferenceRespondOptions,
  InferenceResponse,
  InteractiveSession,
  SessionOptions,
  Run,
  RunCommand,
  RunFileChange,
  RunOptions,
  TimelineEntry,
  Workspace,
  WorkspaceExecOptions,
  WorkspaceExecResult,
  WorkspaceForward,
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
import { Clock, type Config, Effect, Layer, Option, Redacted, Scope, Stream } from "effect";
import * as Context from "effect/Context";

import { ConnectedAccount, type ConnectAccountInput } from "./accounts.ts";
import { SealantEnv } from "./config.ts";
import { SealantConnection } from "./connection.ts";
import { SealantPlatformError } from "./errors.ts";
import { SealantIdentityStore } from "./identity.ts";
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
 * A CAPTURE-sourced workspace (sealantd ADR-0015, Mend ADR-0002): nothing is mounted and nothing
 * is cloned — the daemon fetches the worktree's head plan from the session channel at `endpoint`,
 * materialises it onto its own disk and claims the lease. The channel credential rides the
 * request top level as `captureToken`, sealed into the boot env file as `SEALANT_CAPTURE_TOKEN`.
 *
 * SEAM: the published `@sealant/sdk` (catalog 0.28.0) does not know this source yet; Core PR
 * sealant#231 (branch feat/capture-workspace-source) adds it to `workspaceSourceSchema` and
 * `CreateOptions`. Until that release lands, this is the one place Mend widens the create payload
 * structurally — see PLATFORM-FEEDBACK.md.
 */
export interface WorkspaceCaptureSource {
  readonly kind: "capture";
  readonly endpoint: string;
  readonly worktreeId: string;
  /** `<os>-<arch>-<libc>` placement hint, recorded by the platform, never seen by the daemon. */
  readonly platform?: string | undefined;
}

export type CaptureCreateOptions = Omit<CreateOptions, "source" | "mounts"> & {
  readonly source: WorkspaceCaptureSource;
  readonly captureToken: string;
};

export interface SealantClientShape {
  readonly createWorkspace: (
    options: CreateOptions | CaptureCreateOptions,
  ) => Effect.Effect<Workspace, SealantPlatformError>;
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
    options?: SessionOptions,
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
  /** Reattach to a PTY session by id — works from any workspace handle. */
  /** Stop the workspace: remove its container, settle it "stopped". */
  readonly stopWorkspace: (workspace: Workspace) => Effect.Effect<void, SealantPlatformError>;
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
    options?: WorkspaceExecOptions,
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
  /** The before/after of what a run changed: file list plus the unified diff. */
  readonly runChanges: (run: Run) => Effect.Effect<
    {
      readonly files: ReadonlyArray<RunFileChange>;
      readonly diff: string;
    },
    SealantPlatformError
  >;
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

    const createWorkspace = Effect.fn("SealantClient.createWorkspace")(
      (options: CreateOptions | CaptureCreateOptions) =>
        // The SDK 0.28.0 type predates the capture source (Core PR sealant#231); the control
        // plane on that branch validates the shape, so the payload passes through as-is.
        wrap(() => sealant.workspaces.create(options as CreateOptions)),
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

    const openSession = Effect.fn("SealantClient.openSession")(
      (workspace: Workspace, argv: ReadonlyArray<string>, options?: SessionOptions) =>
        wrap(() => workspace.sessions.open(argv, options)),
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

    const stopWorkspace = Effect.fn("SealantClient.stopWorkspace")((workspace: Workspace) =>
      wrap(() => workspace.stop()),
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

    const exec = Effect.fn("SealantClient.exec")(
      (workspace: Workspace, argv: readonly string[], options?: WorkspaceExecOptions) =>
        wrap(() => workspace.exec(argv, options)),
    );
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
      wrap(async () => ({ files: run.changes.files, diff: await run.changes.diff() })),
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
      getWorkspace,
      getRun,
      runHarness,
      startHarness,
      startHarnessInWorkspace,
      waitRun,
      openSession,
      forward,
      stopWorkspace,
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
        case "first-user": {
          const first = yield* identities.firstUser();
          if (first === null) {
            return yield* platformFailure("NO_PRINCIPAL", "no Mend account exists yet to act as");
          }
          return yield* forUser(first.id);
        }
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

    return {
      forUser,
      forPrincipal,
      sealantUserId: sealantUserIdFor,
      connectedAccounts,
      workspaceSshInfo,
      sshKeys,
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
      createWorkspace: (options) => via((c) => c.createWorkspace(options)),
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
      stopWorkspace: (workspace) => via((c) => c.stopWorkspace(workspace)),
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

/** The code `SealantPlatformError` carries: the body's stable code, else the SDK/tag code. */
export const platformErrorCode = (cause: unknown): string =>
  stableCodeOf(cause) ?? (cause instanceof SealantError ? cause.code : (tagOf(cause) ?? "UNKNOWN"));

const toPlatformError = (cause: unknown) =>
  new SealantPlatformError({
    code: platformErrorCode(cause),
    status: cause instanceof SealantApiError ? (cause.status ?? null) : null,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

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
