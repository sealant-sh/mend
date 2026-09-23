import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Sha } from "@mend/domain";
import { afterEach, describe, expect, it } from "vitest";

import {
  bundleFactsOf,
  bundleRefusal,
  type ChangeLandingDto,
  fetchBundle,
  fetchedLines,
  formatBytes,
  gitRemotes,
  type LandedPullRequestDto,
  landedLines,
  type LandingReportDto,
  landingReportLine,
  landingSucceeded,
  parseLandArgs,
  parsePullArgs,
  pickSession,
  remoteForOrigin,
} from "./landing.ts";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const PUSHED = "3f2a1c0".padEnd(40, "0");

const landing = (overrides: Partial<ChangeLandingDto> = {}): ChangeLandingDto => ({
  remoteBranch: "mend/fix-login",
  pushedSha: PUSHED,
  commitSha: null,
  checkpointSha: "9e8d7c6".padEnd(40, "0"),
  outcome: "pull-request",
  message: null,
  pullRequest: null,
  ...overrides,
});

const pullRequest: LandedPullRequestDto = {
  number: 412,
  url: "https://github.com/acme/api/pull/412",
  state: "open",
  observedAt: NOW.toISOString(),
};

describe("mend land's arguments", () => {
  it("takes the session and every flag by name", () => {
    expect(
      parseLandArgs(["3f2a", "--branch", "wip/login", "--no-pr", "--title", "Fix the login"]),
    ).toEqual({
      args: {
        session: "3f2a",
        branch: "wip/login",
        pullRequest: false,
        title: "Fix the login",
        project: null,
      },
    });
    expect(parseLandArgs(["fix-login", "--project", "api"])).toEqual({
      args: { session: "fix-login", branch: null, pullRequest: true, title: null, project: "api" },
    });
  });

  it("refuses a missing session, a second one, an unknown flag and a flag with no value", () => {
    expect(parseLandArgs([])).toEqual({ error: "name the session to land" });
    expect(parseLandArgs(["a", "b"])).toEqual({ error: 'one session only; "b" is extra' });
    expect(parseLandArgs(["a", "--draft"])).toEqual({ error: "unknown flag --draft" });
    expect(parseLandArgs(["a", "--branch"])).toEqual({ error: "--branch needs a value" });
    expect(parseLandArgs(["a", "--branch", " "])).toEqual({ error: "--branch needs a name" });
  });

  it("reads mend pull's", () => {
    expect(parsePullArgs(["fix-login", "--force"])).toEqual({
      args: { session: "fix-login", force: true, project: null },
    });
    expect(parsePullArgs([])).toEqual({ error: "name the session to pull" });
  });
});

