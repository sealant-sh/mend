import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { HANDOFF_SNAPSHOT_REF } from "@mend/domain/workbench";
import {
  detachedNewsroomCheckout,
  fingerprint,
  hiddenNewsroomCheckout,
} from "@mend/local-git/testing";
import { describe, expect, it } from "vitest";

import { formatBytes } from "./landing.ts";
import {
  mainHandoffFixtures,
  newsroom,
  ORIGIN,
  project,
  received,
  SESSION_ID,
  withBody,
} from "./test/main-handoff-fixtures.ts";

const { handoffServer, json, run, spawning, startCli, startFakeMend, waitFor, world } =
  mainHandoffFixtures();

const lines = (text: string): ReadonlyArray<string> => text.split("\n").filter((l) => l !== "");

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const sshAgentEnv = (w: ReturnType<typeof world>) => ({
  SSH_AUTH_SOCK: path.join(w.root, "agent.sock"),
});

const agentShareSockets = (server: Awaited<ReturnType<typeof handoffServer>>) =>
  server.server.upgradeUrls().filter((url) => url.startsWith("/api/keys/bridge/ws"));

const JOINED_ID = "7c1d2e3f-0a1b-4c2d-8e3f-4a5b6c7d8e9f";

/** Another project adopted from the same origin, with a worktree of the same name. */
const twin = { ...project, id: "project-0", name: "newsroom-api-2" };

/** The words of the `mend …` command a refusal printed, as a shell splits them. */
const printedCommand = (stderr: string): ReadonlyArray<string> => {
  const printed = /· mend ((?:resume|claude) [^·\n]*?) (?:opens|starts) /u.exec(stderr)?.[1];
  if (printed === undefined) throw new Error(`no command in ${stderr}`);
  return execFileSync("sh", ["-c", `set -- ${printed}; printf '%s\\0' "$@"`], {
    encoding: "utf8",
  })
    .split("\0")
    .slice(0, -1);
};

/**
 * Runs the `mend …` command a refusal printed, in the same checkout, until `reached` is seen. The
 * server holds the handoff's worktree and its never-launched session in `project`, and a worktree
 * of the same name in a twin adopted from the same origin, listed first.
 */
