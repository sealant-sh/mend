import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";

import { HANDOFF_SNAPSHOT_REF } from "@mend/domain/workbench";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fingerprint, type HandoffWorld, handoffWorlds } from "./handoff-test-fixtures.ts";
import { handoffCommand, type HandoffDeps } from "./handoff.ts";
import { formatBytes } from "./landing.ts";
import { mainTestFixtures } from "./main-test-fixtures.ts";

const { json, spawning, startCli, startFakeMend, waitFor } = mainTestFixtures();
const world = handoffWorlds();

const ORIGIN = "https://github.com/acme/newsroom-api.git";
const SESSION_ID = "3f2a1c0d-6b1e-4c2a-9d1f-0a1b2c3d4e5f";
const FILE_BYTES = 64 * 1024;

const project = {
  id: "project-1",
  name: "newsroom-api",
  originUrl: ORIGIN,
  storePath: "/srv/mend/newsroom-api/repo.git",
  defaultBranch: "main",
};

const newsroom = (w: HandoffWorld, name = "newsroom-api", origin = ORIGIN) => {
  const dana = w.clone(name);
  const at = (file: string) => path.join(dana, file);
  w.git(dana, ["remote", "set-url", "origin", origin]);
  w.git(dana, ["switch", "-q", "-c", "fix/login"]);
  w.write(at("login.ts"), "export const login = 1;\n");
  w.git(dana, ["add", "login.ts"]);
  w.git(dana, ["commit", "-q", "-m", "login"]);
  w.write(at("a.txt"), "one\ntwo\n");
  w.git(dana, ["commit", "-q", "-am", "two"]);
  w.write(at("a.txt"), "one\ntwo\nstaged\n");
  w.git(dana, ["add", "a.txt"]);
  w.write(at("b.txt"), "unstaged\n");
  fs.rmSync(at("d.txt"));
  w.write(at("tests/login.test.ts"), "test\n");
  w.write(at(".env.local"), "secret=1\n");
  w.write(at("assets/demo.mov"), Buffer.alloc(100 * 1024, 1));
  return dana;
};

interface Fake {
  readonly routes: Array<string>;
  readonly bodies: Array<Buffer>;
  readonly launches: Array<unknown>;
  readonly adoptions: Array<unknown>;
}

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const withBody = (request: IncomingMessage, reply: (body: Buffer) => void): void => {
  void (async () => reply(await readBody(request)))();
};

const received = (
  overrides: {
    readonly name?: string;
    readonly replayed?: boolean;
    readonly status?: string;
    readonly summary?: string | null;
    readonly previous?: string | null;
  } = {},
) => ({
  session: {
    id: SESSION_ID,
    harness: "claude",
    status: overrides.status ?? "idle",
    summary: overrides.summary ?? null,
  },
  worktree: { id: "worktree-1", name: overrides.name ?? "fix-login" },
  commitsAhead: 2,
  replayed: overrides.replayed ?? false,
  previous:
    overrides.previous === undefined || overrides.previous === null
      ? null
      : { name: overrides.previous },
});

