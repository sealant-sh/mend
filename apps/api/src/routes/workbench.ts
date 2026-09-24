import * as fs from "node:fs";

import {
  ChangeDiff,
  ChangedFileView,
  ChangeStats,
  CurrentUser,
  GitAccessView,
  GitBridgeStatusView,
  GitKeyView,
  EnvironmentLoadedEntry,
  EnvironmentLoadReport,
  EnvironmentRejected,
  EnvironmentRejectedEntry,
  EnvironmentStaleWrite,
  MendApi,
  NotFound,
  PastedImage,
  PastedImageRejected,
  ProjectBranch,
  ProjectCapabilities,
  ProjectDetail,
  ProjectEnvironmentMutationResult,
  ProjectFileListing,
  ProjectHotSessionsStatus,
  ProjectPullRequests,
  ProjectSecretMutationResult,
  ClusterBindingDuplicate,
  ClusterBindingMutationResult,
  ClusterBindingRejected,
  ClusterServiceAccountResult,
  ProjectClusterBindingsView,
  ProjectWorkspaceImageSaveResult,
  ProcessLogPage,
  DotfilesSnapshotFileView,
  DotfilesSnapshotView,
  DotfilesView,
  HandoffUnsupported,
  ObservationStamp,
  OpenReviewResult,
  ProtocolSessionNotLive,
  AgentRequestResolved,
  RemovalReport,
  ReviewDiffFileView,
  ReviewDiffHunkView,
  ReviewDiffView,
  SessionActive,
  SessionAnnotation,
  WorktreeAnnotation,
  SessionControlView,
  SessionDetail,
  SessionNotSteerable,
  SessionNotLive,
  SettingsFailure,
  StoreFailure,
  SessionTranscript,
  TranscriptEvent,
  WorkspacePackageResolutionView,
} from "@mend/api-contracts";
import {
  ProjectLinksRepo,
  AgentConversationRepo,
  AuditEventsRepo,
  SessionControlEventsRepo,
  ChangePassesRepo,
  ChangeLandingsRepo,
  ChangeToursRepo,
  CheckpointsRepo,
  FollowUpsRepo,
  HotWorkspacesRepo,
  OrganizationsRepo,
  ProjectClusterBindingsRepo,
  ProjectEnvironmentRepo,
  ProjectMountsRepo,
  ProjectNotFoundError,
  ProjectSecretsRepo,
  ProjectServiceRecipesRepo,
  ProjectsRepo,
  ProjectEnvironmentDuplicateNameError,
  ProjectEnvironmentInvalidInputError,
  ProjectEnvironmentLimitError,
  ReferencesRepo,
  ReviewCommentsRepo,
  ReviewSlicesRepo,
  ServiceForwardsRepo,
  ServiceObservationsRepo,
  ServicesRepo,
  SessionProcessesRepo,
  WorktreeChangesRepo,
  WorktreesRepo,
  SessionsRepo,
  SettingsRepo,
  UserDotfilesRepo,
  UserEvents,
  UserGitAccessRepo,
} from "@mend/db";
import {
  dotfilesRepositoryUrlCredentialIssue,
  MendSettings,
  workspaceImagesEqual,
  type ChangeId,
  ProjectId,
  ReferenceId,
  type ReviewSliceId,
  type SessionId,
  type WorktreeId,
} from "@mend/domain";
import {
  DiffDigest,
  ReviewCommentAnchor,
  currentAgentProcess,
  isAgentProcessKind,
  type ReviewSlice,
  formatProjectEnvironmentIssue,
  parseDotenv,
  resolveServiceEndpoints,
  routeDotenvName,
  validateProjectSecretValue,
  ServiceView,
  canChangeVisibility,
  canManageProject,
  canSteerSession,
  canToggleSharedControl,
  type SessionControlKind,
  canRemoveProject,
  type GitAuthMode,
  type SessionStatus,
} from "@mend/domain/workbench";
import { JobRunner } from "@mend/jobs";
import { asSealantUser, SealantClient } from "@mend/sealant";
import {
  CaptureRuntime,
  DotfilesCloner,
  FollowUpDelivery,
  RECIPE_NAME,
  type ReadStamp,
  SessionEngine,
  WorktreeReads,
  type WorktreeReadError,
  stampLabel,
  storePastedImage,
} from "@mend/sessions";
import {
  AgentBridge,
  DeploymentConfig,
  MendKeys,
  SecretCipher,
  Store,
  DotfilesStore,
  ChangeSummary,
  describeGitRemoteFailure,
  harnessHomePathOf,
  referenceDirectory,
  resolveRemoteEnv,
  worktreePathOf,
  type DiffFileFact,
  type GitError,
  SourcePolicy,
} from "@mend/store";
import { Effect, Option, Result, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { ProjectAccess } from "../access.ts";
import { Budgets } from "../budgets.ts";
import { GithubIdentity } from "../github-identity.ts";
import { HostEnvironment } from "../services/host-environment.ts";
import {
  resolveWorkspaceEnvironment,
  saveResolvedWorkspaceEnvironment,
} from "../services/workspace-environment.ts";
import { budgetExceeded } from "../session-budgets.ts";
import { makeSessionStart } from "../session-start.ts";
import { SessionSteering } from "../session-steering.ts";
import { TenancyConfig } from "../tenancy.ts";
import { classifyGhError, Gh, parseGithubRepo } from "./github.ts";
import { digestReviewPatch, lineAnchorExists, parseReviewDiff } from "./review-diff.ts";

/**
 * The workbench handlers (plan §6): projects, sessions, and the session
 * change. Everything here is host-side — repos, the store, the engine; the
 * platform enters only when a session is launched, which is not an API
 * concern yet (the CLI launches; the API steers and reviews).
 */

/**
 * Directory-, mount-, and shell-safe store names (projects and references
 * both become store directories); the leading [a-z0-9] also keeps the store's
 * `_references/` dir collision-free.
 */
const STORE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A file listing answers at most this many paths; `truncated` says when it bit. */
const FILE_LISTING_LIMIT = 20_000;

const decodeChangeSummaryJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ChangeSummary));

const fileListingFailure = (error: { readonly stderr: string }) =>
  new StoreFailure({ message: error.stderr === "" ? "git could not list files" : error.stderr });

/** A worktree read that could not be served — the observed reason, in the read's own words. */
export const readFailure = (error: WorktreeReadError): StoreFailure =>
  new StoreFailure({
    message:
      error._tag === "GitError"
        ? error.stderr === ""
          ? "git could not read the worktree"
          : error.stderr
        : error._tag === "WorktreeNotCapturedError"
          ? error.message
          : error._tag === "ProjectNotFoundError"
            ? `project ${error.projectId} not found`
            : `worktree ${error.id} not found`,
  });

/** The stamp every change read carries (ADR-0002 "Review"): where the bytes were observed. */
const observationOf = (stamp: ReadStamp, state: "claimed" | "observed" = "observed") =>
  new ObservationStamp({
    state,
    source: stamp.source,
    captureN: stamp.captureN,
    captureId: stamp.captureId,
    seq: stamp.seq,
    partial: stamp.partial,
    observedAt: stamp.observedAt,
    label: state === "claimed" ? `claimed at capture ${stamp.captureN ?? "?"}` : stampLabel(stamp),
  });

/** The pull-request answer for a project that cannot have any on GitHub. */
const noPullRequests = (origin: "none" | "not-github", availability: "no-origin" | "not-github") =>
  new ProjectPullRequests({
    origin,
    repo: null,
    availability,
    detail: null,
    pullRequests: [],
    fetchedAt: null,
  });

const reviewDiffViews = (patch: string, facts: ReadonlyArray<DiffFileFact>) =>
  parseReviewDiff(patch, facts).map(
    (file) =>
      new ReviewDiffFileView({
        ...file,
        hunks: file.hunks.map((hunk) => new ReviewDiffHunkView(hunk)),
      }),
  );

/** Live session states — removal refuses these; project removal stops them. */
/**
 * Refuse a git remote Mend may not reach for this caller (docs/adr/0003, "Multi mode gate"), before
 * any clone or fetch. The message names the rule, never the addresses a host resolved to.
 */
const reachableSource = <E>(source: string, toError: (message: string) => E) =>
  Effect.gen(function* () {
    const caller = yield* CurrentUser;
    const isOperator = yield* (yield* ProjectAccess).isOperator(caller.user.id);
    const policy = yield* SourcePolicy;
    const clearance = yield* policy
      .check(source, { isOperator })
      .pipe(Effect.mapError((refused) => toError(refused.message)));
    // The git that runs next dials the address just checked (DNS rebinding).
    return (env: Readonly<Record<string, string>>) => policy.pinnedEnv(clearance, env);
  });

export const LIVE_STATES: ReadonlySet<SessionStatus> = new Set([
  "starting",
  "running",
  "waiting",
  "idle",
]);

/** The session rows returned by project detail and the number omitted from that response. */
interface ProjectSessionVisibility<SessionRow> {
  /** Sessions visible to this project detail request. */
  readonly sessions: ReadonlyArray<SessionRow>;
  /** Ended sessions omitted because Mend captured no transcript. */
  readonly hiddenEndedSessions: number;
}

/**
 * Apply project detail's transcript filter and report how many ended sessions it omitted.
 * Live sessions and sessions whose transcript state is still unknown always remain visible.
 */
const projectSessionVisibility = <
  SessionRow extends { readonly status: SessionStatus; readonly hasTranscript: boolean | null },
>(
  sessions: ReadonlyArray<SessionRow>,
  includeDeadEnds: boolean,
): ProjectSessionVisibility<SessionRow> => {
  if (includeDeadEnds) return { sessions, hiddenEndedSessions: 0 };

  const hiddenEndedSessions = sessions.filter(
    (session) => !LIVE_STATES.has(session.status) && session.hasTranscript === false,
  );
  return {
    sessions: sessions.filter(
      (session) => LIVE_STATES.has(session.status) || session.hasTranscript !== false,
    ),
    hiddenEndedSessions: hiddenEndedSessions.length,
  };
};

/**
 * Fingerprint-mutating handlers rewarm the project's hot pool: workspaces are created from these
 * inputs, so stale ready entries drain and rebuild. Coalesced and fire-and-forget in the engine —
 * the mutation's response never waits on a container.
 */
const rewarmHotSessions = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const engine = yield* SessionEngine;
    yield* engine.reconcileHotSessions(projectId);
  });

/** Dotfiles are per-user, so a change touches every project that keeps hot workspaces. */
const rewarmAllHotSessions = Effect.gen(function* () {
  const projects = yield* ProjectsRepo;
  const engine = yield* SessionEngine;
  const all = yield* projects.listAll();
  yield* Effect.forEach(
    all.filter((project) => project.hotSessions > 0),
    (project) => engine.reconcileHotSessions(project.id),
  );
});

/**
 * A remote git failure as a `StoreFailure`: a readable sentence when the
 * stderr matched a known ssh/auth shape (docs/GIT-ACCESS.md — permission
 * denied, unknown host key, timeout), the stderr verbatim when it didn't.
 */
const readableGitFailure = (error: GitError, mode: GitAuthMode): StoreFailure => {
  if (error.stderr === "") return new StoreFailure({ message: String(error) });
  const described = describeGitRemoteFailure(error.stderr, mode);
  return new StoreFailure({ message: described ?? error.stderr });
};

/**
 * The resolved env for a remote git op under `mode`, as the HTTP surface
 * reports refusals: the shared seam's typed errors become one StoreFailure
 * with the same readable lines as before (a hung clone would be worse than
 * an honest no).
 */
const remoteEnvFor = (mode: GitAuthMode, userId: string | null) =>
  resolveRemoteEnv(mode, userId).pipe(
    Effect.catchTag("NoSignerError", (error) => new StoreFailure({ message: error.message })),
    Effect.catchTag(
      "KeygenError",
      (error) => new StoreFailure({ message: `Could not create the Mend key: ${error.stderr}` }),
    ),
  );

/**
 * Attribute a bridge-signed op while it runs, so the share CLI of `userId`'s
 * bridge can print what asked for the signature. Non-bridge modes pass through
 * untouched.
 */
export const withSignerContext = <A, E, R>(
  mode: GitAuthMode,
  userId: string,
  description: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | AgentBridge> =>
  mode === "bridge"
    ? Effect.gen(function* () {
        const bridge = yield* AgentBridge;
        const end = yield* bridge.begin(userId, description);
        return yield* effect.pipe(Effect.ensuring(Effect.sync(() => end())));
      })
    : effect;

/**
 * One settings document; PUT replaces it (clients edit what GET returned). Machine settings are
 * the operator's (docs/adr/0003); every member reads them.
 */
export const SettingsGroupLive = HttpApiBuilder.group(MendApi, "settings", (handlers) =>
  handlers
    .handle("get", () =>
      Effect.gen(function* () {
        const settings = yield* SettingsRepo;
        return yield* settings.get();
      }),
    )
    .handle("scanHostEnvironment", () =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).requireOperator("settings");
        const hostEnvironment = yield* HostEnvironment;
        return yield* hostEnvironment.scan();
      }),
    )
    .handle("set", ({ payload }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).requireOperator("settings");
        const settings = yield* SettingsRepo;
        const current = yield* settings.get();
        if (workspaceImagesEqual(current.workspaceImage, payload.workspaceImage)) {
          return yield* settings.modify(
            (latest) => new MendSettings({ ...payload, workspaceImage: latest.workspaceImage }),
          );
        }

        const result = yield* saveResolvedWorkspaceEnvironment(
          payload.workspaceImage,
          (_latest, workspaceImage) => new MendSettings({ ...payload, workspaceImage }),
        );
        if (!result.saved) {
          const rejected = result.resolutions
            .filter((resolution) => resolution.status !== "resolved" || !resolution.supported)
            .map((resolution) =>
              resolution.status === "resolved"
                ? `${resolution.requested} (unsupported)`
                : `${resolution.requested} (${resolution.status})`,
            );
          const target =
            payload.workspaceImage.mode === "custom"
              ? payload.workspaceImage.baseImage
              : payload.workspaceImage.os;
          return yield* new SettingsFailure({
            message: `Workspace packages did not resolve for ${target}: ${rejected.join(", ")}.`,
          });
        }
        return result.settings;
      }),
    )
    .handle("setWorkspaceEnvironment", ({ payload }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).requireOperator("settings");
        return yield* saveResolvedWorkspaceEnvironment(
          payload,
          (latest, workspaceImage) => new MendSettings({ ...latest, workspaceImage }),
        );
      }),
    ),
);