const sessionAt = (id: string, branch: string, createdAt: string, projectId = "p1") => ({
  id,
  projectId,
  harness: "claude",
  label: null,
  worktree: branch.replace(/^mend\//, ""),
  branch,
  createdAt,
});

describe("pickSession", () => {
  const sessions = [
    sessionAt("aaa111", "mend/fix-login", "2026-09-20T00:00:00Z"),
    sessionAt("aaa222", "mend/fix-login", "2026-09-22T00:00:00Z"),
    sessionAt("bbb333", "mend/docs", "2026-09-21T00:00:00Z"),
  ];

  it("takes an id prefix first, then the newest session in a named worktree", () => {
    expect(pickSession(sessions, "bbb")).toEqual({ session: sessions[2] });
    expect(pickSession(sessions, "fix-login")).toEqual({ session: sessions[1] });
    expect(pickSession(sessions, "mend/docs")).toEqual({ session: sessions[2] });
  });

  it("says when a word is ambiguous or matches nothing", () => {
    expect(pickSession(sessions, "aaa")).toEqual({
      error: '"aaa" matches 2 sessions; type more of the id',
    });
    expect(
      pickSession(
        [...sessions, sessionAt("ccc444", "mend/docs", "2026-09-23T00:00:00Z", "p2")],
        "docs",
      ),
    ).toEqual({ error: '"docs" names a worktree in 2 projects; pass --project' });
    expect(pickSession(sessions, "nope")).toEqual({
      error: 'no session or worktree matches "nope" · mend sessions --all lists them',
    });
  });
});

describe("what mend land prints", () => {
  it("states each outcome the way the Land panel does", () => {
    const report = (overrides: Partial<ChangeLandingDto>, step: LandingReportDto["pullRequest"]) =>
      landingReportLine({ landing: landing(overrides), pullRequest: step });
    expect(report({}, { _tag: "opened", pullRequest })).toBe(
      "pushed · mend/fix-login · 3f2a1c0 · pull request #412 · opened",
    );
    expect(report({ outcome: "pushed" }, { _tag: "off" })).toBe(
      "pushed · mend/fix-login · 3f2a1c0",
    );
    expect(
      report(
        { outcome: "pushed" },
        {
          _tag: "unavailable",
          reason: "pull request unavailable · origin is on gitlab.com, not GitHub",
        },
      ),
    ).toBe(
      "pushed · mend/fix-login · 3f2a1c0 · pull request unavailable · origin is on gitlab.com, not GitHub",
    );
    expect(
      report(
        {
          outcome: "refused",
          pushedSha: null,
          message: "origin has moved · mend/fix-login has 1 commit Mend has not seen",
        },
        { _tag: "not-reached" },
      ),
    ).toBe(
      "push refused · mend/fix-login · origin has moved · mend/fix-login has 1 commit Mend has not seen",
    );
    expect(
      report(
        { outcome: "failed", pushedSha: null, message: "checkpoint · disk full" },
        { _tag: "not-reached" },
      ),
    ).toBe("landing failed · checkpoint · disk full");
    expect(
      report(
        { outcome: "failed", message: "gh: not logged in" },
        { _tag: "failed", message: "gh: not logged in" },
      ),
    ).toBe("pushed · mend/fix-login · 3f2a1c0 · pull request step failed · gh: not logged in");
  });

  it("prints the commit Mend wrote, the pull request's link and every observed fact", () => {
    const report: LandingReportDto = {
      landing: landing({ commitSha: "1a2b3c4".padEnd(40, "0"), pullRequest }),
      pullRequest: { _tag: "opened", pullRequest },
    };
    const lines = landedLines(
      report,
      [
        { _tag: "pushed", branch: "mend/fix-login", sha: Sha.make(PUSHED) },
        {
          _tag: "pull-request",
          number: 412,
          state: "open",
          observedAt: new Date(NOW.getTime() - 120_000),
        },
      ],
      NOW,
    );
    expect(lines).toEqual([
      "✓ pushed · mend/fix-login · 3f2a1c0 · pull request #412 · opened",
      "  checkpoint 9e8d7c6",
      "  commit 1a2b3c4 · Mend's, for the work left uncommitted",
      "  pull request https://github.com/acme/api/pull/412",
      "  observed",
      "    pushed · mend/fix-login · 3f2a1c0 · observed",
      "    pull request #412 · open · observed 2 min ago",
    ]);
    for (const line of lines) expect(line).not.toMatch(/ready|safe|approved|tested/i);
  });

  it("marks a refusal and a failure as not reached", () => {
    expect(
      landingSucceeded({ landing: landing(), pullRequest: { _tag: "opened", pullRequest } }),
    ).toBe(true);
    const refused: LandingReportDto = {
      landing: landing({ outcome: "refused", pushedSha: null, message: "[remote rejected]" }),
      pullRequest: { _tag: "not-reached" },
    };
    expect(landingSucceeded(refused)).toBe(false);
    expect(landedLines(refused, [], NOW)[0]).toBe(
      "· push refused · mend/fix-login · [remote rejected]",
    );
  });
});

describe("the clone's origin", () => {
  const remotes = [
    { name: "upstream", url: "https://github.com/acme/api.git" },
    { name: "fork", url: "git@github.com:me/api.git" },
  ];

  it("matches ssh, https and scp spellings of the project's origin", () => {
    expect(remoteForOrigin(remotes, "git@github.com:acme/api.git", "/work")?.name).toBe("upstream");
    expect(remoteForOrigin(remotes, "ssh://git@github.com/Acme/API", "/work")?.name).toBe(
      "upstream",
    );
    expect(remoteForOrigin(remotes, "https://github.com/other/api.git", "/work")).toBeNull();
    expect(remoteForOrigin(remotes, null, "/work")).toBeNull();
  });

  it("matches an origin on this machine by its directory", () => {
    expect(
      remoteForOrigin(
        [{ name: "origin", url: "../srv/api.git" }],
        "/home/me/srv/api.git",
        "/home/me/work",
      )?.name,
    ).toBe("origin");
    expect(
      remoteForOrigin([{ name: "origin", url: "file:///srv/api.git" }], "/srv/api.git", "/work")
        ?.name,
    ).toBe("origin");
  });
});

const answered = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  header: (name: string) => headers[name] ?? null,
  bytes: new TextEncoder().encode(JSON.stringify(body)),
});

