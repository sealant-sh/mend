import { MendApi } from "@mend/api-contracts";
import { pageRefOf } from "@mend/db";
import { defaultSettings, defaultWorkspaceImage, MendSettings, WorkspaceImage } from "@mend/domain";
import {
  ConversationTurn,
  PageRef,
  REMOVED_PROJECT_WORK_REFUSED,
  Session,
  SessionProcess,
  turnSteerSender,
} from "@mend/domain/workbench";
import { Effect, Schema, SchemaAST } from "effect";
import { HttpApi } from "effect/http-api";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import {
  CAROL_SESSION_IN_SHARED_A,
  CAROL_SHELL_IN_SHARED_A,
  CAROL_USER_SKILL,
  CAROL_WORKTREE_IN_SHARED_A,
  FOLDER_A,
  FOLDER_B,
  PROTOCOL_PROCESS,
  REFERENCE_A,
  REFERENCE_B,
  ids,
  type HarnessProject,
  type HarnessUser,
} from "../../test/support/tenancy-harness.ts";

/**
 * Every endpoint of the Mend API against the two-organization world (docs/adr/0003). A refused
 * request answers exactly like a missing resource, names the id the caller asked for, and has
 * touched nothing beyond the reads authorization needs. An admitted request must reach its
 * named downstream method or return the expected fixture data/business refusal. Most downstream
 * methods intentionally defect: these rows prove authorization and invocation, not feature success.
 */

type Target = HarnessProject;
interface Call {
  readonly method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
  /** The id a refusal must name. */
  readonly id: string;
}

type Rule =
  /** Visible to whoever can see the target's project. */
  | "project-read"
  /** Owners and the project's creator. */
  | "project-manage"
  /** Owners and the project's creator; others who can see it get 403 with whose act it is. */
  | "project-manage-visible"
  /** Owners, or the creator of a private project. */
  | "project-remove"
  /** Owners only. */
  | "project-visibility"
  /** The session owner only; others who can see it get 403. */
  | "steer"
  /** Steer, plus organization owners. */
  | "stop"
  /**
   * The session owner only, even under shared control or for an organization owner: landing
   * pushes with the owner's key (docs/adr/0007-landing.md, "Who lands").
   */
  | "land"
  /** Manage the project, or own every session in the worktree. */
  | "worktree-remove"
  /** Manage the project, and hold the operator role (host mounts). */
  | "project-operator"
  /** Operator only. */
  | "operator"
  /** Owners of an organization. */
  | "owner"
  /** Members of the organization the resource belongs to. */
  | "member"
  /** Owners of the organization the resource belongs to (an owner elsewhere is refused). */
  | "other-owner";

interface AccessCase {
  readonly endpoint: string;
  readonly rule: Rule;
  readonly call: (target: Target) => Call;
}

/** Endpoints with no project behind them: authenticated-only, public, or tested on their own. */
const UNSCOPED: ReadonlySet<string> = new Set([
  // Current change visibility, including revocation, is exercised in proof-artifacts.test.ts.
  "proofArtifacts.listForChange",
  "proofArtifacts.byId",
  "proofArtifacts.media",
  "proofArtifacts.mediaHead",
  // Recovery authority and hidden descendants are exercised in removal.test.ts.
  "projects.removed",
  "projects.removedDisk",
  "projects.restore",
  "projects.purge",
  "health.status",
  "instance.get",
  "machine.get",
  "sealant.connection",
  "workspaceSsh.get",
  "workspaceSsh.ensureKey",
  // The caller's own keys only; the platform scopes every call (workspace-ssh.test.ts).
  "workspaceSsh.removeKey",
  "accounts.identity",
  "accounts.connect",
  "accounts.disconnect",
  // The caller's own setting only (agent-logins-routes.test.ts).
  "accounts.messageSettings",
  "accounts.setMessageSettings",
  "accounts.agentLogins",
  "accounts.setAgentLogins",
  "organization.current",
  "organization.members",
  "organization.invitations",
  "organization.createInvitation",
  "organization.revokeInvitation",
  // Owner actions on the caller's own organization: organization.test.ts and member-removal.test.ts.
  "organization.removeMember",
  "organization.setMemberRole",
  "organization.orphanedProjects",
  "organization.takeOverProject",
  "organization.audit",
  "organization.resourceArchives",
  "organization.issuePasswordReset",
  // Every member reads the defaults their projects inherit: organization.test.ts.
  "organization.settings",
  "invitations.preview",
  // The caller's own Slack link and a link code from a mention: slack.test.ts.
  "slack.me",
  "slack.unlink",
  "slack.previewLink",
  "slack.confirmLink",
  // Minting authorizes nothing: the socket route authorizes the ticket's account against the
  // session or service when the ticket is spent (upgrade-tickets.test.ts).
  "upgradeTickets.mint",
  "upgradeTicketExchange.exchange",
  "pageView.view",
  "settings.get",
  "dotfiles.get",
  "dotfiles.repository",
  "dotfiles.snapshot",
  "dotfiles.clearSnapshot",
  "dotfiles.startAfterInstall",
  "skills.list",
  // The caller's own pi profile: no route names anyone else's (pi-profile.test.ts).
  "piProfile.get",
  "piProfile.save",
  "piProfile.remove",
  // The caller's own secret files, likewise (secret-files.test.ts).
  "secretFiles.list",
  "secretFiles.save",
  "secretFiles.remove",
  "doppler.status",
  "doppler.save",
  "doppler.disconnect",
  "doppler.projects",
  "doppler.configs",
  // The machine's model catalog: the same list for every account (harness-models.test.ts).
  "harnessModels.list",
  "gitKeys.show",
  "gitKeys.init",
  "gitKeys.bridgeStatus",
  "gitKeys.access",
  "gitKeys.setAccess",
  "gitKeys.author",
  "gitKeys.setAuthor",
  "gitKeys.clearAuthor",
  "github.status",
  "github.repos",
  "devices.register",
  "devices.unregister",
  "devices.unregisterLegacyIgnoringToken",
  "devices.notificationSettings",
  "devices.setNotificationSettings",
  "userDevices.createPairing",
  "userDevices.create",
  "userDevices.list",
  "userDevices.revoke",
  "userDevices.cliAuthRequest",
  "userDevices.approveCliAuth",
  "userDevices.denyCliAuth",
  "pair.claim",
  "cliAuth.start",
  "cliAuth.poll",
  // Filtered lists, adoption and skills: tested below with their own expectations.
  "projects.list",
  "projects.adopt",
  // Creation is scoped to the authenticated person's membership: project-creation.test.ts.
  "projects.createNew",
  "projects.ensureScratch",
  "sessions.listActive",
  "sessions.listServices",
  "references.list",
  "folders.list",
  "skills.detail",
  "skills.create",
  "skills.update",
  "skills.remove",
  "skills.sync",
  // A landing's id resolves to its change first; landing.test.ts covers who may refresh it.
  "landings.refresh",
  // A preview's id resolves to its project first; preview-open.test.ts covers who may open it.
  "previews.open",
  // A non-owner who can see the session is answered `Refused: owner-only`, not 403;
  // screen-socket.test.ts covers who may take over and hand back.
  "screens.take",
  "screens.handBack",
  // ScreenRtc checks session visibility through AccessRecheck; screen-socket.test.ts covers admission.
  "screens.rtc",
  "handoffs.receive",
  "handoffs.instanceTerms",
]);

const project =
  (rule: Rule, method: Call["method"], suffix: string, body?: unknown) =>
  (endpoint: string): AccessCase => ({
    endpoint,
    rule,
    call: (target) => ({
      method,
      path: `/api/projects/${ids(target).project}${suffix}`,
      id: ids(target).project,
      ...(body === undefined ? {} : { body }),
    }),
  });

const session =
  (rule: Rule, method: Call["method"], suffix: string, body?: unknown) =>
  (endpoint: string): AccessCase => ({
    endpoint,
    rule,
    call: (target) => ({
      method,
      path: `/api/sessions/${ids(target).session}${suffix}`,
      id: ids(target).session,
      ...(body === undefined ? {} : { body }),
    }),
  });

const child =
  (
    rule: Rule,
    kind: "turn" | "request" | "process" | "service" | "worktree" | "change" | "page",
    method: Call["method"],
    prefix: string,
    suffix: string,
    body?: unknown,
  ) =>
  (endpoint: string): AccessCase => ({
    endpoint,
    rule,
    call: (target) => ({
      method,
      path: `${prefix}/${ids(target)[kind]}${suffix}`,
      id: ids(target)[kind],
      ...(body === undefined ? {} : { body }),
    }),
  });

const fixed =
  (rule: Rule, method: Call["method"], path: string, id: string, body?: unknown) =>
  (endpoint: string): AccessCase => ({
    endpoint,
    rule,
    call: () => ({ method, path, id, ...(body === undefined ? {} : { body }) }),
  });

const workspaceImage = Schema.encodeSync(WorkspaceImage)(defaultWorkspaceImage);
const settings = Schema.encodeSync(MendSettings)(defaultSettings);

