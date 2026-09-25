import {
  CheckpointId,
  ProjectClusterBindingId,
  ProjectEnvironmentVariableId,
  ProjectId,
  ProjectSecretId,
  ReviewCommentId,
  ReviewSliceId,
} from "@mend/domain";
import {
  AgentLaunchMode,
  CLUSTER_BINDING_KINDS,
  EFFORT_LEVELS,
  PERMISSION_MODES,
  SPEED_MODES,
  ChangeLanding,
  Checkpoint,
  DiffDigest,
  ProjectClusterBinding,
  ProjectEnvironmentSnapshot,
  ProjectSecret,
  ProjectSecretsSnapshot,
  ServiceBrowserScheme,
  ServiceRecipe,
  Session,
  SessionProcess,
} from "@mend/domain/workbench";
import { Change as SessionChange } from "@mend/domain/workbench";
import { Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";
import {
  ProjectEnvironmentMutationResult,
  ProjectEnvironmentVariableRequest,
  ProjectEnvironmentVariableUpdateRequest,
  ProjectEnvironmentVariableRemoveRequest,
} from "./projects.ts";
import {
  EnvironmentLoadReport,
  EnvironmentLoadRequest,
  EnvironmentRejected,
  EnvironmentStaleWrite,
} from "./projects.ts";
import { StoreFailure } from "./workbench-views.ts";

export const projectEnvironmentGroup = HttpApiGroup.make("projectEnvironment")
  .add(
    HttpApiEndpoint.get("get", "/projects/:id/environment", {
      params: { id: ProjectId },
      success: ProjectEnvironmentSnapshot,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/projects/:id/environment/variables", {
      params: { id: ProjectId },
      payload: ProjectEnvironmentVariableRequest,
      success: ProjectEnvironmentMutationResult,
      // An ARRAY, not Schema.Union: the union collapses per-member httpApiStatus to 500.
      error: [NotFound, EnvironmentRejected],
    }),
  )
  .add(
    HttpApiEndpoint.put("update", "/projects/:id/environment/variables/:variableId", {
      params: { id: ProjectId, variableId: ProjectEnvironmentVariableId },
      payload: ProjectEnvironmentVariableUpdateRequest,
      success: ProjectEnvironmentMutationResult,
      error: [NotFound, EnvironmentRejected, EnvironmentStaleWrite],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/projects/:id/environment/variables/:variableId", {
      params: { id: ProjectId, variableId: ProjectEnvironmentVariableId },
      payload: ProjectEnvironmentVariableRemoveRequest,
      success: ProjectEnvironmentMutationResult,
      error: [NotFound, EnvironmentStaleWrite],
    }),
  )
  .add(
    HttpApiEndpoint.post("load", "/projects/:id/environment/load", {
      params: { id: ProjectId },
      payload: EnvironmentLoadRequest,
      success: EnvironmentLoadReport,
      error: NotFound,
    }),
  )
  .middleware(AuthMiddleware);

/** Create a secret: the value is sealed at rest and never returned by any response. */
export class ProjectSecretRequest extends Schema.Class<ProjectSecretRequest>(
  "ProjectSecretRequest",
)({
  name: Schema.String,
  value: Schema.String,
}) {}

/**
 * Replace a secret's value and/or rename it. `value: null` keeps the stored value (pure rename);
 * a string replaces it. Requires the last-seen row revision.
 */
export class ProjectSecretUpdateRequest extends Schema.Class<ProjectSecretUpdateRequest>(
  "ProjectSecretUpdateRequest",
)({
  name: Schema.String,
  value: Schema.NullOr(Schema.String),
  expectedRevision: Schema.Int,
}) {}

export class ProjectSecretRemoveRequest extends Schema.Class<ProjectSecretRemoveRequest>(
  "ProjectSecretRemoveRequest",
)({
  expectedRevision: Schema.Int,
}) {}

/** A secret mutation's result: the touched row (name/revision only) + new aggregate revision. */
export class ProjectSecretMutationResult extends Schema.Class<ProjectSecretMutationResult>(
  "ProjectSecretMutationResult",
)({
  secret: Schema.NullOr(ProjectSecret),
  revision: Schema.Int,
}) {}

/**
 * Project SECRETS (`.plans/project-environment-variables.md`, "Scope expansion"): the encrypted,
 * write-only half of the project env store. Responses carry names and revisions only — a value
 * that has been written can never be read back through this API. At launch the current set goes
 * to Sealant's transient secret channel, which keeps it out of the blueprint, container env, and
 * captured output. Same lifecycle as Configuration: new workspace launches only.
 */
export const projectSecretsGroup = HttpApiGroup.make("projectSecrets")
  .add(
    HttpApiEndpoint.get("get", "/projects/:id/secrets", {
      params: { id: ProjectId },
      success: ProjectSecretsSnapshot,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/projects/:id/secrets", {
      params: { id: ProjectId },
      payload: ProjectSecretRequest,
      success: ProjectSecretMutationResult,
      error: [NotFound, EnvironmentRejected],
    }),
  )
  .add(
    HttpApiEndpoint.put("update", "/projects/:id/secrets/:secretId", {
      params: { id: ProjectId, secretId: ProjectSecretId },
      payload: ProjectSecretUpdateRequest,
      success: ProjectSecretMutationResult,
      error: [NotFound, EnvironmentRejected, EnvironmentStaleWrite],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/projects/:id/secrets/:secretId", {
      params: { id: ProjectId, secretId: ProjectSecretId },
      payload: ProjectSecretRemoveRequest,
      success: ProjectSecretMutationResult,
      error: [NotFound, EnvironmentStaleWrite],
    }),
  )
  .middleware(AuthMiddleware);

/** 422: the object name failed the DNS-1123 grammar, or the binding set is full. */
export class ClusterBindingRejected extends Schema.TaggedErrorClass<ClusterBindingRejected>()(
  "ClusterBindingRejected",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

/** 409: this (kind, objectName) pair is already bound on the project. */
export class ClusterBindingDuplicate extends Schema.TaggedErrorClass<ClusterBindingDuplicate>()(
  "ClusterBindingDuplicate",
  { kind: Schema.String, objectName: Schema.String },
  { httpApiStatus: 409 },
) {}

/**
 * The cluster-bindings read: aggregate revision, kind/name-ordered bindings, the workspace
 * service account, and `clusterCapable` — a UI HINT driving the panel's degraded state on
 * non-cluster installs, never enforcement (the platform's synchronous create-time rejection is
 * the fail-closed check; a flag can lie in both directions).
 */
export class ProjectClusterBindingsView extends Schema.Class<ProjectClusterBindingsView>(
  "ProjectClusterBindingsView",
)({
  revision: Schema.Int,
  bindings: Schema.Array(ProjectClusterBinding),
  serviceAccount: Schema.NullOr(Schema.String),
  clusterCapable: Schema.Boolean,
}) {}

export class ClusterBindingRequest extends Schema.Class<ClusterBindingRequest>(
  "ClusterBindingRequest",
)({
  kind: Schema.Literals(CLUSTER_BINDING_KINDS),
  objectName: Schema.String,
}) {}

/** A binding mutation's result: the touched row (removals carry null) + new aggregate revision. */
export class ClusterBindingMutationResult extends Schema.Class<ClusterBindingMutationResult>(
  "ClusterBindingMutationResult",
)({
  binding: Schema.NullOr(ProjectClusterBinding),
  revision: Schema.Int,
}) {}

/** Set or clear (null) the workspace ServiceAccount trust grant. */
export class ClusterServiceAccountRequest extends Schema.Class<ClusterServiceAccountRequest>(
  "ClusterServiceAccountRequest",
)({
  serviceAccount: Schema.NullOr(Schema.String),
}) {}

export class ClusterServiceAccountResult extends Schema.Class<ClusterServiceAccountResult>(
  "ClusterServiceAccountResult",
)({
  serviceAccount: Schema.NullOr(Schema.String),
  revision: Schema.Int,
}) {}

/**
 * Project CLUSTER BINDINGS (`.plans/cluster-env-sources.md`): bindings, not values — each row
 * names a Kubernetes Secret/ConfigMap the Sealant worker resolves at fresh workspace launches.
 * Responses carry names and revisions only; there is no value to return, ever. Mutations work on
 * every install (a non-cluster install must be able to REMOVE inherited bindings to launch);
 * only the panel's add affordance degrades there, guided by `clusterCapable`.
 */
export const projectClusterBindingsGroup = HttpApiGroup.make("projectClusterBindings")
  .add(
    HttpApiEndpoint.get("get", "/projects/:id/cluster-bindings", {
      params: { id: ProjectId },
      success: ProjectClusterBindingsView,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("add", "/projects/:id/cluster-bindings", {
      params: { id: ProjectId },
      payload: ClusterBindingRequest,
      success: ClusterBindingMutationResult,
      // An ARRAY, not Schema.Union: the union collapses per-member httpApiStatus to 500.
      error: [NotFound, ClusterBindingRejected, ClusterBindingDuplicate],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/projects/:id/cluster-bindings/:bindingId", {
      params: { id: ProjectId, bindingId: ProjectClusterBindingId },
      success: ClusterBindingMutationResult,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.put("setServiceAccount", "/projects/:id/cluster-bindings/service-account", {
      params: { id: ProjectId },
      payload: ClusterServiceAccountRequest,
      success: ClusterServiceAccountResult,
      error: [NotFound, ClusterBindingRejected],
    }),
  )
  .middleware(AuthMiddleware);

/** Declare a Service on the project itself; command-less = adopt-only. */
export class AddProjectServiceRecipe extends Schema.Class<AddProjectServiceRecipe>(
  "AddProjectServiceRecipe",
)({
  name: Schema.String,
  command: Schema.NullOr(Schema.String),
  port: Schema.Int,
  protocol: Schema.optional(Schema.Literals(["tcp", "udp"])),
  browserScheme: Schema.optional(ServiceBrowserScheme),
}) {}

/**
 * Project-level Service recipes (docs/SESSION-SERVICES.md): the web-editable
 * twin of mend.toml, stored on this machine. Sessions see the union of both;
 * on a name collision the file wins — it travels with the repo.
 */
export const projectRecipesGroup = HttpApiGroup.make("projectRecipes")
  .add(
    HttpApiEndpoint.get("list", "/projects/:id/service-recipes", {
      params: { id: ProjectId },
      success: Schema.Array(ServiceRecipe),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("add", "/projects/:id/service-recipes", {
      params: { id: ProjectId },
      payload: AddProjectServiceRecipe,
      success: ServiceRecipe,
      error: [NotFound, StoreFailure],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/projects/:id/service-recipes/:name", {
      params: { id: ProjectId, name: Schema.String },
      error: NotFound,
    }),
  )
  .middleware(AuthMiddleware);

/**
 * A worktree's name: the session's identity in every list, and the tail of
 * its branch (`mend/<name>`). Same charset as project names — it lands in a
 * git branch ref and a directory name.
 */
export const WorktreeName = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)
        ? undefined
        : "a short lowercase name like `fix-auth` — letters, digits, `.`, `_`, `-`",
    ),
  ),
);

/** Provisioning a session: the worktree exists after this; launching is separate. */
export class NewWorkbenchSession extends Schema.Class<NewWorkbenchSession>("NewWorkbenchSession")({
  harness: Schema.String,
  /** Intended agent launch shape; omitted keeps the PTY default. */
  mode: Schema.optional(AgentLaunchMode),
  label: Schema.NullOr(Schema.String),
  /**
   * Names the worktree. An existing name JOINS that worktree — this request
   * becomes a new conversation inside it (a conflicting `base` is refused,
   * never silently re-based); an unused name creates it (branch
   * `mend/<name>`). Null (and older clients, which omit the key) derives an
   * anonymous worktree.
   */
  name: Schema.NullOr(WorktreeName).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** Branch or sha to base the worktree on; null = the project's default branch. */
  base: Schema.NullOr(Schema.String),
  /**
   * This session's own "Land when a turn completes" (`--land` / `--no-land`,
   * docs/adr/0007-landing.md). Null (and older clients, which omit the key) follows the project.
   */
  autoLand: Schema.NullOr(Schema.Boolean).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
}) {}

/** What the caller may do with a session (docs/adr/0003), so clients show only real controls. */
export class SessionControlView extends Schema.Class<SessionControlView>("SessionControlView")({
  /** Delete, rename or hand off: the owner's alone, even while control is shared. */
  own: Schema.Boolean,
  /** Send turns, interrupt, attach, open shells, stop. */
  steer: Schema.Boolean,
  /** Stop, which an organization owner may do even without steering. */
  stop: Schema.Boolean,
  /** Turn shared control on (owner only) or off (owner or organization owner), as it stands. */
  toggleSharedControl: Schema.Boolean,
}) {}

export class SessionDetail extends Schema.Class<SessionDetail>("SessionDetail")({
  session: Session,
  control: SessionControlView,
  /** The WORKTREE's chain and change, denormalized here for pre-worktree clients. */
  checkpoints: Schema.Array(Checkpoint),
  change: Schema.NullOr(SessionChange),
  /**
   * The change's landings, newest first (docs/adr/0007-landing.md): what was pushed where, and
   * the pull request as `gh` last reported it. Older servers omit it.
   */
  landings: Schema.Array(ChangeLanding).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** Every process the session has held, oldest first — agents, shells, Service attempts. */
  processes: Schema.Array(SessionProcess),
  /** The agent process "the session's agent" means right now; null before the first launch. */
  currentAgent: Schema.NullOr(SessionProcess),
}) {}

/** The API takes only the human-initiated triggers; the engine owns the rest. */
export class CheckpointRequest extends Schema.Class<CheckpointRequest>("CheckpointRequest")({
  trigger: Schema.Literals(["review-open", "user-mark"]),
}) {}

/** Immutable Review bundle plus the exact edited instruction and client retry key. */
export class DeliverFollowUpRequest extends Schema.Class<DeliverFollowUpRequest>(
  "DeliverFollowUpRequest",
)({
  reviewSliceId: ReviewSliceId,
  checkpointAId: CheckpointId,
  checkpointBId: CheckpointId,
  diffDigest: DiffDigest,
  commentIds: Schema.Array(ReviewCommentId),
  instruction: Schema.String,
  idempotencyKey: Schema.String,
}) {}

/**
 * What to run in the session's PTY. Two shapes: verbatim `argv` (argv[0] is
 * the program; wins when present), or the structured start — the server
 * composes the harness argv from it in one place (`composeLaunchArgv`).
 */
export class LaunchRequest extends Schema.Class<LaunchRequest>("LaunchRequest")({
  /** Omitted keeps the existing PTY launch shape. */
  mode: Schema.optional(AgentLaunchMode),
  argv: Schema.optional(Schema.Array(Schema.String)),
  /** The typed first message; rides the harness argv and seeds auto-naming. */
  prompt: Schema.optional(Schema.String),
  /** Free-form harness model id; HARNESS_MODELS is advisory, for pickers. */
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.Literals(EFFORT_LEVELS)),
  permissionMode: Schema.optional(Schema.Literals(PERMISSION_MODES)),
  /** `fast` = priority processing where the harness supports it (codex). */
  speed: Schema.optional(Schema.Literals(SPEED_MODES)),
}) {}

/**
 * Cross-mode pickup (mode handoff): continue the same provider session in the
 * requested mode. `prompt` rides as the opening turn of a protocol pickup —
 * one round trip performs takeover, history backfill, launch, and first turn.
 */
export class HandoffRequest extends Schema.Class<HandoffRequest>("HandoffRequest")({
  to: Schema.Literals(["protocol", "pty"]),
  prompt: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.Literals(EFFORT_LEVELS)),
  permissionMode: Schema.optional(Schema.Literals(PERMISSION_MODES)),
}) {}

/** The session's harness cannot continue in the requested mode (claude and codex only). */
export class HandoffUnsupported extends Schema.TaggedErrorClass<HandoffUnsupported>()(
  "HandoffUnsupported",
  { sessionId: Schema.String, harness: Schema.String, to: Schema.String },
  { httpApiStatus: 422 },
) {}

/** Submit one authored input to the live protocol process. */
export class SubmitAgentTurnRequest extends Schema.Class<SubmitAgentTurnRequest>(
  "SubmitAgentTurnRequest",
)({
  input: Schema.String,
}) {}

/** A live protocol process is required for this operation. */
export class ProtocolSessionNotLive extends Schema.TaggedErrorClass<ProtocolSessionNotLive>()(
  "ProtocolSessionNotLive",
  { processId: Schema.String },
  { httpApiStatus: 409 },
) {}

/** The request already has an observed answer or cancellation. */
export class AgentRequestResolved extends Schema.TaggedErrorClass<AgentRequestResolved>()(
  "AgentRequestResolved",
  { requestId: Schema.String },
  { httpApiStatus: 409 },
) {}

/** Approval and structured-input responses are disjoint on the wire. */

/**
 * An image pasted or dropped onto a session's terminal. The bytes are written
 * into the session's durable harness home — mounted read-write into every
 * workspace the session gets, never inside the worktree — and the reply
 * carries the path inside the workspace, which the terminal then pastes as
 * text. Both TUIs (claude, codex) accept a pasted path to an image file; the
 * clipboard the TUI would read on Ctrl+V belongs to a container that has none.
 * The format is sniffed from the bytes, never trusted from the client.
 */
export class PastedImageUpload extends Schema.Class<PastedImageUpload>("PastedImageUpload")({
  contentsBase64: Schema.String,
}) {}

export class PastedImage extends Schema.Class<PastedImage>("PastedImage")({
  /** Path inside the workspace — what the terminal pastes. */
  path: Schema.String,
  mediaType: Schema.String,
  bytes: Schema.Int,
}) {}

/** The bytes are not an accepted image, or exceed the size cap. */
export class PastedImageRejected extends Schema.TaggedErrorClass<PastedImageRejected>()(
  "PastedImageRejected",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}
