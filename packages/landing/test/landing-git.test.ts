import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Sha } from "@mend/domain";
import { SessionEngine } from "@mend/sessions";
import { Store, StoreConfig, worktreePathOf } from "@mend/store";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LandingGitColocatedLive } from "../src/landing-git.ts";
import { type LandInput, Landing, LandingLive } from "../src/landing.ts";
import { type PublishInput, PullRequests } from "../src/pull-requests.ts";
import { checkpointOf, makeWorld, OWNER, type World } from "./world.ts";

/**
 * Landing end to end against real repositories: a bare origin, the project's bare store cloned
 * from it, and the session's worktree, with the co-located git half and a recorded pull request
 * step. No network.
 */

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "agent",
  GIT_AUTHOR_EMAIL: "agent@example.com",
  GIT_COMMITTER_NAME: "agent",
  GIT_COMMITTER_EMAIL: "agent@example.com",
};
const sh = (cwd: string, args: ReadonlyArray<string>) =>
  execFileSync("git", [...args], { cwd, env: gitEnv, stdio: ["pipe", "pipe", "pipe"] })
    .toString("utf8")
    .replace(/\n$/, "");

const BRANCH = "mend/fix-login";

interface Repos {
  readonly tmp: string;
  readonly storeRoot: string;
  readonly origin: string;
  readonly storePath: string;
  readonly worktree: string;
  readonly baseSha: string;
}

const makeRepos = async (): Promise<Repos> => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-landing-e2e-"));
  const origin = path.join(tmp, "origin.git");
  sh(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = path.join(tmp, "seed");
  sh(tmp, ["clone", "-q", origin, seed]);
  fs.writeFileSync(path.join(seed, "app.ts"), "export const answer = 41\n");
  sh(seed, ["add", "-A"]);
  sh(seed, ["commit", "-q", "-m", "initial"]);
  sh(seed, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
  const baseSha = sh(seed, ["rev-parse", "HEAD"]);
  const storeRoot = path.join(tmp, "store");
  const storePath = path.join(storeRoot, "project", "repo.git");
  sh(tmp, ["clone", "-q", "--bare", origin, storePath]);
  sh(storePath, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.createWorktree(storePath, { directory: "wt-1", branch: BRANCH }, null, null);
    }).pipe(Effect.provide(Store.layer.pipe(Layer.provide(StoreConfig.layerFor(storeRoot))))),
  );
  return {
    tmp,
    storeRoot,
    origin,
    storePath,
    worktree: worktreePathOf(storePath, "wt-1"),
    baseSha,
  };
};