const CASES: ReadonlyArray<AccessCase> = [
  {
    endpoint: "doppler.use",
    rule: "project-read",
    call: (target) => ({
      method: "PUT",
      path: `/api/me/doppler/projects/${ids(target).project}`,
      id: ids(target).project,
      body: { dopplerProject: "backend", config: "dev" },
    }),
  },
  {
    endpoint: "doppler.removeMapping",
    rule: "project-read",
    call: (target) => ({
      method: "DELETE",
      path: `/api/me/doppler/projects/${ids(target).project}`,
      id: ids(target).project,
    }),
  },
  // ── Machine settings and the retired queue: the operator's ──
  fixed(
    "operator",
    "GET",
    "/api/settings/environment-suggestions",
    "settings",
  )("settings.scanHostEnvironment"),
  fixed("operator", "PUT", "/api/settings", "settings", settings)("settings.set"),
  fixed(
    "operator",
    "PUT",
    "/api/settings/workspace-environment",
    "settings",
    workspaceImage,
  )("settings.setWorkspaceEnvironment"),
  fixed("operator", "GET", "/api/issues", "queue")("issues.list"),
  fixed("operator", "POST", "/api/issues", "queue", {
    source: "manual",
    externalRef: null,
    repository: "x/y",
    title: "t",
    body: "",
  })("issues.create"),
  fixed("operator", "GET", "/api/issues/issue-1", "queue")("issues.detail"),
  fixed("operator", "POST", "/api/issues/issue-1/move", "queue", {
    stage: "triage",
    position: null,
  })("issues.move"),
  fixed("operator", "GET", "/api/issues/issue-1/brief", "queue")("briefs.byIssue"),
  fixed("operator", "GET", "/api/issues/issue-1/brief/comments", "queue")("briefs.comments"),
  fixed("operator", "POST", "/api/issues/issue-1/brief/comments", "queue", {
    thread: "t",
    body: "b",
  })("briefs.comment"),
  fixed("operator", "GET", "/api/issues/issue-1/brief/versions", "queue")("briefs.versions"),
  fixed("operator", "GET", "/api/runs/run-1", "queue")("runs.detail"),
  // ── Operator recovery: organizations are named and recovered, never read ──
  fixed("operator", "GET", "/api/operator/organizations", "operator")("operator.organizations"),
  fixed("operator", "GET", "/api/operator/gate", "operator")("operator.gate"),
  fixed("operator", "GET", "/api/operator/exposure", "operator")("operator.exposure"),
  fixed("operator", "POST", "/api/operator/organizations", "operator", { name: "Globex" })(
    "operator.createOrganization",
  ),
  fixed("operator", "PUT", "/api/operator/organizations/org-A/name", "operator", {
    name: "Acme",
  })("operator.renameOrganization"),
  fixed(
    "operator",
    "POST",
    "/api/operator/organizations/org-A/invitations",
    "operator",
    {},
  )("operator.inviteOwner"),
  fixed("operator", "POST", "/api/operator/organizations/org-A/owners", "operator", {
    email: "carol@example.invalid",
  })("operator.grantOwner"),
  fixed("operator", "POST", "/api/operator/password-resets", "operator", {
    email: "carol@example.invalid",
  })("operator.issuePasswordReset"),
  fixed("operator", "GET", "/api/runs/run-1/trace", "queue")("runs.trace"),
  fixed("operator", "GET", "/api/runs/run-1/sources", "queue")("runs.sources"),

  // ── Organization defaults: its owners set them over the instance's ──
  fixed("owner", "PUT", "/api/organization/settings", "organization", {
    workspaceImage: null,
    autoTour: null,
    autoSuggest: null,
    autoName: null,
    autoLand: true,
    backgroundSessions: null,
  })("organization.setSettings"),
  fixed("owner", "PUT", "/api/organization/settings/workspace-environment", "organization", {
    workspaceImage: null,
  })("organization.setWorkspaceEnvironment"),

  // ── Slack: the organization's app is its owners'; a default project must be visible ──
  fixed("owner", "GET", "/api/organization/slack", "slack")("slack.app"),
  fixed("owner", "PUT", "/api/organization/slack", "slack", {
    appToken: "xapp-1",
    botToken: "xoxb-1",
  })("slack.connect"),
  fixed("owner", "DELETE", "/api/organization/slack", "slack")("slack.disconnect"),
  fixed("owner", "PATCH", "/api/organization/slack/settings", "slack", {
    settings: {
      defaultHarness: "claude",
      showAgentMessages: true,
      showDiffs: false,
      externalChannels: false,
    },
  })("slack.setSettings"),
  fixed("owner", "GET", "/api/organization/slack/manifest", "slack")("slack.manifest"),
  fixed("owner", "GET", "/api/organization/slack/links", "slack")("slack.links"),
  fixed("owner", "DELETE", "/api/organization/slack/links/U123", "U123")("slack.removeLink"),
  {
    endpoint: "slack.setDefaultProject",
    rule: "project-read",
    call: (target) => ({
      method: "PUT",
      path: "/api/slack/me/default-project",
      body: { projectId: ids(target).project },
      id: ids(target).project,
    }),
  },

  // ── References: instance-wide until they belong to organizations ──
  fixed("owner", "POST", "/api/references", "references", {
    name: "ref",
    source: "https://example.invalid/ref.git",
    ref: "main",
  })("references.add"),
  fixed(
    "other-owner",
    "DELETE",
    `/api/references/${REFERENCE_A}`,
    REFERENCE_A,
  )("references.remove"),
  fixed(
    "other-owner",
    "POST",
    `/api/references/${REFERENCE_A}/refresh`,
    REFERENCE_A,
  )("references.refresh"),
  project("project-read", "GET", "/references")("references.forProject"),
  project("project-manage", "PUT", "/references", { referenceIds: [] })(
    "references.selectForProject",
  ),

  // ── Folders: members read, owners change, managers select ──
  fixed("owner", "POST", "/api/organization/folders", "folders", { name: "notes" })(
    "folders.create",
  ),
  fixed(
    "other-owner",
    "DELETE",
    `/api/organization/folders/${FOLDER_A}`,
    FOLDER_A,
  )("folders.remove"),
  fixed("member", "GET", `/api/organization/folders/${FOLDER_A}/files`, FOLDER_A)("folders.files"),
  fixed("other-owner", "POST", `/api/organization/folders/${FOLDER_A}/files`, FOLDER_A, {
    files: [],
    merge: true,
  })("folders.upload"),
  fixed(
    "other-owner",
    "DELETE",
    `/api/organization/folders/${FOLDER_A}/files?path=a.md`,
    FOLDER_A,
  )("folders.deleteFile"),
  project("project-read", "GET", "/folders")("folders.forProject"),
  project("project-manage", "PUT", "/folders", { selections: [] })("folders.selectForProject"),

  // ── Projects ──
  project("project-read", "GET", "")("projects.detail"),
  project("project-remove", "DELETE", "")("projects.remove"),
  project("project-visibility", "PUT", "/visibility", { visibility: "shared" })(
    "projects.visibility",
  ),
  project("project-manage", "PUT", "/automation", {
    autoTour: "inherit",
    autoSuggest: "inherit",
    autoName: "inherit",
    backgroundSessions: "inherit",
  })("projects.automation"),
  project("project-manage", "PUT", "/git-auth", { gitAuthMode: "bridge" })("projects.gitAuth"),
  project("project-manage", "PUT", "/workspace-image", { workspaceImage: null })(
    "projects.workspaceImage",
  ),
  project("project-manage", "PUT", "/new-worktrees-use-project-resources", {
    newWorktreesUseProjectResources: false,
  })("projects.newWorktreesUseProjectResources"),
  project("project-manage", "PUT", "/apply-dotfiles", { applyDotfiles: true })(
    "projects.applyDotfiles",
  ),
  project("project-manage", "PUT", "/default-shell-profile", { defaultShellProfile: true })(
    "projects.defaultShellProfile",
  ),
  project("project-manage", "PUT", "/inherit-user-skills", { inheritUserSkills: true })(
    "projects.inheritUserSkills",
  ),
  project("project-manage", "PUT", "/hot-sessions", { hotSessions: 0 })("projects.hotSessions"),
  project("project-manage", "PUT", "/install-command", { installCommand: null })(
    "projects.installCommand",
  ),
  project("project-manage", "PUT", "/install-enabled", { installEnabled: false })(
    "projects.installEnabled",
  ),
  project("project-read", "GET", "/install-detection")("projects.installDetection"),
  project("project-read", "GET", "/hot-sessions")("projects.hotSessionsStatus"),
  project("project-read", "GET", "/branches")("projects.branches"),
  project("project-read", "POST", "/refresh")("projects.refresh"),
  project("project-read", "GET", "/files")("projects.files"),
  project("project-read", "GET", "/pull-requests")("projects.pullRequests"),
  project("project-read", "GET", "/memory")("agentMemory.list"),
  project("project-read", "GET", "/memory/file?path=x")("agentMemory.file"),
  project("project-read", "DELETE", "/memory/file?path=x")("agentMemory.remove"),
  project("project-read", "POST", "/memory/import", { files: [] })("agentMemory.import"),
  project("project-read", "POST", "/memory/import/plan", { files: [] })("agentMemory.importPlan"),
  project("project-read", "GET", "/skills")("skills.forProject"),

  // ── Project configuration ──
  project("project-read", "GET", "/environment")("projectEnvironment.get"),
  project("project-manage", "POST", "/environment/variables", { name: "A", value: "b" })(
    "projectEnvironment.create",
  ),
  project("project-manage", "PUT", "/environment/variables/var-1", {
    name: "A",
    value: "b",
    expectedRevision: 1,
  })("projectEnvironment.update"),
  project("project-manage", "DELETE", "/environment/variables/var-1", { expectedRevision: 1 })(
    "projectEnvironment.remove",
  ),
  project("project-manage", "POST", "/environment/load", {
    contents: "A=b",
    secretNames: [],
    allSecret: false,
  })("projectEnvironment.load"),
  project("project-read", "GET", "/secrets")("projectSecrets.get"),
  project("project-manage", "POST", "/secrets", { name: "A", value: "b" })("projectSecrets.create"),
  project("project-manage", "PUT", "/secrets/secret-1", {
    name: "A",
    value: "b",
    expectedRevision: 1,
  })("projectSecrets.update"),
  project("project-manage", "DELETE", "/secrets/secret-1", { expectedRevision: 1 })(
    "projectSecrets.remove",
  ),
  project("project-read", "GET", "/cluster-bindings")("projectClusterBindings.get"),
  project("project-manage", "POST", "/cluster-bindings", {
    kind: "secret",
    objectName: "x",
  })("projectClusterBindings.add"),
  project(
    "project-manage",
    "DELETE",
    "/cluster-bindings/binding-1",
  )("projectClusterBindings.remove"),
  project("project-manage", "PUT", "/cluster-bindings/service-account", {
    serviceAccount: null,
    expectedRevision: 0,
  })("projectClusterBindings.setServiceAccount"),
  project("project-read", "GET", "/mounts")("projectMounts.list"),
  project("project-operator", "POST", "/mounts", {
    name: "data",
    hostPath: "/tmp",
    readOnly: true,
  })("projectMounts.add"),
  project("project-manage", "DELETE", "/mounts/mount-1")("projectMounts.remove"),
  project("project-read", "GET", "/links")("projectLinks.list"),
  project("project-manage", "POST", "/links", {
    name: "other",
    linkedProjectId: "project-other",
    worktreeName: null,
  })("projectLinks.add"),
  project("project-manage", "DELETE", "/links/link-1")("projectLinks.remove"),
  project("project-read", "GET", "/service-recipes")("projectRecipes.list"),
  project("project-manage", "POST", "/service-recipes", {
    name: "web",
    command: null,
    port: 3000,
  })("projectRecipes.add"),
  project("project-manage", "DELETE", "/service-recipes/web")("projectRecipes.remove"),
  project("project-read", "GET", "/resources?timeZone=UTC")("resources.list"),
  {
    endpoint: "resources.add",
    rule: "project-read",
    call: (target) => ({
      method: "POST",
      path: `/api/projects/${ids(target).project}/worktrees/resources`,
      body: {
        worktreeId: ids(target).worktree,
        definition: { name: "db", preset: "postgres", version: "17" },
      },
      id: ids(target).project,
    }),
  },
  {
    endpoint: "resources.remove",
    rule: "project-read",
    call: (target) => ({
      method: "DELETE",
      path: `/api/projects/${ids(target).project}/resources/db`,
      id: ids(target).project,
      body: { level: "project", worktreeId: ids(target).worktree },
    }),
  },
  // A worktree's choice is its change owner's, which in the harness is its session's owner.
  {
    endpoint: "resources.use",
    rule: "steer",
    call: (target) => ({
      method: "PUT",
      path: `/api/projects/${ids(target).project}/worktrees/${ids(target).worktree}/resources/db/selection?timeZone=UTC`,
      id: ids(target).project,
      body: { mode: "worktree" },
    }),
  },
  project("project-read", "POST", "/resource-loads?timeZone=UTC", {
    name: "db",
    worktreeId: null,
    target: "shared",
    source: { kind: "upload", label: "staging.sql", bytesTotal: null },
  })("resources.beginLoad"),
  project(
    "project-read",
    "GET",
    "/resource-loads/11111111-1111-1111-1111-111111111111?timeZone=UTC",
  )("resources.readLoad"),
  project(
    "project-read",
    "PUT",
    "/resource-loads/11111111-1111-1111-1111-111111111111/body?timeZone=UTC",
  )("resources.feedLoad"),
  ...(["start", "stop"] as const).map(
    (verb): AccessCase => ({
      endpoint: `resources.${verb}`,
      rule: "project-read",
      call: (target) => ({
        method: "POST",
        path: `/api/projects/${ids(target).project}/resources/db/${verb}?timeZone=UTC`,
        id: ids(target).project,
        body: { level: "project", worktreeId: ids(target).worktree, restart: false },
      }),
    }),
  ),
  {
    endpoint: "resources.reset",
    rule: "project-read",
    call: (target) => ({
      method: "POST",
      path: `/api/projects/${ids(target).project}/worktrees/${ids(target).worktree}/resources/db/reset?timeZone=UTC`,
      id: ids(target).project,
    }),
  },
  {
    endpoint: "resources.env",
    rule: "project-read",
    call: (target) => ({
      method: "GET",
      path: `/api/projects/${ids(target).project}/worktrees/${ids(target).worktree}/resources/env?timeZone=UTC`,
      id: ids(target).project,
    }),
  },

  // ── Sessions ──
  project("project-read", "POST", "/sessions", { harness: "shell", label: null, base: null })(
    "sessions.create",
  ),
  session("project-read", "GET", "")("sessions.detail"),
  session("project-read", "GET", "/screen")("screens.read"),
  session("steer", "POST", "/screen/wake")("sessions.wakeScreen"),
  session("steer", "POST", "/messages", { input: "Continue" })("sessions.sendMessage"),
  session("steer", "POST", "/turns", { input: "Continue" })("sessions.submitTurn"),
  session("steer", "POST", "/images", { contentsBase64: "iVBORw0KGgo=" })("sessions.pasteImage"),
  child("steer", "turn", "POST", "/api/turns", "/interrupt")("sessions.interruptTurn"),
  child("steer", "turn", "POST", "/api/turns", "/steer", { input: "Keep the shape" })(
    "sessions.steerTurn",
  ),
  session("project-read", "GET", "/waiting")("sessions.conversationWait"),
  // docs/adr/0016, decision 14: anyone who sees the session reads it; the engine lets only the
  // change's owner replace the workspace.
  session("project-read", "GET", "/workspace-retirement")("sessions.workspaceRetirement"),
  session("project-read", "POST", "/workspace-retirement/replace", { seen: "f1" })(
    "sessions.replaceWorkspace",
  ),
  session("steer", "POST", "/waiting/end", { kind: "task", id: "task-1" })(
    "sessions.endBackgroundWork",
  ),
  session("project-read", "GET", "/turns")("sessions.listTurns"),
  session("project-read", "GET", "/items")("sessions.listItems"),
  session("project-read", "GET", "/pages")("pages.listForSession"),
  child("project-read", "page", "GET", "/api/pages", "/frame?appearance=dark")("pages.frame"),
  session("project-read", "GET", "/requests")("sessions.listAgentRequests"),
  child("steer", "request", "POST", "/api/requests", "/respond", { decision: "accept" })(
    "sessions.respondAgentRequest",
  ),
  session("project-read", "GET", "/processes")("sessions.listProcesses"),
  session("steer", "POST", "/shell")("sessions.openShell"),
  child("steer", "process", "POST", "/api/processes", "/stop")("sessions.stopShell"),
  child("steer", "process", "POST", "/api/processes", "/label", { label: "tools" })(
    "sessions.renameShell",
  ),
  session("steer", "POST", "/services", { port: 3000, name: "web" })("sessions.addService"),
  session("steer", "POST", "/services/run", { argv: ["pnpm", "dev"], port: 3000, name: "web" })(
    "sessions.runService",
  ),
  session("steer", "POST", "/services/recipe", { name: "web" })("sessions.runServiceRecipe"),
  session("project-read", "GET", "/recipes")("sessions.listRecipes"),
  session("project-read", "GET", "/declarations")("sessions.declarations"),
  session(
    "project-read",
    "GET",
    "/services/starts/4a1f7e0e-8a5e-4d5b-9b0e-0d6f0b3c6a11",
  )("sessions.serviceStart"),
  child("project-read", "process", "GET", "/api/processes", "/logs")("sessions.processLogs"),
  child("steer", "service", "POST", "/api/services", "/restart")("sessions.restartService"),
  child("steer", "service", "POST", "/api/services", "/stop")("sessions.stopService"),
  session("steer", "DELETE", "")("sessions.remove"),
  // The owner's alone, like removal: what is not saved is theirs to discard.
  session("steer", "POST", "/discard-unsaved", { confirm: "discard unsaved" })(
    "sessions.discardUnsaved",
  ),
  session("steer", "POST", "/label", { label: "renamed" })("sessions.label"),
  session("stop", "POST", "/stop")("sessions.stop"),
  session("stop", "POST", "/services/stop")("sessions.stopServices"),
  session("stop", "POST", "/services/starts/stop", { name: "web" })("sessions.stopServiceStarts"),
  // Turning it off: the owner or an organization owner. Turning it on is the owner's alone
  // (shared-control.test.ts); off leaves the world unshared for every other case.
  session("stop", "PUT", "/shared-control", { enabled: false })("sessions.sharedControl"),
  session("project-read", "GET", "/control-events")("sessions.controlEvents"),
  session("project-read", "POST", "/checkpoints", { trigger: "user-mark" })("sessions.checkpoint"),
  session("steer", "POST", "/launch", { argv: ["codex"] })("sessions.launch"),
  session("project-read", "GET", "/transcript")("sessions.transcript"),
  session("steer", "POST", "/resume", { harness: null })("sessions.resume"),
  session("steer", "POST", "/handoff", { to: "pty" })("sessions.switchMode"),
  session("project-read", "GET", "/follow-up")("sessions.followUpPending"),
  session("steer", "POST", "/follow-up/deliver", {
    reviewSliceId: "slice-1",
    checkpointAId: "checkpoint-a",
    checkpointBId: "checkpoint-b",
    diffDigest: "0".repeat(64),
    commentIds: [],
    instruction: "Address it",
    idempotencyKey: "k",
  })("sessions.followUpDeliver"),

  // ── Worktrees ──
  project("project-read", "POST", "/worktrees", { name: null, base: null })("worktrees.create"),
  project("project-read", "GET", "/worktrees")("worktrees.list"),
  child("project-read", "worktree", "GET", "/api/worktrees", "")("worktrees.detail"),
  child("project-read", "worktree", "GET", "/api/worktrees", "/previews")("worktrees.previews"),
  child("worktree-remove", "worktree", "DELETE", "/api/worktrees", "")("worktrees.remove"),
  child("project-read", "worktree", "POST", "/api/worktrees", "/sessions", {
    harness: "shell",
  })("worktrees.createSession"),
  child(
    "project-read",
    "worktree",
    "GET",
    "/api/worktrees",
    "/diff?to=checkpoint-1",
  )("worktrees.diff"),
  child(
    "project-read",
    "worktree",
    "GET",
    "/api/worktrees",
    "/contents?path=README.md",
  )("worktrees.contents"),
  child(
    "project-read",
    "worktree",
    "GET",
    "/api/worktrees",
    "/raw?path=README.md",
  )("worktrees.raw"),
  child(
    "project-read",
    "worktree",
    "HEAD",
    "/api/worktrees",
    "/raw?path=README.md",
  )("worktrees.rawHead"),
  child("project-read", "worktree", "POST", "/api/worktrees", "/checkpoints", {
    trigger: "user-mark",
  })("worktrees.checkpoint"),

  // ── Changes and review ──
  child("project-read", "change", "POST", "/api/changes", "/reviews/open", {
    idempotencyKey: "k",
  })("sessionChanges.openReview"),
  child(
    "project-read",
    "change",
    "GET",
    "/api/changes",
    "/reviews/slice-1/diff",
  )("sessionChanges.reviewDiff"),
  child("project-read", "change", "POST", "/api/changes", "/reviews/slice-1/comments", {
    target: {
      oldPath: null,
      newPath: "a.ts",
      side: "new",
      startLine: 1,
      endLine: 1,
      hunkContextHash: null,
    },
    body: "b",
  })("sessionChanges.sliceComment"),
  child("project-read", "change", "GET", "/api/changes", "/diff")("sessionChanges.diff"),
  child("project-read", "change", "GET", "/api/changes", "/stats")("sessionChanges.stats"),
  child("project-read", "change", "GET", "/api/changes", "/comments")("sessionChanges.comments"),
  child("project-read", "change", "POST", "/api/changes", "/comments/comment-1/state", {
    state: "addressed",
  })("sessionChanges.commentState"),
  child("project-read", "change", "POST", "/api/changes", "/read")("sessionChanges.read"),
  child("project-read", "change", "GET", "/api/changes", "/tour")("sessionChanges.tour"),
  child("project-read", "change", "POST", "/api/changes", "/tour")("sessionChanges.composeTour"),
  child("project-read", "change", "POST", "/api/changes", "/suggest")("sessionChanges.suggest"),
  child("project-read", "change", "GET", "/api/changes", "/passes")("sessionChanges.passes"),
  // ── Landing (docs/adr/0007-landing.md) ──
  session("land", "POST", "/land", {})("landings.land"),
  session("project-read", "GET", "/landings")("landings.forSession"),
  child("project-read", "change", "GET", "/api/changes", "/landings")("landings.forChange"),
  child("project-read", "change", "GET", "/api/changes", "/bundle")("landings.bundle"),
  project("project-read", "GET", "/handoffs")("handoffs.terms"),
  child("land", "change", "POST", "/api/changes", "/pull-request/check")("landings.checkGitHub"),
  session("project-read", "GET", "/git-ops")("landings.gitOps"),
];