const runPrinted = async (
  stderr: string,
  cwd: string,
  reached: (route: string) => boolean,
): Promise<{ readonly bodies: Readonly<Record<string, unknown>> }> => {
  const words = printedCommand(stderr);
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
  const detailOf = (of: typeof project) => ({
    project: of,
    sessions: of.id === project.id ? [handoffSession] : [],
    annotations: [],
    worktrees: [{ id: `worktree-of-${of.id}`, name: "fix-login", branch: "mend/fix-login" }],
  });
  const server = await startFakeMend((request, response) => {
    const route = `${request.method ?? "GET"} ${request.url ?? ""}`;
    routes.push(route);
    withBody(request, (body) => {
      if (body.length > 0) bodies[route] = JSON.parse(body.toString());
      const projectPost = /^POST \/api\/projects\/([^/]+)\/sessions$/u.exec(route)?.[1];
      if (route === "GET /api/projects") json(response, [twin, project]);
      else if (route === `GET /api/projects/${project.id}`) json(response, detailOf(project));
      else if (route === `GET /api/projects/${twin.id}`) json(response, detailOf(twin));
      else if (projectPost !== undefined) {
        json(response, {
          ...handoffSession,
          projectId: projectPost,
          id: JOINED_ID,
          status: "starting",
        });
      } else if (route.startsWith("POST /api/sessions/")) {
        json(response, { ...handoffSession, status: "starting" });
      } else response.writeHead(404).end();
    });
  }, "hold");
  const cli = startCli(server.url, words, {}, cwd);
  try {
    await waitFor(() => routes.some(reached) || cli.stderr() !== "");
  } finally {
    cli.child.kill("SIGKILL");
    await server.close();
  }
  expect(routes.some(reached), cli.stderr()).toBe(true);
  return { bodies };
};

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

  it("names each file whose edit travels though it is hidden from git", async () => {
    const w = world();
    const dana = hiddenNewsroomCheckout(w, ORIGIN);
    const server = await handoffServer();
    const result = await run(server, [], dana);
    expect(result.code, result.stderr).toBe(0);
    expect(lines(result.stdout).slice(1, 6)).toEqual([
      "✓ fix/login · 2 commits ahead of main · 4 uncommitted files · 1 untracked",
      "  stays here · gitignored files and .env files: .env.local",
      "  travels though hidden from git · b.txt (skip-worktree)",
      "  travels though hidden from git · docs/guide.md (assume-unchanged)",
      "  left out · assets/demo.mov · 100 KiB, over the 64 KiB file limit",
    ]);
  }, 30_000);

  it("hands off a detached HEAD under its own name, and takes --with", async () => {
    const w = world();
    const dana = detachedNewsroomCheckout(w, ORIGIN);
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
      "mend: the hold failed · mend resume 3f2a1c0d --project newsroom-api --with shell opens the workspace with a shell\n",
    );
    const resumed = await runPrinted(failed.stderr, dana, (route) =>
      route.startsWith(`POST /api/sessions/${SESSION_ID}/resume`),
    );
    expect(resumed.bodies[`POST /api/sessions/${SESSION_ID}/resume`]).toEqual({ harness: "shell" });
  }, 30_000);

  it("says the prompt was not sent when the launch is refused, and the command that sends it", async () => {
    const w = world();
    const dana = newsroom(w);
    const refusing = () =>
      handoffServer({
        launch: (response) => {
          response.writeHead(409, { "content-type": "application/json" });
          response.end(JSON.stringify({ message: "no seat left for an agent" }));
        },
      });
    const result = await run(await refusing(), ["finish the tests"], dana);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("✓ handed off as fix-login");
    expect(result.stdout).not.toContain("✓ running");
    expect(result.stderr).toMatch(
      /^mend: .+ · the prompt was not sent · mend claude --project newsroom-api --worktree fix-login 'finish the tests' starts claude in the handoff with it\n$/u,
    );
    const prompt = "finish Dana's tests, then $HOME `ls`";
    const quoted = await run(await refusing(), [prompt], dana);
    const started = await runPrinted(quoted.stderr, dana, (route) =>
      route.startsWith(`POST /api/sessions/${JOINED_ID}/launch`),
    );
    expect(started.bodies[`POST /api/projects/${project.id}/sessions`]).toMatchObject({
      harness: "claude",
      name: "fix-login",
    });
    expect(started.bodies[`POST /api/projects/${twin.id}/sessions`]).toBeUndefined();
    expect(started.bodies[`POST /api/sessions/${JOINED_ID}/launch`]).toMatchObject({ prompt });
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

  describe("this machine's ssh-agent", () => {
    it("is not shared for a Mend-key project, whatever the account default", async () => {
      const w = world();
      const dana = newsroom(w);
      const server = await handoffServer({
        projects: [{ ...project, gitAuthMode: "mend-key" }],
        accountMode: "bridge",
        socket: "drop",
      });
      const result = await run(server, [], dana, sshAgentEnv(w));
      expect(result.code, result.stderr).toBe(0);
      expect(agentShareSockets(server)).toEqual([]);
    }, 30_000);

    it("is shared while it runs for a bridge project, whatever the account default", async () => {
      const w = world();
      const dana = newsroom(w);
      // The fake never answers a close handshake; a dropped socket lets the stopped share end.
      const server = await handoffServer({
        projects: [{ ...project, gitAuthMode: "bridge" }],
        accountMode: "mend-key",
        socket: "drop",
      });
      const result = await run(server, [], dana, sshAgentEnv(w));
      expect(result.code, result.stderr).toBe(0);
      expect(agentShareSockets(server)).toHaveLength(1);
    }, 30_000);

    it("is shared for an adoption when the account default, the mode it adopts with, is bridge", async () => {
      const w = world();
      const dana = newsroom(w);
      const server = await handoffServer({ projects: [], accountMode: "bridge", socket: "drop" });
      const result = await run(server, ["--yes"], dana, sshAgentEnv(w));
      expect(result.code, result.stderr).toBe(0);
      expect(server.adoptions).toHaveLength(1);
      expect(agentShareSockets(server)).toHaveLength(1);
    }, 30_000);
  });
});