describe("landing a co-located session", () => {
  let repos: Repos;
  let world: World;
  let published: Array<PublishInput>;
  beforeEach(async () => {
    repos = await makeRepos();
    world = makeWorld({
      storePath: repos.storePath,
      branch: BRANCH,
      directory: "wt-1",
      baseSha: Sha.make(repos.baseSha),
      tour: { summary: "Fix the answer", approach: null },
    });
    published = [];
  });
  afterEach(() => {
    fs.rmSync(repos.tmp, { recursive: true, force: true });
  });

  const layer = () => {
    const store = Store.layer.pipe(Layer.provide(StoreConfig.layerFor(repos.storeRoot)));
    let ordinal = 0;
    // The engine's checkpoint, as far as landing sees it: a store snapshot of the worktree.
    const engine = Layer.unwrap(
      Effect.gen(function* () {
        const git = yield* Store;
        return Layer.mock(SessionEngine, {
          checkpointNow: (_sessionId, trigger) =>
            Effect.gen(function* () {
              ordinal += 1;
              const snapshot = yield* git.checkpoint(repos.worktree, "wt-1", ordinal, null);
              return checkpointOf(world, ordinal, snapshot.sha, trigger);
            }),
        });
      }),
    );
    const pullRequests = Layer.succeed(PullRequests, {
      publish: (input) =>
        Effect.sync(() => {
          published.push(input);
          return {
            action: published.length === 1 ? ("opened" as const) : ("updated" as const),
            pullRequest: {
              number: 7,
              url: "https://github.com/acme/api/pull/7",
              state: "open" as const,
              observedAt: new Date(),
            },
            workspace: "short-lived" as const,
          };
        }),
      observe: () => Effect.die("not in this test"),
    });
    return LandingLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          world.repos,
          pullRequests,
          LandingGitColocatedLive.pipe(Layer.provide(engine), Layer.provide(store)),
        ),
      ),
      Layer.provideMerge(store),
    );
  };

  const land = (overrides: Partial<LandInput> = {}) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Landing).land({
          sessionId: world.session.id,
          actorUserId: OWNER,
          trigger: "manual",
          remoteBranch: null,
          pullRequest: true,
          title: null,
          webOrigin: "https://mend.test",
          remoteEnv: Effect.succeed({}),
          ...overrides,
        });
      }).pipe(Effect.provide(layer())),
    );

  const originHead = () =>
    sh(repos.origin, ["for-each-ref", "--format=%(objectname)", `refs/heads/${BRANCH}`]);

  it("commits the uncommitted work as the owner, pushes it, and leaves the worktree alone", async () => {
    fs.writeFileSync(path.join(repos.worktree, "app.ts"), "export const answer = 42\n");
    const headFile = fs.readFileSync(
      path.join(sh(repos.worktree, ["rev-parse", "--absolute-git-dir"]), "HEAD"),
      "utf8",
    );

    const report = await land();

    expect(report.landing.outcome).toBe("pull-request");
    const commit = report.landing.commitSha ?? "";
    expect(commit).not.toBe("");
    expect(report.landing.pushedSha).toBe(commit);
    expect(originHead()).toBe(commit);
    // The owner is author and committer; the parent is the base; the tree is the checkpoint's.
    expect(sh(repos.origin, ["log", "-1", "--format=%an <%ae>|%cn <%ce>|%P", commit])).toBe(
      `Ada Owner <ada@example.com>|Ada Owner <ada@example.com>|${repos.baseSha}`,
    );
    expect(sh(repos.origin, ["rev-parse", `${commit}^{tree}`])).toBe(
      sh(repos.storePath, ["rev-parse", `${report.landing.checkpointSha}^{tree}`]),
    );
    expect(sh(repos.origin, ["log", "-1", "--format=%B", commit])).toBe(
      `Fix the answer\n\nMend-Session: https://mend.test/sessions/${world.session.id}\n`,
    );
    // The worktree still has its edit uncommitted and its HEAD file untouched.
    expect(fs.readFileSync(path.join(repos.worktree, "app.ts"), "utf8")).toBe(
      "export const answer = 42\n",
    );
    expect(
      fs.readFileSync(
        path.join(sh(repos.worktree, ["rev-parse", "--absolute-git-dir"]), "HEAD"),
        "utf8",
      ),
    ).toBe(headFile);
    // The pull request step got the pushed branch and the file with its counts.
    expect(published[0]).toMatchObject({ head: BRANCH, base: "main", previous: null });
    expect(published[0]?.section).toContain("- `app.ts` · +1 −1");
  });

  it("pushes the agent's own commits as they are and adds nothing", async () => {
    fs.writeFileSync(path.join(repos.worktree, "app.ts"), "export const answer = 43\n");
    sh(repos.worktree, ["commit", "-q", "-am", "agent: bump the answer"]);
    const agentCommit = sh(repos.worktree, ["rev-parse", "HEAD"]);

    const report = await land();

    expect(report.landing.commitSha).toBeNull();
    expect(report.landing.pushedSha).toBe(agentCommit);
    expect(originHead()).toBe(agentCommit);
  });

  it("joins the landing and the agent's later commit, fast-forwards, and never moves the branch", async () => {
    fs.writeFileSync(path.join(repos.worktree, "app.ts"), "export const answer = 42\n");
    const first = await land();
    const landed = first.landing.pushedSha ?? "";
    // The session branch is where the agent left it; Mend's commit is under its own ref.
    expect(sh(repos.storePath, ["rev-parse", `refs/heads/${BRANCH}`])).toBe(repos.baseSha);
    expect(sh(repos.storePath, ["rev-parse", "refs/mend/landed/wt-1"])).toBe(landed);

    // The agent commits everything with its own index, which never saw Mend's commit, and
    // leaves one more edit. Its commit reverts nothing: it is the base plus its work.
    fs.writeFileSync(path.join(repos.worktree, "notes.md"), "agent notes\n");
    sh(repos.worktree, ["add", "-A"]);
    sh(repos.worktree, ["commit", "-q", "-m", "agent: commit it all"]);
    const agentCommit = sh(repos.worktree, ["rev-parse", "HEAD"]);
    expect(sh(repos.worktree, ["show", "HEAD:app.ts"])).toBe("export const answer = 42");
    fs.writeFileSync(path.join(repos.worktree, "left.md"), "leftover\n");

    const second = await land({ trigger: "automatic" });

    expect(second.landing.outcome).toBe("pull-request");
    const merge = second.landing.pushedSha ?? "";
    expect(originHead()).toBe(merge);
    expect(sh(repos.origin, ["log", "-1", "--format=%P", merge])).toBe(`${landed} ${agentCommit}`);
    expect(sh(repos.origin, ["log", "-1", "--format=%an", merge])).toBe("Ada Owner");
    expect(sh(repos.origin, ["ls-tree", "--name-only", merge]).split("\n")).toEqual([
      "app.ts",
      "left.md",
      "notes.md",
    ]);
    expect(sh(repos.storePath, ["rev-parse", `refs/heads/${BRANCH}`])).toBe(agentCommit);
    expect(published[1]?.previous).toBe(7);
  });

  it("says nothing is new when nothing moved since the last landing, and pushes nothing", async () => {
    fs.writeFileSync(path.join(repos.worktree, "app.ts"), "export const answer = 42\n");
    const first = await land();
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Landing)
          .land({
            sessionId: world.session.id,
            actorUserId: OWNER,
            trigger: "manual",
            remoteBranch: null,
            pullRequest: true,
            title: null,
            webOrigin: "https://mend.test",
            remoteEnv: Effect.succeed({}),
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer())),
    );
    expect(error.reason).toBe("nothing-new");
    expect(originHead()).toBe(first.landing.pushedSha);
    expect(published).toHaveLength(1);
  });

  it("adds follow-up work on the same branch and updates the same pull request", async () => {
    fs.writeFileSync(path.join(repos.worktree, "app.ts"), "export const answer = 42\n");
    const first = await land();
    fs.writeFileSync(path.join(repos.worktree, "notes.md"), "more work\n");
    const second = await land({ trigger: "automatic" });

    expect(second.landing.outcome).toBe("pull-request");
    expect(second.pullRequest._tag).toBe("updated");
    expect(published[1]?.previous).toBe(7);
    const secondCommit = second.landing.commitSha ?? "";
    expect(sh(repos.origin, ["log", "-1", "--format=%P", secondCommit])).toBe(
      first.landing.commitSha,
    );
    expect(originHead()).toBe(secondCommit);
  });

  it("stops when origin's branch has a teammate's commit, and leaves origin as it was", async () => {
    // A teammate pushed to the branch first.
    const teammate = path.join(repos.tmp, "teammate");
    sh(repos.tmp, ["clone", "-q", repos.origin, teammate]);
    fs.writeFileSync(path.join(teammate, "theirs.md"), "theirs\n");
    sh(teammate, ["add", "-A"]);
    sh(teammate, ["commit", "-q", "-m", "teammate"]);
    sh(teammate, ["push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`]);
    const theirs = originHead();

    fs.writeFileSync(path.join(repos.worktree, "app.ts"), "export const answer = 42\n");
    const report = await land();

    expect(report.landing.outcome).toBe("refused");
    expect(report.landing.pushedSha).toBeNull();
    expect(report.landing.message).toMatch(
      /^origin has moved · mend\/fix-login has 1 commit Mend has not seen · /,
    );
    expect(report.pullRequest).toEqual({ _tag: "not-reached" });
    expect(published).toEqual([]);
    expect(originHead()).toBe(theirs);
  });
});
