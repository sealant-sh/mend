import * as fs from "node:fs";
import { type IncomingMessage, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { mainTestFixtures, type HttpHandler } from "./main-test-fixtures.ts";

const { project, session, json, spawning, startCli, startFakeMend, git } = mainTestFixtures();

/** A request's JSON body, for a fake route that asserts what the CLI sent. */
const bodyOf = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString();
  return text === "" ? null : JSON.parse(text);
};

/** Read a request's JSON body, then answer it with `reply`. */
const withBody = (request: IncomingMessage, reply: (body: unknown) => void): void => {
  void bodyOf(request).then(reply);
};

describe("mend codex --land", spawning, () => {
  it("sends the session's own override and says what it did", async () => {
    const bodies: Array<unknown> = [];
    const fake = await startFakeMend((request, response) => {
      const route = `${request.method ?? "GET"} ${request.url ?? ""}`;
      if (route === "GET /api/projects") json(response, [{ ...project, autoLand: "inherit" }]);
      else if (route === `POST /api/projects/${project.id}/sessions`) {
        withBody(request, (body) => {
          bodies.push(body);
          json(response, session);
        });
      } else if (route === `POST /api/sessions/${session.id}/launch`) json(response, session);
      else response.writeHead(404).end();
    });
    const cli = startCli(fake.url, ["codex", "--project", project.name, "--land", "-d"]);

    try {
      await cli.exited;
      expect(bodies, cli.stderr()).toEqual([
        { harness: "codex", label: null, name: null, base: null, autoLand: true },
      ]);
      expect(cli.stdout()).toContain("automatic landing · on for this session");
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  });

  it("refuses the flags on mend run, whose command has no turns", async () => {
    const cli = startCli("http://127.0.0.1:9", ["run", "--no-land", "--", "make"]);
    expect((await cli.exited).code).toBe(1);
    expect(cli.stderr()).toContain("mend run takes no landing flags");
  });
});

describe("mend land", spawning, () => {
  const PUSHED = "3f2a1c0".padEnd(40, "0");
  const landed = {
    id: "landing-1",
    changeId: "change-1",
    sessionId: session.id,
    projectId: project.id,
    checkpointId: "checkpoint-1",
    checkpointRef: "refs/mend/checkpoints/wt/3",
    checkpointSha: "9e8d7c6".padEnd(40, "0"),
    commitSha: "1a2b3c4".padEnd(40, "0"),
    remoteBranch: "mend/fix-login",
    pushedSha: PUSHED,
    trigger: "manual",
    pullRequest: {
      number: 412,
      url: "https://github.com/acme/api/pull/412",
      state: "open",
      observedAt: new Date().toISOString(),
    },
    outcome: "pull-request",
    message: null,
    userId: "user-1",
    createdAt: new Date().toISOString(),
  };
  const landingRoutes =
    (
      answer: (body: unknown) => { readonly status: number; readonly body: unknown },
      sent: Array<unknown>,
    ): HttpHandler =>
    (request, response) => {
      const route = `${request.method ?? "GET"} ${request.url ?? ""}`;
      if (route === "GET /api/projects") json(response, [project]);
      else if (route === `GET /api/projects/${project.id}?deadEnds=include`) {
        json(response, { project, sessions: [session], annotations: [] });
      } else if (route === `POST /api/sessions/${session.id}/land`) {
        withBody(request, (body) => {
          sent.push(body);
          const reply = answer(body);
          response.writeHead(reply.status, { "content-type": "application/json" });
          response.end(JSON.stringify(reply.body));
        });
      } else if (route === `GET /api/sessions/${session.id}/landings`) {
        json(response, {
          changeId: "change-1",
          sessionId: session.id,
          land: true,
          landings: [landed],
          facts: [
            { _tag: "pushed", branch: "mend/fix-login", sha: PUSHED },
            {
              _tag: "pull-request",
              number: 412,
              state: "open",
              observedAt: new Date().toISOString(),
            },
          ],
          remote: null,
          remoteFailure: null,
          pullRequest: { available: true, reason: null },
        });
      } else response.writeHead(404).end();
    };

  it("lands the named session and prints the landing, then what Mend observed", async () => {
    const sent: Array<unknown> = [];
    const fake = await startFakeMend(
      landingRoutes(
        () => ({
          status: 200,
          body: {
            landing: landed,
            pullRequest: { _tag: "opened", pullRequest: landed.pullRequest },
          },
        }),
        sent,
      ),
    );
    const cli = startCli(fake.url, ["land", "session-12", "--title", "Fix the login"]);

    try {
      const exit = await cli.exited;
      expect(exit.code, cli.stderr()).toBe(0);
      expect(sent).toEqual([
        { branch: null, pullRequest: true, title: "Fix the login", body: null },
      ]);
      const out = cli.stdout();
      expect(out).toContain("✓ pushed · mend/fix-login · 3f2a1c0 · pull request #412 · opened");
      expect(out).toContain("pull request https://github.com/acme/api/pull/412");
      expect(out).toContain("    pushed · mend/fix-login · 3f2a1c0 · observed");
      expect(out).toMatch(/pull request #412 · open · observed \d+ s ago/);
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  });

  it("exits 1 on a refused push and says it in the remote's words", async () => {
    const sent: Array<unknown> = [];
    const refused = {
      ...landed,
      pushedSha: null,
      commitSha: null,
      pullRequest: null,
      outcome: "refused",
      message: "origin has moved · mend/fix-login has 1 commit Mend has not seen",
    };
    const fake = await startFakeMend(
      landingRoutes(
        () => ({ status: 200, body: { landing: refused, pullRequest: { _tag: "not-reached" } } }),
        sent,
      ),
    );
    const cli = startCli(fake.url, ["land", "session-12", "--no-pr", "--branch", "wip/login"]);

    try {
      expect((await cli.exited).code).toBe(1);
      expect(sent).toEqual([{ branch: "wip/login", pullRequest: false, title: null, body: null }]);
      expect(cli.stdout()).toContain(
        "push refused · mend/fix-login · origin has moved · mend/fix-login has 1 commit Mend has not seen",
      );
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  });

  it("prints the server's refusal when the caller does not own the session", async () => {
    const fake = await startFakeMend(
      landingRoutes(
        () => ({
          status: 403,
          body: { _tag: "LandingNotAllowed", message: "only the change's owner lands it" },
        }),
        [],
      ),
    );
    const cli = startCli(fake.url, ["land", "session-12"]);

    try {
      expect((await cli.exited).code).toBe(1);
      expect(cli.stderr()).toContain("only the change's owner lands it");
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  });
});

describe("mend pull", spawning, () => {
  /** A bare origin, a store clone holding the session's branch, a bundle of it, and two clones. */
  const repositories = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-cli-pull-e2e-"));
    const origin = path.join(root, "origin.git");
    git(root, ["init", "-q", "--bare", "-b", "main", origin]);
    const store = path.join(root, "store");
    git(root, ["init", "-q", "-b", "main", store]);
    git(store, ["remote", "add", "origin", origin]);
    fs.writeFileSync(path.join(store, "README.md"), "hello\n");
    git(store, ["add", "-A"]);
    git(store, ["commit", "-q", "-m", "Start"]);
    const base = git(store, ["rev-parse", "HEAD"]);
    git(store, ["push", "-q", "origin", "HEAD:main"]);
    git(store, ["switch", "-q", "-c", "mend/fix-login"]);
    fs.writeFileSync(path.join(store, "login.ts"), "export const login = 1;\n");
    git(store, ["add", "-A"]);
    git(store, ["commit", "-q", "-m", "Fix the login redirect"]);
    const tip = git(store, ["rev-parse", "HEAD"]);
    const file = path.join(root, "change.bundle");
    git(store, ["bundle", "create", "-q", file, "mend/fix-login", `^${base}`]);
    const local = path.join(root, "local");
    git(root, ["clone", "-q", origin, local]);
    const other = path.join(root, "other");
    git(root, ["init", "-q", "-b", "main", other]);
    git(other, ["remote", "add", "origin", "https://github.com/someone/else.git"]);
    return { root, origin, local, other, base, tip, bytes: fs.readFileSync(file) };
  };

  const pullRoutes =
    (
      world: ReturnType<typeof repositories>,
      bundle: (response: ServerResponse) => void,
      routes: Array<string>,
    ): HttpHandler =>
    (request, response) => {
      const route = `${request.method ?? "GET"} ${request.url ?? ""}`;
      routes.push(route);
      const pulled = { ...project, originUrl: world.origin };
      if (route === "GET /api/projects") json(response, [pulled]);
      else if (route === `GET /api/projects/${project.id}?deadEnds=include`) {
        json(response, {
          project: pulled,
          sessions: [{ ...session, branch: "mend/fix-login", worktree: "fix-login" }],
          annotations: [],
        });
      } else if (route === `GET /api/sessions/${session.id}/landings`) {
        json(response, { changeId: "change-1", facts: [] });
      } else if (route.startsWith("GET /api/changes/change-1/bundle")) bundle(response);
      else response.writeHead(404).end();
    };

  it("pull, keep working, pull again: the second pull asks to build on the first and fast-forwards", async () => {
    const world = repositories();
    const store = path.join(world.root, "store");
    // The second bundle: the server built the new checkpoint on the first pull's commit.
    fs.writeFileSync(path.join(store, "login.test.ts"), "test\n");
    git(store, ["add", "-A"]);
    const next = git(store, [
      "commit-tree",
      git(store, ["write-tree"]),
      "-p",
      world.tip,
      "-m",
      "Mend: work left uncommitted",
    ]);
    git(store, ["update-ref", "refs/heads/mend/fix-login", next]);
    const nextFile = path.join(world.root, "next.bundle");
    git(store, [
      "bundle",
      "create",
      "-q",
      nextFile,
      "mend/fix-login",
      `^${world.base}`,
      `^${world.tip}`,
    ]);
    const routes: Array<string> = [];
    let served = 0;
    const fake = await startFakeMend(
      pullRoutes(
        world,
        (response) => {
          served += 1;
          const first = served === 1;
          response.writeHead(200, {
            "content-type": "application/x-git-bundle",
            "x-mend-bundle-branch": "mend/fix-login",
            "x-mend-bundle-base": world.base,
            "x-mend-bundle-tip": first ? world.tip : next,
            "x-mend-bundle-commits": first ? "1" : "2",
            ...(first ? {} : { "x-mend-bundle-onto": world.tip }),
          });
          response.end(first ? world.bytes : fs.readFileSync(nextFile));
        },
        routes,
      ),
    );

    try {
      const first = startCli(fake.url, ["pull", "fix-login"], {}, world.local);
      expect((await first.exited).code, first.stderr()).toBe(0);
      const second = startCli(fake.url, ["pull", "fix-login"], {}, world.local);
      expect((await second.exited).code, second.stderr()).toBe(0);
      expect(routes.filter((route) => route.includes("/bundle"))).toEqual([
        "GET /api/changes/change-1/bundle",
        `GET /api/changes/change-1/bundle?onto=${world.tip}`,
      ]);
      expect(second.stdout()).toContain(
        `✓ fetched mend/fix-login · ${next.slice(0, 7)} · 2 commits on ${world.base.slice(0, 7)} · moved from ${world.tip.slice(0, 7)}`,
      );
      expect(git(world.local, ["rev-parse", "refs/heads/mend/fix-login"])).toBe(next);
      expect(git(world.local, ["rev-parse", "refs/mend/pulled/mend/fix-login"])).toBe(next);
    } finally {
      await fake.close();
      fs.rmSync(world.root, { recursive: true, force: true });
    }
  });

  it("fetches the change into this clone as mend/<name> and prints what it fetched", async () => {
    const world = repositories();
    const routes: Array<string> = [];
    const fake = await startFakeMend(
      pullRoutes(
        world,
        (response) => {
          response.writeHead(200, {
            "content-type": "application/x-git-bundle",
            "x-mend-bundle-branch": "mend/fix-login",
            "x-mend-bundle-base": world.base,
            "x-mend-bundle-tip": world.tip,
            "x-mend-bundle-commits": "1",
          });
          response.end(world.bytes);
        },
        routes,
      ),
    );
    const cli = startCli(fake.url, ["pull", "fix-login"], {}, world.local);

    try {
      const exit = await cli.exited;
      expect(exit.code, cli.stderr()).toBe(0);
      expect(cli.stdout()).toContain(
        `✓ fetched mend/fix-login · ${world.tip.slice(0, 7)} · 1 commit on ${world.base.slice(0, 7)} · created`,
      );
      expect(cli.stdout()).toContain("Fix the login redirect");
      expect(git(world.local, ["rev-parse", "refs/heads/mend/fix-login"])).toBe(world.tip);
      expect(git(world.local, ["branch", "--show-current"])).toBe("main");
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
      fs.rmSync(world.root, { recursive: true, force: true });
    }
  });

  it("refuses a bundle over the limit with its size, and fetches nothing", async () => {
    const world = repositories();
    const fake = await startFakeMend(
      pullRoutes(
        world,
        (response) => {
          response.writeHead(413, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              _tag: "BundleTooLarge",
              size: 75_000_000,
              limit: 67_108_864,
              message: "bundle not sent · 75000000 bytes · the limit is 67108864 bytes",
            }),
          );
        },
        [],
      ),
    );
    const cli = startCli(fake.url, ["pull", "session-12"], {}, world.local);

    try {
      expect((await cli.exited).code).toBe(1);
      expect(cli.stderr()).toContain("bundle not sent · 72 MiB (75000000 bytes)");
      expect(() =>
        git(world.local, ["rev-parse", "--verify", "--quiet", "refs/heads/mend/fix-login"]),
      ).toThrow();
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
      fs.rmSync(world.root, { recursive: true, force: true });
    }
  });

  it("refuses a clone of another repository before asking for the bundle", async () => {
    const world = repositories();
    const routes: Array<string> = [];
    const fake = await startFakeMend(pullRoutes(world, (response) => response.end(), routes));
    const cli = startCli(fake.url, ["pull", "fix-login"], {}, world.other);

    try {
      expect((await cli.exited).code).toBe(1);
      expect(cli.stderr()).toContain(
        "this clone's remotes are origin https://github.com/someone/else.git",
      );
      expect(cli.stderr()).toContain("or pass --force");
      expect(routes).not.toContain("GET /api/changes/change-1/bundle");
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
      fs.rmSync(world.root, { recursive: true, force: true });
    }
  });
});