export const ProjectsGroupLive = HttpApiBuilder.group(MendApi, "projects", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const access = yield* ProjectAccess;
        return yield* access.visibleProjects();
      }),
    )
    .handle("adopt", ({ payload }) =>
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo;
        const store = yield* Store;
        if (!STORE_NAME.test(payload.name)) {
          return yield* new StoreFailure({
            message: `"${payload.name}" is not a usable project name (lowercase letters, digits, ".", "_", "-").`,
          });
        }
        const caller = yield* CurrentUser;
        const organizations = yield* OrganizationsRepo;
        const membership = yield* organizations.membershipOf(caller.user.id);
        if (membership === null) {
          return yield* new StoreFailure({
            message: "This account belongs to no organization, so it cannot adopt projects.",
          });
        }
        const organizationId = membership.organization.id;
        const nameTaken = new StoreFailure({
          message: `A project named "${payload.name}" already exists.`,
        });
        if ((yield* projects.byName(organizationId, payload.name)) !== null) {
          return yield* nameTaken;
        }
        const pinned = yield* reachableSource(
          payload.source,
          (message) => new StoreFailure({ message }),
        );
        // The user's git access default decides a new project's mode unless the request says.
        const gitAccess = yield* UserGitAccessRepo;
        const mode = payload.gitAuthMode ?? (yield* gitAccess.mode(caller.user.id)) ?? "mend-key";
        const remoteEnv = pinned(yield* remoteEnvFor(mode, caller.user.id));
        // New stores are laid out by project id: names are unique only within an organization.
        const id = ProjectId.make(crypto.randomUUID());
        const adopted = yield* withSignerContext(
          mode,
          caller.user.id,
          `adopt ${payload.name} → ${payload.source}`,
          store
            .adopt(id, payload.source, remoteEnv)
            .pipe(Effect.mapError((error) => readableGitFailure(error.cause, mode))),
        );
        return yield* projects
          .create({
            id,
            organizationId,
            // Private unless the request says otherwise (docs/adr/0003): only the adopter sees a
            // new project until they or an owner share it. Every adopt surface offers the choice.
            visibility: payload.visibility ?? "private",
            createdByUserId: caller.user.id,
            name: payload.name,
            originUrl: payload.source,
            storePath: adopted.storePath,
            defaultBranch: adopted.defaultBranch,
            adoptedSha: adopted.headSha,
            gitAuthMode: mode,
          })
          .pipe(
            // Another adoption of the same name won the race; drop the clone this one made.
            Effect.catchTag("ProjectNameTakenError", () =>
              store
                .removeProjectStore(adopted.storePath)
                .pipe(Effect.andThen(Effect.fail(nameTaken))),
            ),
          );
      }),
    )
    .handle("detail", ({ params, query }) =>
      Effect.gen(function* () {
        const access = yield* ProjectAccess;
        const sessions = yield* SessionsRepo;
        const changes = yield* WorktreeChangesRepo;
        const worktrees = yield* WorktreesRepo;
        const project = yield* access.project(params.id);
        const viewer = yield* access.viewer();
        // A settled session with no transcript cannot be resumed or handed off: hidden by
        // default, listed only on request (`mend sessions --all`). Its worktree still lists.
        const sessionVisibility = projectSessionVisibility(
          yield* sessions.listForProject(params.id),
          query.deadEnds === "include",
        );
        const projectSessions = sessionVisibility.sessions;
        const worktreeRows = yield* worktrees.listForProject(params.id);
        const annotations = yield* changes.annotationsForProject(params.id);
        // One read for every session's processes; `currentAgent` is derived per session.
        const processes = yield* SessionProcessesRepo;
        const rows = yield* processes.listForSessions(projectSessions.map((session) => session.id));
        const bySession = new Map<string, Array<(typeof rows)[number]>>();
        for (const row of rows) {
          const list = bySession.get(row.sessionId);
          if (list === undefined) bySession.set(row.sessionId, [row]);
          else list.push(row);
        }
        return new ProjectDetail({
          project,
          sessions: projectSessions,
          hiddenEndedSessions: sessionVisibility.hiddenEndedSessions,
          annotations: annotations.map(
            (row) =>
              new SessionAnnotation({
                ...row,
                currentAgent: currentAgentProcess(bySession.get(row.sessionId) ?? []),
              }),
          ),
          // Embedded so worktree-aware lists never need a second fetch; the
          // key's presence is how clients detect a worktree-aware server.
          worktrees: worktreeRows,
          worktreeAnnotations: worktreeRows.map((row) => {
            const members = projectSessions.filter((session) => session.worktreeId === row.id);
            const memberIds = new Set<string>(members.map((session) => session.id));
            const facts = annotations.find((annotation) => memberIds.has(annotation.sessionId));
            return new WorktreeAnnotation({
              worktreeId: row.id,
              changeId: facts?.changeId ?? null,
              sessions: members.length,
              liveSessions: members.filter((session) => LIVE_STATES.has(session.status)).length,
              openComments: facts?.openComments ?? 0,
              totalComments: facts?.totalComments ?? 0,
              pendingFollowUp: annotations.some(
                (annotation) => memberIds.has(annotation.sessionId) && annotation.pendingFollowUp,
              ),
              currentAgent: currentAgentProcess(
                rows.filter((process) => memberIds.has(process.sessionId)),
              ),
            });
          }),
          capabilities: new ProjectCapabilities({
            manage: viewer !== null && canManageProject(project, viewer),
            changeVisibility: viewer !== null && canChangeVisibility(project, viewer),
            remove: viewer !== null && canRemoveProject(project, viewer),
            hostMounts:
              viewer !== null &&
              canManageProject(project, viewer) &&
              (yield* TenancyConfig).mode === "single" &&
              (yield* (yield* ProjectAccess).isOperator(viewer.userId)),
          }),
          mountDelivery: (yield* DeploymentConfig).sessionStore === "captured" ? "sources" : "bind",
        });
      }),
    )
    .handle("remove", ({ params }) =>
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo;
        const sessions = yield* SessionsRepo;
        const services = yield* ServicesRepo;
        const forwards = yield* ServiceForwardsRepo;
        const engine = yield* SessionEngine;
        const store = yield* Store;
        // Removal stops every session in the project, so it is narrower than managing it.
        const access = yield* ProjectAccess;
        const project = yield* access.manageProject(params.id);
        const viewer = yield* access.viewer();
        if (viewer === null || !canRemoveProject(project, viewer)) {
          return yield* new NotFound({ id: params.id });
        }
        // Stop every Service first. A forward-only adopted Service can retain a settled session's
        // workspace even though no session_process row is live.
        const projectSessions = yield* sessions.listForProject(params.id);
        for (const session of projectSessions) {
          for (const service of yield* services.listForSession(session.id)) {
            yield* engine.stopService(service.id).pipe(Effect.ignore);
          }
        }
        const projectSessionIds = new Set(projectSessions.map((session) => session.id));
        let remainingForwardLease = false;
        for (const forward of yield* forwards.listOpen()) {
          const service = yield* services.byId(forward.serviceId);
          if (service !== null && projectSessionIds.has(service.sessionId)) {
            remainingForwardLease = true;
            break;
          }
        }
        if (remainingForwardLease) {
          return yield* new StoreFailure({
            message: "The project still has live Service forwards. Stop them before removal.",
          });
        }
        yield* Effect.forEach(
          projectSessions.filter((session) => LIVE_STATES.has(session.status)),
          (session) => engine.stop(session.id).pipe(Effect.ignore),
          { concurrency: 4 },
        );
        // Hot workspaces too: their rows cascade with the project, but the containers would
        // otherwise burn until the platform TTL. Worktrees go with the store directory below.
        const hotWorkspaces = yield* HotWorkspacesRepo;
        const sealant = yield* SealantClient;
        const hotEntries = yield* hotWorkspaces.listForProject(params.id);
        yield* Effect.forEach(
          hotEntries,
          (entry) =>
            entry.sealantWorkspaceId === null
              ? Effect.void
              : sealant.getWorkspace(entry.sealantWorkspaceId).pipe(
                  Effect.flatMap((workspace) => sealant.stopWorkspace(workspace)),
                  Effect.ignore,
                  asSealantUser(entry.ownerUserId),
                ),
          { concurrency: 4 },
        );
        const { leftover } = yield* store.removeProjectStore(project.storePath);
        yield* projects.remove(params.id);
        return new RemovalReport({ removed: true, leftover });
      }),
    )
    .handle("visibility", ({ params, payload }) =>
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo;
        yield* (yield* ProjectAccess).changeVisibility(params.id);
        const project = yield* projects
          .setVisibility(params.id, payload.visibility)
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
        yield* (yield* AuditEventsRepo).record({
          organizationId: project.organizationId,
          actorUserId: (yield* CurrentUser).user.id,
          action: "project.visibility_changed",
          subjectType: "project",
          subjectId: project.id,
          data: { visibility: project.visibility },
        });
        // Who may run here changed: standbys warmed for accounts that lost access drain.
        yield* (yield* SessionEngine).reconcileHotSessions(params.id);
        return project;
      }),
    )
    .handle("automation", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).manageProject(params.id);
        const projects = yield* ProjectsRepo;
        return yield* projects
          .setAutomation(params.id, {
            autoTour: payload.autoTour,
            autoSuggest: payload.autoSuggest,
            autoName: payload.autoName,
            backgroundSessions: payload.backgroundSessions,
            ...(payload.autoLand === undefined ? {} : { autoLand: payload.autoLand }),
          })
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
      }),
    )
    .handle("gitAuth", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).manageProject(params.id);
        const projects = yield* ProjectsRepo;
        // Resolving the env generates the key on first mend-key use, so the
        // settings card can show a public key the moment the mode lands.
        // Bridge is NOT resolved here: switching to it must work before the
        // signer connects — the card reports presence as an observation.
        if (payload.gitAuthMode === "mend-key") {
          const caller = yield* CurrentUser;
          yield* remoteEnvFor("mend-key", caller.user.id);
        }
        return yield* projects
          .setGitAuthMode(params.id, payload.gitAuthMode)
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
      }),
    )
    .handle("workspaceImage", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).manageProject(params.id);
        const projects = yield* ProjectsRepo;
        if (payload.workspaceImage === null) {
          const project = yield* projects
            .setWorkspaceImage(params.id, null)
            .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
          yield* rewarmHotSessions(params.id);
          return new ProjectWorkspaceImageSaveResult({ saved: true, project, resolutions: [] });
        }
        const sealant = yield* SealantClient;
        const resolved = yield* resolveWorkspaceEnvironment(
          payload.workspaceImage,
          sealant.resolveWorkspacePackage,
        ).pipe(
          Effect.catchTag("SealantPlatformError", (error) =>
            Effect.fail(new SettingsFailure({ message: error.message })),
          ),
        );
        const resolutions = resolved.resolutions.map(
          (resolution) => new WorkspacePackageResolutionView(resolution),
        );
        if (resolved.workspaceImage === null) {
          return new ProjectWorkspaceImageSaveResult({ saved: false, project: null, resolutions });
        }
        const project = yield* projects
          .setWorkspaceImage(params.id, resolved.workspaceImage)
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
        yield* rewarmHotSessions(params.id);
        return new ProjectWorkspaceImageSaveResult({ saved: true, project, resolutions });
      }),
    )
    .handle("applyDotfiles", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).manageProject(params.id);
        const projects = yield* ProjectsRepo;
        const engine = yield* SessionEngine;
        const project = yield* projects
          .setApplyDotfiles(params.id, payload.applyDotfiles)
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
        // Dotfiles are a create-time workspace input — rewarm the pool.
        yield* engine.reconcileHotSessions(params.id);
        return project;
      }),
    )
    .handle("inheritUserSkills", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).manageProject(params.id);
        const projects = yield* ProjectsRepo;
        const engine = yield* SessionEngine;
        const project = yield* projects
          .setInheritUserSkills(params.id, payload.inheritUserSkills)
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
        // Skills are materialized before workspace boot, so ready skeletons must be rebuilt.
        yield* engine.reconcileHotSessions(params.id);
        return project;
      }),
    )
    .handle("hotSessions", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).manageProject(params.id);
        const projects = yield* ProjectsRepo;
        const engine = yield* SessionEngine;
        const project = yield* projects
          .setHotSessions(params.id, payload.hotSessions)
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
        yield* engine.reconcileHotSessions(params.id);
        return project;
      }),
    )
    .handle("installCommand", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).manageProject(params.id);
        const caller = yield* CurrentUser;
        const projects = yield* ProjectsRepo;
        const jobs = yield* JobRunner;
        const project = yield* projects
          .setInstallCommand(params.id, payload.installCommand?.trim() ?? null)
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
        // The shared cache is fed only by the Mend-controlled install (ADR-0002 decision 9):
        // a changed command re-runs it; the key dedups a run already queued.
        yield* jobs
          .enqueue({
            name: "dependency-install",
            payload: { projectId: project.id, requestedByUserId: caller.user.id },
            idempotencyKey: `dependency-install:${project.id}:${project.updatedAt.toISOString()}`,
          })
          .pipe(Effect.ignore);
        return project;
      }),
    )
    .handle("branches", ({ params }) =>
      Effect.gen(function* () {
        const store = yield* Store;
        const project = yield* (yield* ProjectAccess).project(params.id);
        const branches = yield* store
          .listBranches(project.storePath)
          .pipe(Effect.mapError((error) => readableGitFailure(error, project.gitAuthMode)));
        // The success schema is a Schema.Class: encoding demands instances, not shape-alikes.
        return branches.map((branch) => new ProjectBranch(branch));
      }),
    )
    .handle("refresh", ({ params }) =>
      Effect.gen(function* () {
        const store = yield* Store;
        const project = yield* (yield* ProjectAccess).project(params.id);
        const caller = yield* CurrentUser;
        // Checked on use too: the policy may have tightened, or the name moved, since adoption.
        const pinned =
          project.originUrl === null
            ? (env: Readonly<Record<string, string>>) => ({ ...env })
            : yield* reachableSource(project.originUrl, (message) => new StoreFailure({ message }));
        const remoteEnv = pinned(yield* remoteEnvFor(project.gitAuthMode, caller.user.id));
        yield* withSignerContext(
          project.gitAuthMode,
          caller.user.id,
          `refresh ${project.name} → origin`,
          store
            .refreshFromOrigin(project.storePath, remoteEnv)
            .pipe(Effect.mapError((error) => readableGitFailure(error, project.gitAuthMode))),
        );
        const branches = yield* store
          .listBranches(project.storePath)
          .pipe(Effect.mapError((error) => readableGitFailure(error, project.gitAuthMode)));
        return branches.map((branch) => new ProjectBranch(branch));
      }),
    )
    .handle("files", ({ params, query }) =>
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        const store = yield* Store;
        const reads = yield* WorktreeReads;
        const project = yield* (yield* ProjectAccess).project(params.id);
        // A worktree listing comes from wherever the authority is: beside Mend (a host path
        // the desktop can open) or the chain head's tree (no path — a capture, stamped).
        const worktreeListing = (worktreeId: WorktreeId, label: string, directory: string) =>
          reads.listWorktreeFiles(project.id, worktreeId, FILE_LISTING_LIMIT).pipe(
            Effect.mapError(readFailure),
            Effect.map(
              (listing) =>
                new ProjectFileListing({
                  source: "worktree",
                  label,
                  rootPath:
                    listing.stamp.source === "worktree"
                      ? worktreePathOf(project.storePath, directory)
                      : null,
                  files: listing.value.files,
                  truncated: listing.value.truncated,
                  observation: observationOf(listing.stamp),
                }),
            ),
          );
        if (query.worktree !== undefined) {
          const worktrees = yield* WorktreesRepo;
          const worktreeRow = yield* worktrees
            .byId(query.worktree)
            .pipe(Effect.mapError(() => new NotFound({ id: query.worktree ?? params.id })));
          if (worktreeRow.projectId !== project.id) {
            return yield* new NotFound({ id: query.worktree });
          }
          return yield* worktreeListing(worktreeRow.id, worktreeRow.name, worktreeRow.directory);
        }
        if (query.session !== undefined) {
          const session = yield* sessions
            .byId(query.session)
            .pipe(Effect.mapError(() => new NotFound({ id: query.session ?? params.id })));
          if (session.projectId !== project.id) {
            return yield* new NotFound({ id: query.session });
          }
          return yield* worktreeListing(session.worktreeId, session.worktree, session.worktree);
        }
        const listing = yield* store
          .listTreeFiles(project.storePath, project.defaultBranch, FILE_LISTING_LIMIT)
          .pipe(Effect.mapError(fileListingFailure));
        return new ProjectFileListing({
          source: "branch",
          label: project.defaultBranch,
          rootPath: null,
          files: listing.files,
          truncated: listing.truncated,
        });
      }),
    )
    .handle("pullRequests", ({ params }) =>
      Effect.gen(function* () {
        const cli = yield* Gh;
        const project = yield* (yield* ProjectAccess).project(params.id);
        if (project.originUrl === null) return noPullRequests("none", "no-origin");
        const repo = parseGithubRepo(project.originUrl);
        if (repo === null) return noPullRequests("not-github", "not-github");
        const authority = yield* (yield* GithubIdentity).forCaller();
        if (authority.kind === "none") {
          return new ProjectPullRequests({
            origin: "github",
            repo,
            availability: "no-identity",
            detail: authority.detail,
            pullRequests: [],
            fetchedAt: null,
          });
        }
        return yield* cli.pullRequests(repo).pipe(
          Effect.map(
            (pullRequests) =>
              new ProjectPullRequests({
                origin: "github",
                repo,
                availability: "ok",
                detail: null,
                pullRequests,
                fetchedAt: new Date().toISOString(),
              }),
          ),
          Effect.catch((error) =>
            Effect.succeed(
              new ProjectPullRequests({
                origin: "github",
                repo,
                availability: classifyGhError(error),
                detail: error.stderr === "" ? String(error) : error.stderr,
                pullRequests: [],
                fetchedAt: null,
              }),
            ),
          ),
        );
      }),
    )
    .handle("hotSessionsStatus", ({ params }) =>
      Effect.gen(function* () {
        const hotWorkspaces = yield* HotWorkspacesRepo;
        const project = yield* (yield* ProjectAccess).project(params.id);
        const caller = yield* CurrentUser;
        // The pool is kept per person (docs/adr/0003): the caller's own standbys, and never
        // another account's failure text.
        const entries = (yield* hotWorkspaces.listForProject(params.id)).filter(
          (entry) => entry.ownerUserId === caller.user.id,
        );
        const countOf = (status: string) =>
          entries.filter((entry) => entry.status === status).length;
        // The latest failure, when one exists — the setup page shows it verbatim.
        const failed = entries
          .toReversed()
          .find((entry) => entry.status === "failed" && entry.error !== null);
        return new ProjectHotSessionsStatus({
          hotSessions: project.hotSessions,
          ready: countOf("ready"),
          warming: countOf("warming"),
          failed: countOf("failed"),
          error: failed?.error ?? null,
        });
      }),
    ),
);