const handoffServer = async (
  options: {
    readonly projects?: ReadonlyArray<unknown>;
    readonly terms?: (response: ServerResponse) => void;
    readonly answer?: (response: ServerResponse, attempt: number) => void;
    readonly launch?: (response: ServerResponse) => void;
    readonly mountDelivery?: "bind" | "sources";
    readonly socket?: "end" | "drop";
  } = {},
) => {
  const fake: Fake = { routes: [], bodies: [], launches: [], adoptions: [] };
  const server = await startFakeMend((request, response) => {
    const route = `${request.method ?? "GET"} ${request.url ?? ""}`;
    fake.routes.push(route);
    if (route === "GET /api/projects") json(response, options.projects ?? [project]);
    else if (route === "GET /api/health") json(response, { version: "0.35.1" });
    else if (route === "GET /api/organization") {
      json(response, { mountDelivery: options.mountDelivery ?? "sources" });
    } else if (route === "GET /api/me/git-access") json(response, { mode: "bridge" });
    else if (route === `GET /api/projects/${project.id}/handoffs`) {
      if (options.terms === undefined) {
        json(response, { bundleBytes: 64 * 1024 * 1024, fileBytes: FILE_BYTES });
      } else options.terms(response);
    } else if (route === "GET /api/projects/handoff-probe/handoffs") {
      if (options.terms === undefined) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ _tag: "NotFound", id: "handoff-probe" }));
      } else options.terms(response);
    } else if (route.startsWith(`POST /api/projects/${project.id}/handoffs?`)) {
      withBody(request, (body) => {
        fake.bodies.push(body);
        if (options.answer === undefined) json(response, received());
        else options.answer(response, fake.bodies.length);
      });
    } else if (route === `POST /api/sessions/${SESSION_ID}/launch`) {
      withBody(request, (body) => {
        fake.launches.push(JSON.parse(body.toString()));
        if (options.launch === undefined) {
          json(response, { ...received().session, status: "running", summary: null });
        } else options.launch(response);
      });
    } else if (route === "POST /api/projects") {
      withBody(request, (body) => {
        fake.adoptions.push(JSON.parse(body.toString()));
        json(response, project);
      });
    } else response.writeHead(404).end();
  }, options.socket);
  return { ...fake, server };
};

const run = async (
  server: Awaited<ReturnType<typeof handoffServer>>,
  args: ReadonlyArray<string>,
  cwd: string,
  env: Readonly<Record<string, string>> = {},
) => {
  const cli = startCli(server.server.url, ["handoff", ...args], env, cwd);
  const { code } = await cli.exited;
  await server.server.close();
  return { code, stdout: cli.stdout(), stderr: cli.stderr() };
};

const lines = (text: string): ReadonlyArray<string> => text.split("\n").filter((l) => l !== "");

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const json413 = (budget: string, limit: number) => (response: ServerResponse) => {
  response.writeHead(413, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      _tag: "BudgetExceeded",
      budget,
      limit,
      retryAfterSeconds: null,
      message: "Request body too large",
    }),
  );
};

const capture = () => {
  const out: Array<string> = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  return out;
};

const JOINED_ID = "7c1d2e3f-0a1b-4c2d-8e3f-4a5b6c7d8e9f";

/**
 * Runs the `mend …` command a refusal printed, in the same checkout, against a server whose
 * project holds the handoff's worktree and its never-launched session, until `reached` is seen.
 */
const runPrinted = async (
  stderr: string,
  cwd: string,
  reached: (route: string) => boolean,
): Promise<{ readonly bodies: Readonly<Record<string, unknown>> }> => {
  const printed = /· mend ((?:resume|claude)[^·\n]*?) (?:opens|starts) /u.exec(stderr)?.[1];
  if (printed === undefined) throw new Error(`no command in ${stderr}`);
  const routes: Array<string> = [];
  const bodies: Record<string, unknown> = {};
  const handoffSession = {
    id: SESSION_ID,
    projectId: project.id,
    worktreeId: "worktree-1",
    harness: "claude",
    label: null,
    worktree: "fix-login",
    branch: "mend/fix-login",
    baseSha: "a".repeat(40),
    baseRef: "main",
    status: "failed",
    summary: null,
    settledAt: null,
    createdAt: new Date(0).toISOString(),
  };
  const server = await startFakeMend((request, response) => {
    const route = `${request.method ?? "GET"} ${request.url ?? ""}`;
    routes.push(route);
    withBody(request, (body) => {
      if (body.length > 0) bodies[route] = JSON.parse(body.toString());
      if (route === "GET /api/projects") json(response, [project]);
      else if (route === `GET /api/projects/${project.id}`) {
        json(response, {
          project,
          sessions: [handoffSession],
          annotations: [],
          worktrees: [{ id: "worktree-1", name: "fix-login", branch: "mend/fix-login" }],
        });
      } else if (route === `POST /api/projects/${project.id}/sessions`) {
        json(response, { ...handoffSession, id: JOINED_ID, status: "starting" });
      } else if (route.startsWith("POST /api/sessions/")) {
        json(response, { ...handoffSession, status: "starting" });
      } else response.writeHead(404).end();
    });
  }, "hold");
  const cli = startCli(server.url, printed.split(" "), {}, cwd);
  try {
    await waitFor(() => routes.some(reached));
  } finally {
    cli.child.kill("SIGKILL");
    await server.close();
  }
  return { bodies };
};

