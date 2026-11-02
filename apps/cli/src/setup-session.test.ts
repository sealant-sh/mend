import { describe, expect, it } from "vitest";

import { mainTestFixtures } from "./main-test-fixtures.ts";
import { offerSetupSession, parseSetupSessionArgs } from "./setup-session.ts";

const { spawning, project, session, json, startFakeMend, startCli, expectExit } =
  mainTestFixtures();

describe("setup-session arguments and adoption consent", () => {
  it("defaults to Codex and preserves a named agent and the person's note", () => {
    expect(parseSetupSessionArgs([])).toEqual({
      kind: "start",
      agent: "codex",
      launchArgs: [],
      note: null,
    });
    expect(
      parseSetupSessionArgs(["claude", "--note", "-- this is my note", "--project", "app"]),
    ).toEqual({
      kind: "start",
      agent: "claude",
      launchArgs: ["--project", "app"],
      note: "-- this is my note",
    });
    for (const args of [
      ["shell"],
      ["codex", "claude"],
      ["--note"],
      ["--note", ""],
      ["--worktree", "existing"],
    ])
      expect(parseSetupSessionArgs(args).kind).toBe("error");
  });

  it.each(["y", "yes", " YES "])(
    "a TTY answer %s starts with the named default agent",
    async (answer) => {
      const questions: string[] = [];
      const started: string[] = [];
      await offerSetupSession({
        terminal: true,
        question: async (text) => {
          questions.push(text);
          return answer;
        },
        start: async (agent) => {
          started.push(agent);
        },
      });
      expect(questions).toEqual([
        "Set up this project with codex? It uses your own codex login. [y/N] ",
      ]);
      expect(started).toEqual(["codex"]);
    },
  );

  it.each(["", "n", "no", "Not now", "anything else"])(
    "TTY answer %s starts nothing",
    async (answer) => {
      let started = false;
      await offerSetupSession({
        terminal: true,
        question: async () => answer,
        start: async () => {
          started = true;
        },
      });
      expect(started).toBe(false);
    },
  );

  it("never asks outside a TTY", async () => {
    await offerSetupSession({
      terminal: false,
      question: async () => {
        throw new Error("must not ask");
      },
      start: async () => {
        throw new Error("must not start");
      },
    });
  });
});

describe("setup-session CLI", spawning, () => {
  it("lists setup-session and its agents in both shell completion scripts", async () => {
    const zsh = startCli("http://127.0.0.1:1", ["completions", "zsh"]);
    const bash = startCli("http://127.0.0.1:1", ["completions", "bash"]);
    await Promise.all([zsh.closed, bash.closed]);
    expect(zsh.stdout()).toContain("'setup-session:set up this project with your agent'");
    expect(zsh.stdout()).toContain("setup-session) compadd -- claude codex --note --project");
    expect(bash.stdout()).toContain("adopt setup-session codex");
    expect(bash.stdout()).toContain('compgen -W "claude codex --note --project"');
  });

  it.each(["claude", "codex"])(
    "creates a setup session with %s, sends only the note and attaches its terminal",
    async (agent) => {
      const writes: Array<{ route: string; body: unknown }> = [];
      const fake = await startFakeMend((req, res) => {
        if (req.method === "POST") {
          let text = "";
          req.on("data", (chunk: Buffer) => {
            text += chunk.toString();
          });
          req.on("end", () => {
            writes.push({ route: req.url ?? "", body: JSON.parse(text) });
            json(res, { ...session, harness: agent, baseRef: null });
          });
        } else if (req.url === "/api/projects") json(res, [project]);
        else if (req.url === `/api/sessions/${session.id}`)
          json(res, { session: { ...session, status: "completed" } });
        else if (req.url === `/api/sessions/${session.id}/services`) json(res, []);
        else res.writeHead(404).end();
      });
      try {
        const cli = startCli(fake.url, [
          "setup-session",
          agent,
          "--project",
          project.name,
          "--note",
          "Study sign-in",
        ]);
        await expectExit(cli.exited, () => cli.stdout() + cli.stderr());
        expect(writes).toEqual([
          {
            route: `/api/projects/${project.id}/sessions`,
            body: { harness: agent, label: null, name: null, base: null, purpose: "setup" },
          },
          { route: `/api/sessions/${session.id}/launch`, body: { prompt: "Study sign-in" } },
        ]);
        expect(fake.upgradedSessions()).toEqual([session.id]);
        expect(cli.stdout()).not.toContain("worktree name");
      } finally {
        await fake.close();
      }
    },
  );

  it("adopts non-interactively without asking or starting a session, even with yes on stdin", async () => {
    const writes: string[] = [];
    const fake = await startFakeMend((req, res) => {
      if (req.method === "POST") {
        writes.push(req.url ?? "");
        json(res, project);
      } else res.writeHead(404).end();
    });
    try {
      const cli = startCli(
        fake.url,
        ["adopt", "https://github.com/team/repo.git"],
        {},
        undefined,
        "yes\n",
      );
      await expectExit(cli.exited, () => cli.stdout() + cli.stderr());
      expect(writes).toEqual(["/api/projects"]);
      expect(cli.stdout()).not.toContain("Set up this project with");
    } finally {
      await fake.close();
    }
  });
});