/**
 * The current user's dotfiles — repository knob + store snapshot. Contents arrive from the
 * machine that HAS them (CLI sync, web upload); the server's own home is never scanned.
 */
const dotfilesView = (userId: string) =>
  Effect.gen(function* () {
    const userDotfiles = yield* UserDotfilesRepo;
    const store = yield* DotfilesStore;
    const repository = yield* userDotfiles.repository(userId);
    const snapshot = yield* store
      .current(userId)
      .pipe(Effect.mapError((error) => new SettingsFailure({ message: error.message })));
    return new DotfilesView({
      repository,
      snapshot:
        snapshot === null
          ? null
          : new DotfilesSnapshotView({
              sha: snapshot.sha,
              source: snapshot.source,
              committedAt: snapshot.committedAt,
              files: snapshot.files.map((file) => new DotfilesSnapshotFileView(file)),
            }),
    });
  });

export const DotfilesGroupLive = HttpApiBuilder.group(MendApi, "dotfiles", (handlers) =>
  handlers
    .handle("get", () =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        return yield* dotfilesView(caller.user.id).pipe(
          Effect.catchTag("SettingsFailure", (error) => Effect.die(error)),
        );
      }),
    )
    .handle("repository", ({ payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const userDotfiles = yield* UserDotfilesRepo;
        if (payload.repository !== null) {
          const credentialIssue = dotfilesRepositoryUrlCredentialIssue(payload.repository.url);
          if (credentialIssue !== null) {
            return yield* new SettingsFailure({ message: credentialIssue });
          }
          const pinCloneEnv = yield* reachableSource(
            payload.repository.url,
            (message) => new SettingsFailure({ message }),
          );
          // Tried before it is saved, through the launch's own clone and pack (same bounds, same
          // git environment, the caller's own git access): a repository that cannot be cloned,
          // has no such branch or subdirectory, or packs past the cap is refused here with that
          // reason, instead of being left out of every launch after it. The clone is a launch's
          // clone, so it holds one of the account's launch slots: saves cannot start clones past
          // that budget.
          const budgets = yield* Budgets;
          const cloner = yield* DotfilesCloner;
          const tried = yield* budgets.withLaunchSlot(
            caller.user.id,
            cloner.archive(caller.user.id, payload.repository, { pinCloneEnv }).pipe(
              Effect.mapError((error) => new SettingsFailure({ message: error.message })),
              Effect.as(true),
            ),
          );
          if (tried === null) {
            return yield* budgetExceeded("accountLaunchesInFlight", budgets.limits);
          }
        }
        yield* userDotfiles.setRepository(caller.user.id, payload.repository);
        yield* rewarmAllHotSessions;
        return yield* dotfilesView(caller.user.id);
      }),
    )
    .handle("snapshot", ({ payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const store = yield* DotfilesStore;
        yield* store
          .snapshot(caller.user.id, payload.files, {
            source: payload.source,
            merge: payload.merge,
          })
          .pipe(Effect.mapError((error) => new SettingsFailure({ message: error.message })));
        yield* rewarmAllHotSessions;
        return yield* dotfilesView(caller.user.id);
      }),
    )
    .handle("clearSnapshot", () =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const store = yield* DotfilesStore;
        yield* store
          .clear(caller.user.id)
          .pipe(Effect.mapError((error) => new SettingsFailure({ message: error.message })));
        yield* rewarmAllHotSessions;
        return yield* dotfilesView(caller.user.id);
      }),
    ),
);

/** The machine's Mend git key — public half only, ever (docs/GIT-ACCESS.md). */
export const GitKeysGroupLive = HttpApiBuilder.group(MendApi, "gitKeys", (handlers) =>
  handlers
    .handle("show", () =>
      Effect.gen(function* () {
        const keys = yield* MendKeys;
        const caller = yield* CurrentUser;
        const key = yield* keys.read(caller.user.id, caller.user.email).pipe(Effect.orDie);
        return key === null
          ? new GitKeyView({ exists: false, publicKey: null, fingerprint: null })
          : new GitKeyView({
              exists: true,
              publicKey: key.publicKey,
              fingerprint: key.fingerprint,
            });
      }),
    )
    .handle("init", () =>
      Effect.gen(function* () {
        const keys = yield* MendKeys;
        const caller = yield* CurrentUser;
        const key = yield* keys
          .ensure(caller.user.id, caller.user.email)
          .pipe(
            Effect.mapError(
              (error) =>
                new StoreFailure({ message: `Could not create the Mend key: ${error.stderr}` }),
            ),
          );
        yield* gitAccessChanged(caller.user.id);
        return new GitKeyView({
          exists: true,
          publicKey: key.publicKey,
          fingerprint: key.fingerprint,
        });
      }),
    )
    .handle("bridgeStatus", () =>
      Effect.gen(function* () {
        const bridge = yield* AgentBridge;
        const caller = yield* CurrentUser;
        const bridgeStatus = yield* bridge.status(caller.user.id);
        return new GitBridgeStatusView(bridgeStatus);
      }),
    )
    .handle("access", () => gitAccessView())
    .handle("setAccess", ({ payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const gitAccess = yield* UserGitAccessRepo;
        yield* gitAccess.setMode(caller.user.id, payload.mode);
        // Choosing the key creates it, so the page can show what to add on the git host.
        if (payload.mode === "mend-key") {
          const keys = yield* MendKeys;
          yield* keys
            .ensure(caller.user.id, caller.user.email)
            .pipe(
              Effect.mapError(
                (error) =>
                  new StoreFailure({ message: `Could not create the Mend key: ${error.stderr}` }),
              ),
            );
        }
        yield* gitAccessChanged(caller.user.id);
        return yield* gitAccessView();
      }),
    ),
);

/** The pointer the first-run checklist and Settings re-read this user's git access on. */
const gitAccessChanged = (userId: string) =>
  Effect.gen(function* () {
    const events = yield* UserEvents;
    yield* events.changed(userId, "git-access");
  });

/** The calling user's git access: mode, their key (public half), the bridge's presence. */
const gitAccessView = () =>
  Effect.gen(function* () {
    const caller = yield* CurrentUser;
    const gitAccess = yield* UserGitAccessRepo;
    const keys = yield* MendKeys;
    const bridge = yield* AgentBridge;
    const mode = (yield* gitAccess.mode(caller.user.id)) ?? "mend-key";
    const key = yield* keys.read(caller.user.id, caller.user.email).pipe(Effect.orDie);
    const bridgeStatus = yield* bridge.status(caller.user.id);
    return new GitAccessView({
      mode,
      key:
        key === null
          ? new GitKeyView({ exists: false, publicKey: null, fingerprint: null })
          : new GitKeyView({
              exists: true,
              publicKey: key.publicKey,
              fingerprint: key.fingerprint,
            }),
      bridge: new GitBridgeStatusView(bridgeStatus),
    });
  });

/** The blueprint's path shape, checked early so the failure names the field, not the launch. */
const isNormalizedAbsolutePath = (value: string): boolean =>
  value.startsWith("/") &&
  value !== "/" &&
  !value.endsWith("/") &&
  !value.includes("//") &&
  value.split("/").every((segment) => segment !== "." && segment !== "..");

export const ProjectMountsGroupLive = HttpApiBuilder.group(MendApi, "projectMounts", (handlers) =>
  handlers
    .handle("list", ({ params }) =>
      Effect.gen(function* () {
        const mounts = yield* ProjectMountsRepo;
        yield* (yield* ProjectAccess).project(params.id);
        return yield* mounts.listForProject(params.id);
      }),
    )
    .handle("add", ({ params, payload }) =>
      Effect.gen(function* () {
        const mounts = yield* ProjectMountsRepo;
        // Host paths are the operator's to hand out, on a single-organization install only
        // (docs/adr/0003): project membership must not grant access to the machine's filesystem.
        // Folders replace them for everyone else.
        const access = yield* ProjectAccess;
        yield* access.manageProject(params.id);
        yield* access.requireOperator(params.id);
        if ((yield* TenancyConfig).mode !== "single") {
          return yield* new NotFound({ id: params.id });
        }
        if (!STORE_NAME.test(payload.name)) {
          return yield* new StoreFailure({
            message: `"${payload.name}" is not a usable mount name (lowercase letters, digits, ".", "_", "-").`,
          });
        }
        if (!isNormalizedAbsolutePath(payload.hostPath)) {
          return yield* new StoreFailure({
            message: `Host path must be absolute and normalized (no "..", no trailing slash): ${payload.hostPath}`,
          });
        }
        const isDirectory = yield* Effect.sync(() => {
          try {
            return fs.statSync(payload.hostPath).isDirectory();
          } catch {
            return false;
          }
        });
        if (!isDirectory) {
          return yield* new StoreFailure({
            message: `Not a directory on this machine: ${payload.hostPath}`,
          });
        }
        const existing = yield* mounts.listForProject(params.id);
        const clash = existing.find(
          (mount) => mount.name === payload.name || mount.hostPath === payload.hostPath,
        );
        if (clash !== undefined) {
          return yield* new StoreFailure({
            message: `Already declared on this project: ${clash.name} (${clash.hostPath})`,
          });
        }
        const created = yield* mounts.create({
          projectId: params.id,
          name: payload.name,
          hostPath: payload.hostPath,
          readOnly: payload.readOnly,
        });
        yield* rewarmHotSessions(params.id);
        return created;
      }),
    )
    .handle("remove", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).manageProject(params.id);
        const mounts = yield* ProjectMountsRepo;
        const mount = yield* mounts
          .byId(params.mountId)
          .pipe(Effect.mapError(() => new NotFound({ id: params.mountId })));
        if (mount.projectId !== params.id) {
          return yield* new NotFound({ id: params.mountId });
        }
        yield* mounts.remove(params.mountId);
        yield* rewarmHotSessions(params.id);
      }),
    ),
);

/**
 * Linked projects (ADR-0001): sibling adopted projects this project's sessions work in,
 * read-write, at /workspace/repos/<name>. The engine mounts the linked project's worktrees root
 * as a bindable root and binds the named worktree at launch.
 */
export const ProjectLinksGroupLive = HttpApiBuilder.group(MendApi, "projectLinks", (handlers) =>
  handlers
    .handle("list", ({ params }) =>
      Effect.gen(function* () {
        const links = yield* ProjectLinksRepo;
        yield* (yield* ProjectAccess).project(params.id);
        return yield* links.listForProject(params.id);
      }),
    )
    .handle("add", ({ params, payload }) =>
      Effect.gen(function* () {
        const links = yield* ProjectLinksRepo;
        const worktrees = yield* WorktreesRepo;
        const engine = yield* SessionEngine;
        const access = yield* ProjectAccess;
        yield* access.manageProject(params.id);
        if (payload.linkedProjectId === params.id) {
          return yield* new StoreFailure({ message: "A project cannot link itself." });
        }
        // Same organization, and visible to the caller: a private target only to its creator.
        const linked = yield* access.project(payload.linkedProjectId);
        if (!STORE_NAME.test(payload.name)) {
          return yield* new StoreFailure({
            message: `"${payload.name}" is not a usable link name (lowercase letters, digits, ".", "_", "-").`,
          });
        }
        const existing = yield* links.listForProject(params.id);
        const clash = existing.find(
          (link) => link.name === payload.name || link.linkedProjectId === payload.linkedProjectId,
        );
        if (clash !== undefined) {
          return yield* new StoreFailure({
            message: `Already linked on this project: ${clash.name} (${linked.name})`,
          });
        }
        // The worktree bound at launch: a named one must exist; none named picks the linked
        // project's worktree named after its default branch, created now if it is missing.
        const worktreeName = payload.worktreeName?.trim() ?? "";
        if (worktreeName !== "") {
          const named = yield* worktrees.byName(linked.id, worktreeName);
          if (named === null) {
            return yield* new StoreFailure({
              message: `${linked.name} has no worktree named ${worktreeName}.`,
            });
          }
        }
        const target =
          worktreeName === ""
            ? yield* engine
                .ensureWorktree(
                  linked.id,
                  { name: linked.defaultBranch, base: null },
                  (yield* CurrentUser).user.id,
                )
                .pipe(
                  Effect.mapError(
                    (error) =>
                      new StoreFailure({
                        message: `Could not prepare ${linked.name}'s ${linked.defaultBranch} worktree: ${error.message}`,
                      }),
                  ),
                  Effect.map((worktree) => worktree.name),
                )
            : worktreeName;
        const created = yield* links.create({
          projectId: params.id,
          linkedProjectId: linked.id,
          name: payload.name,
          worktreeName: target,
        });
        yield* rewarmHotSessions(params.id);
        return created;
      }),
    )
    .handle("remove", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).manageProject(params.id);
        const links = yield* ProjectLinksRepo;
        const link = yield* links
          .byId(params.linkId)
          .pipe(Effect.mapError(() => new NotFound({ id: params.linkId })));
        if (link.projectId !== params.id) {
          return yield* new NotFound({ id: params.linkId });
        }
        yield* links.remove(params.linkId);
        yield* rewarmHotSessions(params.id);
      }),
    ),
);

