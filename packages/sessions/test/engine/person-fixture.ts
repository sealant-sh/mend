import { linuxLoginNameOf } from "@mend/db";
import {
  PersonLayoutPlatform,
  type PersonLogin,
  SealantClient,
  type SealantClientShape,
  SealantPlatformError,
  SealantPrincipal,
  type SealantPrincipalValue,
} from "@mend/sealant";
import { MendKeys } from "@mend/store";
import type { InteractiveSession } from "@sealant/sdk";
import { Deferred, Effect, Layer, Stream } from "effect";

// ─── per-person harness homes (docs/adr/0016) ─────────────────────────────

/** Second member account used by the person-engine scenarios. */
export const MARIA = "user-maria";

/** A prepare that made the launcher (`user-fixture`) and nobody else, as a fresh head does. */
export const LAYOUT_READY = `mend-layout probed\nmend-layout made ${linuxLoginNameOf("user-fixture")}\nmend-layout ready\n`;

/** The executor's first exec, carrying the layout's probe (a person's home exec carries none). */
export const isPrepare = (argv: ReadonlyArray<string>) =>
  (argv[2] ?? "").includes("layout_missing=0");

/** Every exec whose script carries the layout's own lines answers with `stdout`. */
export const answerLayout =
  (stdout: string) =>
  (argv: ReadonlyArray<string>): { exitCode: number; stdout: string; stderr: string } | undefined =>
    argv[0] === "sh" && isPrepare(argv) ? { exitCode: 0, stdout, stderr: "" } : undefined;

/** Shared personPlatform fixture for engine scenarios. */
export const personPlatform = (
  calls: Array<string>,
  report: { readonly person?: boolean | null; readonly missing?: ReadonlyArray<string> } = {},
  /**
   * The platform applies dotfiles as a person (`dotfiles.apply`, sealant#334): each person's
   * `install.sh` ends when their `bootstrapEnds` does; null runs none.
   */
  dotfiles?: {
    readonly bootstrapEnds: (user: string) => Deferred.Deferred<number> | null;
  },
  /** Each person's own login for a provider, as Core says it stands; `active` unless said. */
  logins?: (accountId: string) => PersonLogin,
  /** A login write Core does not complete: it did not answer (`true`), or it refused with this. */
  postFails?: (onBehalfOf: string, home: string) => boolean | SealantPlatformError,
  /** What the control plane says of itself, asked each time; it can run per person unless said. */
  controlPlane?: () => string | null,
  /** Core runs a workspace's SSH sessions as a user (`features.workspaceSshUser`); yes unless said. */
  sshUserReported = true,
  /** Core's answer to each `sshAsRoot`: taken unless said. */
  sshUserTaken: () => boolean = () => true,
  /** Whether the launcher's person binding is made in Core: yes unless said. */
  personBound = true,
): Layer.Layer<PersonLayoutPlatform> =>
  Layer.succeed(PersonLayoutPlatform, {
    dotfilesUser: dotfiles !== undefined,
    controlPlaneObstacle: Effect.sync(() => controlPlane?.() ?? null),
    sshUser: Effect.succeed(sshUserReported),
    sshAsOwnerFor: () =>
      Effect.succeed(!sshUserReported ? "not-taken" : personBound ? "yes" : "unbound"),
    sshAsRoot: () =>
      Effect.sync(() => {
        calls.push("ssh-user:root");
        return sshUserTaken();
      }),
    workspaceProcessUser: () => Effect.succeed("supported"),
    // Core 0.39.0-next.696 (sealant#333): the map rides the capture source, as the live layer does.
    withOwnerMap: (options, map) =>
      options.source?.kind === "capture"
        ? { ...options, source: { ...options.source, ownerMap: map } }
        : options,
    sealantUserOf: (accountId) => Effect.succeed(accountId),
    imageReport: () =>
      Effect.succeed({
        digest: "sha256:img",
        runtime: "docker",
        person: report.person ?? null,
        missing: report.missing ?? [],
      }),
    loginOf: (accountId) =>
      Effect.sync(() => {
        calls.push(`login:${accountId}`);
        return logins?.(accountId) ?? { _tag: "active" };
      }),
    postCredentials: (_workspace, input) =>
      Effect.suspend(() => {
        calls.push(`post:${input.onBehalfOf}:${input.home}`);
        const failed = postFails?.(input.onBehalfOf, input.home) ?? false;
        if (failed instanceof SealantPlatformError) return Effect.fail(failed);
        return failed
          ? Effect.fail(
              new SealantPlatformError({
                code: "control_plane_unavailable",
                status: 503,
                // A sentence, as Codex's own refusals are: the session line must not double its stop.
                message: "Core did not answer.",
                cause: null,
              }),
            )
          : Effect.succeed({ skipped: [] });
      }),
    deleteCredentials: (_workspace, input) =>
      Effect.sync(() => {
        calls.push(`delete:${input.home}`);
      }),
    listCredentials: () =>
      Effect.sync(() => {
        calls.push("list");
        return [];
      }),
    applyDotfiles: (_workspace, input) =>
      Effect.sync(() => {
        calls.push(`dotfiles:${input.user.name}:${input.home}`);
        const ends = dotfiles?.bootstrapEnds(input.user.name) ?? null;
        return {
          bootstrap:
            ends === null
              ? null
              : {
                  ended: Deferred.await(ends).pipe(Effect.map((exitCode) => ({ exitCode }))),
                },
        };
      }),
  });

