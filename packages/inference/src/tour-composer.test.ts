import { createHash } from "node:crypto";

import { ChangeToursRepo, ProjectsRepo, SessionsRepo, WorktreeChangesRepo } from "@mend/db";
import {
  ChangeId,
  OrganizationId,
  ProjectId,
  SealantRunId,
  SessionId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { Change, ChangeTour, Project, Session } from "@mend/domain/workbench";
import { SealantClient } from "@mend/sealant";
import { WORKTREE_STAMP, WorktreeReads } from "@mend/sessions";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { InferenceError, InferenceProvider } from "./provider.ts";
import { ComposeTourJob, TourComposer } from "./tour-composer.ts";

const NOW = new Date("2026-09-25T10:00:00.000Z");
const CHANGE = ChangeId.make("change-1");
const PROJECT = ProjectId.make("project-1");
const WORKTREE = WorktreeId.make("wt-1");
const SESSION = SessionId.make("session-1");
const DIFF = "diff --git a/src/login.ts b/src/login.ts\n+retry once\n";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

const change = new Change({
  id: CHANGE,
  projectId: PROJECT,
  worktreeId: WORKTREE,
  sessionId: SESSION,
  branch: "mend/fix-login",
  baseSha: Sha.make("a".repeat(40)),
  headSha: Sha.make("b".repeat(40)),
  createdAt: NOW,
  updatedAt: NOW,
});

const project = new Project({
  id: PROJECT,
  name: "web",
  organizationId: OrganizationId.make("org-1"),
  visibility: "shared",
  createdByUserId: null,
  originUrl: null,
  storePath: "/store/web/repo.git",
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
  defaultShellProfile: true,
  inheritUserSkills: true,
  hotSessions: 0,
  installCommand: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const session = new Session({
  id: SESSION,
  projectId: PROJECT,
  worktreeId: WORKTREE,
  harness: "claude",
  providerSessionId: null,
  label: null,
  worktree: "fix-login",
  branch: "mend/fix-login",
  baseSha: Sha.make("a".repeat(40)),
  baseRef: "main",
  contextSnapshotId: null,
  referenceMounts: [],
  extraMounts: [],
  sealantRunId: SealantRunId.make("run-1"),
  sealantWorkspaceId: null,
  sealantSessionId: null,
  workspaceExpiresAt: null,
  workspaceTtlRenewedAt: null,
  workspaceTtlRenewalFailedAt: null,
  workspaceTtlRenewalError: null,
  workspaceImage: null,
  dotfiles: null,
  ownerUserId: "alice",
  hasTranscript: true,
  status: "completed",
  summary: null,
  lastSeenSequence: 10n,
  recordHistoryComplete: true,
  startedAt: NOW,
  settledAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
});

/** Compose once over a change whose current tour was composed from `tourDiff` (null: none). */
const composeOver = (tourDiff: string | null) => {
  const asked: Array<string> = [];
  const layer = TourComposer.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(InferenceProvider, {
          respond: (request) =>
            Effect.suspend(() => {
              asked.push(request.context);
              return Effect.fail(new InferenceError({ message: "no account", cause: null }));
            }),
        }),
        Layer.mock(WorktreeChangesRepo, { byId: () => Effect.succeed(change) }),
        Layer.mock(SessionsRepo, { byId: () => Effect.succeed(session) }),
        Layer.mock(ProjectsRepo, { byId: () => Effect.succeed(project) }),
        Layer.mock(ChangeToursRepo, {
          byChange: () =>
            Effect.succeed(
              tourDiff === null
                ? null
                : new ChangeTour({
                    id: "tour-1",
                    changeId: CHANGE,
                    sessionId: SESSION,
                    summary: "Retries the login once.",
                    approach: null,
                    stops: [],
                    diffDigest: digest(tourDiff),
                    createdAt: NOW,
                  }),
            ),
          upsert: (tour) => Effect.die(`not upserted in this test: ${tour.diffDigest}`),
        }),
        Layer.mock(WorktreeReads, {
          diffWorktree: () => Effect.succeed({ value: DIFF, stamp: WORKTREE_STAMP }),
        }),
        Layer.mock(SealantClient, {}),
      ),
    ),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const composer = yield* TourComposer;
      return yield* composer.compose(new ComposeTourJob({ changeId: CHANGE })).pipe(Effect.result);
    }).pipe(Effect.provide(layer)),
  ).then((result) => ({ result, asked }));
};

describe("TourComposer", () => {
  it("spends nothing when the diff is the one the current tour was composed from", async () => {
    // No inference asked for, no tour written (the fake dies on either).
    const { result, asked } = await composeOver(DIFF);
    expect(result._tag === "Success" ? result.success : null).toBe("unchanged");
    expect(asked).toEqual([]);
  });

  it("composes when the diff moved since the tour, or there is none", async () => {
    for (const tourDiff of ["diff --git a/src/old.ts b/src/old.ts\n", null]) {
      const { result, asked } = await composeOver(tourDiff);
      expect(asked).toEqual(["change-tour"]);
      expect(result._tag).toBe("Failure");
    }
  });
});