/** Repo write rejections → one 422 shape whose wording the settings UI shows verbatim. */
export const rejectEnvironment = (
  error:
    | ProjectEnvironmentInvalidInputError
    | ProjectEnvironmentDuplicateNameError
    | ProjectEnvironmentLimitError,
): EnvironmentRejected => {
  if (error instanceof ProjectEnvironmentInvalidInputError) {
    return new EnvironmentRejected({ issues: error.issues });
  }
  if (error instanceof ProjectEnvironmentDuplicateNameError) {
    return new EnvironmentRejected({
      issues: [
        {
          field: "name",
          rule: "duplicate-name",
          message: `A variable named ${error.name} already exists on this project.`,
        },
      ],
    });
  }
  return new EnvironmentRejected({
    issues: [
      {
        field: null,
        rule: error.kind === "entries" ? "entry-count" : "total-size",
        message:
          error.kind === "entries"
            ? `A project can have at most ${error.limit} environment variables.`
            : `A project's environment variables can total at most ${error.limit} bytes.`,
      },
    ],
  });
};

export const ProjectEnvironmentGroupLive = HttpApiBuilder.group(
  MendApi,
  "projectEnvironment",
  (handlers) =>
    handlers
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          yield* (yield* ProjectAccess).project(params.id);
          const environment = yield* ProjectEnvironmentRepo;
          return yield* environment.snapshot(params.id).pipe(
            Effect.catchTags({
              ProjectNotFoundError: () => new NotFound({ id: params.id }),
              // A row that no longer parses is data corruption, not a client condition.
              ProjectEnvironmentCorruptRecordError: (error) => Effect.die(error),
            }),
          );
        }),
      )
      .handle("create", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* (yield* ProjectAccess).manageProject(params.id);
          const environment = yield* ProjectEnvironmentRepo;
          yield* refusePlaintextOfSecret(params.id, payload.name);
          const result = yield* environment
            .create(params.id, { name: payload.name, value: payload.value })
            .pipe(
              Effect.catchTags({
                ProjectNotFoundError: () => new NotFound({ id: params.id }),
                ProjectEnvironmentInvalidInputError: (error) => rejectEnvironment(error),
                ProjectEnvironmentDuplicateNameError: (error) => rejectEnvironment(error),
                ProjectEnvironmentLimitError: (error) => rejectEnvironment(error),
              }),
            );
          yield* rewarmHotSessions(params.id);
          return new ProjectEnvironmentMutationResult({
            variable: result.variable,
            revision: result.revision,
          });
        }),
      )
      .handle("update", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* (yield* ProjectAccess).manageProject(params.id);
          const environment = yield* ProjectEnvironmentRepo;
          yield* refusePlaintextOfSecret(params.id, payload.name);
          const result = yield* environment
            .update(params.id, params.variableId, {
              name: payload.name,
              value: payload.value,
              expectedRevision: payload.expectedRevision,
            })
            .pipe(
              Effect.catchTags({
                ProjectNotFoundError: () => new NotFound({ id: params.id }),
                ProjectEnvironmentVariableNotFoundError: () =>
                  new NotFound({ id: params.variableId }),
                ProjectEnvironmentStaleWriteError: (error) =>
                  new EnvironmentStaleWrite({
                    variableId: error.variableId,
                    currentRevision: error.currentRevision,
                  }),
                ProjectEnvironmentInvalidInputError: (error) => rejectEnvironment(error),
                ProjectEnvironmentDuplicateNameError: (error) => rejectEnvironment(error),
                ProjectEnvironmentLimitError: (error) => rejectEnvironment(error),
              }),
            );
          yield* rewarmHotSessions(params.id);
          return new ProjectEnvironmentMutationResult({
            variable: result.variable,
            revision: result.revision,
          });
        }),
      )
      .handle("remove", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* (yield* ProjectAccess).manageProject(params.id);
          const environment = yield* ProjectEnvironmentRepo;
          const result = yield* environment
            .remove(params.id, params.variableId, payload.expectedRevision)
            .pipe(
              Effect.catchTags({
                ProjectNotFoundError: () => new NotFound({ id: params.id }),
                ProjectEnvironmentVariableNotFoundError: () =>
                  new NotFound({ id: params.variableId }),
                ProjectEnvironmentStaleWriteError: (error) =>
                  new EnvironmentStaleWrite({
                    variableId: error.variableId,
                    currentRevision: error.currentRevision,
                  }),
              }),
            );
          yield* rewarmHotSessions(params.id);
          return new ProjectEnvironmentMutationResult({
            variable: null,
            revision: result.revision,
          });
        }),
      )
      .handle("load", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* (yield* ProjectAccess).manageProject(params.id);
          const environment = yield* ProjectEnvironmentRepo;
          const secrets = yield* ProjectSecretsRepo;
          const projects = yield* ProjectsRepo;
          yield* projects
            .byId(params.id)
            .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
          const loaded: Array<EnvironmentLoadedEntry> = [];
          const rejected: Array<EnvironmentRejectedEntry> = [];
          // A name lives in exactly one lane. Loading into Secrets evicts a plaintext copy;
          // loading a plaintext name that is already a secret is refused — never a silent
          // downgrade from encrypted to plaintext.
          const [existingEnvironment, existingSecrets] = yield* Effect.all([
            environment.snapshot(params.id).pipe(
              Effect.catchTags({
                ProjectNotFoundError: () => new NotFound({ id: params.id }),
                ProjectEnvironmentCorruptRecordError: (error) => Effect.die(error),
              }),
            ),
            secrets
              .snapshot(params.id)
              .pipe(Effect.catchTag("ProjectNotFoundError", () => new NotFound({ id: params.id }))),
          ]);
          const secretNamesStored = new Set(existingSecrets.secrets.map((secret) => secret.name));
          const plaintextByName = new Map(
            existingEnvironment.variables.map((variable) => [variable.name, variable] as const),
          );
          const forcedSecret = new Set(payload.secretNames);
          // A repo-level rejection (limits, a name the lane refuses) becomes a per-name report
          // line, never a failed request: the rest of the file still lands.
          const reasonOf = (error: unknown): string => rejectEnvironmentAny(error);
          const parsed = parseDotenv(payload.contents);
          for (const entry of parsed.entries) {
            const route = routeDotenvName(entry.name);
            if (route.lane === "rejected") {
              rejected.push(
                new EnvironmentRejectedEntry({
                  name: entry.name,
                  reason: formatProjectEnvironmentIssue(route.issue),
                }),
              );
              continue;
            }
            const lane =
              payload.allSecret || forcedSecret.has(entry.name) || route.lane === "secret"
                ? "secret"
                : "configuration";
            if (lane === "configuration") {
              if (secretNamesStored.has(entry.name)) {
                rejected.push(
                  new EnvironmentRejectedEntry({
                    name: entry.name,
                    reason:
                      "Already stored as a secret. Load it with --secret to replace the secret, or remove the secret first to store it as plaintext configuration.",
                  }),
                );
                continue;
              }
              const outcome = yield* environment
                .upsertByName(params.id, { name: entry.name, value: entry.value })
                .pipe(Effect.result);
              if (Result.isSuccess(outcome)) {
                loaded.push(
                  new EnvironmentLoadedEntry({
                    name: entry.name,
                    lane,
                    action: outcome.success.action,
                  }),
                );
              } else if (outcome.failure instanceof ProjectNotFoundError) {
                return yield* new NotFound({ id: params.id });
              } else {
                rejected.push(
                  new EnvironmentRejectedEntry({
                    name: entry.name,
                    reason: reasonOf(outcome.failure),
                  }),
                );
              }
              continue;
            }
            const valueIssue = validateProjectSecretValue(entry.value);
            if (valueIssue !== null) {
              rejected.push(
                new EnvironmentRejectedEntry({
                  name: entry.name,
                  reason: formatProjectEnvironmentIssue(valueIssue),
                }),
              );
              continue;
            }
            const sealedValue = yield* sealSecret(entry.value);
            const outcome = yield* secrets
              .upsertByName(params.id, { name: entry.name, sealedValue })
              .pipe(Effect.result);
            if (Result.isSuccess(outcome)) {
              // Evict a plaintext copy of the same name: the secret now owns it.
              const plaintext = plaintextByName.get(entry.name);
              let action: "created" | "updated" | "moved" = outcome.success.action;
              if (plaintext !== undefined) {
                yield* environment
                  .remove(params.id, plaintext.id, plaintext.revision)
                  .pipe(Effect.ignore);
                plaintextByName.delete(entry.name);
                action = "moved";
              }
              loaded.push(new EnvironmentLoadedEntry({ name: entry.name, lane, action }));
            } else if (outcome.failure instanceof ProjectNotFoundError) {
              return yield* new NotFound({ id: params.id });
            } else {
              rejected.push(
                new EnvironmentRejectedEntry({
                  name: entry.name,
                  reason: reasonOf(outcome.failure),
                }),
              );
            }
          }
          const [environmentSnapshot, secretSnapshot] = yield* Effect.all([
            environment.snapshot(params.id).pipe(
              Effect.catchTags({
                ProjectNotFoundError: () => new NotFound({ id: params.id }),
                ProjectEnvironmentCorruptRecordError: (error) => Effect.die(error),
              }),
            ),
            secrets
              .snapshot(params.id)
              .pipe(Effect.catchTag("ProjectNotFoundError", () => new NotFound({ id: params.id }))),
          ]);
          yield* rewarmHotSessions(params.id);
          return new EnvironmentLoadReport({
            loaded,
            rejected,
            malformedLines: parsed.malformed,
            environmentRevision: environmentSnapshot.revision,
            secretRevision: secretSnapshot.revision,
          });
        }),
      ),
);

/** Wording for a lane-level rejection, whichever typed shape the repo raised. */
const rejectEnvironmentAny = (error: unknown): string => {
  if (
    error instanceof ProjectEnvironmentDuplicateNameError ||
    error instanceof ProjectEnvironmentLimitError ||
    error instanceof ProjectEnvironmentInvalidInputError
  ) {
    return rejectEnvironment(error)
      .issues.map((issue) => issue.message)
      .join(" ");
  }
  return "The entry could not be stored.";
};

/** Value bounds for a secret, checked on the plaintext BEFORE sealing; wording shared with the UI. */
const rejectSecretValue = (value: string) => {
  const issue = validateProjectSecretValue(value);
  return issue === null
    ? Effect.void
    : Effect.fail(
        new EnvironmentRejected({
          issues: [
            { field: "value", rule: issue.rule, message: formatProjectEnvironmentIssue(issue) },
          ],
        }),
      );
};

/** Seal a secret value with the machine key; a cipher failure is a server fault, not a 4xx. */
const sealSecret = (value: string) =>
  Effect.gen(function* () {
    const cipher = yield* SecretCipher;
    return yield* cipher.encrypt(value).pipe(Effect.catchTag("SecretCipherError", Effect.die));
  });

/**
 * A name lives in exactly one lane. When a SECRET takes a name, any plaintext Configuration copy is
 * evicted (the secret wins); best-effort, since the secret write already succeeded.
 */
const evictPlaintextCopy = (projectId: ProjectId, name: string) =>
  Effect.gen(function* () {
    const environment = yield* ProjectEnvironmentRepo;
    const snapshot = yield* environment.snapshot(projectId).pipe(Effect.option);
    if (Option.isNone(snapshot)) return;
    const copy = snapshot.value.variables.find((variable) => variable.name === name);
    if (copy === undefined) return;
    yield* environment.remove(projectId, copy.id, copy.revision).pipe(Effect.ignore);
  });

/** …and a plaintext write may not take a name that is currently a secret (never a silent downgrade). */
const refusePlaintextOfSecret = (projectId: ProjectId, name: string) =>
  Effect.gen(function* () {
    const secrets = yield* ProjectSecretsRepo;
    const snapshot = yield* secrets.snapshot(projectId).pipe(Effect.option);
    if (Option.isSome(snapshot) && snapshot.value.secrets.some((secret) => secret.name === name)) {
      return yield* new EnvironmentRejected({
        issues: [
          {
            field: "name",
            rule: "name-is-secret",
            message:
              "This name is stored as a secret. Replace the secret, or remove it first to store the value as plaintext configuration.",
          },
        ],
      });
    }
  });

export const ProjectSecretsGroupLive = HttpApiBuilder.group(MendApi, "projectSecrets", (handlers) =>
  handlers
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).project(params.id);
        const secrets = yield* ProjectSecretsRepo;
        return yield* secrets
          .snapshot(params.id)
          .pipe(Effect.catchTag("ProjectNotFoundError", () => new NotFound({ id: params.id })));
      }),
    )
    .handle("create", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).manageProject(params.id);
        const secrets = yield* ProjectSecretsRepo;
        yield* rejectSecretValue(payload.value);
        const sealedValue = yield* sealSecret(payload.value);
        const result = yield* secrets.create(params.id, { name: payload.name, sealedValue }).pipe(
          Effect.catchTags({
            ProjectNotFoundError: () => new NotFound({ id: params.id }),
            ProjectEnvironmentInvalidInputError: (error) => rejectEnvironment(error),
            ProjectEnvironmentDuplicateNameError: (error) => rejectEnvironment(error),
            ProjectEnvironmentLimitError: (error) => rejectEnvironment(error),
          }),
        );
        // A name lives in exactly one lane: the secret now owns it.
        yield* evictPlaintextCopy(params.id, payload.name);
        yield* rewarmHotSessions(params.id);
        return new ProjectSecretMutationResult({
          secret: result.secret,
          revision: result.revision,
        });
      }),
    )
    .handle("update", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).manageProject(params.id);
        const secrets = yield* ProjectSecretsRepo;
        if (payload.value !== null) yield* rejectSecretValue(payload.value);
        const sealedValue = payload.value === null ? null : yield* sealSecret(payload.value);
        const result = yield* secrets
          .update(params.id, params.secretId, {
            name: payload.name,
            sealedValue,
            expectedRevision: payload.expectedRevision,
          })
          .pipe(
            Effect.catchTags({
              ProjectNotFoundError: () => new NotFound({ id: params.id }),
              ProjectSecretNotFoundError: () => new NotFound({ id: params.secretId }),
              ProjectEnvironmentStaleWriteError: (error) =>
                new EnvironmentStaleWrite({
                  variableId: error.variableId,
                  currentRevision: error.currentRevision,
                }),
              ProjectEnvironmentInvalidInputError: (error) => rejectEnvironment(error),
              ProjectEnvironmentDuplicateNameError: (error) => rejectEnvironment(error),
              ProjectEnvironmentLimitError: (error) => rejectEnvironment(error),
            }),
          );
        // A name lives in exactly one lane: the secret now owns it.
        yield* evictPlaintextCopy(params.id, payload.name);
        yield* rewarmHotSessions(params.id);
        return new ProjectSecretMutationResult({
          secret: result.secret,
          revision: result.revision,
        });
      }),
    )
    .handle("remove", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).manageProject(params.id);
        const secrets = yield* ProjectSecretsRepo;
        const result = yield* secrets
          .remove(params.id, params.secretId, payload.expectedRevision)
          .pipe(
            Effect.catchTags({
              ProjectNotFoundError: () => new NotFound({ id: params.id }),
              ProjectSecretNotFoundError: () => new NotFound({ id: params.secretId }),
              ProjectEnvironmentStaleWriteError: (error) =>
                new EnvironmentStaleWrite({
                  variableId: error.variableId,
                  currentRevision: error.currentRevision,
                }),
            }),
          );
        yield* rewarmHotSessions(params.id);
        return new ProjectSecretMutationResult({ secret: null, revision: result.revision });
      }),
    ),
);