/**
 * Independent expectations from each handler and the fixture, not its observed status alone.
 * Calls are method invocations. Eager Effect construction is not proof an operation completed.
 * Comments name prerequisites that deliberately limit a row to an earlier authorized boundary.
 */
const ADMITTED: Readonly<
  Record<
    string,
    { readonly status: number; readonly calls: ReadonlyArray<string>; readonly body?: unknown }
  >
> = {
  "settings.scanHostEnvironment": { status: 500, calls: ["hostEnvironment.scan"] },
  "screens.read": { status: 500, calls: ["screensRepo.ofSession"] },
  "sessions.wakeScreen": { status: 500, calls: ["engine.wakeScreen"] },
  // Settings get defects before save.
  "settings.set": { status: 500, calls: ["settings.get"] },
  "settings.setWorkspaceEnvironment": { status: 500, calls: ["sealant.resolveWorkspacePackage"] },
  "issues.list": { status: 500, calls: ["issues.list"] },
  "issues.create": { status: 500, calls: ["issues.create"] },
  "issues.detail": { status: 500, calls: ["issues.byId"] },
  "issues.move": { status: 500, calls: ["issues.move"] },
  // Shared legacy issue→change→brief lookup defects before endpoint-specific behavior; current oracle proves operator admission only.
  "briefs.byIssue": { status: 500, calls: ["legacyChanges.byIssue"] },
  // Shared legacy issue→change→brief lookup defects before endpoint-specific behavior; current oracle proves operator admission only.
  "briefs.comments": { status: 500, calls: ["legacyChanges.byIssue"] },
  // Shared legacy issue→change→brief lookup defects before endpoint-specific behavior; current oracle proves operator admission only.
  "briefs.comment": { status: 500, calls: ["legacyChanges.byIssue"] },
  // Shared legacy issue→change→brief lookup defects before endpoint-specific behavior; current oracle proves operator admission only.
  "briefs.versions": { status: 500, calls: ["legacyChanges.byIssue"] },
  // Shared runs.byId lookup defects before distinct SDK/detail behavior.
  "runs.detail": { status: 500, calls: ["runs.byId"] },
  "operator.organizations": { status: 500, calls: ["organizations.listWithCounts"] },
  "operator.gate": { status: 200, calls: [], body: [] },
  "operator.exposure": { status: 200, calls: [], body: { declared: "loopback", items: [] } },
  "operator.createOrganization": {
    status: 422,
    calls: [],
    body: {
      _tag: "OrganizationRejected",
      message: "This Mend runs one organization (MEND_TENANCY=single). Rename it instead.",
    },
  },
  "operator.renameOrganization": { status: 500, calls: ["organizations.rename"] },
  // Same organization lookup masks invitation creation.
  "operator.inviteOwner": { status: 500, calls: ["organizations.byId"] },
  // Same organization lookup masks user/membership/role operation.
  "operator.grantOwner": { status: 500, calls: ["organizations.byId"] },
  // User lookup masks reset operation.
  "operator.issuePasswordReset": { status: 500, calls: ["users.byEmail"] },
  // Shared runs.byId lookup defects before distinct SDK/detail behavior.
  "runs.trace": { status: 500, calls: ["runs.byId"] },
  // Shared runs.byId lookup defects before distinct SDK/detail behavior.
  "runs.sources": { status: 500, calls: ["runs.byId"] },
  // Settings snapshot masks save.
  "organization.setSettings": { status: 500, calls: ["organizationSettings.get"] },
  // Same settings snapshot masks environment save.
  "organization.setWorkspaceEnvironment": { status: 500, calls: ["organizationSettings.get"] },
  "slack.app": { status: 500, calls: ["slackInstalls.byOrganization"] },
  "slack.connect": { status: 500, calls: ["slackApi.authTest"] },
  "slack.disconnect": { status: 500, calls: ["slackInstalls.remove"] },
  // Install lookup masks settings write.
  "slack.setSettings": { status: 500, calls: ["slackInstalls.byOrganization"] },
  "slack.manifest": {
    status: 200,
    calls: [],
    body: {
      manifest: {
        _metadata: { major_version: 1, minor_version: 1 },
        display_information: {
          name: "Mend",
          description: "Start a Mend session by mentioning Mend in a thread.",
        },
        features: {
          app_home: {
            home_tab_enabled: false,
            messages_tab_enabled: true,
            messages_tab_read_only_enabled: false,
          },
          bot_user: { display_name: "mend", always_online: true },
        },
        oauth_config: {
          scopes: {
            bot: [
              "app_mentions:read",
              "channels:history",
              "groups:history",
              "im:history",
              "mpim:history",
              "chat:write",
              "im:write",
              "reactions:write",
              "files:read",
              "files:write",
              "users:read",
            ],
          },
        },
        settings: {
          event_subscriptions: { bot_events: ["app_mention", "message.im"] },
          interactivity: { is_enabled: true },
          org_deploy_enabled: false,
          socket_mode_enabled: true,
          token_rotation_enabled: false,
        },
      },
      steps: [
        "Create an app in Slack from this manifest (api.slack.com/apps → Create New App → From a manifest).",
        "Under Basic Information → App-Level Tokens, generate a token with the connections:write scope. It starts with xapp-.",
        "Install the app to your workspace, then copy the Bot User OAuth Token from OAuth & Permissions. It starts with xoxb-.",
        "Paste both tokens here. Before it saves them, Mend checks the bot token with auth.test and the app-level token with apps.connections.open, and that both belong to the same app.",
      ],
      appTokenScope: "connections:write",
    },
  },
  "slack.links": { status: 500, calls: ["slackLinks.listForOrganization"] },
  // Install lookup masks unlink.
  "slack.removeLink": { status: 500, calls: ["slackInstalls.byOrganization"] },
  "slack.setDefaultProject": { status: 500, calls: ["slackDefaults.setPersonalDefault"] },
  // Name collision read masks clone.
  "references.add": { status: 500, calls: ["references.byName"] },
  "references.remove": { status: 500, calls: ["store.removeReference"] },
  // Git preference read masks reference refresh.
  "references.refresh": { status: 500, calls: ["gitAccess.mode"] },
  "references.forProject": { status: 500, calls: ["references.listForProject"] },
  "references.selectForProject": { status: 500, calls: ["references.setForProject"] },
  "folders.create": { status: 500, calls: ["folderStore.create"] },
  "folders.remove": { status: 500, calls: ["folders.remove"] },
  "folders.files": { status: 500, calls: ["folderStore.list"] },
  "folders.upload": { status: 500, calls: ["folderStore.write"] },
  "folders.deleteFile": { status: 500, calls: ["folderStore.deleteFile"] },
  "folders.forProject": { status: 500, calls: ["folders.listForProject"] },
  // Empty selection still probes host-mount name collisions first.
  "folders.selectForProject": { status: 500, calls: ["mounts.listForProject"] },
  // Unimplemented sessions.listForProject stops detail assembly.
  "projects.detail": { status: 500, calls: ["sessions.listForProject"] },
  // The removal marks the project, then its first unimplemented read fails and the mark is lifted
  // before any stop or delete (an unimplemented method records as it fails, after the release its
  // failure ran).
  "projects.remove": {
    status: 500,
    calls: ["removalFences.take", "removalFences.release", "forwards.listOpen"],
  },
  "projects.visibility": { status: 500, calls: ["projects.setVisibility"] },
  "projects.automation": { status: 500, calls: ["projects.setAutomation"] },
  "projects.gitAuth": { status: 500, calls: ["projects.setGitAuthMode"] },
  "projects.workspaceImage": { status: 500, calls: ["projects.setWorkspaceImage"] },
  "projects.newWorktreesUseProjectResources": {
    status: 500,
    calls: ["projects.setNewWorktreesUseProjectResources"],
  },
  "projects.applyDotfiles": { status: 500, calls: ["projects.setApplyDotfiles"] },
  "projects.defaultShellProfile": { status: 500, calls: ["projects.setDefaultShellProfile"] },
  "projects.inheritUserSkills": { status: 500, calls: ["projects.setInheritUserSkills"] },
  "projects.hotSessions": { status: 500, calls: ["projects.setHotSessions"] },
  "projects.installCommand": { status: 500, calls: ["projects.setInstallCommand"] },
  "projects.installEnabled": { status: 500, calls: ["projects.setInstallEnabled"] },
  "projects.installDetection": { status: 500, calls: ["store.listTopLevel"] },
  "projects.hotSessionsStatus": { status: 500, calls: ["hotWorkspaces.listForProject"] },
  "projects.branches": { status: 500, calls: ["store.listBranches"] },
  "projects.refresh": { status: 500, calls: ["store.refreshFromOrigin"] },
  "projects.files": { status: 500, calls: ["store.listTreeFiles"] },
  "projects.pullRequests": {
    status: 200,
    calls: [],
    body: {
      origin: "not-github",
      repo: null,
      availability: "not-github",
      detail: null,
      pullRequests: [],
      fetchedAt: null,
    },
  },
  "doppler.use": { status: 500, calls: ["doppler.connection"] },
  "doppler.removeMapping": { status: 500, calls: ["doppler.removeMapping"] },
  "agentMemory.list": { status: 500, calls: ["agentMemory.list"] },
  "agentMemory.file": { status: 500, calls: ["agentMemory.read"] },
  "agentMemory.remove": { status: 500, calls: ["agentMemory.remove"] },
  "agentMemory.import": { status: 500, calls: ["agentMemory.importFiles"] },
  "agentMemory.importPlan": { status: 500, calls: ["agentMemory.importFiles"] },
  "skills.forProject": { status: 500, calls: ["skills.listForProject"] },
  "projectEnvironment.get": { status: 500, calls: ["environment.snapshot"] },
  // Secret-lane guard defects before plaintext write.
  "projectEnvironment.create": { status: 500, calls: ["secrets.snapshot"] },
  // Same secret-lane guard masks update.
  "projectEnvironment.update": { status: 500, calls: ["secrets.snapshot"] },
  "projectEnvironment.remove": { status: 500, calls: ["environment.remove"] },
  "projectEnvironment.load": { status: 500, calls: ["environment.snapshot", "secrets.snapshot"] },
  "projectSecrets.get": { status: 500, calls: ["secrets.snapshot"] },
  // Cipher encrypt masks secret persistence.
  "projectSecrets.create": { status: 500, calls: ["cipher.encrypt"] },
  // Cipher encrypt masks update.
  "projectSecrets.update": { status: 500, calls: ["cipher.encrypt"] },
  "projectSecrets.remove": { status: 500, calls: ["secrets.remove"] },
  "projectClusterBindings.get": { status: 500, calls: ["clusterBindings.snapshot"] },
  "projectClusterBindings.add": { status: 500, calls: ["clusterBindings.add"] },
  "projectClusterBindings.remove": { status: 500, calls: ["clusterBindings.remove"] },
  "projectClusterBindings.setServiceAccount": {
    status: 500,
    calls: ["clusterBindings.setServiceAccount"],
  },
  "projectMounts.list": { status: 500, calls: ["mounts.listForProject"] },
  // Name/path clash listing masks creation; /tmp real stat is an environmental prerequisite.
  "projectMounts.add": { status: 500, calls: ["mounts.listForProject"] },
  // Unimplemented subordinate byId is a named lookup only.
  "projectMounts.remove": { status: 500, calls: ["mounts.byId"] },
  "projectLinks.list": { status: 500, calls: ["links.listForProject"] },
  // Missing project-other stops before all link operations.
  "projectLinks.add": { status: 404, calls: [], body: { _tag: "NotFound", id: "project-other" } },
  // Unimplemented subordinate link lookup masks remove.
  "projectLinks.remove": { status: 500, calls: ["links.byId"] },
  "projectRecipes.list": { status: 500, calls: ["recipes.listForProject"] },
  "projectRecipes.add": { status: 500, calls: ["recipes.create"] },
  "projectRecipes.remove": { status: 500, calls: ["recipes.remove"] },
  // The page's reads run together, so all are asked before the first unimplemented one fails.
  "resources.list": {
    status: 200,
    calls: ["resources.listWithChoices"],
    body: { settings: [], file: { kind: "not-selected" } },
  },
  "resources.add": { status: 500, calls: ["resourceTableWrites.appendResourceTable"] },
  // Who added the definition decides who may remove it, so it is read first.
  "resources.remove": { status: 500, calls: ["resources.byName"] },
  // What the worktree used before decides whether its Services restart, so it is read first.
  "resources.use": { status: 500, calls: ["resources.listIdentities"] },
  // A start or stop finds the definition by name first.
  "resources.beginLoad": { status: 500, calls: ["resourceLoads.begin"] },
  "resources.readLoad": { status: 500, calls: ["resourceLoads.read"] },
  "resources.feedLoad": { status: 500, calls: ["resourceLoads.feed"] },
  "resources.start": {
    status: 500,
    calls: ["reads.readFile", "reads.readFile", "resources.listForProject"],
  },
  "resources.stop": { status: 500, calls: ["resources.byName"] },
  "resources.reset": { status: 500, calls: ["resources.byName"] },
  "resources.env": { status: 500, calls: ["resourceRuntime.envOf", "resources.listForProject"] },
  "sessions.create": { status: 500, calls: ["removalFences.admitsStart", "engine.provision"] },
  // Refresh-capture helper defects before detail reads.
  "sessions.detail": {
    status: 500,
    calls: [
      "resources.listWithChoices",
      "reads.readFile",
      "reads.readFile",
      "resources.ownDatabases",
      "resources.bindingRows",
      "sessions.launchersOf",
      "engine.refreshCaptureStatus",
    ],
  },
  "sessions.sendMessage": { status: 500, calls: ["engine.sendMessage"] },
  "sessions.submitTurn": { status: 500, calls: ["engine.submitTurn"] },
  "sessions.pasteImage": { status: 500, calls: ["engine.storePastedImage"] },
  "sessions.interruptTurn": { status: 500, calls: ["engine.interruptTurn"] },
  "sessions.steerTurn": { status: 500, calls: ["engine.steerTurn"] },
  "sessions.conversationWait": { status: 500, calls: ["engine.conversationWait"] },
  "sessions.workspaceRetirement": {
    status: 200,
    calls: ["engine.workspaceRetirement"],
    body: null,
  },
  "sessions.replaceWorkspace": { status: 500, calls: ["engine.replaceWorkspaceNow"] },
  "sessions.endBackgroundWork": { status: 500, calls: ["engine.endBackgroundWork"] },
  "sessions.listTurns": { status: 200, calls: ["conversation.listConversationTurns"] },
  "sessions.listItems": { status: 500, calls: ["conversation.listItems"] },
  "pages.listForSession": { status: 200, calls: ["pages.listForSession"] },
  "pages.frame": { status: 200, calls: [] },
  "sessions.listAgentRequests": { status: 500, calls: ["conversation.listRequests"] },
  "sessions.respondAgentRequest": { status: 500, calls: ["engine.respondRequest"] },
  "sessions.listProcesses": { status: 200, calls: [] },
  "sessions.openShell": { status: 500, calls: ["engine.openShell"] },
  "sessions.stopShell": { status: 500, calls: ["engine.stopShell"] },
  "sessions.renameShell": { status: 500, calls: ["engine.renameShell"] },
  "sessions.addService": { status: 500, calls: ["engine.addService"] },
  "sessions.runService": { status: 500, calls: ["engine.runService"] },
  "sessions.runServiceRecipe": { status: 500, calls: ["engine.runServiceRecipe"] },
  "sessions.listRecipes": { status: 500, calls: ["engine.listServiceRecipes"] },
  "sessions.declarations": { status: 500, calls: ["engine.serviceDeclarations"] },
  "sessions.serviceStart": { status: 500, calls: ["engine.serviceStartProgress"] },
  "sessions.processLogs": {
    status: 500,
    calls: ["sealant.sessionOutput", "workspaceCaller.observe"],
  },
  "sessions.restartService": { status: 500, calls: ["engine.restartService"] },
  "sessions.stopService": { status: 500, calls: ["engine.stopService"] },
  // Open-forward read masks actual removal.
  "sessions.remove": { status: 500, calls: ["services.listForSession", "forwards.listOpen"] },
  "sessions.discardUnsaved": { status: 500, calls: ["engine.discardUnsavedAndStop"] },
  "sessions.label": { status: 500, calls: ["sessions.setLabel"] },
  "sessions.stop": { status: 500, calls: ["engine.stop"] },
  "sessions.stopServices": { status: 500, calls: ["engine.stopServices"] },
  "sessions.stopServiceStarts": { status: 500, calls: ["engine.stopServiceStarts"] },
  "sessions.sharedControl": {
    status: 200,
    calls: [
      "sessions.setSharedControl",
      "engine.cancelSteeredTurns",
      "controlEvents.record",
      "audit.record",
    ],
  },
  "sessions.controlEvents": { status: 500, calls: ["controlEvents.listForSession"] },
  "sessions.checkpoint": { status: 500, calls: ["engine.checkpointNow"] },
  // The launch effect is built before engine.detach defects; no actual launch ran.
  "sessions.launch": { status: 500, calls: ["engine.launch", "engine.detach"] },
  "sessions.transcript": { status: 500, calls: ["engine.transcript"] },
  "sessions.resume": { status: 500, calls: ["engine.resumeSession"] },
  "sessions.switchMode": { status: 500, calls: ["engine.switchMode"] },
  "sessions.followUpPending": { status: 500, calls: ["followUps.activeForSession"] },
  "sessions.followUpDeliver": { status: 500, calls: ["followUpDelivery.deliver"] },
  "worktrees.create": { status: 500, calls: ["engine.ensureWorktree"] },
  "worktrees.list": { status: 500, calls: ["worktrees.listForProject", "sessions.listForProject"] },
  "worktrees.detail": { status: 500, calls: ["changes.byWorktree", "checkpoints.listForWorktree"] },
  "worktrees.previews": { status: 500, calls: ["previews.ensureForWorktree"] },
  // Open-forward check masks capture/unlanded/disk/row removal.
  "worktrees.remove": {
    status: 500,
    calls: ["removalFences.take", "removalFences.release", "forwards.listOpen"],
  },
  "worktrees.createSession": {
    status: 500,
    calls: ["removalFences.admitsStart", "engine.provisionSessionIn"],
  },
  // Chain listing masks diff generation.
  "worktrees.diff": { status: 500, calls: ["checkpoints.listForWorktree"] },
  "worktrees.contents": { status: 500, calls: ["reads.readFile"] },
  // The reads layer decides a raw read (the captured layer refuses it); this world has none.
  "worktrees.raw": { status: 500, calls: ["reads.openRawFile"] },
  "worktrees.rawHead": { status: 500, calls: ["reads.openRawFile"], body: "" },
  // newestLiveSessionId masks engine checkpoint after change lookup.
  "worktrees.checkpoint": {
    status: 500,
    calls: ["changes.byWorktree", "worktrees.newestLiveSessionId"],
  },
  "sessionChanges.openReview": { status: 500, calls: ["slices.withChangeLock"] },
  // Review-context byId masks patch read.
  "sessionChanges.reviewDiff": { status: 500, calls: ["slices.byId"] },
  // Same review-context resolver masks anchor verification/comment creation.
  "sessionChanges.sliceComment": { status: 500, calls: ["slices.byId"] },
  "sessionChanges.diff": { status: 500, calls: ["reads.diffWorktree"] },
  "sessionChanges.stats": { status: 500, calls: ["reads.changedFiles"] },
  "sessionChanges.comments": { status: 500, calls: ["comments.listForChange"] },
  // Subordinate comment lookup masks write.
  "sessionChanges.commentState": { status: 500, calls: ["comments.byId"] },
  // Shared queue helper defects at passes.queue before distinct job selection.
  "sessionChanges.read": { status: 500, calls: ["changePasses.queue"] },
  "sessionChanges.tour": { status: 500, calls: ["changeTours.byChange"] },
  // Same helper cannot distinguish tour from read/suggest when only method name recorded.
  "sessionChanges.composeTour": { status: 500, calls: ["changePasses.queue"] },
  // Same helper cannot distinguish suggest from read/tour.
  "sessionChanges.suggest": { status: 500, calls: ["changePasses.queue"] },
  "sessionChanges.passes": { status: 500, calls: ["changePasses.listForChange"] },
  "landings.land": { status: 500, calls: ["landing.land"] },
  "landings.forSession": { status: 500, calls: ["changes.byWorktree", "landings.listForChange"] },
  "landings.forChange": { status: 500, calls: ["landings.listForChange"] },
  "landings.bundle": { status: 500, calls: ["landing.bundle"] },
  "handoffs.terms": {
    status: 200,
    calls: [],
    body: { bundleBytes: 64 * 1024 * 1024, fileBytes: 8 * 1024 * 1024 },
  },
  "landings.checkGitHub": { status: 500, calls: ["landing.adoptPullRequest"] },
  "landings.gitOps": { status: 500, calls: ["gitOps.listForSession"] },
};