const OLD_SERVER =
  "mend: this Mend server (0.35.1) does not take handoffs · upgrade it, then hand off again · nothing was created\n";

describe("mend handoff", spawning, () => {
  it("says every line of the design's usage, launches on the prompt and does not attach", async () => {
    const w = world();
    const dana = newsroom(w);
    const head = w.git(dana, ["rev-parse", "HEAD"]);
    const mergeBase = w.git(dana, ["merge-base", "HEAD", "origin/main"]);
    const before = fingerprint(dana);
    const server = await handoffServer();
    const result = await run(server, ["finish the tests"], dana);
    expect(result.code, result.stderr).toBe(0);
    expect(fingerprint(dana)).toEqual(before);
    const [body] = server.bodies;
    if (body === undefined) throw new Error("no bundle arrived");
    const out = lines(result.stdout);
    expect(out.slice(0, 5)).toEqual([
      "✓ project newsroom-api · main · from origin",
      "✓ fix/login · 2 commits ahead of main · 3 uncommitted files · 1 untracked",
      "  stays here · gitignored files and .env files: .env.local",
      "  left out · assets/demo.mov · 100 KiB, over the 64 KiB file limit",
      `  bundling 2 commits · 4 files → uploading ${formatBytes(body.length).replace(".0 ", " ")} → creating worktree`,
    ]);
    expect(out[5]).toMatch(
      /^✓ handed off as fix-login · your checkout is unchanged · as of \d\d:\d\d:\d\d$/u,
    );
    expect(out.slice(6)).toEqual([
      `  base main ${mergeBase.slice(0, 7)} · session 3f2a1c0d`,
      "✓ running · claude on your prompt",
      "  attach · mend attach 3f2a1c0d",
      `  watch · ${server.server.url}/sessions/${SESSION_ID}`,
    ]);
    expect(server.routes).toContain(
      `POST /api/projects/${project.id}/handoffs?harness=claude&hold=false`,
    );
    expect(server.launches).toEqual([{ prompt: "finish the tests" }]);
    expect(server.server.upgradeCount()).toBe(0);

    const bundle = path.join(w.root, "arrived.bundle");
    fs.writeFileSync(bundle, body);
    const store = path.join(w.root, "store.git");
    w.git(w.root, ["clone", "-q", "--bare", w.origin, store]);
    w.git(store, ["bundle", "verify", "-q", bundle]);
    w.git(store, ["fetch", "-q", bundle, `${HANDOFF_SNAPSHOT_REF}:${HANDOFF_SNAPSHOT_REF}`]);
    expect(w.git(store, ["rev-parse", `${HANDOFF_SNAPSHOT_REF}^^`])).toBe(head);
  }, 30_000);

  it("holds the workspace with no agent when there is no prompt", async () => {
    const w = world();
    const dana = newsroom(w);
    const server = await handoffServer();
    const tmp = fs.mkdtempSync(path.join(w.root, "tmp-"));
    const result = await run(server, [], dana, { TMPDIR: tmp });
    expect(result.code, result.stderr).toBe(0);
    expect(fs.readdirSync(tmp)).toEqual([]);
    expect(result.stdout).toContain("✓ held · idle, no agent\n");
    expect(server.routes).toContain(
      `POST /api/projects/${project.id}/handoffs?harness=claude&hold=true`,
    );
    expect(server.routes.filter((route) => route.endsWith("/launch"))).toEqual([]);
  }, 30_000);

  it("hands off a detached HEAD under its own name, and takes --with", async () => {
    const w = world();
    const dana = w.clone("newsroom-api");
    w.git(dana, ["remote", "set-url", "origin", ORIGIN]);
    w.git(dana, ["checkout", "-q", "--detach"]);
    w.write(path.join(dana, "a.txt"), "edited\n");
    const head7 = w.git(dana, ["rev-parse", "--short=7", "HEAD"]);
    const server = await handoffServer({
      answer: (response) => json(response, received({ name: `handoff-${head7}` })),
    });
    const result = await run(server, ["--with", "codex"], dana);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      `✓ detached at ${head7} · even with main · 1 uncommitted file\n`,
    );
    expect(result.stdout).toMatch(new RegExp(`✓ handed off as handoff-${head7} · your checkout`));
    expect(server.routes).toContain(
      `POST /api/projects/${project.id}/handoffs?harness=codex&hold=true`,
    );
  }, 30_000);

  it("names the earlier handoff only when the server says it is one, and says a replay is one", async () => {
    const w = world();
    const dana = newsroom(w);
    const second = await handoffServer({
      answer: (response) =>
        json(response, received({ name: "fix-login-2", previous: "fix-login" })),
    });
    expect((await run(second, [], dana)).stdout).toMatch(
      /✓ handed off as fix-login-2 · fix-login is your earlier handoff · your checkout is unchanged/u,
    );
    const taken = await handoffServer({
      answer: (response) => json(response, received({ name: "fix-login-2" })),
    });
    expect((await run(taken, [], dana)).stdout).toMatch(
      /✓ handed off as fix-login-2 · fix-login was taken · your checkout is unchanged/u,
    );
    const replay = await handoffServer({
      answer: (response) => json(response, received({ replayed: true })),
    });
    expect((await run(replay, [], dana)).stdout).toMatch(
      /✓ already handed off as fix-login · your checkout is unchanged/u,
    );
  }, 30_000);

  it("sends the same bytes again when the connection ends with no answer", async () => {
    const w = world();
    const dana = newsroom(w);
    const server = await handoffServer({
      answer: (response, attempt) => {
        if (attempt === 1) response.socket?.destroy();
        else json(response, received());
      },
    });
    const result = await run(server, [], dana);
    expect(result.code, result.stderr).toBe(0);
    expect(server.bodies.map(sha256)).toEqual([
      sha256(server.bodies[0] ?? Buffer.alloc(0)),
      sha256(server.bodies[0] ?? Buffer.alloc(0)),
    ]);
    expect(result.stdout).toContain("  no answer · sending the same bundle again\n");
    expect(result.stdout).toContain("✓ handed off as fix-login");
  }, 30_000);

  it("says the hold as the answer observed it, and a failed one with its recovery", async () => {
    const w = world();
    const dana = newsroom(w);
    const running = await handoffServer({
      answer: (response) => json(response, received({ status: "running" })),
    });
    const held = await run(running, [], dana);
    expect(held.code, held.stderr).toBe(0);
    expect(held.stdout).toContain("· the session reads running\n");
    expect(held.stdout).not.toContain("held");

    const failing = await handoffServer({
      answer: (response) =>
        json(
          response,
          received({ status: "failed", summary: "hold failed: the workspace did not start" }),
        ),
    });
    const failed = await run(failing, [], dana);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain(
      "! not held · failed · hold failed: the workspace did not start\n",
    );
    expect(failed.stdout).not.toContain("✓ held");
    expect(failed.stderr).toBe(
      "mend: the hold failed · mend resume 3f2a1c0d --with shell opens the workspace with a shell\n",
    );
    const resumed = await runPrinted(failed.stderr, dana, (route) =>
      route.startsWith(`POST /api/sessions/${SESSION_ID}/resume`),
    );
    expect(resumed.bodies[`POST /api/sessions/${SESSION_ID}/resume`]).toEqual({ harness: "shell" });
  }, 30_000);

  it("says the prompt was not sent when the launch is refused, and how to start the agent", async () => {
    const w = world();
    const dana = newsroom(w);
    const server = await handoffServer({
      launch: (response) => {
        response.writeHead(409, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "no seat left for an agent" }));
      },
    });
    const result = await run(server, ["finish the tests"], dana);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("✓ handed off as fix-login");
    expect(result.stdout).not.toContain("✓ running");
    expect(result.stderr).toMatch(
      /^mend: .+ · the prompt was not sent · mend claude --worktree fix-login starts claude in the handoff\n$/u,
    );
    const started = await runPrinted(result.stderr, dana, (route) =>
      route.startsWith(`POST /api/sessions/${JOINED_ID}/launch`),
    );
    expect(started.bodies[`POST /api/projects/${project.id}/sessions`]).toMatchObject({
      harness: "claude",
      name: "fix-login",
    });
  }, 30_000);

  it("sends the same bytes again when a proxy answers 502", async () => {
    const w = world();
    const dana = newsroom(w);
    const server = await handoffServer({
      answer: (response, attempt) => {
        if (attempt === 1) {
          response.writeHead(502, { "content-type": "text/html" });
          response.end("<html><body>502 Bad Gateway</body></html>");
        } else json(response, received());
      },
    });
    const result = await run(server, [], dana);
    expect(result.code, result.stderr).toBe(0);
    expect(server.bodies).toHaveLength(2);
    expect(sha256(server.bodies[1] ?? Buffer.alloc(0))).toBe(
      sha256(server.bodies[0] ?? Buffer.alloc(0)),
    );
    expect(result.stdout).toContain("  HTTP 502 · sending the same bundle again\n");
    expect(result.stdout).toContain("✓ handed off as fix-login");
  }, 30_000);

  it("says something in front of the server refused the bundle on a 413 that is not Mend's", async () => {
    const w = world();
    const dana = newsroom(w);
    const server = await handoffServer({
      answer: (response) => {
        response.writeHead(413, { "content-type": "text/html" });
        response.end("<html><body>413 Request Entity Too Large</body></html>");
      },
    });
    const result = await run(server, [], dana);
    const size = server.bodies[0]?.length ?? 0;
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `mend: handoff not sent · something in front of the Mend server refused the ${formatBytes(size).replace(".0 ", " ")} bundle (${size} bytes) with HTTP 413 · its body limit is below the bundle · nothing was created\n`,
    );
  }, 30_000);

  it("refuses a TMPDIR inside the checkout, its git dir included, before writing anything", async () => {
    const w = world();
    const dana = newsroom(w);
    for (const inside of [path.join(dana, "tmp-here"), path.join(dana, ".git", "tmp-here")]) {
      fs.mkdirSync(inside, { recursive: true });
      const before = fingerprint(dana);
      const server = await handoffServer();
      const result = await run(server, [], dana, { TMPDIR: inside });
      expect(result.code).toBe(1);
      expect(result.stderr).toBe(
        `mend: TMPDIR is ${inside}, inside this checkout, and a handoff writes nothing there · set TMPDIR elsewhere, then hand off again · nothing was created\n`,
      );
      expect(fingerprint(dana)).toEqual(before);
      expect(server.routes.filter((route) => route.startsWith("POST"))).toEqual([]);
    }
  }, 30_000);

  it("tells an old server by its bare 404, before building anything", async () => {
    const w = world();
    const dana = newsroom(w);
    const server = await handoffServer({ terms: (response) => response.writeHead(404).end() });
    const result = await run(server, [], dana);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(OLD_SERVER);
    expect(result.stdout).not.toContain("bundling");
    expect(server.routes.filter((route) => route.startsWith("POST"))).toEqual([]);
  }, 30_000);

  it("reads a 413 on the body budget as an old server, and on the bundle budget as too large", async () => {
    const w = world();
    const dana = newsroom(w);
    const bodyBudget = await handoffServer({ answer: json413("bodyBytes", 1024 * 1024) });
    const old = await run(bodyBudget, [], dana);
    expect(old.code).toBe(1);
    expect(old.stderr).toBe(OLD_SERVER);
    const bundleBudget = await handoffServer({ answer: json413("bundleBytes", 1024) });
    const large = await run(bundleBudget, [], dana);
    const size = bundleBudget.bodies[0]?.length ?? 0;
    expect(large.code).toBe(1);
    expect(large.stderr).toBe(
      `mend: handoff not sent · the bundle is ${formatBytes(size).replace(".0 ", " ")} (${size} bytes) · the server's limit is 1 KiB (MEND_BUDGET_BUNDLE_BYTES) · nothing was created\n`,
    );
  }, 30_000);

  it("refuses a bundle over the server's terms before uploading it", async () => {
    const w = world();
    const dana = newsroom(w);
    const server = await handoffServer({
      terms: (response) => json(response, { bundleBytes: 100, fileBytes: FILE_BYTES }),
    });
    const tmp = fs.mkdtempSync(path.join(w.root, "tmp-"));
    const result = await run(server, [], dana, { TMPDIR: tmp });
    expect(fs.readdirSync(tmp)).toEqual([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(
      /^mend: handoff not sent · the bundle is .+ \(\d+ bytes\) · the server's limit is 100 bytes \(MEND_BUDGET_BUNDLE_BYTES\) · nothing was created\n$/u,
    );
    expect(server.routes.filter((route) => route.startsWith("POST"))).toEqual([]);
  }, 30_000);

  it("prints the server's words when it refuses the handoff", async () => {
    const w = world();
    const dana = newsroom(w);
    const message =
      "this project's store is co-located with the server, which takes no handoffs · nothing was created";
    const server = await handoffServer({
      terms: (response) => {
        response.writeHead(422, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ _tag: "HandoffRefused", reason: "store-co-located", message }),
        );
      },
    });
    const result = await run(server, [], dana);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`mend: ${message}\n`);
  }, 30_000);

  it("refuses a foreign origin, by directory name and by --project alike", async () => {
    const w = world();
    const fork = newsroom(w, "newsroom-api", "https://github.com/someone/newsroom-api-fork.git");
    const refusal = `mend: this checkout's origin is https://github.com/someone/newsroom-api-fork.git · newsroom-api's is ${ORIGIN} · nothing was created\n`;
    for (const args of [[], ["--project", "newsroom-api"]]) {
      const server = await handoffServer();
      const result = await run(server, args, fork);
      expect(result.code).toBe(1);
      expect(result.stderr).toBe(refusal);
      expect(server.routes).toEqual(["GET /api/projects"]);
    }
  }, 30_000);

  it("refuses what the checkout or the server would refuse before it offers to adopt", async () => {
    const w = world();
    const unborn = path.join(w.root, "unborn");
    w.git(w.root, ["init", "-q", "-b", "main", unborn]);
    w.git(unborn, ["remote", "add", "origin", ORIGIN]);

    const conflicted = newsroom(w, "conflicted");
    w.git(conflicted, ["stash", "-q", "-u"]);
    w.git(conflicted, ["switch", "-q", "-c", "theirs", "origin/main"]);
    w.write(path.join(conflicted, "a.txt"), "theirs\n");
    w.git(conflicted, ["commit", "-q", "-am", "theirs"]);
    expect(() => w.git(conflicted, ["merge", "-q", "fix/login"])).toThrow();

    const untracked = newsroom(w, "untracked-main");
    w.git(untracked, ["update-ref", "-d", "refs/remotes/origin/main"]);

    const cases: ReadonlyArray<readonly [string, string, "bind" | "sources"]> = [
      [
        unborn,
        "this branch has no commit yet · commit once, then hand off · nothing was created",
        "sources",
      ],
      [
        conflicted,
        "1 unmerged path · finish or abort the merge, then hand off · nothing was created",
        "sources",
      ],
      [
        untracked,
        "this checkout has no origin/main · run git fetch origin, then hand off again · nothing was created",
        "sources",
      ],
      [
        newsroom(w, "co-located"),
        "this server keeps worktrees in the co-located store, which takes no handoffs · the operator can unset MEND_SESSION_STORE to run the capture store · nothing was created",
        "bind",
      ],
    ];
    for (const [checkout, words, mountDelivery] of cases) {
      const before = fingerprint(checkout);
      const server = await handoffServer({ projects: [], mountDelivery });
      const result = await run(server, ["--yes"], checkout);
      expect(result.stderr).toBe(`mend: ${words}\n`);
      expect(result.code).toBe(1);
      expect(server.adoptions).toEqual([]);
      expect(server.routes.filter((route) => route.startsWith("POST"))).toEqual([]);
      expect(fingerprint(checkout)).toEqual(before);
    }
  }, 60_000);

  it("says what it adopted when a refusal comes after the adoption", async () => {
    const w = world();
    const dana = newsroom(w);
    const server = await handoffServer({
      projects: [],
      terms: (response) => json(response, { bundleBytes: 100, fileBytes: FILE_BYTES }),
    });
    const result = await run(server, ["--yes"], dana);
    expect(result.code).toBe(1);
    expect(server.adoptions).toHaveLength(1);
    expect(result.stderr).toMatch(
      /^mend: handoff not sent · the bundle is .+ · nothing was handed off · newsroom-api stays adopted\n$/u,
    );
  }, 30_000);

  it("removes its copy of the work from TMPDIR when Ctrl-C lands while it bundles", async () => {
    const w = world();
    const dana = newsroom(w);
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const shims = fs.mkdtempSync(path.join(w.root, "shims-"));
    const bundling = path.join(w.root, "bundling");
    fs.writeFileSync(
      path.join(shims, "git"),
      `#!/bin/sh\ncase " $* " in *" bundle create "*) : > '${bundling}'; sleep 2;; esac\nexec '${realGit}' "$@"\n`,
      { mode: 0o755 },
    );
    const tmp = fs.mkdtempSync(path.join(w.root, "tmp-"));
    const server = await handoffServer();
    const env = { TMPDIR: tmp, PATH: `${shims}:${process.env["PATH"] ?? ""}` };
    const cli = startCli(server.server.url, ["handoff"], env, dana);
    await waitFor(() => fs.existsSync(bundling));
    expect(fs.readdirSync(tmp)).not.toEqual([]);
    cli.child.kill("SIGINT");
    const { code } = await cli.exited;
    await server.server.close();
    expect(code, cli.stderr()).toBe(130);
    expect(cli.stderr()).toBe("mend: interrupted · nothing was created\n");
    expect(fs.readdirSync(tmp)).toEqual([]);
    expect(server.routes.filter((route) => route.startsWith("POST"))).toEqual([]);
  }, 30_000);

  it("shares this machine's ssh-agent while it runs, for a server in bridge mode", async () => {
    const w = world();
    const dana = newsroom(w);
    // The fake never answers a close handshake; a dropped socket lets the stopped share end.
    const server = await handoffServer({ socket: "drop" });
    const result = await run(server, [], dana, { SSH_AUTH_SOCK: path.join(w.root, "agent.sock") });
    expect(result.code, result.stderr).toBe(0);
    expect(server.routes[0]).toBe("GET /api/me/git-access");
  }, 30_000);

  it("offers to adopt the origin; without a terminal it needs --yes", async () => {
    const w = world();
    const dana = newsroom(w);
    const refused = await handoffServer({ projects: [] });
    const result = await run(refused, [], dana);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      "mend: non-interactive · pass --yes to adopt github.com/acme/newsroom-api and hand off · nothing was created\n",
    );
    expect(refused.routes.filter((route) => route.startsWith("POST"))).toEqual([]);

    const adopting = await handoffServer({ projects: [] });
    const adopted = await run(adopting, ["--yes"], dana);
    expect(adopted.code, adopted.stderr).toBe(0);
    expect(adopting.adoptions).toEqual([{ name: "newsroom-api", source: ORIGIN }]);
    expect(adopted.stdout).toContain("✓ adopted · newsroom-api");
    expect(adopted.stdout).toContain("✓ handed off as fix-login");

    const old = await handoffServer({
      projects: [],
      terms: (response) => response.writeHead(404).end(),
    });
    const before = await run(old, ["--yes"], dana);
    expect(before.stderr).toBe(OLD_SERVER);
    expect(old.routes.filter((route) => route.startsWith("POST"))).toEqual([]);
  }, 30_000);
});