// ─── git and Mend identity per process (docs/adr/0016, decision 4) ─────────

/** Each account's own Mend key, and who asked for one. */
export const perAccountKeys = (asked: Array<string>): Layer.Layer<MendKeys> =>
  Layer.succeed(MendKeys, {
    ensure: (userId) =>
      Effect.sync(() => {
        asked.push(String(userId));
        return {
          publicKey: `ssh-ed25519 ${userId}`,
          fingerprint: `256 SHA256:${userId}`,
          privateKeyPath: `/keys/${userId}`,
        };
      }),
    read: () => Effect.succeed(null),
  });

/** Whose principal a platform call is made under, as `workspacesPerOwner` records it. */
const userOf = (principal: SealantPrincipalValue) =>
  principal.kind === "none" ? "none" : principal.userId;

/**
 * The platform as Core serves it to more than one person (`MEND_TENANCY=multi`, each Mend user its
 * own Sealant user): a workspace, its interactive sessions and their runs belong to the Sealant
 * user who created the workspace, and every call about them by anyone else is a 404, as
 * `GET /v1/workspaces/<id>` answered the joiner on alpha. Stricter than Core in one way, so no
 * path can hide behind a handle: a call through a workspace handle is judged by the principal it
 * is made under, not by whose client fetched the handle. Every judged call lands in `seen` as
 * `<user>:<found|404>`, and in `calls` as `<method> <user>:<found|404>`.
 */