type Expectation = "refused" | "forbidden" | "admitted";

/** Who may do what, per rule: [user, target project, expectation]. */
const MATRIX: Readonly<Record<Rule, ReadonlyArray<readonly [HarnessUser, Target, Expectation]>>> = {
  "project-read": [
    ["bob", "shared-a", "refused"],
    ["dave", "shared-a", "refused"],
    ["carol", "private-alice", "refused"],
    ["alice", "private-carol", "refused"],
    ["alice", "shared-b", "refused"],
    ["alice", "shared-a", "admitted"],
    ["carol", "shared-a", "admitted"],
    ["carol", "private-carol", "admitted"],
    ["bob", "shared-b", "admitted"],
  ],
  "project-manage": [
    ["bob", "shared-a", "refused"],
    ["dave", "shared-a", "refused"],
    ["carol", "shared-a", "refused"],
    ["carol", "private-alice", "refused"],
    ["alice", "private-carol", "refused"],
    ["alice", "shared-a", "admitted"],
    ["carol", "private-carol", "admitted"],
    ["bob", "shared-b", "admitted"],
  ],
  "project-manage-visible": [
    ["bob", "shared-a", "refused"],
    ["dave", "shared-a", "refused"],
    ["carol", "private-alice", "refused"],
    ["alice", "private-carol", "refused"],
    ["carol", "shared-a", "forbidden"],
    ["alice", "shared-a", "admitted"],
    ["carol", "private-carol", "admitted"],
    ["bob", "shared-b", "admitted"],
  ],
  "project-remove": [
    ["bob", "shared-a", "refused"],
    ["carol", "shared-a", "refused"],
    ["alice", "private-carol", "refused"],
    ["alice", "shared-a", "admitted"],
    ["carol", "private-carol", "admitted"],
  ],
  "project-visibility": [
    ["bob", "shared-a", "refused"],
    ["carol", "shared-a", "refused"],
    ["carol", "private-carol", "refused"],
    ["alice", "shared-a", "admitted"],
    ["alice", "private-alice", "admitted"],
  ],
  steer: [
    ["bob", "shared-a", "refused"],
    ["dave", "shared-a", "refused"],
    ["carol", "private-alice", "refused"],
    ["carol", "shared-a", "forbidden"],
    ["alice", "shared-a", "admitted"],
    ["carol", "private-carol", "admitted"],
  ],
  land: [
    ["bob", "shared-a", "refused"],
    ["dave", "shared-a", "refused"],
    ["carol", "private-alice", "refused"],
    ["carol", "shared-a", "forbidden"],
    ["alice", "shared-a", "admitted"],
    ["carol", "private-carol", "admitted"],
  ],
  stop: [
    ["bob", "shared-a", "refused"],
    ["carol", "private-alice", "refused"],
    ["carol", "shared-a", "forbidden"],
    ["alice", "shared-a", "admitted"],
    ["carol", "private-carol", "admitted"],
  ],
  "worktree-remove": [
    ["bob", "shared-a", "refused"],
    // Carol sees alice's worktree; only alice, whose change it is, removes it (decision Q4).
    ["carol", "shared-a", "forbidden"],
    ["carol", "private-alice", "refused"],
    ["alice", "shared-a", "admitted"],
    ["carol", "private-carol", "admitted"],
  ],
  "project-operator": [
    ["carol", "private-carol", "refused"],
    ["bob", "shared-b", "refused"],
    ["bob", "shared-a", "refused"],
    ["alice", "shared-a", "admitted"],
  ],
  operator: [
    ["carol", "shared-a", "refused"],
    ["bob", "shared-b", "refused"],
    ["dave", "shared-a", "refused"],
    ["alice", "shared-a", "admitted"],
  ],
  owner: [
    ["carol", "shared-a", "refused"],
    ["dave", "shared-a", "refused"],
    ["alice", "shared-a", "admitted"],
  ],
  member: [
    ["bob", "shared-b", "refused"],
    ["dave", "shared-a", "refused"],
    ["carol", "shared-a", "admitted"],
    ["alice", "shared-a", "admitted"],
  ],
  "other-owner": [
    ["bob", "shared-b", "refused"],
    ["carol", "shared-a", "refused"],
    ["alice", "shared-a", "admitted"],
  ],
};

