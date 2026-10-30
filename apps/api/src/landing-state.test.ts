import { ChangeLandingsRepo } from "@mend/db";
import {
  ChangeId,
  ChangeLandingId,
  OrganizationId,
  ProjectId,
  SessionId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { Change, ChangeLanding, Project, Worktree } from "@mend/domain/workbench";
import { LandingGit, LandingStepError } from "@mend/landing";
import { WorktreeReads } from "@mend/sessions";
import {
  AgentBridge,
  type ChangedFile,
  MendKeys,
  SourcePolicy,
  makeSourcePolicy,
} from "@mend/store";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { makeProject } from "../test/support/tenancy-harness.ts";
import { ProjectAccess } from "./access.ts";
import { changeStandingOf } from "./landing-state.ts";

/** Worktree removal against the landing record (docs/adr/0007-landing.md, "Worktree removal"). */

const NOW = new Date("2026-09-24T10:00:00Z");
const BASE = Sha.make("1111111111111111111111111111111111111111");
const CHECKPOINT = Sha.make("cccccccccccccccccccccccccccccccccccccccc");
const PUSHED = Sha.make("3f2a1c0000000000000000000000000000000000");

const project = new Project({
  ...makeProject({
    id: ProjectId.make("p-api"),
    organizationId: OrganizationId.make("org-acme"),
    visibility: "shared",
    createdByUserId: "ada",
    storePath: "/store/p-api/repo.git",
  }),
  originUrl: "git@github.com:acme/api.git",
});

const worktree = new Worktree({
  id: WorktreeId.make("wt-1"),
  projectId: project.id,
  name: "fix-login",
  directory: "fix-login",
  branch: "mend/fix-login",
  baseSha: BASE,
  baseRef: "main",
  handoff: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const change = new Change({
  id: ChangeId.make("c-1"),
  projectId: project.id,
  worktreeId: worktree.id,
  sessionId: SessionId.make("s-1"),
  branch: worktree.branch,
  baseSha: BASE,
  headSha: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const landed = new ChangeLanding({
  id: ChangeLandingId.make("l-1"),
  changeId: change.id,
  sessionId: change.sessionId,
  projectId: project.id,
  checkpointId: null,
  checkpointRef: "refs/mend/checkpoints/wt-1/3",
  checkpointSha: CHECKPOINT,
  commitSha: PUSHED,
  remoteBranch: "mend/fix-login",
  pushedSha: PUSHED,
  trigger: "manual",
  pullRequest: null,
  outcome: "pushed",
  message: null,
  userId: "ada",
  createdAt: NOW,
});

const file = (path: string, additions: number, deletions: number): ChangedFile => ({
  path,
  additions,
  deletions,
});

const LANDED_AT = { remoteBranch: "mend/fix-login", sha: PUSHED };

interface Scene {
  readonly project?: Project;
  /** Files that differ from each base the removal compares against. */
  readonly changedSince: Readonly<Record<string, ReadonlyArray<ChangedFile>>>;
  readonly landings: ReadonlyArray<ChangeLanding>;
  readonly probe?:
    | { readonly remoteSha: Sha | null; readonly holds: boolean }
    | { readonly fails: string };
}

const refusalFor = (scene: Scene) => {
  const probes: Array<{ readonly sha: string; readonly remoteBranch: string }> = [];
  const layer = Layer.mergeAll(
    Layer.mock(WorktreeReads, {
      changedFiles: (_projectId, _worktreeId, base) =>
        Effect.succeed({
          value: scene.changedSince[base] ?? [],
          stamp: {
            source: "worktree",
            captureN: null,
            captureId: null,
            seq: null,
            kind: null,
            partial: false,
            observedAt: null,
          },
        }),
    }),
    Layer.mock(ChangeLandingsRepo, { listForChange: () => Effect.succeed(scene.landings) }),
    Layer.mock(LandingGit, {
      probe: (_place, input) =>
        Effect.suspend(() => {
          probes.push({ sha: input.sha, remoteBranch: input.remoteBranch });
          const probe = scene.probe ?? { remoteSha: input.sha, holds: true };
          return "fails" in probe
            ? Effect.fail(new LandingStepError({ step: "probe", message: probe.fails }))
            : Effect.succeed({
                remoteBranch: input.remoteBranch,
                remoteSha: probe.remoteSha,
                unseen: 0,
                ahead: probe.holds ? 0 : 1,
                holds: probe.holds,
              });
        }),
    }),
    Layer.succeed(
      SourcePolicy,
      makeSourcePolicy({
        profile: "operator",
        allowedHosts: [],
        resolve: async () => ["140.82.112.3"],
      }),
    ),
    Layer.mock(ProjectAccess, { isOperator: () => Effect.succeed(false) }),
    // Signer services are captured here; transport adapters resolve them in their actual operation.
    Layer.mock(MendKeys, {
      ensure: () =>
        Effect.succeed({
          publicKey: "ssh-ed25519 AAAA ada@example.com",
          fingerprint: "256 SHA256:x ada@example.com (ED25519)",
          privateKeyPath: "/keys/users/ada/id_ed25519",
        }),
    }),
    Layer.mock(AgentBridge, { socketPath: () => "/unused/agent.sock" }),
  );
  return Effect.runPromise(
    changeStandingOf({ change, project: scene.project ?? project, worktree, userId: "ada" }).pipe(
      Effect.map((standing) => ({ standing, probes })),
      Effect.provide(layer),
    ),
  );
};

describe("changeStandingOf", () => {
  it("lets a worktree with nothing past its base go, without asking origin", async () => {
    const { standing, probes } = await refusalFor({ changedSince: {}, landings: [] });
    expect(standing).toEqual({ _tag: "at-base" });
    expect(probes).toEqual([]);
  });

  it("refuses a change that was never landed, naming its files and line counts", async () => {
    const { standing } = await refusalFor({
      changedSince: { [BASE]: [file("src/login.ts", 12, 3), file("notes.md", 1, 0)] },
      landings: [],
    });
    expect(standing).toEqual({
      _tag: "never-landed",
      files: [file("src/login.ts", 12, 3), file("notes.md", 1, 0)],
    });
  });

  it("names work in a project with no origin as on no remote (decision Q3)", async () => {
    const { standing, probes } = await refusalFor({
      project: new Project({ ...project, originUrl: null }),
      changedSince: { [BASE]: [file("src/login.ts", 12, 3)] },
      landings: [],
    });
    expect(standing).toEqual({ _tag: "no-remote", files: [file("src/login.ts", 12, 3)] });
    expect(probes).toEqual([]);
  });

  it("refuses what changed since the last landing, counted from the landed checkpoint", async () => {
    const { standing, probes } = await refusalFor({
      changedSince: { [BASE]: [file("src/login.ts", 12, 3)], [CHECKPOINT]: [file("a.ts", 2, 1)] },
      landings: [landed],
    });
    expect(standing).toEqual({
      _tag: "changed-since-landing",
      landed: LANDED_AT,
      files: [file("a.ts", 2, 1)],
    });
    expect(probes).toEqual([]);
  });

  it("lets a landed change go when origin's branch still holds the landed commit", async () => {
    const { standing, probes } = await refusalFor({
      changedSince: { [BASE]: [file("src/login.ts", 12, 3)] },
      landings: [landed],
    });
    expect(standing).toEqual({ _tag: "on-origin", landed: LANDED_AT, via: "branch" });
    expect(probes).toEqual([{ sha: PUSHED, remoteBranch: "mend/fix-login" }]);
  });

  it("refuses when origin's branch no longer holds the landed commit", async () => {
    const gone = await refusalFor({
      changedSince: { [BASE]: [file("src/login.ts", 12, 3)] },
      landings: [landed],
      probe: { remoteSha: null, holds: false },
    });
    expect(gone.standing).toEqual({ _tag: "origin-moved", landed: LANDED_AT, remoteSha: null });
    const rewritten = await refusalFor({
      changedSince: { [BASE]: [file("src/login.ts", 12, 3)] },
      landings: [landed],
      probe: { remoteSha: Sha.make("9999999000000000000000000000000000000000"), holds: false },
    });
    expect(rewritten.standing).toEqual({
      _tag: "origin-moved",
      landed: LANDED_AT,
      remoteSha: "9999999000000000000000000000000000000000",
    });
  });

  it("lets a change go whose pull request was last reported merged, though its branch is gone", async () => {
    const merged = new ChangeLanding({
      ...landed,
      outcome: "pull-request",
      pullRequest: {
        number: 412,
        url: "https://github.com/acme/api/pull/412",
        state: "merged",
        title: null,
        observedAt: NOW,
      },
    });
    const { standing, probes } = await refusalFor({
      changedSince: { [BASE]: [file("src/login.ts", 12, 3)] },
      landings: [merged],
      probe: { remoteSha: null, holds: false },
    });
    expect(standing).toEqual({ _tag: "on-origin", landed: LANDED_AT, via: "merged-pull-request" });
    // A squash merge leaves no ancestry to fetch: the recorded state answers.
    expect(probes).toEqual([]);
    // A later push the merged pull request does not hold is still asked about.
    const later = new ChangeLanding({
      ...landed,
      id: ChangeLandingId.make("l-2"),
      pushedSha: Sha.make("4444444000000000000000000000000000000000"),
    });
    const afterMerge = await refusalFor({
      changedSince: { [BASE]: [file("src/login.ts", 12, 3)] },
      landings: [later, merged],
      probe: { remoteSha: null, holds: false },
    });
    expect(afterMerge.standing).toMatchObject({ _tag: "origin-moved", remoteSha: null });
  });

  it("refuses in the remote's words when origin cannot be checked", async () => {
    const { standing } = await refusalFor({
      changedSince: { [BASE]: [file("src/login.ts", 12, 3)] },
      landings: [landed],
      probe: { fails: "Permission denied (publickey)." },
    });
    expect(standing).toEqual({
      _tag: "origin-unchecked",
      landed: LANDED_AT,
      reason: "Permission denied (publickey).",
    });
  });

  it("skips a landing that pushed nothing", async () => {
    const refused = new ChangeLanding({
      ...landed,
      pushedSha: null,
      commitSha: null,
      outcome: "refused",
      message: "[rejected] (fetch first)",
    });
    const { standing } = await refusalFor({
      changedSince: { [BASE]: [file("src/login.ts", 12, 3)] },
      landings: [refused],
    });
    expect(standing).toMatchObject({ _tag: "never-landed" });
  });
});
