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
import { AgentBridge, type ChangedFile, MendKeys, SourcePolicy } from "@mend/store";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { makeProject } from "../test/support/tenancy-harness.ts";
import { ProjectAccess } from "./access.ts";
import { describeUnlanded, unlandedWork } from "./landing-state.ts";

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

interface Scene {
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
    Layer.mock(SourcePolicy, {
      profile: "operator",
      check: () => Effect.succeed({ scheme: "ssh", host: "github.com", port: null, addresses: [] }),
      pinnedEnv: (_clearance, env) => ({ ...env }),
    }),
    Layer.mock(ProjectAccess, { isOperator: () => Effect.succeed(false) }),
    Layer.mock(MendKeys, {}),
    Layer.mock(AgentBridge, { socketPath: () => "/unused/agent.sock" }),
  );
  return Effect.runPromise(
    unlandedWork({ change, project, worktree, userId: "ada" }).pipe(
      Effect.map((refusal) => ({ refusal, probes })),
      Effect.provide(layer),
    ),
  );
};

describe("unlandedWork", () => {
  it("lets a worktree with nothing past its base go, without asking origin", async () => {
    const { refusal, probes } = await refusalFor({ changedSince: {}, landings: [] });
    expect(refusal).toBeNull();
    expect(probes).toEqual([]);
  });

  it("refuses a change that was never landed, naming its files and line counts", async () => {
    const { refusal } = await refusalFor({
      changedSince: { [BASE]: [file("src/login.ts", 12, 3), file("notes.md", 1, 0)] },
      landings: [],
    });
    expect(refusal).toBe(
      "This worktree holds a change that was never landed · 2 files · +13 −3 · src/login.ts +12 −3, notes.md +1 −0. Land it or discard it before removal, or pass force=true to remove it anyway.",
    );
  });

  it("refuses what changed since the last landing, counted from the landed checkpoint", async () => {
    const { refusal, probes } = await refusalFor({
      changedSince: { [BASE]: [file("src/login.ts", 12, 3)], [CHECKPOINT]: [file("a.ts", 2, 1)] },
      landings: [landed],
    });
    expect(refusal).toBe(
      "This worktree changed since its last landing (mend/fix-login · 3f2a1c0) · 1 file · +2 −1 · a.ts +2 −1. Land it again or discard it before removal, or pass force=true to remove it anyway.",
    );
    expect(probes).toEqual([]);
  });

  it("lets a landed change go when origin's branch still holds the landed commit", async () => {
    const { refusal, probes } = await refusalFor({
      changedSince: { [BASE]: [file("src/login.ts", 12, 3)] },
      landings: [landed],
    });
    expect(refusal).toBeNull();
    expect(probes).toEqual([{ sha: PUSHED, remoteBranch: "mend/fix-login" }]);
  });

  it("refuses when origin's branch no longer holds the landed commit", async () => {
    const gone = await refusalFor({
      changedSince: { [BASE]: [file("src/login.ts", 12, 3)] },
      landings: [landed],
      probe: { remoteSha: null, holds: false },
    });
    expect(gone.refusal).toBe(
      "origin's mend/fix-login no longer holds the landed commit 3f2a1c0 · the branch is gone. Land it again before removal, or pass force=true to remove it anyway.",
    );
    const rewritten = await refusalFor({
      changedSince: { [BASE]: [file("src/login.ts", 12, 3)] },
      landings: [landed],
      probe: { remoteSha: Sha.make("9999999000000000000000000000000000000000"), holds: false },
    });
    expect(rewritten.refusal).toContain("· it is at 9999999.");
  });

  it("refuses in the remote's words when origin cannot be checked", async () => {
    const { refusal } = await refusalFor({
      changedSince: { [BASE]: [file("src/login.ts", 12, 3)] },
      landings: [landed],
      probe: { fails: "Permission denied (publickey)." },
    });
    expect(refusal).toBe(
      "origin could not be checked for the last landing (mend/fix-login · 3f2a1c0) · Permission denied (publickey). Try again, or pass force=true to remove it anyway.",
    );
  });

  it("skips a landing that pushed nothing", async () => {
    const refused = new ChangeLanding({
      ...landed,
      pushedSha: null,
      commitSha: null,
      outcome: "refused",
      message: "[rejected] (fetch first)",
    });
    const { refusal } = await refusalFor({
      changedSince: { [BASE]: [file("src/login.ts", 12, 3)] },
      landings: [refused],
    });
    expect(refusal).toContain("never landed");
  });
});

describe("describeUnlanded", () => {
  it("names five files and counts the rest", () => {
    const files = Array.from({ length: 7 }, (_, index) => file(`f${index}.ts`, index, 1));
    expect(describeUnlanded(files)).toBe(
      "7 files · +21 −7 · f0.ts +0 −1, f1.ts +1 −1, f2.ts +2 −1, f3.ts +3 −1, f4.ts +4 −1, 2 more",
    );
  });
});