let api: TenancyApi;

beforeAll(async () => {
  api = await createTenancyApi();
});
afterAll(async () => {
  await api.dispose();
});
beforeEach(() => {
  api.world.calls.splice(0, api.world.calls.length);
});

const send = async (user: HarnessUser, call: Call) => {
  const response = await api.request(user, call.method, call.path, call.body);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
};

const idOf = (body: unknown): unknown =>
  typeof body === "object" && body !== null && "id" in body ? body.id : undefined;

describe("every endpoint is classified", () => {
  it("names an access rule, or is explicitly unscoped", () => {
    const covered = new Set(CASES.map((entry) => entry.endpoint));
    const missing: Array<string> = [];
    HttpApi.reflect(MendApi, {
      onGroup: () => {},
      onEndpoint: ({ group, endpoint }) => {
        const key = `${group.identifier}.${endpoint.identifier}`;
        if (!covered.has(key) && !UNSCOPED.has(key)) missing.push(key);
      },
    });
    expect(missing).toEqual([]);
    expect(Object.keys(ADMITTED).toSorted()).toEqual([...covered].toSorted());
  });
});

/** Capture expected fixture DTOs before a request can mutate the in-memory world. */
const admittedBody = (endpoint: string, target: Target): unknown => {
  if (endpoint === "sessions.listTurns") {
    const turn = api.world.turns.get(ids(target).turn);
    if (turn === undefined) throw new Error("missing target turn fixture");
    return Schema.encodeSync(Schema.Array(ConversationTurn))([
      new ConversationTurn({ ...turn, steerSender: turnSteerSender(turn) }),
    ]);
  }
  if (endpoint === "sessions.listProcesses") {
    const keys =
      target === "shared-a" ? [ids(target).process, PROTOCOL_PROCESS] : [ids(target).process];
    return Schema.encodeSync(Schema.Array(SessionProcess))(
      keys.map((key) => {
        const process = api.world.processes.get(key);
        if (process === undefined) throw new Error("missing target process fixture");
        return process;
      }),
    );
  }
  if (endpoint === "sessions.sharedControl") {
    const targetSession = api.world.sessions.get(ids(target).session);
    if (targetSession === undefined) throw new Error("missing target session fixture");
    return Schema.encodeSync(Session)(
      new Session({
        ...targetSession,
        sharedControlEnabledByUserId: null,
        sharedControlEnabledAt: null,
      }),
    );
  }
  if (endpoint === "pages.listForSession") {
    const page = api.world.pages.get(ids(target).page);
    if (page === undefined) throw new Error("missing target page fixture");
    return Schema.encodeSync(Schema.Array(PageRef))([pageRefOf(page)]);
  }
  if (endpoint === "pages.frame") {
    return {
      url: `/api/page-view?view=${encodeURIComponent(`${ids(target).page}.dark`)}`,
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
  }
  return ADMITTED[endpoint]?.body;
};

describe.each(CASES)("$endpoint", (entry) => {
  it.each(MATRIX[entry.rule])("%s on %s: %s", async (user, target, expectation) => {
    const call = entry.call(target);
    const expectedBody =
      expectation === "admitted" ? admittedBody(entry.endpoint, target) : undefined;
    const { status, body } = await send(user, call);
    if (expectation === "refused") {
      expect({ status, id: idOf(body), calls: api.world.calls }).toEqual({
        status: 404,
        // A HEAD answer has no body to name the target in.
        id: call.method === "HEAD" ? undefined : call.id,
        calls: [],
      });
    } else if (expectation === "forbidden") {
      expect({ status, calls: api.world.calls }).toEqual({ status: 403, calls: [] });
    } else {
      const expected = ADMITTED[entry.endpoint];
      if (expected === undefined) throw new Error(`missing admission oracle: ${entry.endpoint}`);
      expect(status).toBe(expected.status);
      // Parallel default-package resolution can begin the same method more than once before
      // the fixture failure interrupts siblings; neither scheduler count nor order is a contract.
      const calls =
        entry.endpoint === "settings.setWorkspaceEnvironment"
          ? [...new Set(api.world.calls)]
          : api.world.calls;
      expect(calls).toEqual(expected.calls);
      if (entry.endpoint === "slack.manifest") {
        if (
          typeof body !== "object" ||
          body === null ||
          !("manifest" in body) ||
          typeof body.manifest !== "string"
        ) {
          throw new Error("expected a Slack manifest response");
        }
        expect({ ...body, manifest: JSON.parse(body.manifest) }).toEqual(expectedBody);
      } else if (expected.status !== 500) {
        expect(body).toEqual(expectedBody);
      }
    }
  });
});

const sentinels = SchemaAST.resolveAt("~sentinels");
const tagOf = (ast: SchemaAST.AST): unknown => {
  const found = sentinels(ast);
  return Array.isArray(found)
    ? found.find((sentinel) => sentinel.key === "_tag")?.literal
    : undefined;
};

/** The tags each endpoint declares at 409, by `group.endpoint`. */
const conflicts = new Map<string, ReadonlyArray<unknown>>();
HttpApi.reflect(MendApi, {
  onGroup: () => {},
  onEndpoint: ({ group, endpoint, errors }) => {
    conflicts.set(
      `${group.identifier}.${endpoint.identifier}`,
      [...(errors.get(409) ?? [])].map((schema) => tagOf(schema.ast)),
    );
  },
});

/** Every write whose target is a project, or something in one: its path names the project's rows. */
const PROJECT_WRITES = CASES.filter((entry) => {
  const call = entry.call("private-alice");
  return (
    call.method !== "GET" && call.method !== "HEAD" && call.path !== entry.call("shared-b").path
  );
});

describe("a change asked of a removed project", () => {
  let removedWorld: TenancyApi;
  beforeAll(async () => {
    removedWorld = await createTenancyApi({}, { errorDetail: { mode: "redacted" } });
    const removed = ids("private-alice").project;
    const row = removedWorld.world.projects.get(removed);
    if (row === undefined) throw new Error("missing private-alice fixture");
    removedWorld.world.retainedProjects.set(removed, {
      project: row,
      removedAt: new Date("2026-10-30T12:00:00.000Z"),
      removedByUserId: "alice",
      state: "removed",
    });
  });
  afterAll(async () => {
    await removedWorld.dispose();
  });
  beforeEach(() => {
    removedWorld.world.calls.splice(0, removedWorld.world.calls.length);
  });

  const sendTo = async (user: HarnessUser, call: Call) => {
    const response = await removedWorld.request(user, call.method, call.path, call.body);
    return { status: response.status, body: await response.json() };
  };

  it.each(PROJECT_WRITES)(
    "$endpoint says to restore it to whoever can see it, declares that refusal, and is a 404 to anyone else",
    async (entry) => {
      const call = entry.call("private-alice");
      const byCreator = await sendTo("alice", call);
      const byOther = await sendTo("carol", call);
      expect({
        creator: byCreator,
        other: { status: byOther.status, id: idOf(byOther.body) },
        declared: conflicts.get(entry.endpoint)?.includes("RemovalInProgress"),
        calls: removedWorld.world.calls,
      }).toEqual({
        creator: {
          status: 409,
          body: { _tag: "RemovalInProgress", message: REMOVED_PROJECT_WORK_REFUSED },
        },
        other: { status: 404, id: call.id },
        declared: true,
        calls: [],
      });
    },
  );

  it("still reads as missing to the person who removed it", async () => {
    for (const entry of CASES) {
      const call = entry.call("private-alice");
      if (call.method !== "GET" || call.path === entry.call("shared-b").path) continue;
      expect({ endpoint: entry.endpoint, ...(await sendTo("alice", call)) }).toMatchObject({
        endpoint: entry.endpoint,
        status: 404,
      });
    }
  });
});

describe("owners stop sessions in their organization", () => {
  it("alice (owner) may stop carol's session in her shared project; carol may not stop alice's", async () => {
    const stopped: string[] = [];
    const controls: Array<{
      readonly sessionId: string;
      readonly actorUserId: string;
      readonly kind: string;
      readonly refId: string | null;
    }> = [];
    const instance = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            stop: (sessionId) =>
              Effect.sync(() => {
                stopped.push(sessionId);
              }),
          },
          controlEvents: {
            record: (event) =>
              Effect.sync(() => {
                controls.push(event);
              }),
          },
        },
      },
    );
    try {
      const byOwner = await instance.request(
        "alice",
        "POST",
        `/api/sessions/${CAROL_SESSION_IN_SHARED_A}/stop`,
      );
      expect(byOwner.status).toBe(200);
      expect(await byOwner.json()).toMatchObject({
        id: CAROL_SESSION_IN_SHARED_A,
        ownerUserId: "carol",
      });
      expect(stopped).toEqual([CAROL_SESSION_IN_SHARED_A]);
      expect(controls).toEqual([
        { sessionId: CAROL_SESSION_IN_SHARED_A, actorUserId: "alice", kind: "stop", refId: null },
      ]);
      instance.world.calls.length = 0;
      const byMember = await instance.request(
        "carol",
        "POST",
        `/api/sessions/${ids("shared-a").session}/stop`,
      );
      expect({ status: byMember.status, calls: instance.world.calls }).toEqual({
        status: 403,
        calls: [],
      });
      expect(stopped).toEqual([CAROL_SESSION_IN_SHARED_A]);
      expect(controls).toHaveLength(1);
    } finally {
      await instance.dispose();
    }
  });
});

