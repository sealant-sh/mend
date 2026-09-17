import { MendApi } from "@mend/api-contracts";
import { defaultSettings, defaultWorkspaceImage, MendSettings, WorkspaceImage } from "@mend/domain";
import { Schema } from "effect";
import { HttpApi } from "effect/unstable/httpapi";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import {
  CAROL_SESSION_IN_SHARED_A,
  CAROL_USER_SKILL,
  CAROL_WORKTREE_IN_SHARED_A,
  FOLDER_A,
  FOLDER_B,
  REFERENCE_A,
  REFERENCE_B,
  ids,
  type HarnessProject,
  type HarnessUser,
} from "../../test/support/tenancy-harness.ts";

/**
 * Every endpoint of the Mend API against the two-organization world (docs/adr/0003). A refused
 * request answers exactly like a missing resource, names the id the caller asked for, and has
 * touched nothing beyond the reads authorization needs. An admitted request gets past
 * authorization (whatever the unimplemented mocks do after that).
 */

type Target = HarnessProject;
interface Call {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
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
  /** Owners, or the creator of a private project. */
  | "project-remove"
  /** Owners only. */
  | "project-visibility"
  /** The session owner only; others who can see it get 403. */
  | "steer"
  /** Steer, plus organization owners. */
  | "stop"
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
  "health.status",
  "instance.get",
  "machine.get",
  "sealant.connection",
  "workspaceSsh.get",
  "workspaceSsh.ensureKey",
  "accounts.identity",
  "accounts.connect",
  "accounts.disconnect",
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
  "organization.issuePasswordReset",
  "invitations.preview",
  // Minting authorizes nothing: the socket route authorizes the ticket's account against the
  // session or service when the ticket is spent (upgrade-tickets.test.ts).
  "upgradeTickets.mint",
  "upgradeTicketExchange.exchange",
  "settings.get",
  "dotfiles.get",
  "dotfiles.repository",
  "dotfiles.snapshot",
  "dotfiles.clearSnapshot",
  "skills.list",
  "gitKeys.show",
  "gitKeys.init",
  "gitKeys.bridgeStatus",
  "gitKeys.access",
  "gitKeys.setAccess",
  "github.status",
  "github.repos",
  "devices.register",
  "devices.unregister",
  "userDevices.createPairing",
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
  "sessions.listActive",
  "sessions.listServices",
  "references.list",
  "folders.list",
  "skills.detail",
  "skills.create",
  "skills.update",
  "skills.remove",
  "skills.sync",
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
    kind: "turn" | "request" | "process" | "service" | "worktree" | "change",
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
  project("project-manage", "PUT", "/git-auth", { gitAuthMode: "ambient" })("projects.gitAuth"),
  project("project-manage", "PUT", "/workspace-image", { workspaceImage: null })(
    "projects.workspaceImage",
  ),
  project("project-manage", "PUT", "/apply-dotfiles", { applyDotfiles: true })(
    "projects.applyDotfiles",
  ),
  project("project-manage", "PUT", "/inherit-user-skills", { inheritUserSkills: true })(
    "projects.inheritUserSkills",
  ),
  project("project-manage", "PUT", "/hot-sessions", { hotSessions: 0 })("projects.hotSessions"),
  project("project-manage", "PUT", "/install-command", { installCommand: null })(
    "projects.installCommand",
  ),
  project("project-read", "GET", "/hot-sessions")("projects.hotSessionsStatus"),
  project("project-read", "GET", "/branches")("projects.branches"),
  project("project-read", "POST", "/refresh")("projects.refresh"),
  project("project-read", "GET", "/files")("projects.files"),
  project("project-read", "GET", "/pull-requests")("projects.pullRequests"),
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