/**
 * Cluster bindings (`.plans/cluster-env-sources.md`): names only, on every install. Mutations are
 * deliberately install-independent — a project whose data arrives on a non-cluster machine must
 * be able to REMOVE bindings to become launchable; only the panel's add affordance degrades,
 * guided by the read's `clusterCapable` hint (`DeploymentConfig.mode`, never enforcement).
 */
export const ProjectClusterBindingsGroupLive = HttpApiBuilder.group(
  MendApi,
  "projectClusterBindings",
  (handlers) =>
    handlers
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          yield* (yield* ProjectAccess).project(params.id);
          const bindings = yield* ProjectClusterBindingsRepo;
          const deployment = yield* DeploymentConfig;
          const snapshot = yield* bindings
            .snapshot(params.id)
            .pipe(Effect.catchTag("ProjectNotFoundError", () => new NotFound({ id: params.id })));
          return new ProjectClusterBindingsView({
            revision: snapshot.revision,
            bindings: snapshot.bindings,
            serviceAccount: snapshot.serviceAccount,
            clusterCapable: deployment.mode === "kubernetes",
          });
        }),
      )
      .handle("add", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* (yield* ProjectAccess).manageProject(params.id);
          const bindings = yield* ProjectClusterBindingsRepo;
          const result = yield* bindings
            .add(params.id, { kind: payload.kind, objectName: payload.objectName })
            .pipe(
              Effect.catchTags({
                ProjectNotFoundError: () => new NotFound({ id: params.id }),
                ClusterBindingInvalidInputError: (error) =>
                  new ClusterBindingRejected({ message: error.message }),
                ClusterBindingDuplicateError: (error) =>
                  new ClusterBindingDuplicate({
                    kind: error.kind,
                    objectName: error.objectName,
                  }),
              }),
            );
          yield* rewarmHotSessions(params.id);
          return new ClusterBindingMutationResult({
            binding: result.binding,
            revision: result.revision,
          });
        }),
      )
      .handle("remove", ({ params }) =>
        Effect.gen(function* () {
          yield* (yield* ProjectAccess).manageProject(params.id);
          const bindings = yield* ProjectClusterBindingsRepo;
          const result = yield* bindings.remove(params.id, params.bindingId).pipe(
            Effect.catchTags({
              ProjectNotFoundError: () => new NotFound({ id: params.id }),
              ClusterBindingNotFoundError: () => new NotFound({ id: params.bindingId }),
            }),
          );
          yield* rewarmHotSessions(params.id);
          return new ClusterBindingMutationResult({ binding: null, revision: result.revision });
        }),
      )
      .handle("setServiceAccount", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* (yield* ProjectAccess).manageProject(params.id);
          const bindings = yield* ProjectClusterBindingsRepo;
          const result = yield* bindings.setServiceAccount(params.id, payload.serviceAccount).pipe(
            Effect.catchTags({
              ProjectNotFoundError: () => new NotFound({ id: params.id }),
              ClusterBindingInvalidInputError: (error) =>
                new ClusterBindingRejected({ message: error.message }),
            }),
          );
          yield* rewarmHotSessions(params.id);
          return new ClusterServiceAccountResult({
            serviceAccount: result.serviceAccount,
            revision: result.revision,
          });
        }),
      ),
);

export const ProjectRecipesGroupLive = HttpApiBuilder.group(MendApi, "projectRecipes", (handlers) =>
  handlers
    .handle("list", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).project(params.id);
        const projects = yield* ProjectsRepo;
        const recipes = yield* ProjectServiceRecipesRepo;
        yield* projects
          .byId(params.id)
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
        return yield* recipes.listForProject(params.id);
      }),
    )
    .handle("add", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).manageProject(params.id);
        const projects = yield* ProjectsRepo;
        const recipes = yield* ProjectServiceRecipesRepo;
        yield* projects
          .byId(params.id)
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
        if (!RECIPE_NAME.test(payload.name)) {
          return yield* new StoreFailure({
            message: `"${payload.name}" is not a usable Service name (lowercase letters, digits, ".", "_", "-").`,
          });
        }
        if (payload.port < 1 || payload.port > 65535) {
          return yield* new StoreFailure({ message: `Port out of range: ${payload.port}` });
        }
        const command = payload.command?.trim();
        const protocol = payload.protocol ?? "tcp";
        const browserScheme = payload.browserScheme ?? null;
        if (protocol === "udp" && browserScheme !== null) {
          return yield* new StoreFailure({
            message: "UDP Services cannot declare an HTTP or HTTPS browser scheme.",
          });
        }
        return yield* recipes
          .create({
            projectId: params.id,
            name: payload.name,
            command: command === undefined || command === "" ? null : command,
            port: payload.port,
            protocol,
            browserScheme,
          })
          .pipe(
            Effect.catchTag("RecipeNameTakenError", () =>
              Effect.fail(
                new StoreFailure({ message: `Already declared on this project: ${payload.name}` }),
              ),
            ),
          );
      }),
    )
    .handle("remove", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).manageProject(params.id);
        const projects = yield* ProjectsRepo;
        const recipes = yield* ProjectServiceRecipesRepo;
        yield* projects
          .byId(params.id)
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
        yield* recipes.remove(params.id, params.name);
      }),
    ),
);

/** The caller's own git access: how references they add or refresh are fetched. */
const callerGitMode = Effect.gen(function* () {
  const caller = yield* CurrentUser;
  const gitAccess = yield* UserGitAccessRepo;
  const mode = (yield* gitAccess.mode(caller.user.id)) ?? "mend-key";
  return { userId: caller.user.id, mode };
});

/** A reference of the caller's organization that the caller owns; `NotFound` otherwise. */
const ownedReference = (id: ReferenceId) =>
  Effect.gen(function* () {
    const viewer = yield* (yield* ProjectAccess).requireOwner(id);
    const references = yield* ReferencesRepo;
    const reference = yield* references.byId(id).pipe(Effect.mapError(() => new NotFound({ id })));
    if (reference.organizationId !== viewer.organizationId) return yield* new NotFound({ id });
    return reference;
  });

/**
 * Reference repositories belong to an organization (docs/adr/0003-organizations-and-tenancy.md):
 * members list them and projects select from them; owners add, refresh and remove them, fetching
 * with their own git access, never the host's.
 */
export const ReferencesGroupLive = HttpApiBuilder.group(MendApi, "references", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const viewer = yield* (yield* ProjectAccess).viewer();
        if (viewer === null) return [];
        const references = yield* ReferencesRepo;
        return yield* references.listForOrganization(viewer.organizationId);
      }),
    )
    .handle("add", ({ payload }) =>
      Effect.gen(function* () {
        const viewer = yield* (yield* ProjectAccess).requireOwner("references");
        const references = yield* ReferencesRepo;
        const store = yield* Store;
        if (!STORE_NAME.test(payload.name)) {
          return yield* new StoreFailure({
            message: `"${payload.name}" is not a usable reference name (lowercase letters, digits, ".", "_", "-").`,
          });
        }
        const pinned = yield* reachableSource(
          payload.source,
          (message) => new StoreFailure({ message }),
        );
        if ((yield* references.byName(viewer.organizationId, payload.name)) !== null) {
          return yield* new StoreFailure({
            message: `A reference named "${payload.name}" already exists.`,
          });
        }
        const { userId, mode } = yield* callerGitMode;
        const remoteEnv = pinned(yield* remoteEnvFor(mode, userId));
        const id = ReferenceId.make(crypto.randomUUID());
        const cloned = yield* withSignerContext(
          mode,
          userId,
          `reference ${payload.name} → ${payload.source}`,
          store
            .cloneReference(
              referenceDirectory(viewer.organizationId, id),
              payload.source,
              payload.ref,
              remoteEnv,
            )
            .pipe(Effect.mapError((error) => readableGitFailure(error.cause, mode))),
        );
        const created = yield* references.create({
          id,
          organizationId: viewer.organizationId,
          createdByUserId: userId,
          name: payload.name,
          originUrl: payload.source,
          path: cloned.path,
          pinnedRef: payload.ref,
          headSha: cloned.headSha,
        });
        yield* (yield* AuditEventsRepo).record({
          organizationId: viewer.organizationId,
          actorUserId: userId,
          action: "reference.added",
          subjectType: "reference",
          subjectId: created.id,
          data: { name: created.name },
        });
        return created;
      }),
    )
    .handle("remove", ({ params }) =>
      Effect.gen(function* () {
        const reference = yield* ownedReference(params.id);
        const references = yield* ReferencesRepo;
        const store = yield* Store;
        yield* store.removeReference(reference.path);
        yield* references.remove(params.id);
        yield* (yield* AuditEventsRepo).record({
          organizationId: reference.organizationId,
          actorUserId: (yield* CurrentUser).user.id,
          action: "reference.removed",
          subjectType: "reference",
          subjectId: reference.id,
          data: { name: reference.name },
        });
      }),
    )
    .handle("refresh", ({ params }) =>
      Effect.gen(function* () {
        const reference = yield* ownedReference(params.id);
        const references = yield* ReferencesRepo;
        const store = yield* Store;
        const pinned = yield* reachableSource(
          reference.originUrl,
          (message) => new StoreFailure({ message }),
        );
        const { userId, mode } = yield* callerGitMode;
        const remoteEnv = pinned(yield* remoteEnvFor(mode, userId));
        const refreshed = yield* withSignerContext(
          mode,
          userId,
          `reference ${reference.name} → origin`,
          store
            .refreshReference(reference.path, reference.pinnedRef, remoteEnv)
            .pipe(Effect.mapError((error) => readableGitFailure(error, mode))),
        );
        yield* references.setHead(params.id, refreshed.headSha);
        return yield* references
          .byId(params.id)
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
      }),
    )
    .handle("forProject", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).project(params.id);
        const references = yield* ReferencesRepo;
        return yield* references.listForProject(params.id);
      }),
    )
    .handle("selectForProject", ({ params, payload }) =>
      Effect.gen(function* () {
        const project = yield* (yield* ProjectAccess).manageProject(params.id);
        const references = yield* ReferencesRepo;
        // Only the project's own organization's references; any other id is not found.
        const found = new Set<string>(
          (yield* references.byIdsInOrganization(project.organizationId, payload.referenceIds)).map(
            (reference) => reference.id,
          ),
        );
        const missing = payload.referenceIds.find((id) => !found.has(id));
        if (missing !== undefined) return yield* new NotFound({ id: missing });
        yield* references.setForProject(params.id, payload.referenceIds);
        yield* rewarmHotSessions(params.id);
        return yield* references.listForProject(params.id);
      }),
    ),
);

/** Record who steered a session, after the act succeeded (docs/adr/0003). */
const recordControl = (sessionId: SessionId, kind: SessionControlKind, refId: string | null) =>
  Effect.gen(function* () {
    const caller = yield* CurrentUser;
    yield* (yield* SessionControlEventsRepo).record({
      sessionId,
      actorUserId: caller.user.id,
      kind,
      refId,
    });
  });

