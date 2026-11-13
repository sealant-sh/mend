import { type ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { mainTestFixtures, type HttpHandler } from "./main-test-fixtures.ts";

const { project, session, json, spawning, startCli, startFakeMend } = mainTestFixtures();

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

  it("mend sessions says your own Boat key to the session's owner and its owner's to anyone else", async () => {
    for (const [viewer, words] of [
      ["anna", "Boat · your own Boat key"],
      ["bob", "Boat · its owner's own Boat key"],
    ] as const) {
      const fake = await startFakeMend(
        people(
          (route, response) => {
            if (route !== "GET /api/organization") return false;
            json(response, { userId: viewer });
            return true;
          },
          { ...flagOff, boatKey: "person" },
        ),
      );
      const cli = startCli(fake.url, ["sessions"]);
      try {
        await cli.exited;
        expect(cli.stdout(), cli.stderr()).toContain(words);
      } finally {
        cli.child.kill("SIGKILL");
        await fake.close();
      }
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