  // ── Sessions ──
  project("project-read", "POST", "/sessions", { harness: "shell", label: null, base: null })(
    "sessions.create",
  ),
  session("project-read", "GET", "")("sessions.detail"),
  session("steer", "POST", "/turns", { input: "Continue" })("sessions.submitTurn"),
  session("steer", "POST", "/images", { contentsBase64: "iVBORw0KGgo=" })("sessions.pasteImage"),
  child("steer", "turn", "POST", "/api/turns", "/interrupt")("sessions.interruptTurn"),
  session("project-read", "GET", "/turns")("sessions.listTurns"),
  session("project-read", "GET", "/items")("sessions.listItems"),
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
  child("project-read", "process", "GET", "/api/processes", "/logs")("sessions.processLogs"),
  child("steer", "service", "POST", "/api/services", "/restart")("sessions.restartService"),
  child("steer", "service", "POST", "/api/services", "/stop")("sessions.stopService"),
  session("steer", "DELETE", "")("sessions.remove"),
  session("steer", "POST", "/label", { label: "renamed" })("sessions.label"),
  session("stop", "POST", "/stop")("sessions.stop"),
  // Turning it off: the owner or an organization owner. Turning it on is the owner's alone
  // (shared-control.test.ts); off leaves the world unshared for every other case.
  session("stop", "PUT", "/shared-control", { enabled: false })("sessions.sharedControl"),
  session("project-read", "GET", "/control-events")("sessions.controlEvents"),
  session("project-read", "POST", "/checkpoints", { trigger: "user-mark" })("sessions.checkpoint"),
  session("steer", "POST", "/launch", { argv: ["codex"] })("sessions.launch"),
  session("project-read", "GET", "/transcript")("sessions.transcript"),
  session("steer", "POST", "/resume", { harness: null })("sessions.resume"),
  session("steer", "POST", "/handoff", { to: "pty" })("sessions.handoff"),
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
  child("worktree-remove", "worktree", "DELETE", "/api/worktrees", "")("worktrees.remove"),
  child("project-read", "worktree", "POST", "/api/worktrees", "/sessions", {
    harness: "shell",
  })("worktrees.createSession"),
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
];

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
  stop: [
    ["bob", "shared-a", "refused"],
    ["carol", "private-alice", "refused"],
    ["carol", "shared-a", "forbidden"],
    ["alice", "shared-a", "admitted"],
    ["carol", "private-carol", "admitted"],
  ],
  "worktree-remove": [
    ["bob", "shared-a", "refused"],
    ["carol", "shared-a", "refused"],
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
        const key = `${group.identifier}.${endpoint.name}`;
        if (!covered.has(key) && !UNSCOPED.has(key)) missing.push(key);
      },
    });
    expect(missing).toEqual([]);
  });
});

describe.each(CASES)("$endpoint", (entry) => {
  it.each(MATRIX[entry.rule])("%s on %s: %s", async (user, target, expectation) => {
    const call = entry.call(target);
    const { status, body } = await send(user, call);
    if (expectation === "refused") {
      expect({ status, id: idOf(body), calls: api.world.calls }).toEqual({
        status: 404,
        id: call.id,
        calls: [],
      });
    } else if (expectation === "forbidden") {
      expect({ status, calls: api.world.calls }).toEqual({ status: 403, calls: [] });
    } else {
      expect(status).not.toBe(400);
      expect(status).not.toBe(401);
      expect(status).not.toBe(403);
      if (status === 404) expect(idOf(body)).not.toBe(call.id);
    }
  });
});

describe("owners stop sessions in their organization", () => {
  it("alice (owner) may stop carol's session in her shared project; carol may not stop alice's", async () => {
    const byOwner = await send("alice", {
      method: "POST",
      path: `/api/sessions/${CAROL_SESSION_IN_SHARED_A}/stop`,
      id: CAROL_SESSION_IN_SHARED_A,
    });
    expect(byOwner.status).not.toBe(403);
    expect(byOwner.status).not.toBe(404);
    api.world.calls.splice(0, api.world.calls.length);
    const byMember = await send("carol", {
      method: "POST",
      path: `/api/sessions/${ids("shared-a").session}/stop`,
      id: ids("shared-a").session,
    });
    expect({ status: byMember.status, calls: api.world.calls }).toEqual({ status: 403, calls: [] });
  });
});

const skill = (id: string): Call => ({ method: "GET", path: `/api/skills/${id}`, id });
const remove = (id: string): Call => ({ method: "DELETE", path: `/api/skills/${id}`, id });

describe("worktree removal by a member", () => {
  it("is allowed when the member owns every session in it, and refused before any effect otherwise", async () => {
    const own = await send("carol", {
      method: "DELETE",
      path: `/api/worktrees/${CAROL_WORKTREE_IN_SHARED_A}`,
      id: CAROL_WORKTREE_IN_SHARED_A,
    });
    expect(own.status).not.toBe(404);
    api.world.calls.splice(0, api.world.calls.length);
    const shared = await send("carol", {
      method: "DELETE",
      path: `/api/worktrees/${ids("shared-a").worktree}`,
      id: ids("shared-a").worktree,
    });
    expect({ status: shared.status, calls: api.world.calls }).toEqual({ status: 404, calls: [] });
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
    expect((await send("carol", skill(ids("shared-a").skill))).status).not.toBe(404);
    const hidden = await send("carol", skill(ids("private-alice").skill));
    expect({ status: hidden.status, id: idOf(hidden.body) }).toEqual({
      status: 404,
      id: ids("private-alice").skill,
    });
    expect((await send("bob", skill(ids("shared-a").skill))).status).toBe(404);
    expect((await send("carol", skill(CAROL_USER_SKILL))).status).not.toBe(404);
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
