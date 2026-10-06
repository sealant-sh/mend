import { SessionRunsRepo, SessionsRepo } from "@mend/db";
import {
  OrganizationId,
  ProjectId,
  SealantRunId,
  SealantWorkspaceId,
  SessionId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { Session, SessionRun } from "@mend/domain/workbench";
import {
  asSealantUser,
  SealantClient,
  type SealantPlatformError,
  SealantPrincipal,
} from "@mend/sealant";
import type { Run, Workspace } from "@sealant/sdk";
import { Effect, Layer, ManagedRuntime, Result, Stream } from "effect";
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
 * Alice launched the holder's executor; Bob joined it; Carol is a member with no session in the
 * worktree. The platform beneath records whose principal each call was made under, and how often
 * Mend asked who created a workspace.
 */
const world = (options: { readonly visibility?: "shared" | "private" } = {}) => {
  const asked: Array<string> = [];
  const creatorReads: Array<string> = [];
  const members = new Set(["alice", "bob", "carol"]);
  const record = (method: string) =>
    Effect.map(SealantPrincipal, (principal) => {
      asked.push(`${method} ${principal.kind === "none" ? "none" : principal.userId}`);
    });
  const holder = sessionOf("s-alice", "alice", HOLDER_WORKSPACE);
  const platform = Layer.mock(SealantClient, {
    getWorkspace: () => record("getWorkspace").pipe(Effect.as(workspace)),
    exec: () => record("exec").pipe(Effect.as({ exitCode: 0, stdout: "", stderr: "", run })),
    stopWorkspace: () =>
      record("stopWorkspace").pipe(
        Effect.as({ state: "stopped" as const, retained: null, completion: null }),
      ),
    startHarness: () => record("startHarness").pipe(Effect.as(run)),
    findWorkspaceByKey: () =>
      record("findWorkspaceByKey").pipe(Effect.as({ kind: "none" as const })),
    recordStream: () => Stream.unwrap(record("recordStream").pipe(Effect.as(Stream.empty))),
  });
  const roleOf = (userId: string) => (members.has(userId) ? ("member" as const) : null);
  const repos = Layer.mergeAll(
    Layer.mock(SessionsRepo, {
      executorSessionOf: (workspaceId) =>
        Effect.sync(() => {
          creatorReads.push(workspaceId);
          return workspaceId === HOLDER_WORKSPACE ? holder : null;
        }),
      executorAccessOf: (workspaceId, asker) =>
        Effect.succeed(
          workspaceId === HOLDER_WORKSPACE
            ? {
                creatorUserId: "alice",
                project: {
                  organizationId: OrganizationId.make("org-test"),
                  visibility: options.visibility ?? "shared",
                  createdByUserId: "alice",
                },
                creatorRole: roleOf("alice"),
                askerRole: roleOf(asker),
              }
            : null,
        ),
    }),
    Layer.mock(SessionRunsRepo, {
      bySealantRunId: (id) => Effect.succeed(id === joinedRun.sealantRunId ? joinedRun : null),
    }),
  );
  const layer = SealantClientByWorkspaceCreator.pipe(
    Layer.provide(WorkspaceCallerLive),
    Layer.provide(platform),
    Layer.provide(repos),
  );
  // One client for the whole world, as the server has: its caches live as long as it does.
  const runtime = ManagedRuntime.make(layer);
  const runAs = <A, E>(userId: string | null, effect: Effect.Effect<A, E, SealantClient>) =>
    runtime.runPromise(effect.pipe(asSealantUser(userId), Effect.result));
  return { asked, creatorReads, members, runAs };
};

const lookup = Effect.flatMap(SealantClient, (client) => client.getWorkspace(HOLDER_WORKSPACE));
const exec = Effect.flatMap(SealantClient, (client) => client.exec(workspace, ["ls"]));
const codeOf = <A>(result: Result.Result<A, SealantPlatformError>) =>
  Result.isFailure(result) ? result.failure.code : "answered";

describe("WorkspaceCaller: whose platform identity a call about a workspace runs as", () => {
  it("lends the creator's identity to a joiner who may work there, and asks the creator as herself", async () => {
    const { asked, runAs } = world();
    await runAs("bob", Effect.andThen(lookup, exec));
    await runAs("alice", Effect.andThen(lookup, exec));
    expect(asked).toEqual(["getWorkspace alice", "exec alice", "getWorkspace alice", "exec alice"]);
  });

  it("refuses an act for someone who may not work there, but observes and ends as the creator", async () => {
    const { asked, members, runAs } = world();
    members.delete("bob");
    const acted = await runAs("bob", exec);
    await runAs("bob", lookup);
    await runAs(
      "bob",
      Effect.flatMap(SealantClient, (client) => client.stopWorkspace(workspace)),
    );
    // Nobody outside the organization is lent anything either, nor is nobody.
    const outsider = await runAs("dave", exec);
    await runAs(null, lookup);
    expect([codeOf(acted), codeOf(outsider)]).toEqual(["no_standing", "no_standing"]);
    expect(asked).toEqual(["getWorkspace alice", "stopWorkspace alice", "getWorkspace none"]);
  });

  it("lends nothing once the creator lost access: acts are refused, the executor can still be ended", async () => {
    const { asked, members, runAs } = world();
    members.delete("alice");
    const acted = await runAs("bob", exec);
    await runAs(
      "bob",
      Effect.flatMap(SealantClient, (client) => client.stopWorkspace(workspace)),
    );
    expect(codeOf(acted)).toBe("creator_no_access");
    expect(asked).toEqual(["stopWorkspace alice"]);
  });

  it("refuses an act in a private project for a member who cannot see it", async () => {
    const { asked, runAs } = world({ visibility: "private" });
    expect(codeOf(await runAs("bob", exec))).toBe("no_standing");
    expect(codeOf(await runAs("alice", exec))).toBe("answered");
    expect(asked).toEqual(["exec alice"]);
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

  it("asks as the principal about a workspace whose creator Mend has not recorded, and believes that a while", async () => {
    const { asked, creatorReads, runAs } = world();
    const unknown = Effect.flatMap(SealantClient, (client) => client.getWorkspace("ws-unknown"));
    await runAs("bob", unknown);
    await runAs("bob", unknown);
    await runAs("bob", lookup);
    await runAs("bob", lookup);
    expect(asked).toEqual([
      "getWorkspace bob",
      "getWorkspace bob",
      "getWorkspace alice",
      "getWorkspace alice",
    ]);
    // One read each: "none on record" is kept for a while, a creator for good.
    expect(creatorReads).toEqual(["ws-unknown", HOLDER_WORKSPACE]);
  });
});