const skill = (id: string): Call => ({ method: "GET", path: `/api/skills/${id}`, id });
const remove = (id: string): Call => ({ method: "DELETE", path: `/api/skills/${id}`, id });

describe("worktree removal by a member", () => {
  it("is allowed when the member owns every session in it, and refused before any effect otherwise", async () => {
    const removed: Array<{ readonly storePath: string; readonly directory: string }> = [];
    const shell = api.world.processes.get(CAROL_SHELL_IN_SHARED_A);
    if (shell === undefined) throw new Error("missing member shell fixture");
    const instance = await createTenancyApi(
      {},
      {
        processes: [
          new SessionProcess({
            ...shell,
            status: "stopped",
            exitCode: 0,
            exitedAt: new Date("2026-09-17T10:01:00.000Z"),
          }),
        ],
        implement: {
          engine: { launchUnderWay: () => false, captureHolds: () => Effect.succeed([]) },
          forwards: { listOpen: () => Effect.succeed([]) },
          store: {
            removeWorktreeForce: (storePath, directory) =>
              Effect.sync(() => {
                removed.push({ storePath, directory });
                return { leftover: null };
              }),
          },
        },
      },
    );
    try {
      const worktree = instance.world.worktrees.get(CAROL_WORKTREE_IN_SHARED_A);
      const targetProject = instance.world.projects.get(ids("shared-a").project);
      if (worktree === undefined || targetProject === undefined)
        throw new Error("missing removal fixture");
      // Explicit force bypasses unlanded-change inspection, never the ownership check.
      const own = await instance.request(
        "carol",
        "DELETE",
        `/api/worktrees/${CAROL_WORKTREE_IN_SHARED_A}?force=true`,
      );
      expect(own.status).toBe(200);
      expect(await own.json()).toEqual({ removed: true, leftover: null });
      expect(removed).toEqual([
        { storePath: targetProject.storePath, directory: worktree.directory },
      ]);
      expect(instance.world.worktrees.has(CAROL_WORKTREE_IN_SHARED_A)).toBe(false);
      instance.world.calls.length = 0;
      const shared = await instance.request(
        "carol",
        "DELETE",
        `/api/worktrees/${ids("shared-a").worktree}?force=true`,
      );
      expect({ status: shared.status, calls: instance.world.calls }).toEqual({
        status: 403,
        calls: [],
      });
      expect(await shared.json()).toEqual({
        _tag: "RemovalForbidden",
        owner: { userId: "alice", name: "Alice" },
        message: "not removed · only Alice, who started this worktree's change, removes it.",
      });
      expect(removed).toHaveLength(1);
      expect(instance.world.worktrees.has(ids("shared-a").worktree)).toBe(true);
    } finally {
      await instance.dispose();
    }
  });
});

