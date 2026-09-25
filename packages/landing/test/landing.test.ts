import { describe, expect, it } from "@effect/vitest";
import { UserFacts } from "@mend/db";
import { SessionId, Sha } from "@mend/domain";
import type { CheckpointTrigger, LandedPullRequest } from "@mend/domain/workbench";
import { BundleTooLargeError, PushRefusedError } from "@mend/store";
import { Effect, Layer } from "effect";

import { DESCRIPTION_START } from "../src/description.ts";
import {
  type LandInput,
  Landing,
  LandingGit,
  LandingLive,
  LandingNotStartedError,
  LandingStepError,
} from "../src/landing.ts";
import { type PublishInput, PullRequests, PullRequestStepError } from "../src/pull-requests.ts";
import { BASE_SHA, checkpointOf, makeWorld, OWNER, type WorldOptions } from "./world.ts";

const CHECKPOINT_SHA = "cccccccccccccccccccccccccccccccccccccccc";
const HEAD_SHA = Sha.make("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const MEND_COMMIT = Sha.make("dddddddddddddddddddddddddddddddddddddddd");
const LATEST_CHECKPOINT_SHA = "2222222222222222222222222222222222222222";
const BOB_SESSION = "33333333-3333-3333-3333-333333333333";
const EARLIER = new Date("2026-09-24T09:00:00Z");
const LATER = new Date("2026-09-24T11:00:00Z");

const input = (overrides: Partial<LandInput> = {}): LandInput => ({
  sessionId: makeWorld().session.id,
  actorUserId: OWNER,
  trigger: "manual",
  remoteBranch: null,
  pullRequest: true,
  title: null,
  body: null,
  webOrigin: "https://mend.test",
  remoteEnv: Effect.succeed({ GIT_SSH_COMMAND: "ssh" }),
  ...overrides,
});

interface Script {
  readonly checkpointFails?: string;
  readonly commitFails?: string;
  /** Mend wrote no commit: the agent's own commits hold the checkpoint's tree. */
  readonly nothingToCommit?: boolean;
  /** Once a landing pushed, the next finds nothing new since it. */
  readonly nothingNew?: boolean;
  readonly push?: "ok" | PushRefusedError | LandingStepError;
  readonly publish?: "opened" | "updated" | PullRequestStepError;
  readonly observed?: LandedPullRequest;
  readonly bundle?: "ok" | BundleTooLargeError;
  /** The worktree has no checkpoint yet. */
  readonly noCheckpoint?: boolean;
}

const PR: LandedPullRequest = {
  number: 412,
  url: "https://github.com/acme/api/pull/412",
  state: "open",
  observedAt: new Date("2026-09-24T10:05:00Z"),
};

/** A world with scripted git and pull request steps, and a log of what each step was asked. */
const harness = (script: Script = {}, options: WorldOptions = {}) => {
  const world = makeWorld(options);
  const calls: Array<string> = [];
  const triggers: Array<CheckpointTrigger> = [];
  const commits: Array<{
    readonly author: unknown;
    readonly message: string;
    readonly lastLanded: string | null;
    readonly keep: boolean;
  }> = [];
  const observed: Array<PublishInput["target"]> = [];
  const pushes: Array<{
    readonly sha: string;
    readonly remoteBranch: string;
    readonly env: unknown;
  }> = [];
  const published: Array<PublishInput> = [];
  const bundles: Array<{ readonly base: string; readonly tip: string; readonly branch: string }> =
    [];
  const git = Layer.succeed(LandingGit, {
    checkpoint: (_scope, trigger) =>
      Effect.suspend(() => {
        calls.push("checkpoint");
        triggers.push(trigger);
        return script.checkpointFails === undefined
          ? Effect.succeed({
              checkpoint: checkpointOf(world, 3, CHECKPOINT_SHA, trigger),
              agentHead: HEAD_SHA,
            })
          : Effect.fail(
              new LandingStepError({ step: "checkpoint", message: script.checkpointFails }),
            );
      }),
    latest: () =>
      Effect.suspend(() => {
        calls.push("latest");
        if (script.checkpointFails !== undefined) {
          return Effect.fail(
            new LandingStepError({ step: "checkpoint", message: script.checkpointFails }),
          );
        }
        return Effect.succeed({
          checkpoint:
            script.noCheckpoint === true
              ? null
              : checkpointOf(world, 2, LATEST_CHECKPOINT_SHA, "turn-boundary"),
          agentHead: HEAD_SHA,
        });
      }),
    commit: (_scope, commit) =>
      Effect.suspend(() => {
        calls.push("commit");
        commits.push({
          author: commit.author,
          message: commit.message,
          lastLanded: commit.lastLanded,
          keep: commit.keep,
        });
        if (script.commitFails !== undefined) {
          return Effect.fail(new LandingStepError({ step: "commit", message: script.commitFails }));
        }
        const committed: {
          readonly head: Sha;
          readonly commitSha: Sha | null;
          readonly nothingNew: boolean;
        } =
          script.nothingNew === true && commit.lastLanded !== null
            ? { head: commit.lastLanded, commitSha: null, nothingNew: true }
            : script.nothingToCommit === true
              ? { head: commit.agentHead, commitSha: null, nothingNew: false }
              : { head: MEND_COMMIT, commitSha: MEND_COMMIT, nothingNew: false };
        return Effect.succeed(committed);
      }),
    push: (_scope, push) =>
      Effect.suspend(() => {
        calls.push("push");
        pushes.push({ sha: push.sha, remoteBranch: push.remoteBranch, env: push.remoteEnv });
        const outcome = script.push ?? "ok";
        return outcome === "ok"
          ? Effect.succeed({
              remoteBranch: push.remoteBranch,
              pushedSha: push.sha,
              created: true,
              upToDate: false,
            })
          : Effect.fail(outcome);
      }),
    probe: (_place, probe) =>
      Effect.sync(() => {
        calls.push("probe");
        return {
          remoteBranch: probe.remoteBranch,
          remoteSha: probe.sha,
          unseen: 0,
          ahead: 0,
          holds: true,
        };
      }),
    bundle: (_scope, bundle) =>
      Effect.suspend(() => {
        calls.push("bundle");
        bundles.push({ base: bundle.base, tip: bundle.tip, branch: bundle.branch });
        const outcome = script.bundle ?? "ok";
        return outcome === "ok"
          ? Effect.succeed({
              branch: bundle.branch,
              base: bundle.base,
              tip: bundle.tip,
              commits: 1,
              bytes: new Uint8Array([1, 2, 3]),
            })
          : Effect.fail(outcome);
      }),
    changedFiles: () =>
      Effect.sync(() => {
        calls.push("files");
        return [
          {
            oldPath: "src/login.ts",
            newPath: "src/login.ts",
            status: "modified" as const,
            additions: 12,
            deletions: 3,
            binary: false,
          },
        ];
      }),
  });
  const pullRequests = Layer.succeed(PullRequests, {
    publish: (publish) =>
      Effect.suspend(() => {
        calls.push("publish");
        published.push(publish);
        const outcome = script.publish ?? "opened";
        return typeof outcome === "string"
          ? Effect.succeed({ action: outcome, pullRequest: PR, workspace: "short-lived" as const })
          : Effect.fail(outcome);
      }),
    observe: (observe) =>
      Effect.sync(() => {
        observed.push(observe.target);
        return script.observed ?? PR;
      }),
  });
  const layer = LandingLive.pipe(Layer.provide(Layer.mergeAll(world.repos, git, pullRequests)));
  return { world, calls, triggers, commits, pushes, published, observed, bundles, layer };
};

describe("Landing.land", () => {
  it.effect("checkpoints, commits, pushes and opens the pull request, and records it", () => {
    const h = harness(
      {},
      { tour: { summary: "Fix the login redirect", approach: "Read the expiry first." } },
    );
    return Effect.gen(function* () {
      const report = yield* (yield* Landing).land(input());
      expect(h.calls).toEqual(["checkpoint", "commit", "push", "files", "publish"]);
      expect(report.pullRequest).toEqual({ _tag: "opened", pullRequest: PR });
      expect(report.landing).toMatchObject({
        outcome: "pull-request",
        checkpointId: "cp-3",
        checkpointSha: CHECKPOINT_SHA,
        commitSha: MEND_COMMIT,
        remoteBranch: "mend/fix-login",
        pushedSha: MEND_COMMIT,
        trigger: "manual",
        userId: OWNER,
        message: null,
        pullRequest: PR,
      });
      expect(h.world.landings).toHaveLength(1);

      // The owner's button checkpoints as a user mark.
      expect(h.triggers).toEqual(["user-mark"]);
      // Mend's commit is the owner's, with the tour's summary and the session trailer.
      expect(h.commits).toEqual([
        {
          author: { name: "Ada Owner", email: "ada@example.com" },
          message: `Fix the login redirect\n\nMend-Session: https://mend.test/sessions/${h.world.session.id}\n`,
          lastLanded: null,
          keep: true,
        },
      ]);
      // The push is Mend's commit, with the env the caller resolved.
      expect(h.pushes).toEqual([
        { sha: MEND_COMMIT, remoteBranch: "mend/fix-login", env: { GIT_SSH_COMMAND: "ssh" } },
      ]);
      const [publish] = h.published;
      expect(publish).toMatchObject({
        target: { ownerUserId: OWNER, sessionId: h.world.session.id },
        repository: { slug: "acme/api" },
        head: "mend/fix-login",
        base: "main",
        title: "login loop",
        titleGiven: false,
        previous: null,
      });
      expect(publish?.section.startsWith(DESCRIPTION_START)).toBe(true);
      expect(publish?.section).toContain("## Summary\n\nFix the login redirect");
      expect(publish?.section).toContain("- `src/login.ts` · +12 −3");
      expect(publish?.section).toContain(`/changes/${h.world.change.id}`);
      expect(publish?.section).toContain(`#checkpoint-3`);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("checkpoints a completed turn at its turn boundary", () => {
    const h = harness();
    return Effect.gen(function* () {
      const report = yield* (yield* Landing).land(input({ trigger: "automatic" }));
      expect(h.triggers).toEqual(["turn-boundary"]);
      expect(report.landing.trigger).toBe("automatic");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("records no commit when the agent's commits already hold the checkpoint", () => {
    const h = harness({ nothingToCommit: true });
    return Effect.gen(function* () {
      const report = yield* (yield* Landing).land(input());
      expect(report.landing.commitSha).toBeNull();
      expect(report.landing.pushedSha).toBe(HEAD_SHA);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("updates the pull request an earlier landing opened, on the same branch", () => {
    const h = harness({ publish: "updated" });
    return Effect.gen(function* () {
      const landing = yield* Landing;
      yield* landing.land(input({ remoteBranch: "fix/login" }));
      const second = yield* landing.land(input({ trigger: "automatic", title: "Fix login" }));
      expect(second.pullRequest._tag).toBe("updated");
      expect(h.pushes.map((push) => push.remoteBranch)).toEqual(["fix/login", "fix/login"]);
      expect(h.published[1]).toMatchObject({
        head: "fix/login",
        previous: 412,
        title: "Fix login",
        titleGiven: true,
      });
      expect(h.world.landings.map((row) => row.remoteBranch)).toEqual(["fix/login", "fix/login"]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("builds each landing on what the last one pushed", () => {
    const h = harness();
    return Effect.gen(function* () {
      const landing = yield* Landing;
      yield* landing.land(input());
      yield* landing.land(input({ trigger: "automatic" }));
      expect(h.commits.map((commit) => commit.lastLanded)).toEqual([null, MEND_COMMIT]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("neither builds on nor reuses the branch of a landing that pushed nothing", () => {
    const h = harness({
      push: new PushRefusedError({
        remoteBranch: "wip/login",
        reason: "rejected",
        message: "GH006: Protected branch update failed",
        remoteSha: null,
        unseen: null,
      }),
    });
    return Effect.gen(function* () {
      const landing = yield* Landing;
      const refused = yield* landing.land(input({ remoteBranch: "wip/login" }));
      expect(refused.landing.outcome).toBe("refused");
      yield* landing.land(input());
      expect(h.pushes.map((push) => push.remoteBranch)).toEqual(["wip/login", "mend/fix-login"]);
      expect(h.commits.map((commit) => commit.lastLanded)).toEqual([null, null]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("says nothing is new since the last landing, and records nothing", () => {
    const h = harness({ nothingNew: true });
    return Effect.gen(function* () {
      const landing = yield* Landing;
      yield* landing.land(input());
      const error = yield* landing.land(input()).pipe(Effect.flip);
      expect(error.reason).toBe("nothing-new");
      expect(error.message).toBe("landing not started · nothing new since the last landing");
      expect(h.world.landings).toHaveLength(1);
      expect(h.pushes).toHaveLength(1);
      // A new title still reaches the pull request, pushing what already landed.
      const retitled = yield* landing.land(input({ title: "Fix the login loop" }));
      expect(retitled.landing.pushedSha).toBe(MEND_COMMIT);
      expect(h.published[1]).toMatchObject({ title: "Fix the login loop", titleGiven: true });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("goes on when nothing is new but the last pull request step failed", () => {
    const h = harness({
      nothingNew: true,
      publish: new PullRequestStepError({ message: "gh: HTTP 502" }),
    });
    return Effect.gen(function* () {
      const landing = yield* Landing;
      const first = yield* landing.land(input());
      expect(first.landing.outcome).toBe("failed");
      const again = yield* landing.land(input());
      expect(again.landing.pushedSha).toBe(MEND_COMMIT);
      expect(h.published).toHaveLength(2);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("refuses to push to the default branch or the pull request's base", () => {
    const h = harness({}, { baseRef: "release/2" });
    return Effect.gen(function* () {
      const landing = yield* Landing;
      const main = yield* landing.land(input({ remoteBranch: "main" })).pipe(Effect.flip);
      expect(main.reason).toBe("branch");
      expect(main.message).toBe(
        "landing not started · main is the project's default branch · name another branch",
      );
      const base = yield* landing.land(input({ remoteBranch: "release/2" })).pipe(Effect.flip);
      expect(base.message).toBe(
        "landing not started · release/2 is the pull request's base · name another branch",
      );
      expect(h.calls).toEqual([]);
      expect(h.world.landings).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect(
    "lands only for the change's owner, never for a teammate who joined the worktree",
    () => {
      const h = harness(
        {},
        { siblings: [{ id: BOB_SESSION, ownerUserId: "bob", createdAt: LATER }] },
      );
      return Effect.gen(function* () {
        const landing = yield* Landing;
        // Bob owns a session in Ada's worktree; landing from it is still Ada's alone.
        const error = yield* landing
          .land(input({ sessionId: SessionId.make(BOB_SESSION), actorUserId: "bob" }))
          .pipe(Effect.flip);
        expect(error.reason).toBe("not-owner");
        expect(error.message).toBe("landing not started · only the change's owner lands it");
        expect(h.calls).toEqual([]);
        // Ada lands through Bob's session: her key, her commit, and `gh` never in Bob's workspace.
        const report = yield* landing.land(input({ sessionId: SessionId.make(BOB_SESSION) }));
        expect(report.landing.userId).toBe(OWNER);
        expect(h.commits[0]?.author).toEqual({ name: "Ada Owner", email: "ada@example.com" });
        expect(h.published[0]?.target).toEqual({ ownerUserId: OWNER, sessionId: null });
        yield* landing.refreshPullRequest(report.landing.id);
        expect(h.observed).toEqual([{ ownerUserId: OWNER, sessionId: null }]);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("takes the change's owner from the worktree's first session", () => {
    // Carol started the worktree; Ada's session came later.
    const h = harness(
      {},
      { siblings: [{ id: BOB_SESSION, ownerUserId: "carol", createdAt: EARLIER }] },
    );
    return Effect.gen(function* () {
      const error = yield* (yield* Landing).land(input()).pipe(Effect.flip);
      expect(error.reason).toBe("not-owner");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("lands only for the owner, and records nothing otherwise", () => {
    const h = harness();
    return Effect.gen(function* () {
      const error = yield* (yield* Landing).land(input({ actorUserId: "bob" })).pipe(Effect.flip);
      expect(error).toBeInstanceOf(LandingNotStartedError);
      expect(error.reason).toBe("not-owner");
      expect(h.calls).toEqual([]);
      expect(h.world.landings).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("does not start for a change with no owner", () => {
    const h = harness({}, { ownerUserId: null });
    return Effect.gen(function* () {
      const error = yield* (yield* Landing).land(input()).pipe(Effect.flip);
      expect(error.reason).toBe("no-owner");
      expect(h.world.landings).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("stops at a failed checkpoint and records it without one", () => {
    const h = harness({ checkpointFails: "fatal: not a git repository" });
    return Effect.gen(function* () {
      const report = yield* (yield* Landing).land(input());
      expect(h.calls).toEqual(["checkpoint"]);
      expect(report.pullRequest).toEqual({ _tag: "not-reached" });
      expect(report.landing).toMatchObject({
        outcome: "failed",
        checkpointId: null,
        commitSha: null,
        pushedSha: null,
        message: "fatal: not a git repository",
      });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("stops at a failed commit and records the checkpoint it took", () => {
    const h = harness({
      commitFails: "fatal: unable to read tree cccccccccccccccccccccccccccccccccccccccc",
    });
    return Effect.gen(function* () {
      const report = yield* (yield* Landing).land(input());
      expect(h.calls).toEqual(["checkpoint", "commit"]);
      expect(report.landing).toMatchObject({
        outcome: "failed",
        checkpointId: "cp-3",
        commitSha: null,
        pushedSha: null,
        message: "fatal: unable to read tree cccccccccccccccccccccccccccccccccccccccc",
      });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("records a refused push in the remote's words, with what the probe counted", () => {
    const h = harness({
      push: new PushRefusedError({
        remoteBranch: "mend/fix-login",
        reason: "diverged",
        message: "[rejected] (fetch first)",
        remoteSha: "eeeeeee",
        unseen: 2,
      }),
    });
    return Effect.gen(function* () {
      const report = yield* (yield* Landing).land(input());
      expect(h.calls).toEqual(["checkpoint", "commit", "push"]);
      expect(report.landing).toMatchObject({
        outcome: "refused",
        commitSha: MEND_COMMIT,
        pushedSha: null,
        message:
          "origin has moved · mend/fix-login has 2 commits Mend has not seen · [rejected] (fetch first)",
      });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("records branch protection in the remote's words", () => {
    const h = harness({
      push: new PushRefusedError({
        remoteBranch: "mend/fix-login",
        reason: "rejected",
        message:
          "GH006: Protected branch update failed · [remote rejected] (pre-receive hook declined)",
        remoteSha: null,
        unseen: null,
      }),
    });
    return Effect.gen(function* () {
      const report = yield* (yield* Landing).land(input());
      expect(report.landing.message).toBe(
        "GH006: Protected branch update failed · [remote rejected] (pre-receive hook declined)",
      );
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("records a push that could not run as failed, with nothing pushed", () => {
    const h = harness({
      push: new LandingStepError({ step: "push", message: "Permission denied (publickey)." }),
    });
    return Effect.gen(function* () {
      const report = yield* (yield* Landing).land(input());
      expect(report.landing).toMatchObject({
        outcome: "failed",
        pushedSha: null,
        message: "Permission denied (publickey).",
      });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("records credentials that could not be resolved as a failed push", () => {
    const h = harness();
    return Effect.gen(function* () {
      const report = yield* (yield* Landing).land(
        input({
          remoteEnv: Effect.fail(
            new LandingStepError({ step: "push", message: "no signer is connected" }),
          ),
        }),
      );
      expect(h.calls).toEqual(["checkpoint", "commit"]);
      expect(report.landing).toMatchObject({
        outcome: "failed",
        message: "no signer is connected",
      });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("pushes only, with the reason, when origin is not on GitHub", () => {
    const h = harness({}, { originUrl: "https://gitlab.com/acme/api.git" });
    return Effect.gen(function* () {
      const report = yield* (yield* Landing).land(input());
      expect(h.calls).toEqual(["checkpoint", "commit", "push"]);
      expect(report.landing).toMatchObject({ outcome: "pushed", pushedSha: MEND_COMMIT });
      expect(report.pullRequest).toEqual({
        _tag: "unavailable",
        reason: "pull request unavailable · origin is on gitlab.com, not GitHub",
      });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("pushes only when the owner turned the pull request off", () => {
    const h = harness();
    return Effect.gen(function* () {
      const report = yield* (yield* Landing).land(input({ pullRequest: false }));
      expect(h.calls).toEqual(["checkpoint", "commit", "push"]);
      expect(report.landing.outcome).toBe("pushed");
      expect(report.pullRequest).toEqual({ _tag: "off" });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("records a failed pull request step with the sha that was pushed", () => {
    const h = harness({
      publish: new PullRequestStepError({
        message: "no GitHub account connected for the owner · connected account was not found",
      }),
    });
    return Effect.gen(function* () {
      const report = yield* (yield* Landing).land(input());
      expect(report.landing).toMatchObject({
        outcome: "failed",
        pushedSha: MEND_COMMIT,
        pullRequest: null,
        message: "no GitHub account connected for the owner · connected account was not found",
      });
      expect(report.pullRequest).toEqual({
        _tag: "failed",
        message: "no GitHub account connected for the owner · connected account was not found",
      });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("writes the description with no summary and no links when it has neither", () => {
    const h = harness({}, { tour: null });
    return Effect.gen(function* () {
      yield* (yield* Landing).land(input({ webOrigin: null }));
      const section = h.published[0]?.section ?? "";
      expect(section).toContain("No summary");
      expect(section).not.toContain("](");
      expect(h.commits[0]?.message).toBe(`login loop\n\nMend-Session: ${h.world.session.id}\n`);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("opens into the default branch when the session's base was a commit", () => {
    const h = harness({}, { baseRef: BASE_SHA });
    return Effect.gen(function* () {
      yield* (yield* Landing).land(input());
      expect(h.published[0]?.base).toBe("main");
    }).pipe(Effect.provide(h.layer));
  });
});

describe("Landing.refreshPullRequest", () => {
  it.effect("records the state gh reports now", () => {
    const merged = {
      ...PR,
      state: "merged" as const,
      observedAt: new Date("2026-09-24T12:00:00Z"),
    };
    const h = harness({ observed: merged });
    return Effect.gen(function* () {
      const landing = yield* Landing;
      const first = yield* landing.land(input());
      const refreshed = yield* landing.refreshPullRequest(first.landing.id);
      expect(refreshed.pullRequest).toEqual(merged);
      expect(h.world.landings[0]?.pullRequest?.state).toBe("merged");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("leaves a landing without a pull request as it is", () => {
    const h = harness();
    return Effect.gen(function* () {
      const landing = yield* Landing;
      const first = yield* landing.land(input({ pullRequest: false }));
      const refreshed = yield* landing.refreshPullRequest(first.landing.id);
      expect(refreshed).toEqual(first.landing);
    }).pipe(Effect.provide(h.layer));
  });
});

const bundleInput = (actorUserId = "bob") => ({
  sessionId: makeWorld().session.id,
  actorUserId,
  webOrigin: "https://mend.test",
  limitBytes: 1024,
});

describe("Landing.bundle", () => {
  it.effect(
    "takes no checkpoint for someone other than the change's owner, and keeps nothing",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const bundle = yield* (yield* Landing).bundle(bundleInput());
        // The latest checkpoint there is: pulling adds nothing to the owner's record.
        expect(h.calls).toEqual(["latest", "commit", "bundle"]);
        expect(h.triggers).toEqual([]);
        // The commit is the owner's work, whoever asked, and no ref keeps it.
        expect(h.commits).toMatchObject([
          {
            author: { name: "Ada Owner", email: "ada@example.com" },
            lastLanded: null,
            keep: false,
          },
        ]);
        expect(h.bundles).toEqual([{ base: BASE_SHA, tip: MEND_COMMIT, branch: "mend/fix-login" }]);
        expect(bundle.commits).toBe(1);
        expect(h.world.landings).toEqual([]);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("checkpoints first when the change's owner pulls it", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* (yield* Landing).bundle(bundleInput(OWNER));
      expect(h.calls).toEqual(["checkpoint", "commit", "bundle"]);
      expect(h.triggers).toEqual(["user-mark"]);
      expect(h.commits[0]?.keep).toBe(false);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("builds on what the last landing pushed", () => {
    const h = harness();
    return Effect.gen(function* () {
      const landing = yield* Landing;
      yield* landing.land(input());
      yield* landing.bundle(bundleInput());
      expect(h.commits.map((commit) => [commit.lastLanded, commit.keep])).toEqual([
        [null, true],
        [MEND_COMMIT, false],
      ]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("bundles the agent's own head when there was nothing left to commit", () => {
    const h = harness({ nothingToCommit: true });
    return Effect.gen(function* () {
      yield* (yield* Landing).bundle(bundleInput());
      expect(h.bundles[0]?.tip).toBe(HEAD_SHA);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("is by the asker when the change has no owner", () => {
    const h = harness(
      {},
      {
        ownerUserId: null,
        users: [new UserFacts({ id: "bob", name: "Bob", email: "bob@example.com" })],
      },
    );
    return Effect.gen(function* () {
      yield* (yield* Landing).bundle(bundleInput());
      expect(h.commits[0]?.author).toEqual({ name: "Bob", email: "bob@example.com" });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("makes none before the worktree has a checkpoint", () => {
    const h = harness({ noCheckpoint: true });
    return Effect.gen(function* () {
      const error = yield* (yield* Landing).bundle(bundleInput()).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "LandingNotStartedError",
        message: "bundle not made · the worktree has no checkpoint yet",
      });
      expect(h.calls).toEqual(["latest"]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("passes a bundle over the limit through with its size", () => {
    const h = harness({
      bundle: new BundleTooLargeError({ branch: "mend/fix-login", size: 4096, limit: 1024 }),
    });
    return Effect.gen(function* () {
      const error = yield* (yield* Landing).bundle(bundleInput()).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "BundleTooLargeError", size: 4096, limit: 1024 });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("stops at a failed checkpoint in git's words", () => {
    const h = harness({ checkpointFails: "fatal: bad object" });
    return Effect.gen(function* () {
      const error = yield* (yield* Landing).bundle(bundleInput(OWNER)).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "LandingStepError", message: "fatal: bad object" });
      expect(h.calls).toEqual(["checkpoint"]);
    }).pipe(Effect.provide(h.layer));
  });
});