export const SessionsGroupLive = HttpApiBuilder.group(MendApi, "sessions", (handlers) =>
  handlers
    .handle("listActive", ({ query }) =>
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        const access = yield* ProjectAccess;
        const active = yield* access.filterByProject(yield* sessions.listActive());
        if (query.retained === undefined) return active;

        const ids = new Set(active.map((session) => session.id));
        const processes = yield* SessionProcessesRepo;
        for (const process of yield* processes.listLive()) {
          if (!isAgentProcessKind(process.kind)) ids.add(process.sessionId);
        }
        const services = yield* ServicesRepo;
        const forwards = yield* ServiceForwardsRepo;
        for (const forward of yield* forwards.listOpen()) {
          const service = yield* services.byId(forward.serviceId);
          if (service !== null) ids.add(service.sessionId);
        }
        const retained = [...active];
        for (const id of ids) {
          if (retained.some((session) => session.id === id)) continue;
          const session = yield* sessions
            .byId(id)
            .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
          if (session !== null) retained.push(session);
        }
        return yield* access.filterByProject(retained);
      }),
    )
    .handle("create", ({ params, payload }) =>
      Effect.gen(function* () {
        // The auth middleware guarantees a real account here (the CLI's static token included).
        const caller = yield* CurrentUser;
        const start = yield* makeSessionStart;
        return yield* start.createAs(caller.user.id, params.id, {
          harness: payload.harness,
          label: payload.label,
          name: payload.name,
          base: payload.base,
          origin: "mend",
          autoLand: payload.autoLand,
        });
      }),
    )
    .handle("detail", ({ params }) =>
      Effect.gen(function* () {
        const checkpoints = yield* CheckpointsRepo;
        const changes = yield* WorktreeChangesRepo;
        const landings = yield* ChangeLandingsRepo;
        const session = yield* (yield* ProjectAccess).session(params.id);
        // The chain and the change belong to the worktree: this is what makes
        // slices spanning several conversations reviewable from any of them.
        const sessionCheckpoints = yield* checkpoints.listForWorktree(session.worktreeId);
        const change = yield* changes.byWorktree(session.worktreeId);
        const processes = yield* SessionProcessesRepo;
        const rows = yield* processes.listForSession(params.id);
        const viewer = yield* (yield* ProjectAccess).viewer();
        const steer = viewer !== null && canSteerSession(session, viewer.userId);
        return new SessionDetail({
          session,
          control: new SessionControlView({
            own: viewer !== null && session.ownerUserId === viewer.userId,
            steer,
            stop: steer || viewer?.role === "owner",
            toggleSharedControl:
              viewer !== null &&
              canToggleSharedControl(session, viewer, session.sharedControlEnabledAt === null),
          }),
          checkpoints: sessionCheckpoints,
          change,
          landings: change === null ? [] : yield* landings.listForChange(change.id),
          processes: rows,
          currentAgent: currentAgentProcess(rows),
        });
      }),
    )
    .handle("submitTurn", ({ params, payload }) =>
      Effect.gen(function* () {
        const steering = yield* SessionSteering;
        yield* steering.session(params.id);
        const engine = yield* SessionEngine;
        const caller = yield* CurrentUser;
        return yield* engine
          .submitTurn(params.id, payload.input, caller.user.id)
          .pipe(
            Effect.catchTag("ProtocolHostNotLiveError", (error) =>
              Effect.fail(new ProtocolSessionNotLive({ processId: error.processId })),
            ),
          );
      }),
    )
    .handle("pasteImage", ({ params, payload }) =>
      Effect.gen(function* () {
        const steering = yield* SessionSteering;
        const session = yield* steering.session(params.id);
        const projects = yield* ProjectsRepo;
        const project = yield* projects
          .byId(session.projectId)
          .pipe(Effect.mapError(() => new NotFound({ id: session.projectId })));
        const bytes = Buffer.from(payload.contentsBase64, "base64");
        const stored = yield* storePastedImage(
          harnessHomePathOf(project.storePath, session.id),
          new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        ).pipe(
          Effect.catchTag("PastedImageError", (error) =>
            Effect.fail(
              error.reason === "write-failed"
                ? new StoreFailure({ message: error.message })
                : new PastedImageRejected({ message: error.message }),
            ),
          ),
        );
        return new PastedImage({
          path: stored.path,
          mediaType: stored.mediaType,
          bytes: stored.bytes,
        });
      }),
    )
    .handle("interruptTurn", ({ params }) =>
      Effect.gen(function* () {
        const steering = yield* SessionSteering;
        const { session } = yield* steering.turn(params.id);
        const engine = yield* SessionEngine;
        yield* engine
          .interruptTurn(params.id)
          .pipe(
            Effect.catchTag("ProtocolHostNotLiveError", (error) =>
              Effect.fail(new ProtocolSessionNotLive({ processId: error.processId })),
            ),
          );
        yield* recordControl(session.id, "interrupt", params.id);
      }),
    )
    .handle("listTurns", ({ params }) =>
      Effect.gen(function* () {
        const conversation = yield* AgentConversationRepo;
        yield* (yield* ProjectAccess).session(params.id);
        return yield* conversation.listTurns(params.id);
      }),
    )
    .handle("listItems", ({ params, query }) =>
      Effect.gen(function* () {
        const conversation = yield* AgentConversationRepo;
        yield* (yield* ProjectAccess).session(params.id);
        const rawAfter = Number(query.after ?? "0");
        const rawLimit = Number(query.limit ?? "100");
        const after = Number.isSafeInteger(rawAfter) && rawAfter >= 0 ? rawAfter : 0;
        const limit =
          Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
        return yield* conversation.listItems(params.id, after, limit);
      }),
    )
    .handle("listAgentRequests", ({ params, query }) =>
      Effect.gen(function* () {
        const conversation = yield* AgentConversationRepo;
        yield* (yield* ProjectAccess).session(params.id);
        return yield* conversation.listRequests(params.id, query.pending === "1");
      }),
    )
    .handle("respondAgentRequest", ({ params, payload }) =>
      Effect.gen(function* () {
        const steering = yield* SessionSteering;
        yield* steering.agentRequest(params.id);
        const engine = yield* SessionEngine;
        const caller = yield* CurrentUser;
        return yield* engine.respondRequest(params.id, payload, caller.user.id).pipe(
          Effect.catchTag("ProtocolHostNotLiveError", (error) =>
            Effect.fail(new ProtocolSessionNotLive({ processId: error.processId })),
          ),
          Effect.catchTag("AgentRequestNotFoundError", () =>
            Effect.fail(new NotFound({ id: params.id })),
          ),
          Effect.catchTag("AgentRequestAlreadyResolvedError", () =>
            Effect.fail(new AgentRequestResolved({ requestId: params.id })),
          ),
        );
      }),
    )
    .handle("listProcesses", ({ params }) =>
      Effect.gen(function* () {
        const processes = yield* SessionProcessesRepo;
        yield* (yield* ProjectAccess).session(params.id);
        return yield* processes.listForSession(params.id);
      }),
    )
    .handle("openShell", ({ params }) =>
      Effect.gen(function* () {
        const steering = yield* SessionSteering;
        yield* steering.session(params.id);
        const engine = yield* SessionEngine;
        const shell = yield* engine.openShell(params.id).pipe(
          Effect.catchTag("SessionNotFoundError", () =>
            Effect.fail(new NotFound({ id: params.id })),
          ),
          Effect.catchTag("LegacyBenchReadOnlyError", () =>
            Effect.fail(new StoreFailure({ message: "Legacy bench sessions are review-only." })),
          ),
          Effect.catchTag("SessionNotLiveError", () =>
            Effect.fail(new SessionNotLive({ id: params.id })),
          ),
          Effect.catchTag("SealantPlatformError", (error) =>
            Effect.fail(new StoreFailure({ message: error.message })),
          ),
        );
        yield* recordControl(params.id, "shell-open", shell.id);
        return shell;
      }),
    )
    .handle("stopShell", ({ params }) =>
      Effect.gen(function* () {
        const steering = yield* SessionSteering;
        yield* steering.process(params.id);
        const engine = yield* SessionEngine;
        return yield* engine
          .stopShell(params.id)
          .pipe(
            Effect.catchTag("ShellProcessNotFoundError", () =>
              Effect.fail(new NotFound({ id: params.id })),
            ),
          );
      }),
    )
    .handle("renameShell", ({ params, payload }) =>
      Effect.gen(function* () {
        const steering = yield* SessionSteering;
        yield* steering.process(params.id);
        const engine = yield* SessionEngine;
        return yield* engine.renameShell(params.id, payload.label).pipe(
          Effect.catchTag("ShellProcessNotFoundError", () =>
            Effect.fail(new NotFound({ id: params.id })),
          ),
          Effect.catchTag("ShellLabelError", (error) =>
            Effect.fail(new StoreFailure({ message: error.message })),
          ),
        );
      }),
    )
    .handle("addService", ({ params, payload }) =>
      Effect.gen(function* () {
        const steering = yield* SessionSteering;
        yield* steering.session(params.id);
        const engine = yield* SessionEngine;
        return yield* engine
          .addService(
            params.id,
            payload.port,
            payload.name,
            payload.protocol,
            payload.browserScheme,
          )
          .pipe(
            Effect.catchTag("SessionNotFoundError", () =>
              Effect.fail(new NotFound({ id: params.id })),
            ),
            Effect.catchTag("LegacyBenchReadOnlyError", () =>
              Effect.fail(new StoreFailure({ message: "Legacy bench sessions are review-only." })),
            ),
            Effect.catchTag("SessionNotLiveError", () =>
              Effect.fail(new SessionNotLive({ id: params.id })),
            ),
            Effect.catchTags({
              SealantPlatformError: (error) =>
                Effect.fail(new StoreFailure({ message: error.message })),
              ServiceBindError: (error) =>
                Effect.fail(new StoreFailure({ message: error.message })),
            }),
          );
      }),
    )
    .handle("runService", ({ params, payload }) =>
      Effect.gen(function* () {
        const steering = yield* SessionSteering;
        yield* steering.session(params.id);
        const engine = yield* SessionEngine;
        return yield* engine
          .runService(
            params.id,
            payload.argv,
            payload.port,
            payload.name,
            payload.protocol,
            payload.browserScheme,
          )
          .pipe(
            Effect.catchTag("SessionNotFoundError", () =>
              Effect.fail(new NotFound({ id: params.id })),
            ),
            Effect.catchTag("LegacyBenchReadOnlyError", () =>
              Effect.fail(new StoreFailure({ message: "Legacy bench sessions are review-only." })),
            ),
            Effect.catchTag("SessionNotLiveError", () =>
              Effect.fail(new SessionNotLive({ id: params.id })),
            ),
            Effect.catchTags({
              SealantPlatformError: (error) =>
                Effect.fail(new StoreFailure({ message: error.message })),
              ServiceBindError: (error) =>
                Effect.fail(new StoreFailure({ message: error.message })),
              ServiceStartError: (error) =>
                Effect.fail(new StoreFailure({ message: error.message })),
            }),
          );
      }),
    )
    .handle("runServiceRecipe", ({ params, payload }) =>
      Effect.gen(function* () {
        const steering = yield* SessionSteering;
        yield* steering.session(params.id);
        const engine = yield* SessionEngine;
        return yield* engine.runServiceRecipe(params.id, payload.name).pipe(
          Effect.catchTag("SessionNotFoundError", () =>
            Effect.fail(new NotFound({ id: params.id })),
          ),
          Effect.catchTag("LegacyBenchReadOnlyError", () =>
            Effect.fail(new StoreFailure({ message: "Legacy bench sessions are review-only." })),
          ),
          Effect.catchTag("SessionNotLiveError", () =>
            Effect.fail(new SessionNotLive({ id: params.id })),
          ),
          Effect.catchTags({
            SealantPlatformError: (error) =>
              Effect.fail(new StoreFailure({ message: error.message })),
            ServiceBindError: (error) => Effect.fail(new StoreFailure({ message: error.message })),
            ServiceStartError: (error) => Effect.fail(new StoreFailure({ message: error.message })),
          }),
        );
      }),
    )
    .handle("listRecipes", ({ params }) =>
      Effect.gen(function* () {
        const session = yield* (yield* ProjectAccess).session(params.id);
        // The session's own worktree copy wins — an agent's edit counts. The engine reads it
        // beside the worktree when co-located, else from the session's live workspace.
        const engine = yield* SessionEngine;
        return yield* engine.listServiceRecipes(session.id).pipe(
          Effect.catchTags({
            SessionNotFoundError: () => Effect.fail(new NotFound({ id: params.id })),
            ProjectNotFoundError: () => Effect.fail(new NotFound({ id: session.projectId })),
            RecipeFileError: (error) => Effect.fail(new StoreFailure({ message: error.message })),
            SealantPlatformError: (error) =>
              Effect.fail(new StoreFailure({ message: error.message })),
          }),
        );
      }),
    )
    .handle("listServices", ({ query }) =>
      Effect.gen(function* () {
        const services = yield* ServicesRepo;
        const sessions = yield* SessionsRepo;
        const processes = yield* SessionProcessesRepo;
        const forwards = yield* ServiceForwardsRepo;
        const observations = yield* ServiceObservationsRepo;
        const access = yield* ProjectAccess;
        // Drop what the caller cannot see before any forward or observation is read.
        const visible = new Set<string>((yield* access.visibleProjects()).map((row) => row.id));
        const all = yield* services.listAll();
        const rows: Array<(typeof all)[number]> = [];
        for (const service of all) {
          const owner = yield* sessions
            .byId(service.sessionId)
            .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
          if (owner !== null && visible.has(owner.projectId)) rows.push(service);
        }
        const views = yield* Effect.forEach(rows, (service) =>
          Effect.gen(function* () {
            const attempts = yield* processes.listForService(service.id);
            const currentForward =
              service.currentForwardId === null
                ? null
                : yield* forwards.byId(service.currentForwardId);
            const previousForward =
              currentForward === null || currentForward.supersedesForwardId === null
                ? null
                : yield* forwards.byId(currentForward.supersedesForwardId);
            const latestObservation = yield* observations.latestForService(service.id);
            const session = yield* sessions.byId(service.sessionId).pipe(Effect.orDie);
            return new ServiceView({
              service,
              attempts,
              currentForward,
              previousForward,
              latestObservation,
              workspaceExpiresAt: session.workspaceExpiresAt,
              workspaceTtlRenewedAt: session.workspaceTtlRenewedAt,
              workspaceTtlRenewalFailedAt: session.workspaceTtlRenewalFailedAt,
              workspaceTtlRenewalError: session.workspaceTtlRenewalError,
              endpoints: resolveServiceEndpoints(service, currentForward),
              previousEndpoints: resolveServiceEndpoints(service, previousForward),
            });
          }),
        );
        if (query.all !== undefined) return views;
        return views.filter(
          (view) =>
            view.attempts.some((attempt) => attempt.exitedAt === null) ||
            view.currentForward?.state === "binding" ||
            view.currentForward?.state === "bound",
        );
      }),
    )
    .handle("processLogs", ({ params, query }) =>
      Effect.gen(function* () {
        const sealant = yield* SealantClient;
        const { process: row } = yield* (yield* ProjectAccess).process(params.id);
        if (row.sealantSessionId === null) {
          return yield* new StoreFailure({
            message:
              "This process has no interactive-session pointer, so its PTY logs are unaddressed.",
          });
        }
        const from = query.from ?? "0";
        const limit = query.limit ?? "256";
        if (!/^(0|[1-9]\d*)$/.test(from)) {
          return yield* new StoreFailure({ message: `Invalid decimal log cursor: ${from}` });
        }
        if (!/^[1-9]\d*$/.test(limit) || BigInt(limit) > 1_000n) {
          return yield* new StoreFailure({ message: `Invalid log page limit: ${limit}` });
        }
        const page = yield* sealant
          .sessionOutput(row.sealantSessionId, { from, limit })
          .pipe(Effect.mapError((error) => new StoreFailure({ message: error.message })));
        return new ProcessLogPage({
          processId: row.id,
          sealantSessionId: row.sealantSessionId,
          sealantRunId: row.sealantRunId,
          requestedFrom: from,
          firstSequence: page.chunks[0]?.sequence ?? null,
          lastSequence: page.chunks.at(-1)?.sequence ?? null,
          nextFrom: page.nextFrom,
          status: page.status,
          chunks: page.chunks,
          telemetryLoss: "unknown" as const,
          telemetryNote:
            "Sealant does not report retained-range loss for interactive-session output.",
        });
      }),
    )
    .handle("restartService", ({ params }) =>
      Effect.gen(function* () {
        const steering = yield* SessionSteering;
        yield* steering.service(params.id);
        const engine = yield* SessionEngine;
        return yield* engine.restartService(params.id).pipe(
          Effect.catchTag("ServiceNotFoundError", () =>
            Effect.fail(new NotFound({ id: params.id })),
          ),
          Effect.catchTags({
            SealantPlatformError: (error) =>
              Effect.fail(new StoreFailure({ message: error.message })),
            ServiceStartError: (error) => Effect.fail(new StoreFailure({ message: error.message })),
            ServiceBindError: (error) => Effect.fail(new StoreFailure({ message: error.message })),
          }),
        );
      }),
    )
    .handle("stopService", ({ params }) =>
      Effect.gen(function* () {
        const steering = yield* SessionSteering;
        yield* steering.service(params.id);
        const engine = yield* SessionEngine;
        return yield* engine
          .stopService(params.id)
          .pipe(
            Effect.catchTag("ServiceNotFoundError", () =>
              Effect.fail(new NotFound({ id: params.id })),
            ),
          );
      }),
    )
    .handle("remove", ({ params }) =>
      Effect.gen(function* () {
        const steering = yield* SessionSteering;
        const session = yield* steering.owned(params.id);
        const sessions = yield* SessionsRepo;
        const projects = yield* ProjectsRepo;
        const processes = yield* SessionProcessesRepo;
        const services = yield* ServicesRepo;
        const forwards = yield* ServiceForwardsRepo;
        const liveProcesses = (yield* processes.listForSession(params.id)).filter(
          (process) => process.exitedAt === null,
        );
        const serviceIds = new Set(
          (yield* services.listForSession(params.id)).map((service) => service.id),
        );
        const liveForwards = (yield* forwards.listOpen()).filter((forward) =>
          serviceIds.has(forward.serviceId),
        );
        // An agent still working is never removed from under it. An idle session — the agent
        // gone, the workspace held by a shell or by nothing — is what "remove after kill" means:
        // a stop here closes the shells and settles it, then the record goes.
        const agentLive = liveProcesses.some((process) => isAgentProcessKind(process.kind));
        if (agentLive || liveForwards.length > 0) {
          return yield* new SessionActive({ id: params.id });
        }
        let current = session;
        if (LIVE_STATES.has(current.status) || liveProcesses.length > 0) {
          const engine = yield* SessionEngine;
          yield* engine
            .stop(params.id)
            .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
          current = yield* sessions
            .byId(params.id)
            .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
          if (LIVE_STATES.has(current.status)) {
            return yield* new SessionActive({ id: params.id });
          }
        }
        const project = yield* projects
          .byId(session.projectId)
          .pipe(Effect.mapError(() => new NotFound({ id: session.projectId })));
        // The worktree-container split: deleting a conversation deletes the
        // conversation record only. The worktree — with its change, chain, and
        // review — is a durable place removed only by its own explicit verb
        // (DELETE /worktrees/:id). The legacy-bench diff guard still protects a
        // bench whose LAST conversation is leaving.
        if (session.harness === "shell" && session.label === "bench") {
          const siblings = yield* sessions.listForWorktree(session.worktreeId);
          if (siblings.every((sibling) => sibling.id === session.id)) {
            const reads = yield* WorktreeReads;
            const diff = (yield* reads
              .diffWorktree(project.id, session.worktreeId, session.baseSha)
              .pipe(Effect.mapError(readFailure))).value;
            if (diff.trim() !== "") {
              return yield* new StoreFailure({
                message:
                  "This legacy bench still contains a reviewable change. Review, land or discard it before removal.",
              });
            }
          }
        }
        yield* sessions.remove(params.id);
        return new RemovalReport({ removed: true, leftover: null });
      }),
    )
    .handle("label", ({ params, payload }) =>
      Effect.gen(function* () {
        const steering = yield* SessionSteering;
        yield* steering.owned(params.id);
        const sessions = yield* SessionsRepo;
        const trimmed = payload.label === null ? null : payload.label.trim();
        yield* sessions.setLabel(params.id, trimmed === "" ? null : trimmed);
        return yield* sessions
          .byId(params.id)
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
      }),
    )
    .handle("stop", ({ params }) =>
      Effect.gen(function* () {
        const steering = yield* SessionSteering;
        yield* steering.stop(params.id);
        const engine = yield* SessionEngine;
        const sessions = yield* SessionsRepo;
        yield* engine.stop(params.id).pipe(Effect.mapError(() => new NotFound({ id: params.id })));
        yield* recordControl(params.id, "stop", null);
        return yield* sessions
          .byId(params.id)
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
      }),
    )
    .handle("sharedControl", ({ params, payload }) =>
      Effect.gen(function* () {
        const access = yield* ProjectAccess;
        const session = yield* access.session(params.id);
        const viewer = yield* access.viewer();
        if (viewer === null || !canToggleSharedControl(session, viewer, payload.enabled)) {
          return yield* new SessionNotSteerable({
            sessionId: session.id,
            message: "only the session owner can share control of this session",
          });
        }
        const sessions = yield* SessionsRepo;
        const updated = yield* sessions
          .setSharedControl(params.id, payload.enabled ? viewer.userId : null)
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
        yield* recordControl(
          params.id,
          payload.enabled ? "shared-control-on" : "shared-control-off",
          null,
        );
        yield* (yield* AuditEventsRepo).record({
          organizationId: viewer.organizationId,
          actorUserId: viewer.userId,
          action: payload.enabled ? "session.shared_control_on" : "session.shared_control_off",
          subjectType: "session",
          subjectId: params.id,
        });
        return updated;
      }),
    )
    .handle("controlEvents", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).session(params.id);
        return yield* (yield* SessionControlEventsRepo).listForSession(params.id);
      }),
    )
    .handle("checkpoint", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).session(params.id);
        const engine = yield* SessionEngine;
        return yield* engine.checkpointNow(params.id, payload.trigger).pipe(
          Effect.catchTag("SessionNotFoundError", () =>
            Effect.fail(new NotFound({ id: params.id })),
          ),
          Effect.catchTag("ProjectNotFoundError", () =>
            Effect.fail(new NotFound({ id: params.id })),
          ),
          Effect.catchTag("GitError", (error) =>
            Effect.fail(new StoreFailure({ message: error.stderr })),
          ),
        );
      }),
    )
    .handle("transcript", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).session(params.id);
        const engine = yield* SessionEngine;
        const result = yield* engine
          .transcript(params.id)
          .pipe(
            Effect.catchTag("SessionNotFoundError", () =>
              Effect.fail(new NotFound({ id: params.id })),
            ),
          );
        return new SessionTranscript({
          sourceHarness: result.sourceHarness,
          events: result.events.map(
            (event) =>
              new TranscriptEvent({
                kind: event.kind,
                text: "text" in event ? event.text : null,
                name: event.kind === "tool" ? event.name : null,
                command: event.kind === "tool" ? event.command : null,
                output: event.kind === "tool" ? event.output : null,
              }),
          ),
        });
      }),
    )
    .handle("handoff", ({ params, payload }) =>
      Effect.gen(function* () {
        const steering = yield* SessionSteering;
        yield* steering.owned(params.id);
        const engine = yield* SessionEngine;
        return yield* engine
          .handoff(
            params.id,
            payload.to,
            {
              mode: payload.to === "protocol" ? "protocol" : "pty",
              ...(payload.prompt === undefined ? {} : { prompt: payload.prompt }),
              ...(payload.model === undefined ? {} : { model: payload.model }),
              ...(payload.effort === undefined ? {} : { effort: payload.effort }),
              ...(payload.permissionMode === undefined
                ? {}
                : { permissionMode: payload.permissionMode }),
            },
            null,
          )
          .pipe(
            Effect.catchTag("SessionNotFoundError", () =>
              Effect.fail(new NotFound({ id: params.id })),
            ),
            Effect.catchTag("ProjectNotFoundError", () =>
              Effect.fail(new NotFound({ id: params.id })),
            ),
            Effect.catchTag("HandoffUnsupportedError", (error) =>
              Effect.fail(
                new HandoffUnsupported({
                  sessionId: error.sessionId,
                  harness: error.harness,
                  to: error.to,
                }),
              ),
            ),
            Effect.catchTag("ProtocolHarnessUnsupportedError", (error) =>
              Effect.fail(
                new HandoffUnsupported({
                  sessionId: params.id,
                  harness: error.message,
                  to: payload.to,
                }),
              ),
            ),
            Effect.catchTag("LegacyBenchReadOnlyError", () =>
              Effect.fail(new StoreFailure({ message: "Legacy bench sessions are review-only." })),
            ),
            Effect.catchTag("SessionNotLiveError", () =>
              Effect.fail(
                new StoreFailure({ message: "The retained workspace is not reachable." }),
              ),
            ),
            Effect.catchTag("SealantPlatformError", (error) =>
              Effect.fail(new StoreFailure({ message: error.message })),
            ),
            Effect.catchTags({
              HarnessStateNotFoundError: (error) =>
                Effect.fail(new StoreFailure({ message: error.message })),
              HarnessStateIOError: (error) =>
                Effect.fail(new StoreFailure({ message: error.message })),
              HarnessStateInvalidError: (error) =>
                Effect.fail(new StoreFailure({ message: error.message })),
              HarnessStateCommandError: (error) =>
                Effect.fail(new StoreFailure({ message: error.message })),
              SessionLaunchSetupError: (error) =>
                Effect.fail(new StoreFailure({ message: error.message })),
              DotfilesResolveError: (error) =>
                Effect.fail(new StoreFailure({ message: error.message })),
            }),
          );
      }),
    )
    .handle("resume", ({ params, payload }) =>
      Effect.gen(function* () {
        const steering = yield* SessionSteering;
        yield* steering.session(params.id);
        const engine = yield* SessionEngine;
        return yield* engine.resumeSession(params.id, payload.harness, payload.fresh ?? false).pipe(
          Effect.catchTag("SessionNotFoundError", () =>
            Effect.fail(new NotFound({ id: params.id })),
          ),
          Effect.catchTag("LegacyBenchReadOnlyError", () =>
            Effect.fail(new StoreFailure({ message: "Legacy bench sessions are review-only." })),
          ),
          Effect.catchTag("ProjectNotFoundError", () =>
            Effect.fail(new NotFound({ id: params.id })),
          ),
          Effect.catchTag("SessionNotLiveError", () =>
            Effect.fail(new StoreFailure({ message: "The retained workspace is not reachable." })),
          ),
          Effect.catchTag("SealantPlatformError", (error) =>
            Effect.fail(new StoreFailure({ message: error.message })),
          ),
          Effect.catchTags({
            HarnessStateNotFoundError: (error) =>
              Effect.fail(new StoreFailure({ message: error.message })),
            HarnessStateIOError: (error) =>
              Effect.fail(new StoreFailure({ message: error.message })),
            HarnessStateInvalidError: (error) =>
              Effect.fail(new StoreFailure({ message: error.message })),
            HarnessStateCommandError: (error) =>
              Effect.fail(new StoreFailure({ message: error.message })),
            SessionLaunchSetupError: (error) =>
              Effect.fail(new StoreFailure({ message: error.message })),
            DotfilesResolveError: (error) =>
              Effect.fail(new StoreFailure({ message: error.message })),
          }),
        );
      }),
    )
    .handle("launch", ({ params, payload }) =>
      Effect.gen(function* () {
        const steering = yield* SessionSteering;
        const session = yield* steering.session(params.id);
        const caller = yield* CurrentUser;
        const start = yield* makeSessionStart;
        return yield* start.launchAs(caller.user.id, session, payload);
      }),
    )
    .handle("followUpPending", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).session(params.id);
        const followUps = yield* FollowUpsRepo;
        return yield* followUps.activeForSession(params.id);
      }),
    )
    .handle("followUpDeliver", ({ params, payload }) =>
      Effect.gen(function* () {
        const steering = yield* SessionSteering;
        yield* steering.session(params.id);
        const caller = yield* CurrentUser;
        const delivery = yield* FollowUpDelivery;
        return yield* delivery
          .deliver({
            sessionId: params.id,
            reviewSliceId: payload.reviewSliceId,
            checkpointAId: payload.checkpointAId,
            checkpointBId: payload.checkpointBId,
            diffDigest: payload.diffDigest,
            commentIds: payload.commentIds,
            instruction: payload.instruction,
            idempotencyKey: payload.idempotencyKey,
            // The turn is the reviewer's, so automatic landing checks it against the owner.
            author: caller.user.id,
          })
          .pipe(Effect.mapError((error) => new StoreFailure({ message: error.message })));
      }),
    ),
);