describe("the bundle's answer", () => {
  it("refuses a bundle over the limit with its size", () => {
    expect(
      bundleRefusal(
        answered(413, {
          _tag: "BundleTooLarge",
          size: 75_000_000,
          limit: 67_108_864,
          message: "bundle not sent · 75000000 bytes · the limit is 67108864 bytes",
        }),
      ),
    ).toBe(
      "bundle not sent · 72 MiB (75000000 bytes) · the server's limit is 64 MiB (MEND_BUDGET_BUNDLE_BYTES) · nothing was fetched",
    );
    expect(
      bundleRefusal(
        answered(422, { message: "nothing to bundle · the change has no commits past its base" }),
      ),
    ).toBe("nothing to bundle · the change has no commits past its base");
    expect(bundleRefusal({ status: 502, header: () => null, bytes: new Uint8Array() })).toBe(
      "the bundle request answered 502",
    );
  });

  it("reads the branch, base, tip and commit count from the headers", () => {
    expect(
      bundleFactsOf(
        answered(200, null, {
          "x-mend-bundle-branch": "mend/fix-login",
          "x-mend-bundle-base": "b".repeat(40),
          "x-mend-bundle-tip": "c".repeat(40),
          "x-mend-bundle-commits": "2",
        }),
      ),
    ).toEqual({ branch: "mend/fix-login", base: "b".repeat(40), tip: "c".repeat(40), commits: 2 });
    expect(bundleFactsOf(answered(200, null))).toBeNull();
  });

  it("formats sizes in the units people read", () => {
    expect(formatBytes(512)).toBe("512 bytes");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(64 * 1024 * 1024)).toBe("64 MiB");
  });
});