describe("references belong to their organization", () => {
  it("a project selects only its own organization's references, before any write", async () => {
    const response = await send("alice", {
      method: "PUT",
      path: `/api/projects/${ids("shared-a").project}/references`,
      id: REFERENCE_B,
      body: { referenceIds: [REFERENCE_A, REFERENCE_B] },
    });
    expect({ status: response.status, id: idOf(response.body), calls: api.world.calls }).toEqual({
      status: 404,
      id: REFERENCE_B,
      calls: [],
    });
  });
});

describe("folders belong to their organization", () => {
  it("a project selects only its own organization's folders, before any write", async () => {
    const response = await send("alice", {
      method: "PUT",
      path: `/api/projects/${ids("shared-a").project}/folders`,
      id: FOLDER_B,
      body: { selections: [{ folderId: FOLDER_B, name: "docs", readOnly: true }] },
    });
    expect({ status: response.status, id: idOf(response.body), calls: api.world.calls }).toEqual({
      status: 404,
      id: FOLDER_B,
      calls: [],
    });
  });
});

describe("adoption needs an organization", () => {
  it("refuses an account in no organization before cloning anything", async () => {
    const response = await api.request("dave", "POST", "/api/projects", {
      name: "stray",
      source: "https://example.invalid/stray.git",
    });
    expect({ status: response.status, calls: api.world.calls }).toEqual({ status: 422, calls: [] });
  });
});

