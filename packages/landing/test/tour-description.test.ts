import { describe, expect, it } from "@effect/vitest";
import { CheckpointsRepo } from "@mend/db";
import { ChangeLandingId, CheckpointId, Sha } from "@mend/domain";
import { ChangeLanding, type LandedPullRequest } from "@mend/domain/workbench";
import { Effect, Layer } from "effect";

import { DESCRIPTION_START } from "../src/description.ts";
import { LandingGit } from "../src/landing.ts";
import { type PublishInput, PullRequests, PullRequestStepError } from "../src/pull-requests.ts";
import { LandingDescriptions, LandingDescriptionsLive } from "../src/tour-description.ts";
import { checkpointOf, makeWorld, NOW, OWNER, type WorldOptions } from "./world.ts";

/**
 * The pull request gains the tour when the tour completes (docs/adr/0007-landing.md, "What the
 * thread sees"): once per tour, only for an open pull request Mend opened before the tour
 * existed, through the same pull request step as the change's owner.
 */

const PUSHED = Sha.make("3f2a1c0000000000000000000000000000000000");
const CHECKPOINT_SHA = "cccccccccccccccccccccccccccccccccccccccc";
const EARLIER = new Date(NOW.getTime() - 3_600_000);

const pullRequest = (state: LandedPullRequest["state"]): LandedPullRequest => ({
  number: 412,
  url: "https://github.com/acme/api/pull/412",
  state,
  observedAt: EARLIER,
});

const harness = (
  options: WorldOptions = { tour: { summary: "Fix the login redirect", approach: null } },
  publishFails: PullRequestStepError | null = null,
) => {
  const world = makeWorld(options);
  const published: Array<PublishInput> = [];
  const landed = (overrides: Partial<ChangeLanding> = {}) =>
    new ChangeLanding({
      id: ChangeLandingId.make("landing-1"),
      changeId: world.change.id,
      sessionId: world.session.id,
      projectId: world.project.id,
      checkpointId: CheckpointId.make("cp-3"),
      checkpointRef: `refs/mend/checkpoints/${world.worktree.id}/3`,
      checkpointSha: Sha.make(CHECKPOINT_SHA),
      commitSha: PUSHED,
      remoteBranch: "mend/fix-login",
      pushedSha: PUSHED,
      trigger: "automatic",
      pullRequest: pullRequest("open"),
      outcome: "pull-request",
      message: null,
      userId: OWNER,
      // Opened before the tour existed: its description has the file list and no summary.
      createdAt: EARLIER,
      ...overrides,
    });
  const layer = LandingDescriptionsLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        world.repos,
        Layer.mock(CheckpointsRepo, {
          byId: () => Effect.succeed(checkpointOf(world, 3, CHECKPOINT_SHA, "turn-boundary")),
        }),
        Layer.mock(LandingGit, {
          changedFiles: () =>
            Effect.succeed([
              {
                oldPath: "src/login.ts",
                newPath: "src/login.ts",
                status: "modified" as const,
                additions: 12,
                deletions: 3,
                binary: false,
              },
            ]),
        }),
        Layer.mock(PullRequests, {
          publish: (input) =>
            Effect.suspend(() => {
              published.push(input);
              return publishFails === null
                ? Effect.succeed({
                    action: "updated" as const,
                    pullRequest: { ...pullRequest("open"), observedAt: NOW },
                    workspace: "short-lived" as const,
                  })
                : Effect.fail(publishFails);
            }),
        }),
      ),
    ),
  );
  return { world, published, landed, layer };
};

describe("LandingDescriptions.afterTour", () => {
  it.effect("writes the completed tour into the open pull request Mend opened, once", () => {
    const h = harness();
    h.world.landings.unshift(h.landed());
    return Effect.gen(function* () {
      const descriptions = yield* LandingDescriptions;
      const first = yield* descriptions.afterTour({
        changeId: h.world.change.id,
        webOrigin: "https://mend.test",
      });
      expect(first).toEqual({ _tag: "updated", number: 412 });
      const [publish] = h.published;
      expect(publish).toMatchObject({
        target: { ownerUserId: OWNER, sessionId: h.world.session.id },
        head: "mend/fix-login",
        base: "main",
        titleGiven: false,
        body: null,
        previous: 412,
      });
      expect(publish?.section.startsWith(DESCRIPTION_START)).toBe(true);
      expect(publish?.section).toContain("## Summary\n\nFix the login redirect");
      expect(publish?.section).toContain("- `src/login.ts` · +12 −3");
      expect(publish?.section).toContain("#checkpoint-3");
      // What gh said is recorded.
      expect(h.world.landings[0]?.pullRequest?.observedAt).toEqual(NOW);

      // The same tour finishing again, or another worker, updates nothing.
      const again = yield* descriptions.afterTour({
        changeId: h.world.change.id,
        webOrigin: "https://mend.test",
      });
      expect(again).toEqual({ _tag: "unchanged" });
      expect(h.published).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("leaves a pull request described after the tour existed alone", () => {
    const h = harness();
    h.world.landings.unshift(h.landed({ createdAt: new Date(NOW.getTime() + 60_000) }));
    return Effect.gen(function* () {
      const result = yield* (yield* LandingDescriptions).afterTour({
        changeId: h.world.change.id,
        webOrigin: null,
      });
      expect(result).toEqual({ _tag: "unchanged" });
      expect(h.published).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("leaves a pull request GitHub last reported closed or merged alone", () => {
    const h = harness();
    h.world.landings.unshift(h.landed({ pullRequest: pullRequest("merged") }));
    return Effect.gen(function* () {
      const result = yield* (yield* LandingDescriptions).afterTour({
        changeId: h.world.change.id,
        webOrigin: null,
      });
      expect(result).toEqual({ _tag: "unchanged" });
      expect(h.published).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("does nothing without a tour or without a pull request from Mend", () => {
    const withoutTour = harness({ tour: null });
    withoutTour.world.landings.unshift(withoutTour.landed());
    const withoutPullRequest = harness();
    withoutPullRequest.world.landings.unshift(
      withoutPullRequest.landed({ pullRequest: null, outcome: "pushed" }),
    );
    return Effect.gen(function* () {
      for (const h of [withoutTour, withoutPullRequest]) {
        const result = yield* Effect.gen(function* () {
          return yield* (yield* LandingDescriptions).afterTour({
            changeId: h.world.change.id,
            webOrigin: null,
          });
        }).pipe(Effect.provide(h.layer));
        expect(result).toEqual({ _tag: "unchanged" });
        expect(h.published).toEqual([]);
      }
    });
  });

  it.effect("fails in gh's words and does not try the same tour again", () => {
    const h = harness(undefined, new PullRequestStepError({ message: "gh pr edit · HTTP 502" }));
    h.world.landings.unshift(h.landed());
    return Effect.gen(function* () {
      const descriptions = yield* LandingDescriptions;
      const error = yield* descriptions
        .afterTour({ changeId: h.world.change.id, webOrigin: null })
        .pipe(Effect.flip);
      expect(error.message).toBe("gh pr edit · HTTP 502");
      const again = yield* descriptions.afterTour({ changeId: h.world.change.id, webOrigin: null });
      expect(again).toEqual({ _tag: "unchanged" });
      expect(h.published).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  });
});
