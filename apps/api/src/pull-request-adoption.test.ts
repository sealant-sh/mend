import { AuditEventsRepo, type NewAuditEvent, ProjectsRepo, WorktreeChangesRepo } from "@mend/db";
import {
  ChangeId,
  ChangeLandingId,
  OrganizationId,
  ProjectId,
  SessionId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { Change, ChangeLanding, Project } from "@mend/domain/workbench";
import { type JobSpec, JobRunner } from "@mend/jobs";
import { type AdoptInput, type Adoption, Landing } from "@mend/landing";
import { WorkspaceGitHooks, WorkspaceGitHooksLive } from "@mend/sessions";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ADOPT_PULL_REQUEST_JOB, PullRequestAdoptionLive } from "./pull-request-adoption.ts";

const NOW = new Date("2026-09-25T10:00:00.000Z");
const WORKTREE = WorktreeId.make("wt-1");
const CHANGE = ChangeId.make("change-1");
const PROJECT = ProjectId.make("project-1");
const event = { sessionId: SessionId.make("session-1"), worktreeId: WORKTREE };

const adoptedLanding = new ChangeLanding({
  id: ChangeLandingId.make("landing-adopted"),
  changeId: CHANGE,
  sessionId: event.sessionId,
  projectId: PROJECT,
  checkpointId: null,
  checkpointRef: null,
  checkpointSha: null,
  commitSha: null,
  remoteBranch: "chore/bump-deps",
  pushedSha: null,
  trigger: "adopted",
  pullRequest: {
    number: 368,
    url: "https://github.com/acme/api/pull/368",
    state: "open",
    observedAt: NOW,
  },
  outcome: "adopted",
  message: null,
  userId: "alice",
  createdAt: NOW,
});

const world = (adoption: Adoption) => {
  const enqueued: Array<JobSpec> = [];
  const adopts: Array<AdoptInput> = [];
  const audited: Array<NewAuditEvent> = [];
  const workers = new Map<string, (payload: unknown) => Effect.Effect<void>>();
  const dependencies = Layer.mergeAll(
    WorkspaceGitHooksLive,
    Layer.succeed(JobRunner, {
      enqueue: (job) => Effect.sync(() => (enqueued.push(job), "job-1")),
      work: (name, handler) => Effect.sync(() => void workers.set(name, handler)),
    }),
    Layer.mock(Landing, {
      adoptPullRequest: (input) => Effect.sync(() => (adopts.push(input), adoption)),
    }),
    Layer.mock(WorktreeChangesRepo, {
      byWorktree: () =>
        Effect.succeed(
          new Change({
            id: CHANGE,
            projectId: PROJECT,
            worktreeId: WORKTREE,
            sessionId: event.sessionId,
            branch: "mend/update-deps",
            baseSha: Sha.make("a".repeat(40)),
            headSha: null,
            createdAt: NOW,
            updatedAt: NOW,
          }),
        ),
    }),
    Layer.mock(ProjectsRepo, {
      byId: () =>
        Effect.succeed(
          new Project({
            id: PROJECT,
            name: "api",
            organizationId: OrganizationId.make("org-1"),
            visibility: "shared",
            createdByUserId: null,
            originUrl: "git@github.com:acme/api.git",
            storePath: "/store/api/repo.git",
            defaultBranch: "main",
            adoptedSha: Sha.make("a".repeat(40)),
            autoTour: "inherit",
            autoSuggest: "inherit",
            autoName: "inherit",
            autoLand: "inherit",
            backgroundSessions: "inherit",
            gitAuthMode: "ambient",
            workspaceImage: null,
            applyDotfiles: true,
            inheritUserSkills: true,
            hotSessions: 0,
            installCommand: null,
            createdAt: NOW,
            updatedAt: NOW,
          }),
        ),
    }),
    Layer.mock(AuditEventsRepo, {
      record: (entry) => Effect.sync(() => void audited.push(entry)),
    }),
  );
  const run = <A>(effect: Effect.Effect<A, never, WorkspaceGitHooks>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* effect;
      }).pipe(
        Effect.provide(PullRequestAdoptionLive.pipe(Layer.provideMerge(dependencies))),
        Effect.scoped,
      ),
    );
  return { enqueued, adopts, audited, workers, run };
};

describe("PullRequestAdoptionLive", () => {
  it("queues a look 45 s after a push that moved a branch, one per change while it waits", async () => {
    const w = world({ _tag: "none" });
    await w.run(
      Effect.gen(function* () {
        yield* (yield* WorkspaceGitHooks).branchesPushed(event);
      }),
    );
    expect(w.enqueued).toEqual([
      {
        name: ADOPT_PULL_REQUEST_JOB,
        payload: { changeId: CHANGE },
        idempotencyKey: `${ADOPT_PULL_REQUEST_JOB}:${CHANGE}`,
        startAfterSeconds: 45,
        retryLimit: 0,
      },
    ]);
    expect(w.adopts).toEqual([]);
    // The job itself looks in the background.
    await w.run(w.workers.get(ADOPT_PULL_REQUEST_JOB)?.({ changeId: CHANGE }) ?? Effect.void);
    expect(w.adopts).toEqual([{ changeId: CHANGE, background: true }]);
  });

  it("looks at once when an agent ends, and audits what it adopted", async () => {
    const w = world({ _tag: "adopted", landing: adoptedLanding });
    await w.run(
      Effect.gen(function* () {
        yield* (yield* WorkspaceGitHooks).agentEnded(event);
      }),
    );
    expect(w.adopts).toEqual([{ changeId: CHANGE, background: true }]);
    expect(w.audited).toEqual([
      expect.objectContaining({
        action: "change.pull_request_adopted",
        actorUserId: "alice",
        organizationId: "org-1",
        data: expect.objectContaining({ pullRequest: 368, branch: "chore/bump-deps", fork: null }),
      }),
    ]);
  });
});