describe("mend handoff's adoption offer at a terminal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const inProcess = (projects: ReadonlyArray<unknown>) => {
    const calls: Array<string> = [];
    const deps: HandoffDeps = {
      api: async (method, route) => {
        calls.push(`${method} ${route}`);
        const answer: unknown = route === "/projects" && method === "GET" ? projects : project;
        return JSON.parse(JSON.stringify(answer));
      },
      download: async (route) => {
        calls.push(`GET ${route}`);
        const known = route === `/projects/${project.id}/handoffs`;
        const body = known
          ? { bundleBytes: 64 * 1024 * 1024, fileBytes: FILE_BYTES }
          : { _tag: "NotFound", id: "handoff-probe" };
        return {
          status: known ? 200 : 404,
          header: () => null,
          bytes: new TextEncoder().encode(JSON.stringify(body)),
        };
      },
      upload: async (route) => {
        calls.push(`POST ${route}`);
        return {
          _tag: "answered",
          status: 200,
          header: () => null,
          bytes: new TextEncoder().encode(JSON.stringify(received())),
        };
      },
      serverVersion: async () => "0.36.0",
      launch: async () => ({ _tag: "running" }),
      spin: (_label, work) => work,
      serverUrl: "http://localhost:3105",
    };
    return { calls, deps };
  };

  it("paints its marks with escape sequences at a terminal", async () => {
    const w = world();
    const dana = newsroom(w);
    const out = capture();
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      await handoffCommand(inProcess([project]).deps, [], dana, {
        interactive: true,
        ask: async () => true,
      });
    } finally {
      if (tty === undefined) Reflect.deleteProperty(process.stdout, "isTTY");
      else Object.defineProperty(process.stdout, "isTTY", tty);
    }
    const text = out.join("");
    expect(text).toContain("\u001b[32m✓\u001b[0m handed off as fix-login");
    expect(text).toContain("\u001b[2m  attach\u001b[0m · mend attach 3f2a1c0d");
    expect(text.replaceAll("\u001b[", "")).not.toMatch(/\[\d+m/u);
  });

  for (const answer of [true, false]) {
    it(`adopts and hands off only on yes (answer: ${String(answer)})`, async () => {
      const w = world();
      const dana = newsroom(w);
      const out = capture();
      const { calls, deps } = inProcess([]);
      const asked: Array<string> = [];
      await handoffCommand(deps, [], dana, {
        interactive: true,
        ask: async (question) => {
          asked.push(question);
          return answer;
        },
      });
      expect(asked).toEqual(["adopt github.com/acme/newsroom-api as newsroom-api and hand off?"]);
      const posts = calls.filter((call) => call.startsWith("POST"));
      if (answer) {
        expect(posts).toEqual([
          "POST /projects",
          `POST /projects/${project.id}/handoffs?harness=claude&hold=true`,
        ]);
        expect(out.join("")).toContain("✓ handed off as fix-login");
      } else {
        expect(posts).toEqual([]);
        expect(out.join("")).toBe("nothing was adopted or handed off\n");
      }
    });
  }
});
