import * as fs from "node:fs";
import { type IncomingMessage, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { mainTestFixtures, type HttpHandler } from "./main-test-fixtures.ts";

const { project, session, json, spawning, startCli, startFakeMend, waitFor, expectExit, git } =
  mainTestFixtures();

describe("Mend CLI session selection", spawning, () => {
  const retained = (request: IncomingMessage, response: ServerResponse): boolean => {
    if (request.url?.startsWith("/api/sessions?retained") === true) {
      json(response, [session]);
      return true;
    }
    if (request.url === "/api/projects") {
      json(response, [project]);
      return true;
    }
    return false;
  };

  it("attach with no id takes the only session instead of a usage error", async () => {
    const fake = await startFakeMend((request, response) => {
      if (!retained(request, response)) response.writeHead(404).end();
    });
    const cli = startCli(fake.url, ["attach"]);

    try {
      await fake.endFrameSent;
      await expectExit(cli.exited, () => cli.stdout() + cli.stderr());
      expect(fake.upgradedSessions()).toEqual([session.id]);
      expect(cli.stdout()).toContain("attaching to");
      expect(cli.stdout()).toContain("session ended");
      expect(cli.stderr()).not.toContain("mend attach <session-id-prefix>");
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  });

  it("stop with no id stops the only session", async () => {
    const stopped: Array<string> = [];
    const fake = await startFakeMend((request, response) => {
      if (retained(request, response)) return;
      if (request.url === `/api/sessions/${session.id}/stop`) {
        stopped.push(session.id);
        json(response, session);
      } else response.writeHead(404).end();
    });
    const cli = startCli(fake.url, ["stop"]);

    try {
      await cli.exited;
      expect(stopped, cli.stderr()).toEqual([session.id]);
      expect(cli.stdout()).toContain("stopped");
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  });

  it("words a refusal that carries no sentence, never the call, the status or the tag", async () => {
    for (const [status, body] of [
      [409, { _tag: "SessionNotLive", id: session.id }],
      [500, null],
    ] as const) {
      const fake = await startFakeMend((request, response) => {
        if (retained(request, response)) return;
        if (request.url === `/api/sessions/${session.id}/stop`) {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(body === null ? "" : JSON.stringify(body));
        } else response.writeHead(404).end();
      });
      const cli = startCli(fake.url, ["stop"]);
      try {
        await cli.exited;
        expect(cli.stderr()).not.toMatch(/SessionNotLive|→|\/sessions\/|409|500/);
        expect(cli.stderr()).toContain(
          status === 409
            ? "The session's workspace is not running — resume the session, then retry."
            : "Mend could not do that. Try again; the server log has the detail.",
        );
      } finally {
        cli.child.kill("SIGKILL");
        await fake.close();
      }
    }
  });

  it("stop takes the session id it is given, first on the line, with no --project", async () => {
    const second = { ...session, id: "session-5678", worktree: "session-5678" };
    const stopped: Array<string> = [];
    const fake = await startFakeMend((request, response) => {
      if (request.url === "/api/sessions") json(response, [session, second]);
      else if (request.url === "/api/projects") json(response, [project]);
      else if (request.url === `/api/sessions/${second.id}/stop`) {
        stopped.push(second.id);
        json(response, second);
      } else response.writeHead(404).end();
    });
    const cli = startCli(fake.url, ["stop", "session-56"]);

    try {
      await cli.exited;
      expect(stopped, cli.stderr()).toEqual([second.id]);
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  });

  it("resume takes the session id it is given, first on the line, with no --with", async () => {
    const settled = { ...session, status: "stopped" };
    const second = { ...settled, id: "session-5678", worktree: "session-5678" };
    // A clone of the project's origin, the directory the CLI runs in.
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), "mend-cli-resume-"));
    git(clone, ["init", "-q", "-b", "main"]);
    git(clone, ["remote", "add", "origin", "https://github.com/acme/fixture.git"]);
    const adopted = { ...project, originUrl: "https://github.com/acme/fixture.git" };
    const resumed: Array<string> = [];
    const fake = await startFakeMend((request, response) => {
      const route = `${request.method ?? "GET"} ${request.url ?? ""}`;
      if (route === "GET /api/projects") json(response, [adopted]);
      else if (route === `GET /api/projects/${project.id}`) {
        // The newest settled session first: the one a resume without an id picks.
        json(response, { project: adopted, sessions: [settled, second], annotations: [] });
      } else if (request.method === "POST" && request.url?.endsWith("/resume") === true) {
        resumed.push(request.url);
        response.writeHead(409, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "stop here" }));
      } else response.writeHead(404).end();
    });
    const cli = startCli(fake.url, ["resume", "session-56"], {}, clone);

    try {
      await cli.exited;
      expect(resumed, cli.stderr()).toEqual([`/api/sessions/${second.id}/resume`]);
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
      fs.rmSync(clone, { recursive: true, force: true });
    }
  });

  it("says which machine a handed-off worktree's sessions came from", async () => {
    const worktree = {
      id: "fixture",
      name: "fixture",
      branch: "mend/fixture",
      baseSha: "abc123",
      baseRef: "main",
      createdAt: new Date(0).toISOString(),
      handoff: null,
    };
    const handedOffWorktree = {
      ...worktree,
      id: "fix-login",
      name: "fix-login",
      branch: "mend/fix-login",
      handoff: { machine: "dana-mbp" },
    };
    const handedOff = { ...session, id: "aaaa1111-handed", worktreeId: "fix-login" };
    const local = { ...session, id: "bbbb2222-local", worktreeId: "fixture" };
    const fake = await startFakeMend((request, response) => {
      const route = `${request.method ?? "GET"} ${request.url ?? ""}`;
      if (route === "GET /api/projects") json(response, [project]);
      else if (route === `GET /api/projects/${project.id}?deadEnds=include`) {
        json(response, {
          project,
          sessions: [handedOff, local],
          annotations: [],
          worktrees: [handedOffWorktree, worktree],
        });
      } else response.writeHead(404).end();
    });
    const cli = startCli(fake.url, ["sessions", "--all"]);
    try {
      await cli.exited;
      const rowOf = (id8: string) =>
        cli
          .stdout()
          .split("\n")
          .find((line) => line.includes(id8)) ?? "";
      expect(rowOf("aaaa1111"), cli.stderr()).toContain("handed off from dana-mbp");
      expect(rowOf("bbbb2222")).not.toBe("");
      expect(rowOf("bbbb2222")).not.toContain("handed off");
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  });

  it("prints --json with each field intact: a URL label and an @ in a summary stay theirs", async () => {
    // Redacting the printed document as text took the summary's `a@b.test` for the label URL's
    // userinfo and dropped fields (review 3 of mend#640, R3-4); each string is redacted alone now.
    const labelled = {
      ...session,
      worktreeId: "worktree-1",
      status: "completed",
      label: "https://example.com",
      summary: "contact a@b.test, token at https://oauth2:TOKEN@github.com/acme/r.git",
    };
    const worktree = {
      id: "worktree-1",
      name: "fixture",
      branch: "mend/fixture",
      baseSha: "abc123",
      baseRef: "main",
      createdAt: new Date(0).toISOString(),
    };
    const fake = await startFakeMend((request, response) => {
      const route = `${request.method ?? "GET"} ${request.url ?? ""}`;
      if (route === "GET /api/projects") json(response, [project]);
      else if (route === `GET /api/projects/${project.id}`) {
        json(response, { project, sessions: [labelled], annotations: [], worktrees: [worktree] });
      } else if (request.url?.startsWith("/api/sessions") === true) json(response, [labelled]);
      else response.writeHead(404).end();
    });

    try {
      for (const args of [
        ["worktrees", "--json"],
        ["sessions", "--json=v2"],
      ]) {
        const cli = startCli(fake.url, args);
        await expectExit(cli.exited, () => cli.stdout() + cli.stderr());
        expect(cli.stdout()).not.toContain("TOKEN");
        const printed: unknown = JSON.parse(cli.stdout());
        expect(JSON.stringify(printed)).toContain('"label":"https://example.com"');
        expect(JSON.stringify(printed)).toContain('"status":"completed"');
        expect(JSON.stringify(printed)).toContain(
          '"summary":"contact a@b.test, token at https://github.com/acme/r.git"',
        );
        cli.child.kill("SIGKILL");
      }
    } finally {
      await fake.close();
    }
  });

  it("names the command it could not disambiguate when no terminal can pick", async () => {
    const second = { ...session, id: "session-5678", worktree: "session-5678" };
    const fake = await startFakeMend((request, response) => {
      if (request.url?.startsWith("/api/sessions?retained") === true) {
        json(response, [session, second]);
      } else if (request.url === "/api/projects") json(response, [project]);
      else response.writeHead(404).end();
    });
    const cli = startCli(fake.url, ["attach"]);

    try {
      await cli.exited;
      expect(cli.stderr()).toContain("mend attach <session-id-prefix>");
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  });
});

describe("Mend CLI session exit", spawning, () => {
  it("returns on the terminal end frame without waiting for the socket to close", async () => {
    const fake = await startFakeMend((request, response) => {
      if (request.url === "/api/sessions") json(response, [session]);
      else response.writeHead(404).end();
    });
    const cli = startCli(fake.url, ["attach", "session-"]);

    try {
      await fake.endFrameSent;
      await expectExit(cli.exited, cli.stderr);
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  });

  it("does no Mend API work after a freshly launched harness ends", async () => {
    let lifecycleEnded = false;
    const postEndRequests: Array<string> = [];
    const fake = await startFakeMend((request, response) => {
      const route = `${request.method ?? "GET"} ${request.url ?? ""}`;
      if (lifecycleEnded) {
        postEndRequests.push(route);
        return;
      }
      if (route === "GET /api/projects") json(response, [project]);
      else if (route === `POST /api/projects/${project.id}/sessions`) json(response, session);
      else if (route === `POST /api/sessions/${session.id}/launch`) json(response, session);
      else response.writeHead(404).end();
    });
    const cli = startCli(fake.url, ["codex", "--project", project.name]);

    try {
      await fake.endFrameSent;
      lifecycleEnded = true;
      await expectExit(cli.exited, cli.stderr);
      expect(postEndRequests).toEqual([]);
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  });
});

describe("Mend CLI session lifecycle", spawning, () => {
  const launchRoutes = (routes: Array<string>): HttpHandler => {
    return (request, response) => {
      const route = `${request.method ?? "GET"} ${request.url ?? ""}`;
      routes.push(route);
      if (route === "GET /api/projects") json(response, [project]);
      else if (route === "GET /api/settings") json(response, { backgroundSessions: false });
      else if (route === `POST /api/projects/${project.id}/sessions`) json(response, session);
      else if (route === `POST /api/sessions/${session.id}/launch`) json(response, session);
      else if (route === `POST /api/sessions/${session.id}/stop`) json(response, session);
      else response.writeHead(404).end();
    };
  };

  it("--detach launches without attaching and prints the reattach hint", async () => {
    const routes: Array<string> = [];
    const fake = await startFakeMend(launchRoutes(routes), "hold");
    const cli = startCli(fake.url, ["codex", "--project", project.name, "--detach"]);

    try {
      // The exit check starts once the fake saw the launch land: the CLI's
      // cold start (node boot + type stripping) is CI-speed, not under test.
      await waitFor(() => routes.includes(`POST /api/sessions/${session.id}/launch`));
      await expectExit(cli.exited, cli.stderr);
      expect(fake.upgradeCount()).toBe(0);
      expect(routes).not.toContain("GET /api/settings"); // the flag decides — no read
      expect(cli.stdout()).toContain(`mend attach ${session.id.slice(0, 8)}`);
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  });

  it("foreground: a SIGTERM mid-attach stops the session before exiting", async () => {
    const routes: Array<string> = [];
    const fake = await startFakeMend(launchRoutes(routes), "hold");
    const cli = startCli(fake.url, ["codex", "--project", project.name]);

    try {
      await fake.upgraded;
      cli.child.kill("SIGTERM");
      const outcome = await Promise.race([
        cli.exited,
        new Promise<{ readonly kind: "timeout" }>((resolve) =>
          setTimeout(() => resolve({ kind: "timeout" }), 4000),
        ),
      ]);
      expect(outcome, cli.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(routes).toContain(`POST /api/sessions/${session.id}/stop`);
      expect(cli.stdout()).toContain("stopped");
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  });

  it("foreground: the harness ending naturally sends no stop", async () => {
    const routes: Array<string> = [];
    const fake = await startFakeMend(launchRoutes(routes), "end");
    const cli = startCli(fake.url, ["codex", "--project", project.name]);

    try {
      await fake.endFrameSent;
      await expectExit(cli.exited, cli.stderr);
      expect(routes).not.toContain(`POST /api/sessions/${session.id}/stop`);
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  });

  it("background: a dropped socket says the session keeps running, not that it ended", async () => {
    const fake = await startFakeMend((request, response) => {
      if (request.url === "/api/sessions") json(response, [session]);
      else response.writeHead(404).end();
    }, "drop");
    const cli = startCli(fake.url, ["attach", "session-"]);

    try {
      const outcome = await Promise.race([
        cli.exited,
        new Promise<{ readonly kind: "timeout" }>((resolve) =>
          setTimeout(() => resolve({ kind: "timeout" }), 4000),
        ),
      ]);
      expect(outcome, cli.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(cli.stdout()).toContain("keeps running");
      expect(cli.stdout()).not.toContain("session ended");
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  });
});

describe("a long launch", spawning, () => {
  it("follows the session when the launch request is cut, and never says the server cannot be reached", async () => {
    let reads = 0;
    const agent = {
      status: "running",
      exitCode: null,
      exitedAt: null,
      harness: "codex",
      sealantSessionId: "pty-1",
      kind: "agent-pty",
    };
    const fake = await startFakeMend((request, response) => {
      const route = `${request.method ?? "GET"} ${request.url ?? ""}`;
      if (route === "GET /api/projects") json(response, [project]);
      else if (route === `POST /api/projects/${project.id}/sessions`) {
        json(response, { ...session, status: "starting" });
      } else if (route === `POST /api/sessions/${session.id}/launch`) {
        // An edge (or fetch's own five-minute limit) gives up on the long request while Mend
        // keeps preparing the workspace.
        setTimeout(() => request.socket.destroy(), 100);
      } else if (route === `GET /api/sessions/${session.id}`) {
        reads += 1;
        json(
          response,
          reads < 3
            ? {
                session: {
                  ...session,
                  status: "starting",
                  summary: "preparing the workspace",
                },
                currentAgent: null,
              }
            : { session, currentAgent: agent },
        );
      } else response.writeHead(404).end();
    }, "end");
    const cli = startCli(fake.url, ["codex", "--project", project.name]);

    try {
      await Promise.race([fake.endFrameSent, cli.exited]);
      await expectExit(cli.exited, () => cli.stdout() + cli.stderr());
      expect(cli.stderr()).not.toContain("cannot reach");
      expect(cli.stdout()).toContain("starting · preparing the workspace");
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  }, 30_000);
});