const toFailure = (error: { readonly stderr: string }) =>
  new StoreFailure({ message: error.stderr });

const openReviewResult = Effect.fn("SessionChanges.openReviewResult")(function* (
  slice: ReviewSlice,
  reused: boolean,
) {
  const checkpoints = yield* CheckpointsRepo;
  const checkpointA = yield* checkpoints.byId(slice.checkpointAId);
  const checkpointB = yield* checkpoints.byId(slice.checkpointBId);
  if (checkpointA === null || checkpointB === null) {
    return yield* new NotFound({ id: slice.id });
  }
  return new OpenReviewResult({ slice, checkpointA, checkpointB, reused });
});

const loadReviewContext = Effect.fn("SessionChanges.loadReviewContext")(function* (
  changeId: ChangeId,
  sliceId: ReviewSliceId,
) {
  const changes = yield* WorktreeChangesRepo;
  const worktrees = yield* WorktreesRepo;
  const projects = yield* ProjectsRepo;
  const slices = yield* ReviewSlicesRepo;
  const checkpoints = yield* CheckpointsRepo;
  const change = yield* changes
    .byId(changeId)
    .pipe(Effect.mapError(() => new NotFound({ id: changeId })));
  const slice = yield* slices.byId(sliceId);
  if (slice === null || slice.changeId !== changeId) {
    return yield* new NotFound({ id: sliceId });
  }
  const worktreeRow = yield* worktrees
    .byId(change.worktreeId)
    .pipe(Effect.mapError(() => new NotFound({ id: change.worktreeId })));
  const project = yield* projects
    .byId(change.projectId)
    .pipe(Effect.mapError(() => new NotFound({ id: change.projectId })));
  const checkpointA = yield* checkpoints.byId(slice.checkpointAId);
  const checkpointB = yield* checkpoints.byId(slice.checkpointBId);
  // Ownership is worktree-level: any two checkpoints of the worktree's chain
  // define a slice, whichever conversations took them.
  if (
    checkpointA === null ||
    checkpointB === null ||
    checkpointA.worktreeId !== worktreeRow.id ||
    checkpointB.worktreeId !== worktreeRow.id
  ) {
    return yield* new NotFound({ id: slice.id });
  }
  return {
    change,
    worktreeRow,
    project,
    slice,
    checkpointA,
    checkpointB,
    worktree: worktreePathOf(project.storePath, worktreeRow.directory),
  };
});

