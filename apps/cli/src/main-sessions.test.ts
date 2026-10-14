import { once } from "node:events";
import * as fs from "node:fs";
import { type IncomingMessage, type ServerResponse } from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

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

describe("socket ticket support discovery", spawning, () => {
  it.each([
    "http-error",
    "malformed",
    "null",
    "array",
    "empty-object",
    "disconnect",
    "modern",
    "legacy",
  ])("mint 404 with %s health only permits an observed legacy socket", async (kind) => {
    const requests: Array<{
      method: string | undefined;
      url: string | undefined;
      auth: string | undefined;
    }> = [];
    const fake = await startFakeMend(
      (request, response) => {
        requests.push({
          method: request.method,
          url: request.url,
          auth: request.headers.authorization,
        });
        if (request.url?.startsWith("/api/sessions?retained") === true) json(response, [session]);
        else if (request.url === "/api/projects") json(response, [project]);
        else if (request.url === "/api/upgrade-tickets") response.writeHead(404).end();
        else if (request.url === "/api/health") {
          if (kind === "disconnect") request.socket.destroy();
          else if (kind === "http-error") response.writeHead(502).end();
          else if (kind === "malformed") response.writeHead(200).end("not JSON");
          else
            json(
              response,
              kind === "legacy"
                ? { status: "ok" }
                : kind === "modern"
                  ? { status: "ok", upgradeTickets: true }
                  : kind === "null"
                    ? null
                    : kind === "array"
                      ? []
                      : {},
            );
        } else response.writeHead(404).end();
      },
      "end",
      false,
    );
    const token = "synthetic-discovery-token";
    const cli = startCli(fake.url, ["attach"], { MEND_TOKEN: token });
    try {
      const exit = await cli.exited;
      expect(requests.filter((r) => r.url === "/api/upgrade-tickets")).toEqual([
        { method: "POST", url: "/api/upgrade-tickets", auth: `Bearer ${token}` },
      ]);
      expect(requests.filter((r) => r.url === "/api/health")).toEqual([
        { method: "GET", url: "/api/health", auth: undefined },
      ]);
      expect(cli.stdout() + cli.stderr()).not.toContain(token);
      if (kind === "legacy") {
        expect(exit.code, cli.stderr()).toBe(0);
        expect(fake.upgradeUrls()).toEqual([
          `/api/tty?session=${session.id}&from=0&token=${token}`,
        ]);
        expect(cli.stderr()).toContain("predates upgrade tickets");
      } else {
        expect(exit.code, cli.stdout() + cli.stderr()).toBe(1);
        expect(fake.upgradeUrls()).toEqual([]);
        expect(cli.stderr()).not.toContain("predates upgrade tickets");
      }
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

/** The requests a command must not make with nothing per-person to say. */
const personReads = (routes: ReadonlyArray<string>): ReadonlyArray<string> =>
  routes.filter(
    (route) =>
      route === "GET /api/organization" ||
      route === "GET /api/organization/members" ||
      route === "GET /api/sessions" ||
      route.endsWith("/waiting") ||
      route.endsWith("/workspace-retirement"),
  );

describe("people in a workspace (docs/adr/0016, decisions 13 and 14)", spawning, () => {
  const anna = { accountId: "anna", name: "Anna" };
  const bob = { accountId: "bob", name: "Bob" };
  const worktree = {
    id: "wt-1",
    name: "fix-auth",
    directory: "fix-auth",
    branch: "mend/fix-auth",
    baseSha: "abc123",
    baseRef: "main",
    createdAt: new Date(0).toISOString(),
  };
  const annas = { ...session, id: "annas-session", worktreeId: worktree.id, baseRef: "main" };
  const people = (
    handle: (route: string, response: ServerResponse) => boolean,
    /**
     * What the project view says of Anna's session beyond its row: who is live, shared control,
     * the retirement's state. By default per-person homes are possible and Anna and Bob are live.
     */
    view: Readonly<Record<string, unknown>> = {},
    routes: Array<string> = [],
  ): HttpHandler => {
    return (request, response) => {
      const route = `${request.method ?? "GET"} ${request.url ?? ""}`;
      routes.push(route);
      if (handle(route, response)) return;
      if (route === "GET /api/projects") json(response, [project]);
      else if (route === `GET /api/projects/${project.id}`) {
        json(response, {
          project,
          sessions: [{ ...annas, ownerUserId: "anna", livePeople: [anna, bob], ...view }],
          annotations: [],
          worktrees: [worktree],
        });
      } else if (route === "GET /api/organization") json(response, { userId: "bob" });
      else if (route === "GET /api/organization/members") json(response, []);
      else response.writeHead(404).end();
    };
  };
  /** Per-person homes off: the project view lists nobody live and no retirement. */
  const flagOff = { livePeople: [], workspaceRetirement: null, sharedControlEnabledAt: null };
  const launched = (route: string, response: ServerResponse): boolean => {
    if (route === `POST /api/projects/${project.id}/sessions`) json(response, session);
    else if (route === `POST /api/sessions/${session.id}/launch`) json(response, session);
    else return false;
    return true;
  };

  it("says the join line before a session starts where another person's session runs", async () => {
    const routes: Array<string> = [];
    const fake = await startFakeMend(people(launched, {}, routes));
    const cli = startCli(fake.url, [
      "codex",
      "--project",
      project.name,
      "--worktree",
      "fix-auth",
      "-d",
    ]);
    try {
      await cli.exited;
      const out = cli.stdout();
      expect(out, cli.stderr()).toContain(
        "Anna's session is running in this worktree. You share its workspace: everything you run runs as you, on your own logins, but either of you can read the other's files, logins included.",
      );
      expect(out.indexOf("Anna's session is running")).toBeLessThan(out.indexOf("✓ worktree"));
      // Read from the project view: no session list, and the project view once.
      expect(routes).not.toContain("GET /api/sessions");
      expect(routes.filter((route) => route === `GET /api/projects/${project.id}`)).toHaveLength(1);
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  });

  it("joins with per-person homes off without asking who you are or what runs there", async () => {
    const routes: Array<string> = [];
    const fake = await startFakeMend(people(launched, flagOff, routes));
    const cli = startCli(fake.url, [
      "codex",
      "--project",
      project.name,
      "--worktree",
      "fix-auth",
      "-d",
    ]);
    try {
      await cli.exited;
      const out = cli.stdout();
      expect(out, cli.stderr()).toContain("joins worktree fix-auth");
      expect(personReads(routes)).toEqual([]);
      // The CLI keeps no account id: the shared-home line would need one.
      expect(out).not.toContain("session is running in this worktree");
      expect(out).not.toContain("shares one home");
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  });

  it("mend sessions says the shared workspace, waiting and retirement lines under a live row", async () => {
    const fake = await startFakeMend(
      people(
        (route, response) => {
          if (route === `GET /api/sessions/${annas.id}/waiting`) {
            json(response, {
              line: "Waits for Anna's background task before Bob's turn starts.",
            });
          } else if (route === `GET /api/sessions/${annas.id}/workspace-retirement`) {
            json(response, {
              state: "marked",
              preRelease: true,
              launcher: "anna",
              stops: [],
              reason: null,
              checkedAt: null,
              fingerprint: "fp-1",
              canReplace: false,
            });
          } else return false;
          return true;
        },
        { sharedControlEnabledAt: new Date(0).toISOString(), workspaceRetirement: "marked" },
      ),
    );
    const cli = startCli(fake.url, ["sessions"]);
    try {
      await cli.exited;
      const out = cli.stdout();
      expect(out, cli.stderr()).toContain(
        "Shared workspace with Anna · each of you runs as yourself · either of you can read the other's files.",
      );
      expect(out).toContain("Waits for Anna's background task before Bob's turn starts.");
      expect(out).toContain(
        "This workspace started before Mend 0.36 and shares one home · it takes only Anna's sessions and turns until it is replaced",
      );
      // Not the change's owner: no action offered.
      expect(out).not.toContain("Replace this workspace now");
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  });

  it("mend sessions asks for no waiting line without shared control, and no retirement without one", async () => {
    const routes: Array<string> = [];
    const fake = await startFakeMend(
      people(() => false, { sharedControlEnabledAt: null, workspaceRetirement: null }, routes),
    );
    const cli = startCli(fake.url, ["sessions"]);
    try {
      await cli.exited;
      expect(cli.stdout(), cli.stderr()).toContain(
        "Shared workspace with Anna · each of you runs as yourself · either of you can read the other's files.",
      );
      expect(routes).not.toContain("GET /api/sessions");
      expect(routes.filter((route) => route.endsWith("/waiting"))).toEqual([]);
      expect(routes.filter((route) => route.endsWith("/workspace-retirement"))).toEqual([]);
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  });

  for (const command of ["sessions", "status"]) {
    it(`mend ${command} with per-person homes off makes no request beyond the project views`, async () => {
      const routes: Array<string> = [];
      const fake = await startFakeMend(people(() => false, flagOff, routes));
      const cli = startCli(fake.url, [command]);
      try {
        await cli.exited;
        expect(cli.stdout(), cli.stderr()).toContain(annas.id.slice(0, 8));
        expect(cli.stdout()).not.toContain("Shared workspace");
        expect(personReads(routes)).toEqual([]);
      } finally {
        cli.child.kill("SIGKILL");
        await fake.close();
      }
    });
  }
});

/** Keep unused ports owned; only hand the selected listener ports to the child CLI. */
const serviceConnectPorts = async (count: number) => {
  const reservations = new Map<number, net.Server>();
  const release = async (ports: ReadonlyArray<number>) => {
    for (const port of ports) {
      const server = reservations.get(port);
      if (server === undefined) throw new Error(`Missing reservation for ${port}.`);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }),
      );
      reservations.delete(port);
    }
  };
  onTestFinished(() => release([...reservations.keys()]));
  for (let index = 0; index < count; index += 1) {
    const reservation = net.createServer((socket) => socket.end("reserved test port\n"));
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    if (address === null || typeof address === "string") throw new Error("Missing reserved port.");
    reservations.set(address.port, reservation);
  }
  return { ports: [...reservations.keys()], release };
};

const connectServiceView = (name: string, port: number, transport: "tcp" | "udp" = "tcp") => ({
  service: {
    id: `service-${name}`,
    sessionId: name === "foreign" ? "another-session" : "owned-session",
    name,
    workspacePort: port,
    transport,
    browserScheme: null,
    currentAttemptId: null,
  },
  attempts: [],
  currentForward: { id: `forward-${name}`, hostPort: null, state: "bound" },
  latestObservation: null,
  workspaceExpiresAt: null,
  workspaceTtlRenewedAt: null,
  workspaceTtlRenewalFailedAt: null,
  workspaceTtlRenewalError: null,
  endpoints: [],
});

const connectCases: ReadonlyArray<{
  readonly label: string;
  readonly names: ReadonlyArray<string>;
  readonly selected: ReadonlyArray<string>;
  readonly portPosition: "before" | "after" | null;
  readonly reclaimUnselected?: boolean;
}> = [
  { label: "one requested name", names: ["web"], selected: ["web"], portPosition: null },
  {
    label: "both requested names",
    names: ["web", "api"],
    selected: ["web", "api"],
    portPosition: null,
  },
  {
    label: "both reversed requested names",
    names: ["api", "web"],
    selected: ["web", "api"],
    portPosition: null,
  },
  {
    label: "one name while an unrelated listener reclaims an unselected port",
    names: ["web"],
    selected: ["web"],
    portPosition: null,
    reclaimUnselected: true,
  },
  { label: "an ID prefix", names: ["service-we"], selected: ["web"], portPosition: null },
  { label: "a port before the name", names: ["web"], selected: ["web"], portPosition: "before" },
  { label: "a port after the name", names: ["web"], selected: ["web"], portPosition: "after" },
  {
    label: "no names (every live TCP service)",
    names: [],
    selected: ["web", "api", "foreign"],
    portPosition: null,
  },
];

describe("mend service connect", spawning, () => {
  it.each(connectCases)(
    "tunnels $label through the public CLI",
    async ({ names, selected, portPosition, reclaimUnselected }) => {
      const reservation = await serviceConnectPorts(4);
      const [webPort, apiPort, foreignPort, override] = reservation.ports;
      if (
        webPort === undefined ||
        apiPort === undefined ||
        foreignPort === undefined ||
        override === undefined
      )
        throw new Error("Missing service fixture ports.");
      const views = [
        connectServiceView("web", webPort),
        connectServiceView("api", apiPort),
        connectServiceView("foreign", foreignPort),
        connectServiceView("metrics", foreignPort, "udp"),
      ];
      const calls: string[] = [];
      const tickets: string[] = [];
      const fake = await startFakeMend(
        (request, response) => {
          calls.push(`${request.method} ${request.url}`);
          if (request.url === "/api/services") json(response, views);
          else if (request.url === "/api/upgrade-tickets") {
            let body = "";
            request.on("data", (chunk: Buffer) => {
              body += chunk.toString();
            });
            request.on("end", () => {
              tickets.push(body);
              json(response, { ticket: `synthetic-service-ticket-${tickets.length}` });
            });
          } else response.writeHead(404).end();
        },
        "hold",
        false,
      );
      const sockets: net.Socket[] = [];
      const args =
        portPosition === null
          ? [...names]
          : portPosition === "before"
            ? ["--port", String(override), ...names]
            : [...names, "--port", String(override)];
      // The fake API and unselected services retain their ports throughout the test.
      // Binding an extra service now fails instead of confusing an unrelated listener for a tunnel.
      await reservation.release(
        portPosition === null
          ? views
              .filter((view) => selected.includes(view.service.name))
              .map((view) => view.service.workspacePort)
          : [override],
      );
      if (reclaimUnselected) {
        // Deterministically reproduce another process taking a port after its reservation closes.
        await reservation.release([apiPort]);
        const unrelated = net.createServer((socket) => socket.end("unrelated listener\n"));
        unrelated.listen(apiPort, "127.0.0.1");
        await once(unrelated, "listening");
        onTestFinished(
          () =>
            new Promise<void>((resolve, reject) =>
              unrelated.close((error) => {
                if (error) {
                  reject(error);
                  return;
                }
                resolve();
              }),
            ),
        );
      }
      const cli = startCli(fake.url, ["service", "connect", ...args], {
        MEND_TOKEN: "synthetic-service-token",
      });
      try {
        await waitFor(() => cli.stdout().includes("Ctrl-C stops") || cli.child.exitCode !== null);
        expect(cli.child.exitCode, cli.stderr()).toBeNull();
        const opened = [...cli.stdout().matchAll(/● (\w+) → 127\.0\.0\.1:(\d+)/g)].map(
          (match) => match[1],
        );
        expect(opened).toEqual(selected);
        for (const view of views.filter(
          (candidate) =>
            candidate.service.transport === "tcp" && !selected.includes(candidate.service.name),
        )) {
          const socket = net.createConnection({
            host: "127.0.0.1",
            port: view.service.workspacePort,
          });
          sockets.push(socket);
          socket.setEncoding("utf8");
          let response = "";
          for await (const chunk of socket) response += chunk;
          expect(response, `${view.service.name} must not have a local tunnel`).toBe(
            reclaimUnselected && view.service.name === "api"
              ? "unrelated listener\n"
              : "reserved test port\n",
          );
        }
        for (const view of views.filter((candidate) => selected.includes(candidate.service.name))) {
          const localPort = portPosition === null ? view.service.workspacePort : override;
          const socket = net.createConnection({ host: "127.0.0.1", port: localPort });
          sockets.push(socket);
          await once(socket, "connect");
        }
        await waitFor(() => fake.upgradeCount() === selected.length);
        expect(tickets.toSorted()).toEqual(
          selected
            .map((name) => JSON.stringify({ target: "service-tunnel", service: `service-${name}` }))
            .toSorted(),
        );
        expect(
          fake
            .upgradeUrls()
            .map((value) => new URL(value, fake.url).searchParams.get("service"))
            .toSorted(),
        ).toEqual(selected.map((name) => `service-${name}`).toSorted());
        expect(calls.filter((call) => call === "GET /api/services")).toHaveLength(1);
        expect(fake.upgradeUrls().some((value) => value.includes("synthetic-service-token"))).toBe(
          false,
        );
        if (names.length > 0) expect(tickets.join(" ")).not.toContain("service-foreign");
      } finally {
        try {
          for (const socket of sockets) socket.destroy();
          if (cli.child.exitCode === null && cli.child.signalCode === null) {
            const closed = once(cli.child, "close");
            cli.child.kill("SIGKILL");
            await closed;
          }
        } finally {
          await fake.close();
        }
      }
    },
  );
});

describe("mend service connect errors", spawning, () => {
  it.each([
    {
      args: ["missing"],
      message: 'no live TCP service matches "missing"',
      listed: true,
      tcp: true,
    },
    {
      args: ["web", "api", "--port", "32123"],
      message: "--port applies to exactly one service — name it",
      listed: true,
      tcp: true,
    },
    {
      args: ["--port", "32123"],
      message: "--port applies to exactly one service — name it",
      listed: true,
      tcp: true,
    },
    {
      args: ["web", "--port", "invalid"],
      message: "--port takes a port number",
      listed: false,
      tcp: true,
    },
    {
      args: [],
      message: "no live TCP services — mend service run starts one",
      listed: true,
      tcp: false,
    },
  ])("preserves $message and opens no tunnel", async ({ args, message, listed, tcp }) => {
    const {
      ports: [webPort, apiPort],
    } = await serviceConnectPorts(2);
    if (webPort === undefined || apiPort === undefined)
      throw new Error("Missing error fixture ports.");
    const calls: string[] = [];
    const fake = await startFakeMend((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      if (request.url === "/api/services")
        json(
          response,
          tcp
            ? [connectServiceView("web", webPort), connectServiceView("api", apiPort)]
            : [connectServiceView("metrics", webPort, "udp")],
        );
      else response.writeHead(404).end();
    });
    const cli = startCli(fake.url, ["service", "connect", ...args]);
    try {
      // The missing-name regression used to keep the process alive tunneling every service.
      await waitFor(() => cli.child.exitCode !== null || cli.stdout().includes("Ctrl-C stops"));
      expect(cli.child.exitCode, cli.stdout() + cli.stderr()).toBe(1);
      expect(cli.stderr()).toContain(message);
      expect(cli.stdout()).not.toContain(" → 127.0.0.1:");
      expect(calls).toEqual(listed ? ["GET /api/services"] : []);
      expect(fake.upgradeCount()).toBe(0);
    } finally {
      try {
        if (cli.child.exitCode === null && cli.child.signalCode === null) {
          const closed = once(cli.child, "close");
          cli.child.kill("SIGKILL");
          await closed;
        }
      } finally {
        await fake.close();
      }
    }
  });
});
