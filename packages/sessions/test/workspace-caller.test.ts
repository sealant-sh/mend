import { OrganizationsRepo, ProjectsRepo, SessionRunsRepo, SessionsRepo } from "@mend/db";
import {
  OrganizationId,
  ProjectId,
  SealantRunId,
  SealantWorkspaceId,
  SessionId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import {
  Organization,
  Project,
  RepositoryCloneUrl,
  Session,
  SessionRun,
} from "@mend/domain/workbench";
import { asSealantUser, SealantClient, SealantPrincipal } from "@mend/sealant";
import type { Run, Workspace } from "@sealant/sdk";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { SealantClientByWorkspaceCreator, WorkspaceCallerLive } from "../src/workspace-caller.ts";

const now = () => new Date("2026-10-06T10:00:00.000Z");
const WORKTREE = WorktreeId.make("wt-1");
const PROJECT = ProjectId.make("proj-1");
const HOLDER_WORKSPACE = "ws-holder";

const sessionOf = (id: string, ownerUserId: string, workspaceId: string | null) =>
  new Session({
    id: SessionId.make(id),
    projectId: PROJECT,
    worktreeId: WORKTREE,
    harness: "claude",
    providerSessionId: null,
    label: null,
    worktree: "together",
    branch: "mend/together",
    baseSha: Sha.make("base-sha"),
    baseRef: "main",
    contextSnapshotId: null,
    referenceMounts: [],
    extraMounts: [],
    sealantRunId: null,
    sealantWorkspaceId: workspaceId === null ? null : SealantWorkspaceId.make(workspaceId),
    sealantSessionId: null,
    workspaceExpiresAt: null,
    workspaceTtlRenewedAt: null,
    workspaceTtlRenewalFailedAt: null,
    workspaceTtlRenewalError: null,
    workspaceImage: null,
    dotfiles: null,
    ownerUserId,
    hasTranscript: null,
    status: "running",
    summary: null,
    lastSeenSequence: 0n,
    recordHistoryComplete: false,
    startedAt: now(),
    settledAt: null,
    createdAt: now(),
    updatedAt: now(),
  });

const project = (visibility: "shared" | "private") =>
  new Project({
    id: PROJECT,
    name: "fixture",
    organizationId: OrganizationId.make("org-test"),
    visibility,
    createdByUserId: "alice",
    originUrl: RepositoryCloneUrl.make("https://example.invalid/fixture.git"),
    storePath: "/store/fixture",
    defaultBranch: "main",
    adoptedSha: Sha.make("0000000000000000000000000000000000000000"),
    autoTour: "inherit",
    autoName: "inherit",
    autoLand: "inherit",
    autoSuggest: "inherit",
    backgroundSessions: "inherit",
    gitAuthMode: "ambient",
    workspaceImage: null,
    applyDotfiles: true,
    defaultShellProfile: true,
    inheritUserSkills: true,
    hotSessions: 0,
    installCommand: null,
    installEnabled: true,
    createdAt: now(),
    updatedAt: now(),
  });

// Only their ids are read on the way through; the platform beneath is a mock.
const workspace = { id: HOLDER_WORKSPACE } as unknown as Workspace;
const run = { id: "run-joined" } as unknown as Run;

const joinedRun = new SessionRun({
  sealantRunId: SealantRunId.make("run-joined"),
  sessionId: SessionId.make("s-bob"),
  ordinal: 1,
  harness: "claude",
  sealantWorkspaceId: SealantWorkspaceId.make(HOLDER_WORKSPACE),
  sealantSessionId: null,
  status: "running",
  summary: null,
  lastSeenSequence: 0n,
  environmentRevision: null,
  environmentVariableNames: null,
  secretRevision: null,
  secretNames: null,
  clusterBindingRevision: null,
  clusterBindingNames: null,
  clusterServiceAccount: null,
  startedAt: now(),
  settledAt: null,
  createdAt: now(),
  updatedAt: now(),
});

/**
 * Alice launched the holder's executor; Bob joined it (his session names it with no launch of its
 * own); Carol is a member with no session in the worktree. The platform beneath records whose
 * principal each call was made under.
 */
const world = (options: { readonly visibility?: "shared" | "private" } = {}) => {
  const asked: Array<string> = [];
  const members = new Set(["alice", "bob", "carol"]);
  const record = (method: string) =>
    Effect.map(SealantPrincipal, (principal) => {
      asked.push(`${method} ${principal.kind === "none" ? "none" : principal.userId}`);
    });
  const sessions = [
    sessionOf("s-alice", "alice", HOLDER_WORKSPACE),
    sessionOf("s-bob", "bob", HOLDER_WORKSPACE),
  ];
  const platform = Layer.mock(SealantClient, {
    getWorkspace: () => record("getWorkspace").pipe(Effect.as(workspace)),
    exec: () => record("exec").pipe(Effect.as({ exitCode: 0, stdout: "", stderr: "", run })),
    startHarness: () => record("startHarness").pipe(Effect.as(run)),
    findWorkspaceByKey: () =>
      record("findWorkspaceByKey").pipe(Effect.as({ kind: "none" as const })),
    recordStream: () => Stream.unwrap(record("recordStream").pipe(Effect.as(Stream.empty))),
  });
  const repos = Layer.mergeAll(
    Layer.mock(SessionsRepo, {
      executorSessionOf: (workspaceId) =>
        Effect.succeed(workspaceId === HOLDER_WORKSPACE ? (sessions[0] ?? null) : null),
      listForWorktree: () => Effect.succeed(sessions),
    }),
    Layer.mock(SessionRunsRepo, {
      bySealantRunId: (id) => Effect.succeed(id === joinedRun.sealantRunId ? joinedRun : null),
    }),
    Layer.mock(ProjectsRepo, {
      byId: () => Effect.succeed(project(options.visibility ?? "shared")),
    }),
    Layer.mock(OrganizationsRepo, {
      membershipOf: (userId) =>
        Effect.succeed(
          members.has(userId)
            ? {
                organization: new Organization({
                  id: OrganizationId.make("org-test"),
                  name: "Test",
                  createdByUserId: null,
                  createdAt: now(),
                  updatedAt: now(),
                }),
                role: "member" as const,
                joinedAt: now(),
              }
            : null,
        ),
    }),
  );
  const layer = SealantClientByWorkspaceCreator.pipe(
    Layer.provide(WorkspaceCallerLive),
    Layer.provide(platform),
    Layer.provide(repos),
  );
  const runAs = <A, E>(userId: string | null, effect: Effect.Effect<A, E, SealantClient>) =>
    Effect.runPromise(effect.pipe(asSealantUser(userId), Effect.provide(layer), Effect.result));
  return { asked, members, runAs };
};

describe("WorkspaceCaller: whose platform identity a call about a workspace runs as", () => {
  it("asks about the holder's workspace as its creator for a joiner, and as the creator for the creator", async () => {
    const { asked, runAs } = world();
    await runAs(
      "bob",
      Effect.flatMap(SealantClient, (client) =>
        client.getWorkspace(HOLDER_WORKSPACE).pipe(Effect.flatMap((w) => client.exec(w, ["ls"]))),
      ),
    );
    await runAs(
      "alice",
      Effect.flatMap(SealantClient, (client) => client.getWorkspace(HOLDER_WORKSPACE)),
    );
    expect(asked).toEqual(["getWorkspace alice", "exec alice", "getWorkspace alice"]);
  });

  it("lends nobody's identity to someone without standing: no session here, removed, kept out, or nobody", async () => {
    const { asked, members, runAs } = world({ visibility: "shared" });
    const lookup = Effect.flatMap(SealantClient, (client) => client.getWorkspace(HOLDER_WORKSPACE));
    await runAs("carol", lookup);
    members.delete("bob");
    await runAs("bob", lookup);
    await runAs(null, lookup);
    expect(asked).toEqual(["getWorkspace carol", "getWorkspace bob", "getWorkspace none"]);

    const kept = world({ visibility: "private" });
    await kept.runAs("bob", lookup);
    expect(kept.asked).toEqual(["getWorkspace bob"]);
  });

  it("keeps calls that are a person's own with them: a create key is never asked as another", async () => {
    const { asked, runAs } = world();
    await runAs(
      "bob",
      Effect.flatMap(SealantClient, (client) => client.findWorkspaceByKey("launch-1")),
    );
    expect(asked).toEqual(["findWorkspaceByKey bob"]);
  });

  it("refuses a harness run in another person's workspace: it would spend the logins it was created with", async () => {
    const { asked, runAs } = world();
    const start = Effect.flatMap(SealantClient, (client) => client.startHarness(workspace, "go"));
    const bob = await runAs("bob", start);
    const alice = await runAs("alice", start);
    expect(bob._tag).toBe("Failure");
    expect(bob._tag === "Failure" ? bob.failure.code : null).toBe("harness_login_not_yours");
    expect(alice._tag).toBe("Success");
    expect(asked).toEqual(["startHarness alice"]);
  });

  it("streams a run's record as the creator of the workspace the run is in", async () => {
    const { asked, runAs } = world();
    await runAs(
      "bob",
      Effect.flatMap(SealantClient, (client) => Stream.runDrain(client.recordStream(run))),
    );
    expect(asked).toEqual(["recordStream alice"]);
  });

  it("asks as the principal about a workspace whose creator Mend has not recorded", async () => {
    const { asked, runAs } = world();
    await runAs(
      "bob",
      Effect.flatMap(SealantClient, (client) => client.getWorkspace("ws-unknown")),
    );
    expect(asked).toEqual(["getWorkspace bob"]);
  });
});