describe("skills follow their project", () => {
  it("reads a project skill where the project is visible, and a user skill only as its owner", async () => {
    const visible = await send("carol", skill(ids("shared-a").skill));
    expect(visible.status).toBe(200);
    expect(visible.body).toMatchObject({ skill: { id: ids("shared-a").skill } });
    const hidden = await send("carol", skill(ids("private-alice").skill));
    expect({ status: hidden.status, id: idOf(hidden.body) }).toEqual({
      status: 404,
      id: ids("private-alice").skill,
    });
    expect((await send("bob", skill(ids("shared-a").skill))).status).toBe(404);
    const own = await send("carol", skill(CAROL_USER_SKILL));
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ skill: { id: CAROL_USER_SKILL } });
    expect((await send("alice", skill(CAROL_USER_SKILL))).status).toBe(404);
  });

  it("changes a project skill only when managing the project, before any write", async () => {
    const refused = await send("carol", remove(ids("shared-a").skill));
    expect({ status: refused.status, calls: api.world.calls }).toEqual({ status: 404, calls: [] });
    const created = await send("carol", {
      method: "POST",
      path: "/api/skills",
      id: ids("shared-a").project,
      body: {
        scope: "project",
        projectId: ids("shared-a").project,
        name: "x",
        description: "d",
        files: [{ path: "SKILL.md", contents: "x" }],
      },
    });
    expect({ status: created.status, calls: api.world.calls }).toEqual({ status: 404, calls: [] });
  });
});

describe("lists show what the caller can see", () => {
  const listIds = async (user: HarnessUser, path: string) => {
    const response = await api.request(user, "GET", path);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    return Array.isArray(body) ? body.map((row: unknown) => String(idOf(row))).toSorted() : [];
  };

  it("projects: a member sees shared projects and their own private ones", async () => {
    expect(await listIds("carol", "/api/projects")).toEqual(
      [ids("private-carol").project, ids("shared-a").project].toSorted(),
    );
    expect(await listIds("alice", "/api/projects")).toEqual(
      [ids("private-alice").project, ids("shared-a").project].toSorted(),
    );
    expect(await listIds("bob", "/api/projects")).toEqual([ids("shared-b").project]);
    expect(await listIds("dave", "/api/projects")).toEqual([]);
  });

  it("active sessions: only those of visible projects", async () => {
    const carol = await listIds("carol", "/api/sessions");
    expect(carol).toContain(ids("shared-a").session);
    expect(carol).toContain(ids("private-carol").session);
    expect(carol).not.toContain(ids("private-alice").session);
    expect(carol).not.toContain(ids("shared-b").session);
    expect(await listIds("dave", "/api/sessions")).toEqual([]);
  });

  it("Services: an account in no organization reads none, and nothing about them", async () => {
    const response = await api.request("dave", "GET", "/api/services");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(api.world.calls).toEqual(["services.listAll"]);
  });

  it("references: an account in no organization reads none", async () => {
    const response = await api.request("dave", "GET", "/api/references");
    expect({ status: response.status, calls: api.world.calls }).toEqual({ status: 200, calls: [] });
    expect(await response.json()).toEqual([]);
  });
});
