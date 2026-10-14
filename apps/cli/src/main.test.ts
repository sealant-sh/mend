import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { mainTestFixtures } from "./main-test-fixtures.ts";

const { project, json, spawning, startCli, startFakeMend } = mainTestFixtures();

describe("mend adopt", spawning, () => {
  it("refuses removed ambient auth before any server request", async () => {
    const requests: Array<string> = [];
    const fake = await startFakeMend(
      (request, response) => {
        requests.push(`${request.method} ${request.url}`);
        response.writeHead(500).end("unexpected request");
      },
      "end",
      false,
    );
    try {
      const cli = startCli(fake.url, [
        "adopt",
        "git@owned.example:team/repo.git",
        "--auth",
        "ambient",
      ]);
      expect((await cli.exited).code, cli.stderr()).toBe(1);
      expect(cli.stderr()).toContain("ambient");
      expect(cli.stderr()).toContain("mend-key");
      expect(cli.stderr()).toContain("bridge");
      expect(requests).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it.each([
    ["mend-key", "mend key", "configured for SSH remotes"],
    ["bridge", "bridge", "configured to use `mend keys share` for SSH remotes"],
  ])(
    "reports the persisted %s mode without claiming an observed clone signer",
    async (mode, value, note) => {
      const source = "https://github.com/acme/fixture.git";
      const requests: Array<unknown> = [];
      const fake = await startFakeMend((request, response) => {
        if (request.method !== "POST" || request.url !== "/api/projects") {
          response.writeHead(404).end();
          return;
        }
        let body = "";
        request.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        request.on("end", () => {
          requests.push(JSON.parse(body));
          json(response, { ...project, originUrl: source, gitAuthMode: mode });
        });
      });
      try {
        const cli = startCli(fake.url, ["adopt", source]);
        expect((await cli.exited).code, cli.stderr()).toBe(0);
        expect(requests).toEqual([{ name: "fixture", source, visibility: "private" }]);
        expect(cli.stdout()).toContain(`git auth mode ${value} (${note})`);
        expect(cli.stdout()).not.toMatch(/cloned over|signed this clone|signed through/);
      } finally {
        await fake.close();
      }
    },
  );

  it.each(["/tmp/repository", "../repository", "file:///tmp/repository"])(
    "rejects local source %s before an API call",
    async (source) => {
      const cli = startCli("http://127.0.0.1:9", ["adopt", source]);
      const exit = await cli.exited;
      expect(exit.code).toBe(1);
      expect(cli.stderr()).toContain("Local paths and file:// URLs are not supported");
    },
  );
});

describe("mend help", spawning, () => {
  it("sequences the start block first and still lists every command", async () => {
    const cli = startCli("http://127.0.0.1:1", ["help"]);
    await cli.exited;
    const help = cli.stdout();

    expect(help.indexOf("\nstart\n")).toBeGreaterThan(-1);
    expect(help.indexOf("\nstart\n")).toBeLessThan(help.indexOf("\nsessions\n"));
    // The start block is the first run, in order.
    const started = ["login", "connect", "adopt", "codex", "pair", "doctor"];
    const positions = started.map((command) => help.indexOf(`\n  ${command} `));
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
    expect(positions[0]).toBeGreaterThan(help.indexOf("\nstart\n"));
    expect(positions.at(-1)).toBeLessThan(help.indexOf("\nsessions\n"));
    // Nothing was dropped on the way past the reorder.
    for (const command of [
      "logout",
      "keys init",
      "keys show",
      "keys share",
      "keys mode",
      "env load",
      "env show",
      "accounts",
      "dotfiles",
      "dotfiles repo",
      "dotfiles sync",
      "run",
      "attach",
      "stop",
      "shell",
      "service run",
      "service add",
      "service init",
      "service list",
      "service logs",
      "service restart",
      "service stop",
      "continue",
      "resume",
      "rejoin",
      "projects",
      "sessions",
      "land",
      "pull",
      "server",
      "server setup",
      "completions",
      "version",
    ]) {
      expect(help, command).toContain(`\n  ${command} `);
    }
    // The installer's renderer stays out of the printed surface.
    expect(help).not.toContain("  qr ");
  });

  it("prints mend help adopt whole: help pages never pass through the credential redactor", async () => {
    // The live pass's cut-off page: the redactor read `file:// … git@github.com:` as one URL with a
    // password and took everything between. Pages are the static catalog, printed as written.
    const cli = startCli("http://127.0.0.1:1", ["help", "adopt"]);
    expect((await cli.exited).code).toBe(0);
    const page = cli.stdout().replace(/\s+/gu, " ");
    for (const part of [
      "local paths and file:// URLs do not.",
      "--auth says how the store fetches from the remote.",
      " options ",
      "--name <name>",
      "mend adopt git@github.com:acme/api.git --auth mend-key",
      " see also ",
    ]) {
      expect(page).toContain(part);
    }
    const projects = startCli("http://127.0.0.1:1", ["help", "projects"]);
    await projects.exited;
    expect(projects.stdout().replace(/\s+/gu, " ")).toContain(
      "https://oauth2:TOKEN@github.com/acme/repo.git reads as https://github.com/acme/repo.git",
    );
  });

  it("prints one command's page for help <command> and <command> --help alike", async () => {
    const byHelp = startCli("http://127.0.0.1:1", ["help", "service", "run"]);
    const byFlag = startCli("http://127.0.0.1:1", ["service", "run", "--help"]);
    await Promise.all([byHelp.exited, byFlag.exited]);
    expect(byHelp.stdout()).toContain("mend service run · ");
    expect(byHelp.stdout()).toContain("--no-connect");
    expect(byFlag.stdout()).toBe(byHelp.stdout());
  });

  it("routes server setup help without touching Docker or login configuration", async () => {
    const cli = startCli("http://127.0.0.1:1", ["server", "setup", "--help"]);
    const outcome = await cli.exited;
    expect(outcome.code).toBe(0);
    expect(cli.stdout()).toContain(
      "mend server setup · install or change the local Mend server, guided",
    );
    expect(cli.stdout()).toContain("--docker-socket <path>");
  });

  it("quotes the catalog's synopsis in a usage error", async () => {
    const cli = startCli("http://127.0.0.1:1", ["service", "stop"]);
    const outcome = await cli.exited;
    expect(outcome.code).toBe(1);
    expect(cli.stderr()).toContain("usage: mend service stop <name-or-id>");
  });
});

describe("mend uninstall", spawning, () => {
  it("refuses in words while the server lock is held, naming its owner and the way out", async () => {
    // It crashed with an uncaught ServerStoreError and a Node stack trace (RC 0.36.0-next.754, D-F2).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-uninstall-lock-"));
    try {
      const lock = path.join(root, "config", "mend", "server.lock");
      fs.mkdirSync(lock, { recursive: true });
      // A process that has exited: the lock it names is stale.
      const gone = spawn(process.execPath, ["-e", ""]);
      await once(gone, "exit");
      fs.writeFileSync(
        path.join(lock, "owner.json"),
        `${JSON.stringify({ pid: gone.pid, hostname: os.hostname(), token: "t" })}\n`,
      );
      const cli = startCli("http://127.0.0.1:9", ["uninstall", "--server", "--yes"], {
        HOME: root,
        XDG_CONFIG_HOME: path.join(root, "config"),
      });
      expect(await cli.exited).toEqual({ kind: "exit", code: 1 });
      expect(cli.stderr()).toContain(`mend: Server is busy: ${lock} is locked (PID ${gone.pid}`);
      expect(cli.stderr()).toContain("the lock may be stale");
      expect(cli.stderr()).toContain("move only this lock directory aside and retry");
      expect(cli.stderr()).not.toMatch(/\n\s+at /);
      expect(fs.existsSync(lock)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("CLI subprocess isolation", spawning, () => {
  it.each(["environment", "saved login"])("ignores the caller's %s credentials", async (source) => {
    const caller = fs.mkdtempSync(path.join(os.tmpdir(), "mend-caller-fixture-"));
    const config = path.join(caller, "config", "mend");
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(
      path.join(config, "cli.json"),
      JSON.stringify({ token: "synthetic-caller-saved-token" }),
    );
    const authorizations: Array<string | undefined> = [];
    const fake = await startFakeMend((request, response) => {
      authorizations.push(request.headers.authorization);
      if (request.url === "/api/projects" || request.url === "/api/sessions") json(response, []);
      else response.writeHead(404).end();
    });
    vi.stubEnv("HOME", caller);
    vi.stubEnv("XDG_CONFIG_HOME", path.join(caller, "config"));
    vi.stubEnv("MEND_TOKEN", source === "environment" ? "synthetic-caller-env-token" : undefined);
    try {
      const cli = startCli(fake.url, ["projects"]);
      expect((await cli.exited).code, cli.stderr()).toBe(0);
      expect(authorizations).toEqual([undefined, undefined]);
      authorizations.length = 0;
      const explicit = startCli(fake.url, ["projects"], { MEND_TOKEN: "synthetic-test-token" });
      expect((await explicit.exited).code, explicit.stderr()).toBe(0);
      expect(authorizations).toEqual([
        "Bearer synthetic-test-token",
        "Bearer synthetic-test-token",
      ]);
    } finally {
      vi.unstubAllEnvs();
      await fake.close();
      fs.rmSync(caller, { recursive: true, force: true });
    }
  });
});