export const SessionChangesGroupLive = HttpApiBuilder.group(MendApi, "sessionChanges", (handlers) =>
  handlers
    .handle("openReview", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).change(params.id);
        const slices = yield* ReviewSlicesRepo;
        return yield* slices.withChangeLock(
          params.id,
          Effect.gen(function* () {
            const key = payload.idempotencyKey.trim();
            if (key === "" || key.length > 200) {
              return yield* new StoreFailure({
                message: "Review idempotency keys must contain between 1 and 200 characters.",
              });
            }
            const changes = yield* WorktreeChangesRepo;
            const projects = yield* ProjectsRepo;
            const checkpoints = yield* CheckpointsRepo;
            const reads = yield* WorktreeReads;
            const engine = yield* SessionEngine;
            const change = yield* changes
              .byId(params.id)
              .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
            const existing = yield* slices.byIdempotencyKey(params.id, key);
            if (existing !== null) return yield* openReviewResult(existing, true);

            const worktrees = yield* WorktreesRepo;
            const worktreeRow = yield* worktrees
              .byId(change.worktreeId)
              .pipe(Effect.mapError(() => new NotFound({ id: change.worktreeId })));
            const project = yield* projects
              .byId(change.projectId)
              .pipe(Effect.mapError(() => new NotFound({ id: change.projectId })));
            // Anchor at ordinal 0 — the worktree's base state — so the review
            // spans every conversation's work, not one session's slice of it.
            const chain = yield* checkpoints.listForWorktree(worktreeRow.id);
            const checkpointA = chain.find((checkpoint) => checkpoint.ordinal === 0);
            if (checkpointA === undefined) {
              return yield* new StoreFailure({
                message: "The worktree has no ordinal-0 checkpoint to anchor Review.",
              });
            }

            const latest = yield* slices.latestForChange(params.id);
            if (latest !== null) {
              const latestB = yield* checkpoints.byId(latest.checkpointBId);
              if (latestB !== null) {
                const worktreeMatches = (yield* reads
                  .worktreeMatchesCommit(project.id, worktreeRow.id, latestB.sha)
                  .pipe(Effect.mapError(readFailure))).value;
                if (worktreeMatches) {
                  const reused = yield* slices.create({
                    changeId: params.id,
                    checkpointAId: latest.checkpointAId,
                    checkpointBId: latest.checkpointBId,
                    diffDigest: latest.diffDigest,
                    idempotencyKey: key,
                  });
                  return yield* openReviewResult(reused, true);
                }
              }
            }

            const orphanedCheckpoint = chain
              .toReversed()
              .find((checkpoint) => checkpoint.trigger === "review-open");
            if (orphanedCheckpoint !== undefined) {
              const worktreeMatches = (yield* reads
                .worktreeMatchesCommit(project.id, worktreeRow.id, orphanedCheckpoint.sha)
                .pipe(Effect.mapError(readFailure))).value;
              if (worktreeMatches) {
                const patch = (yield* reads
                  .diffRange(project.id, worktreeRow.id, checkpointA.sha, orphanedCheckpoint.sha)
                  .pipe(Effect.mapError(readFailure))).value;
                const recovered = yield* slices.create({
                  changeId: params.id,
                  checkpointAId: checkpointA.id,
                  checkpointBId: orphanedCheckpoint.id,
                  diffDigest: DiffDigest.make(digestReviewPatch(patch)),
                  idempotencyKey: key,
                });
                return yield* openReviewResult(recovered, true);
              }
            }

            // Snapshot through a conversation when one exists (newest live wins,
            // else the last contributor) — the checkpoint's provenance is honest
            // either way, and the chain is the worktree's.
            const viaSessionId =
              (yield* worktrees.newestLiveSessionId(worktreeRow.id)) ?? change.sessionId;
            if (viaSessionId === null) {
              return yield* new StoreFailure({
                message: "No conversation has inhabited this worktree yet — nothing to review.",
              });
            }
            const checkpointB = yield* engine.checkpointNow(viaSessionId, "review-open").pipe(
              Effect.catchTags({
                SessionNotFoundError: () => Effect.fail(new NotFound({ id: viaSessionId })),
                ProjectNotFoundError: () => Effect.fail(new NotFound({ id: project.id })),
                GitError: (error) => Effect.fail(toFailure(error)),
              }),
            );
            const patch = (yield* reads
              .diffRange(project.id, worktreeRow.id, checkpointA.sha, checkpointB.sha)
              .pipe(Effect.mapError(readFailure))).value;
            const slice = yield* slices.create({
              changeId: params.id,
              checkpointAId: checkpointA.id,
              checkpointBId: checkpointB.id,
              diffDigest: DiffDigest.make(digestReviewPatch(patch)),
              idempotencyKey: key,
            });
            return yield* openReviewResult(slice, false);
          }),
        );
      }),
    )
    .handle("reviewDiff", ({ params, query }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).change(params.id);
        const context = yield* loadReviewContext(params.id, params.sliceId);
        const reads = yield* WorktreeReads;
        const { project, worktreeRow } = context;
        const canonicalPatch = (yield* reads
          .diffRange(project.id, worktreeRow.id, context.checkpointA.sha, context.checkpointB.sha)
          .pipe(Effect.mapError(readFailure))).value;
        if (digestReviewPatch(canonicalPatch) !== context.slice.diffDigest) {
          return yield* new StoreFailure({
            message: "The Review patch did not match its persisted diff digest.",
          });
        }
        const contextLines =
          query.context === undefined ? undefined : Number.parseInt(query.context, 10);
        if (
          contextLines !== undefined &&
          (!Number.isInteger(contextLines) ||
            contextLines < 0 ||
            contextLines > 100 ||
            String(contextLines) !== query.context)
        ) {
          return yield* new StoreFailure({
            message: "Review context must be a whole number from 0 to 100.",
          });
        }
        const patch =
          query.whitespace === "ignore" || contextLines !== undefined
            ? (yield* reads
                .diffRange(
                  project.id,
                  worktreeRow.id,
                  context.checkpointA.sha,
                  context.checkpointB.sha,
                  contextLines === undefined
                    ? { ignoreWhitespace: query.whitespace === "ignore" }
                    : { ignoreWhitespace: query.whitespace === "ignore", contextLines },
                )
                .pipe(Effect.mapError(readFailure))).value
            : canonicalPatch;
        const canonicalFacts = (yield* reads
          .diffFileFacts(
            project.id,
            worktreeRow.id,
            context.checkpointA.sha,
            context.checkpointB.sha,
          )
          .pipe(Effect.mapError(readFailure))).value;
        const renderedFacts =
          query.whitespace === "ignore"
            ? (yield* reads
                .diffFileFacts(
                  project.id,
                  worktreeRow.id,
                  context.checkpointA.sha,
                  context.checkpointB.sha,
                  { ignoreWhitespace: true },
                )
                .pipe(Effect.mapError(readFailure))).value
            : canonicalFacts;
        const anchorFiles = reviewDiffViews(canonicalPatch, canonicalFacts);
        const files =
          patch === canonicalPatch ? anchorFiles : reviewDiffViews(patch, renderedFacts);
        const worktreeMatches = yield* reads
          .worktreeMatchesCommit(project.id, worktreeRow.id, context.checkpointB.sha)
          .pipe(Effect.mapError(readFailure));
        return new ReviewDiffView({
          change: context.change,
          slice: context.slice,
          checkpointA: context.checkpointA,
          checkpointB: context.checkpointB,
          patch,
          files,
          anchorFiles,
          worktreeChangedSinceSnapshot: !worktreeMatches.value,
          observation: observationOf(worktreeMatches.stamp),
        });
      }),
    )
    .handle("sliceComment", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).change(params.id);
        const context = yield* loadReviewContext(params.id, params.sliceId);
        const comments = yield* ReviewCommentsRepo;
        const reads = yield* WorktreeReads;
        const user = yield* CurrentUser;
        const patch = (yield* reads
          .diffRange(
            context.project.id,
            context.worktreeRow.id,
            context.checkpointA.sha,
            context.checkpointB.sha,
          )
          .pipe(Effect.mapError(readFailure))).value;
        if (digestReviewPatch(patch) !== context.slice.diffDigest) {
          return yield* new StoreFailure({
            message: "The Review patch did not match its persisted diff digest.",
          });
        }
        const facts = (yield* reads
          .diffFileFacts(
            context.project.id,
            context.worktreeRow.id,
            context.checkpointA.sha,
            context.checkpointB.sha,
          )
          .pipe(Effect.mapError(readFailure))).value;
        const files = parseReviewDiff(patch, facts);
        const target = payload.target;
        const hasPath = target.oldPath !== null || target.newPath !== null;
        const hasNoLocation =
          target.side === null &&
          target.startLine === null &&
          target.endLine === null &&
          target.hunkContextHash === null;
        const fileExists = files.some(
          (file) => file.oldPath === target.oldPath && file.newPath === target.newPath,
        );
        const lineTargetComplete =
          target.side !== null &&
          target.startLine !== null &&
          target.endLine !== null &&
          target.hunkContextHash !== null;
        const targetValid =
          (!hasPath && hasNoLocation) ||
          (hasPath && hasNoLocation && fileExists) ||
          (hasPath &&
            lineTargetComplete &&
            lineAnchorExists(files, {
              oldPath: target.oldPath,
              newPath: target.newPath,
              side: target.side,
              startLine: target.startLine,
              endLine: target.endLine,
              hunkContextHash: target.hunkContextHash,
            }));
        const body = payload.body.trim();
        if (!targetValid || body === "") {
          return yield* new StoreFailure({
            message:
              body === ""
                ? "Review comments cannot be empty."
                : "The comment anchor is not present in this Review slice.",
          });
        }
        const anchor = new ReviewCommentAnchor({
          reviewSliceId: context.slice.id,
          checkpointAId: context.checkpointA.id,
          checkpointBId: context.checkpointB.id,
          diffDigest: context.slice.diffDigest,
          oldPath: target.oldPath,
          newPath: target.newPath,
          side: target.side,
          startLine: target.startLine,
          endLine: target.endLine,
          hunkContextHash: target.hunkContextHash,
          mapping: "anchored",
        });
        return yield* comments.create({
          changeId: params.id,
          file: target.side === "old" ? target.oldPath : (target.newPath ?? target.oldPath),
          line: target.startLine,
          endLine: target.endLine,
          anchor,
          authorKind: "reviewer",
          authorName: user.user.name === "" ? user.user.email : user.user.name,
          body,
          state: "open",
        });
      }),
    )
    .handle("diff", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).change(params.id);
        const changes = yield* WorktreeChangesRepo;
        const projects = yield* ProjectsRepo;
        const reads = yield* WorktreeReads;
        const capture = yield* CaptureRuntime;
        const change = yield* changes
          .byId(params.id)
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
        const worktrees = yield* WorktreesRepo;
        const worktreeRow = yield* worktrees
          .byId(change.worktreeId)
          .pipe(Effect.mapError(() => new NotFound({ id: change.worktreeId })));
        const project = yield* projects
          .byId(change.projectId)
          .pipe(Effect.mapError(() => new NotFound({ id: change.projectId })));
        // Summary first (ADR-0002 "Review"): the executor's posted summary for the chain head,
        // stamped `claimed` until the observed pass recomputes it on a runner; a head without
        // a summary is computed here — "compute it", never an error.
        if (capture.enabled) {
          const head = (yield* capture.repo.headOf(worktreeRow.id))?.head ?? null;
          const summaryRow = head === null ? null : yield* capture.repo.summaryOf(head.id);
          if (head !== null && summaryRow !== null) {
            const posted = yield* capture.blobs.get(summaryRow.key).pipe(
              Effect.flatMap((bytes) =>
                decodeChangeSummaryJson(Buffer.from(bytes).toString("utf8")),
              ),
              Effect.option,
            );
            if (Option.isSome(posted)) {
              if (summaryRow.state === "claimed") {
                const jobs = yield* JobRunner;
                yield* jobs
                  .enqueue({
                    name: "summary-observe",
                    payload: { worktreeId: worktreeRow.id, captureId: head.id },
                    idempotencyKey: `summary-observe:${head.id}`,
                  })
                  .pipe(Effect.ignore);
              }
              const stamp: ReadStamp = {
                source: "capture",
                captureN: head.n,
                captureId: head.id,
                seq: head.seq.toString(),
                kind: head.kind,
                partial: head.kind === "auto",
                observedAt: head.createdAt.toISOString(),
              };
              return new ChangeDiff({
                change,
                diff: posted.value.diff,
                files: posted.value.files.map((file) => new ChangedFileView(file)),
                observation: observationOf(stamp, summaryRow.state),
              });
            }
          }
        }
        const diff = yield* reads
          .diffWorktree(project.id, worktreeRow.id, change.baseSha)
          .pipe(Effect.mapError(readFailure));
        const files = yield* reads
          .changedFiles(project.id, worktreeRow.id, change.baseSha)
          .pipe(Effect.mapError(readFailure));
        return new ChangeDiff({
          change,
          diff: diff.value,
          files: files.value.map((file) => new ChangedFileView(file)),
          observation: observationOf(diff.stamp),
        });
      }),
    )
    .handle("read", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).change(params.id);
        const changes = yield* WorktreeChangesRepo;
        const jobs = yield* JobRunner;
        yield* changes.byId(params.id).pipe(Effect.mapError(() => new NotFound({ id: params.id })));
        // One pass at a time per change (the key dedups while queued/active);
        // a finished pass can be re-requested and reads the newer state.
        yield* jobs
          .enqueue({
            name: "read-change",
            payload: { changeId: params.id },
            idempotencyKey: `read-change:${params.id}`,
          })
          .pipe(Effect.orDie);
        return { queued: true };
      }),
    )
    .handle("tour", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).change(params.id);
        const changes = yield* WorktreeChangesRepo;
        const tours = yield* ChangeToursRepo;
        yield* changes.byId(params.id).pipe(Effect.mapError(() => new NotFound({ id: params.id })));
        return yield* tours.byChange(params.id);
      }),
    )
    .handle("composeTour", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).change(params.id);
        const changes = yield* WorktreeChangesRepo;
        const jobs = yield* JobRunner;
        yield* changes.byId(params.id).pipe(Effect.mapError(() => new NotFound({ id: params.id })));
        yield* jobs
          .enqueue({
            name: "compose-tour",
            payload: { changeId: params.id },
            idempotencyKey: `compose-tour:${params.id}`,
          })
          .pipe(Effect.orDie);
        return { queued: true };
      }),
    )
    .handle("suggest", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).change(params.id);
        const changes = yield* WorktreeChangesRepo;
        const jobs = yield* JobRunner;
        yield* changes.byId(params.id).pipe(Effect.mapError(() => new NotFound({ id: params.id })));
        // One pass at a time per change; a finished pass can be re-requested.
        yield* jobs
          .enqueue({
            name: "suggest-change",
            payload: { changeId: params.id },
            idempotencyKey: `suggest-change:${params.id}`,
          })
          .pipe(Effect.orDie);
        return { queued: true };
      }),
    )
    .handle("passes", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).change(params.id);
        const changes = yield* WorktreeChangesRepo;
        const passes = yield* ChangePassesRepo;
        yield* changes.byId(params.id).pipe(Effect.mapError(() => new NotFound({ id: params.id })));
        return yield* passes.listForChange(params.id);
      }),
    )
    .handle("stats", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).change(params.id);
        const changes = yield* WorktreeChangesRepo;
        const projects = yield* ProjectsRepo;
        const change = yield* changes
          .byId(params.id)
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
        const worktrees = yield* WorktreesRepo;
        const worktreeRow = yield* worktrees
          .byId(change.worktreeId)
          .pipe(Effect.mapError(() => new NotFound({ id: change.worktreeId })));
        const project = yield* projects
          .byId(change.projectId)
          .pipe(Effect.mapError(() => new NotFound({ id: change.projectId })));
        const reads = yield* WorktreeReads;
        const files = yield* reads
          .changedFiles(project.id, worktreeRow.id, change.baseSha)
          .pipe(Effect.mapError(readFailure));
        return new ChangeStats({
          files: files.value.length,
          additions: files.value.reduce((sum, file) => sum + file.additions, 0),
          deletions: files.value.reduce((sum, file) => sum + file.deletions, 0),
          observation: observationOf(files.stamp),
        });
      }),
    )
    .handle("comments", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).change(params.id);
        const comments = yield* ReviewCommentsRepo;
        return yield* comments.listForChange(params.id);
      }),
    )
    .handle("commentState", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).change(params.id);
        const comments = yield* ReviewCommentsRepo;
        const existing = yield* comments
          .byId(params.commentId)
          .pipe(Effect.mapError(() => new NotFound({ id: params.commentId })));
        // The comment must anchor to the change in the path — ids are not
        // interchangeable across changes.
        if (existing.changeId !== params.id) {
          return yield* Effect.fail(new NotFound({ id: params.commentId }));
        }
        yield* comments.setState(params.commentId, payload.state);
        return yield* comments
          .byId(params.commentId)
          .pipe(Effect.mapError(() => new NotFound({ id: params.commentId })));
      }),
    ),
);