// ─── fetching a bundle into a real clone ────────────────────────────────────

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const IDENTITY = [
  "-c",
  "user.name=Mend Test",
  "-c",
  "user.email=test@mend.invalid",
  "-c",
  "commit.gpgsign=false",
];
const run = (cwd: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" }).trim();

const commit = (cwd: string, file: string, text: string, message: string): string => {
  fs.writeFileSync(path.join(cwd, file), text);
  run(cwd, ["add", "-A"]);
  run(cwd, ["commit", "-q", "-m", message]);
  return run(cwd, ["rev-parse", "HEAD"]);
};

/**
 * A bare origin with one commit on main, a clone that stands in for Mend's store (where the
 * session's branch gets two commits past the base), and the person's own clone of origin.
 */
const world = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-cli-pull-"));
  roots.push(root);
  const origin = path.join(root, "origin.git");
  run(root, ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = path.join(root, "seed");
  run(root, ["init", "-q", "-b", "main", seed]);
  run(seed, ["remote", "add", "origin", origin]);
  const base = commit(seed, "README.md", "hello\n", "Start");
  run(seed, ["push", "-q", "origin", "HEAD:main"]);
  const store = path.join(root, "store");
  run(root, ["clone", "-q", origin, store]);
  run(store, ["switch", "-q", "-c", "mend/fix-login"]);
  commit(store, "login.ts", "export const login = 1;\n", "Fix the login redirect");
  const tip = commit(store, "login.test.ts", "test\n", "Mend: work left uncommitted");
  const bundleFile = path.join(root, "change.bundle");
  run(store, ["bundle", "create", "-q", bundleFile, "mend/fix-login", `^${base}`]);
  const local = path.join(root, "local");
  run(root, ["clone", "-q", origin, local]);
  return {
    root,
    origin,
    store,
    local,
    bundle: {
      branch: "mend/fix-login",
      base,
      tip,
      commits: 2,
      bytes: new Uint8Array(fs.readFileSync(bundleFile)),
    },
  };
};

describe("fetchBundle", () => {
  it("creates mend/<name> from the bundle and leaves the working tree and HEAD alone", () => {
    const { local, bundle } = world();
    fs.writeFileSync(path.join(local, "notes.txt"), "mine\n");
    const head = run(local, ["rev-parse", "HEAD"]);

    const fetched = fetchBundle(local, bundle);

    expect(fetched).toEqual({
      _tag: "fetched",
      branch: "mend/fix-login",
      previous: null,
      tip: bundle.tip,
      base: bundle.base,
      commits: 2,
      log: [
        `${bundle.tip.slice(0, 7)} Mend: work left uncommitted`,
        expect.stringMatching(/^[0-9a-f]{7} Fix the login redirect$/),
      ],
    });
    expect(run(local, ["rev-parse", "refs/heads/mend/fix-login"])).toBe(bundle.tip);
    expect(run(local, ["rev-parse", "HEAD"])).toBe(head);
    expect(run(local, ["branch", "--show-current"])).toBe("main");
    expect(run(local, ["status", "--porcelain"])).toBe("?? notes.txt");
    expect(fs.existsSync(path.join(local, ".git", "FETCH_HEAD"))).toBe(false);
    if (fetched._tag !== "fetched") throw new Error("expected a fetch");
    expect(fetchedLines(fetched)[0]).toBe(
      `✓ fetched mend/fix-login · ${bundle.tip.slice(0, 7)} · 2 commits on ${bundle.base.slice(0, 7)} · created`,
    );
    expect(fetchedLines(fetched).at(-1)).toBe("  switch to it git switch mend/fix-login");
  });

  it("says a second pull found the branch already here, and fast-forwards an older one", () => {
    const { local, bundle } = world();
    expect(fetchBundle(local, bundle)._tag).toBe("fetched");
    const again = fetchBundle(local, bundle);
    expect(again._tag === "fetched" && again.previous).toBe(bundle.tip);

    run(local, ["branch", "-f", "mend/fix-login", `${bundle.tip}~1`]);
    const forward = fetchBundle(local, bundle);
    if (forward._tag !== "fetched") throw new Error("expected a fetch");
    expect(fetchedLines(forward)[0]).toContain("· moved from ");
    expect(run(local, ["rev-parse", "refs/heads/mend/fix-login"])).toBe(bundle.tip);
  });

  it("refuses to move a local branch with commits the change does not have", () => {
    const { local, bundle } = world();
    run(local, ["switch", "-q", "-c", "mend/fix-login"]);
    const mine = commit(local, "mine.txt", "mine\n", "My own work");
    run(local, ["switch", "-q", "main"]);

    const fetched = fetchBundle(local, bundle);

    expect(fetched._tag).toBe("refused");
    expect(fetched._tag === "refused" && fetched.message).toMatch(/non-fast-forward|rejected/);
    expect(run(local, ["rev-parse", "refs/heads/mend/fix-login"])).toBe(mine);
  });

  it("refuses while the branch is checked out, and when the clone lacks the base", () => {
    const { local, store, root, bundle } = world();
    run(local, ["switch", "-q", "-c", "mend/fix-login"]);
    expect(fetchBundle(local, bundle)).toEqual({
      _tag: "refused",
      message:
        "mend/fix-login is checked out here · switch to another branch first; mend pull does not touch the working tree",
    });

    // A base only the store has: the person's clone never fetched it.
    run(store, ["switch", "-q", "-c", "mend/later", "main"]);
    const unseenBase = commit(store, "later.txt", "later\n", "Only in the store");
    const tip = commit(store, "later2.txt", "later\n", "Work");
    const file = path.join(root, "later.bundle");
    run(store, ["bundle", "create", "-q", file, "mend/later", `^${unseenBase}`]);
    const lacking = fetchBundle(path.join(root, "local"), {
      branch: "mend/later",
      base: unseenBase,
      tip,
      commits: 1,
      bytes: new Uint8Array(fs.readFileSync(file)),
    });
    expect(lacking).toEqual({
      _tag: "refused",
      message: `this clone lacks the change's base ${unseenBase.slice(0, 7)} · fetch it from origin, then run mend pull again`,
    });
  });

  it("refuses a branch name git does not accept", () => {
    const { local, bundle } = world();
    expect(fetchBundle(local, { ...bundle, branch: "mend/..bad" })).toEqual({
      _tag: "refused",
      message: "the bundle names a branch git does not accept: mend/..bad",
    });
  });

  it("lists the clone's remotes, one per name", () => {
    const { local, origin } = world();
    run(local, ["remote", "add", "fork", "git@github.com:me/api.git"]);
    expect(gitRemotes(local)).toEqual([
      { name: "fork", url: "git@github.com:me/api.git" },
      { name: "origin", url: origin },
    ]);
  });
});