export const workspacesPerOwner = (
  inner: Layer.Layer<SealantClient>,
  seen: Array<string>,
  calls: Array<string> = [],
  ptys: {
    /** Every PTY the platform closed, by id: what a test reads to see a process really ended. */
    readonly closed?: Set<string>;
    /** While true, closing a PTY fails the way a platform that does not answer does. */
    readonly closeFails?: () => boolean;
    /** A defective lookup in one concurrent Stop must not interrupt the others. */
    readonly getSessionDefect?: (ptyId: string) => boolean;
  } = {},
): Layer.Layer<SealantClient> =>
  Layer.effect(
    SealantClient,
    Effect.map(SealantClient, (client): SealantClientShape => {
      const owners = new Map<string, string>();
      const runOwners = new Map<string, string>();
      const ptyOwners = new Map<string, string>();
      const notFound = new SealantPlatformError({
        code: "WorkspaceNotFoundError",
        status: 404,
        message: "workspace not found",
        cause: null,
      });
      const judge = (
        method: string,
        owner: string | undefined,
        principal: SealantPrincipalValue,
      ) => {
        const found = owner === undefined || owner === userOf(principal);
        const entry = `${userOf(principal)}:${found ? "found" : "404"}`;
        seen.push(entry);
        calls.push(`${method} ${entry}`);
        return found;
      };
      const guarded = <A, R = never>(
        method: string,
        ownerOf: () => string | undefined,
        call: () => Effect.Effect<A, SealantPlatformError, R>,
      ): Effect.Effect<A, SealantPlatformError, R> =>
        Effect.flatMap(SealantPrincipal, (principal) =>
          judge(method, ownerOf(), principal) ? call() : Effect.fail(notFound),
        );
      const guardedStream = <A>(
        method: string,
        ownerOf: () => string | undefined,
        call: () => Stream.Stream<A, SealantPlatformError>,
      ): Stream.Stream<A, SealantPlatformError> =>
        Stream.unwrap(
          Effect.map(SealantPrincipal, (principal) =>
            judge(method, ownerOf(), principal) ? call() : Stream.fail(notFound),
          ),
        );
      const ofWorkspace = (id: string) => () => owners.get(id);
      const ofRun = (id: string) => () => runOwners.get(id);
      return {
        createWorkspace: (options, launch, watch) =>
          Effect.flatMap(SealantPrincipal, (principal) =>
            client
              .createWorkspace(options, launch, watch)
              .pipe(
                Effect.tap((workspace) =>
                  Effect.sync(() => owners.set(workspace.id, userOf(principal))),
                ),
              ),
          ),
        findWorkspaceByKey: (key) => client.findWorkspaceByKey(key),
        fenceWorkspaceCreate: (key) => client.fenceWorkspaceCreate(key),
        getWorkspace: (id) =>
          guarded("getWorkspace", ofWorkspace(id), () => client.getWorkspace(id)),
        getRun: (runId) => guarded("getRun", ofRun(runId), () => client.getRun(runId)),
        runHarness: (workspace, prompt, options) =>
          guarded("runHarness", ofWorkspace(workspace.id), () =>
            client.runHarness(workspace, prompt, options),
          ),
        startHarness: (workspace, prompt, options) =>
          guarded("startHarness", ofWorkspace(workspace.id), () =>
            client.startHarness(workspace, prompt, options),
          ),
        startHarnessInWorkspace: (workspaceId, harness, prompt) =>
          guarded("startHarnessInWorkspace", ofWorkspace(workspaceId), () =>
            client.startHarnessInWorkspace(workspaceId, harness, prompt),
          ),
        waitRun: (run) => guarded("waitRun", ofRun(run.id), () => client.waitRun(run)),
        openSession: (workspace, argv, options) =>
          guarded("openSession", ofWorkspace(workspace.id), () =>
            client.openSession(workspace, argv, options).pipe(
              Effect.tap((pty) =>
                Effect.sync(() => {
                  const owner = owners.get(workspace.id);
                  if (owner === undefined) return;
                  runOwners.set(pty.runId, owner);
                  ptyOwners.set(pty.id, owner);
                }),
              ),
            ),
          ),
        forwardUdp: (workspace, port, host) =>
          guarded("forwardUdp", ofWorkspace(workspace.id), () =>
            client.forwardUdp(workspace, port, host),
          ),
        openForward: (workspace, port, destination, options) =>
          guarded("openForward", ofWorkspace(workspace.id), () =>
            client.openForward(workspace, port, destination, options),
          ),
        stopWorkspace: (workspace, options) =>
          guarded("stopWorkspace", ofWorkspace(workspace.id), () =>
            client.stopWorkspace(workspace, options),
          ),
        launchedRuntime: (workspace) =>
          guarded("launchedRuntime", ofWorkspace(workspace.id), () =>
            client.launchedRuntime(workspace),
          ),
        runtimeResourceId: (workspace, launchId) =>
          guarded("runtimeResourceId", ofWorkspace(workspace.id), () =>
            client.runtimeResourceId(workspace, launchId),
          ),
        captureFlush: (workspace, kind) =>
          guarded("captureFlush", ofWorkspace(workspace.id), () =>
            client.captureFlush(workspace, kind),
          ),
        captureStatus: (workspace) =>
          guarded("captureStatus", ofWorkspace(workspace.id), () =>
            client.captureStatus(workspace),
          ),
        captureReplan: (workspace) =>
          guarded("captureReplan", ofWorkspace(workspace.id), () =>
            client.captureReplan(workspace),
          ),
        runtimeDeadline: (workspace) =>
          guarded("runtimeDeadline", ofWorkspace(workspace.id), () =>
            client.runtimeDeadline(workspace),
          ),
        bootedImage: (workspace) =>
          guarded("bootedImage", ofWorkspace(workspace.id), () => client.bootedImage(workspace)),
        expireWorkspace: (workspaceId, ttlSeconds) =>
          guarded("expireWorkspace", ofWorkspace(workspaceId), () =>
            client.expireWorkspace(workspaceId, ttlSeconds),
          ),
        getSession: (workspace, sessionId) =>
          guarded("getSession", ofWorkspace(workspace.id), () =>
            (ptys.getSessionDefect?.(sessionId) === true
              ? Effect.die("injected process lookup defect")
              : client.getSession(workspace, sessionId)
            ).pipe(
              Effect.map(
                (pty): InteractiveSession => ({
                  ...pty,
                  close: async () => {
                    if (ptys.closeFails?.() === true) {
                      throw new SealantPlatformError({
                        code: "control_plane_unavailable",
                        status: 503,
                        message: "the control plane did not answer",
                        cause: null,
                      });
                    }
                    ptys.closed?.add(pty.id);
                    await pty.close();
                  },
                }),
              ),
            ),
          ),
        sessionOutput: (sessionId, options) =>
          guarded(
            "sessionOutput",
            () => ptyOwners.get(sessionId),
            () => client.sessionOutput(sessionId, options),
          ),
        exec: (workspace, argv, options) =>
          guarded("exec", ofWorkspace(workspace.id), () => client.exec(workspace, argv, options)),
        bindWorkspace: (workspace, options) =>
          guarded("bindWorkspace", ofWorkspace(workspace.id), () =>
            client.bindWorkspace(workspace, options),
          ),
        diffCommits: (workspaceId, base, head) =>
          guarded("diffCommits", ofWorkspace(workspaceId), () =>
            client.diffCommits(workspaceId, base, head),
          ),
        inferenceRespond: (options) => client.inferenceRespond(options),
        recordStream: (run, options) =>
          guardedStream("recordStream", ofRun(run.id), () => client.recordStream(run, options)),
        recordTimeline: (run, options) =>
          guardedStream("recordTimeline", ofRun(run.id), () => client.recordTimeline(run, options)),
        recordCommands: (run) =>
          guarded("recordCommands", ofRun(run.id), () => client.recordCommands(run)),
        recordScrollback: (run, processId, stream) =>
          guarded("recordScrollback", ofRun(run.id), () =>
            client.recordScrollback(run, processId, stream),
          ),
        runChanges: (run) => guarded("runChanges", ofRun(run.id), () => client.runChanges(run)),
        connectionCheck: () => client.connectionCheck(),
        resolveWorkspacePackage: (packageName, targetOs) =>
          client.resolveWorkspacePackage(packageName, targetOs),
      };
    }),
  ).pipe(Layer.provide(inner));
