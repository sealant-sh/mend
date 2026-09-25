import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const project = {
  id: "project-1",
  name: "fixture",
  originUrl: null,
  storePath: "/tmp/mend/fixture/repo.git",
  defaultBranch: "main",
};

const session = {
  id: "session-1234",
  projectId: project.id,
  harness: "codex",
  label: null,
  worktree: "session-1234",
  branch: "mend/session/session-1234",
  baseSha: "abc123",
  status: "running",
  summary: null,
  createdAt: new Date(0).toISOString(),
};

const json = (response: ServerResponse, value: unknown): void => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

const websocketTextFrame = (text: string): Buffer => {
  const payload = Buffer.from(text);
  if (payload.length >= 126) throw new Error("test frame must use the short WebSocket encoding");
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
};

const acceptWebSocket = (request: IncomingMessage, socket: Duplex): void => {
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") throw new Error("missing WebSocket key");
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      "\r\n",
  );
};

type HttpHandler = (request: IncomingMessage, response: ServerResponse) => void;

/**
 * What the fake terminal does when a client attaches: `end` sends the end
 * control frame (the session settled); `drop` severs the transport without
 * one (a server restart, a network cut); `hold` keeps the socket open silent
 * (a live session — signals decide the exit).
 */
const startFakeMend = async (
  handleHttp: HttpHandler,
  behavior: "end" | "drop" | "hold" = "end",
) => {
  let notifyEndFrame: (() => void) | undefined;
  const endFrameSent = new Promise<void>((resolve) => {
    notifyEndFrame = resolve;
  });
  let notifyUpgraded: (() => void) | undefined;
  const upgraded = new Promise<void>((resolve) => {
    notifyUpgraded = resolve;
  });
  let upgrades = 0;
  const upgradedSockets = new Set<Duplex>();
  const server = createServer(handleHttp);
  server.on("upgrade", (request, socket) => {
    upgrades += 1;
    upgradedSockets.add(socket);
    socket.once("close", () => upgradedSockets.delete(socket));
    acceptWebSocket(request, socket);
    notifyUpgraded?.();
    if (behavior === "end") {
      socket.write(websocketTextFrame(JSON.stringify({ t: "end" })));
      notifyEndFrame?.();
      // Deliberately keep the transport open. Session lifecycle ended already;
      // transport teardown must not remain on the user's exit path.
    } else if (behavior === "drop") {
      setTimeout(() => socket.destroy(), 50);
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");

  return {
    endFrameSent,
    upgraded,
    upgradeCount: () => upgrades,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of upgradedSockets) socket.destroy();
      server.close();
      await once(server, "close");
    },
  };
};

const startCli = (
  url: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {},
) => {
  const entrypoint = fileURLToPath(new URL("./main.ts", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-strip-types", entrypoint, ...args], {
    env: { ...process.env, MEND_URL: url, MEND_DETACH_KEY: "none", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<{ readonly kind: "exit"; readonly code: number | null }>((resolve) => {
    child.once("exit", (code) => resolve({ kind: "exit", code }));
  });
  return { child, exited, stdout: () => stdout, stderr: () => stderr };
};

/** Poll until the fake observed something — CI cold starts must not count against a race. */
const waitFor = async (predicate: () => boolean, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition never became true");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
};

const expectFastExit = async (
  exited: Promise<{ readonly kind: "exit"; readonly code: number | null }>,
  stderr: () => string,
) => {
  const outcome = await Promise.race([
    exited,
    new Promise<{ readonly kind: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ kind: "timeout" }), 750),
    ),
  ]);
  expect(outcome, stderr()).toEqual({ kind: "exit", code: 0 });
};

describe("mend adopt", () => {
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

describe("Mend CLI session selection", () => {
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
      await expectFastExit(cli.exited, cli.stderr);
      expect(cli.stdout()).toContain("attaching to");
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

describe("Mend CLI session exit", () => {
  it("returns on the terminal end frame without waiting for the socket to close", async () => {
    const fake = await startFakeMend((request, response) => {
      if (request.url === "/api/sessions") json(response, [session]);
      else response.writeHead(404).end();
    });
    const cli = startCli(fake.url, ["attach", "session-"]);

    try {
      await fake.endFrameSent;
      await expectFastExit(cli.exited, cli.stderr);
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
      await expectFastExit(cli.exited, cli.stderr);
      expect(postEndRequests).toEqual([]);
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  });
});

describe("Mend CLI session lifecycle", () => {
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
      // The fast-exit race starts once the fake saw the launch land: the CLI's
      // cold start (node boot + type stripping) is CI-speed, not under test.
      await waitFor(() => routes.includes(`POST /api/sessions/${session.id}/launch`));
      await expectFastExit(cli.exited, cli.stderr);
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
      await expectFastExit(cli.exited, cli.stderr);
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

describe("mend help", () => {
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
    expect(cli.stdout()).toContain("mend server setup · install or repair the local Mend server");
    expect(cli.stdout()).toContain("--docker-socket <path>");
  });

  it("quotes the catalog's synopsis in a usage error", async () => {
    const cli = startCli("http://127.0.0.1:1", ["service", "stop"]);
    const outcome = await cli.exited;
    expect(outcome.code).toBe(1);
    expect(cli.stderr()).toContain("usage: mend service stop <name-or-id>");
  });
});

describe("mend dotfiles", () => {
  const repository = {
    url: "git@github.com:me/dots.git",
    ref: null,
    subdirectory: "dots",
    manager: "copy",
    bootstrap: true,
  };

  /** A fake that records every `PUT /api/dotfiles/repository` body and echoes it back as saved. */
  const startDotfilesFake = async (saved: typeof repository | null) => {
    const puts: Array<unknown> = [];
    const fake = await startFakeMend((request, response) => {
      if (request.url === "/api/dotfiles" && request.method === "GET") {
        json(response, { repository: saved, snapshot: null });
        return;
      }
      if (request.url === "/api/dotfiles/repository" && request.method === "PUT") {
        let body = "";
        request.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        request.on("end", () => {
          const parsed = JSON.parse(body) as { readonly repository: unknown };
          puts.push(parsed);
          json(response, { repository: parsed.repository, snapshot: null });
        });
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    return { fake, puts };
  };

  it("shows the manager the repository applies with", async () => {
    const { fake } = await startDotfilesFake(repository);
    try {
      const cli = startCli(fake.url, ["dotfiles"]);
      const exit = await cli.exited;
      expect(exit.code, cli.stderr()).toBe(0);
      expect(cli.stdout()).toContain("git@github.com:me/dots.git");
      expect(cli.stdout()).toContain("default branch · dots/ · manager copy · install.sh on");
    } finally {
      await fake.close();
    }
  });

  it("sets the whole repository, the manager included", async () => {
    const { fake, puts } = await startDotfilesFake(null);
    try {
      const cli = startCli(fake.url, [
        "dotfiles",
        "repo",
        "git@github.com:me/dots.git",
        "--subdirectory",
        "dots",
        "--manager",
        "stow",
        "--no-bootstrap",
      ]);
      const exit = await cli.exited;
      expect(exit.code, cli.stderr()).toBe(0);
      expect(puts).toEqual([
        {
          repository: {
            url: "git@github.com:me/dots.git",
            ref: null,
            subdirectory: "dots",
            manager: "stow",
            bootstrap: false,
          },
        },
      ]);
      expect(cli.stdout()).toContain("manager stow · install.sh off");
    } finally {
      await fake.close();
    }
  });

  it("clears the repository with --clear", async () => {
    const { fake, puts } = await startDotfilesFake(repository);
    try {
      const cli = startCli(fake.url, ["dotfiles", "repo", "--clear"]);
      const exit = await cli.exited;
      expect(exit.code, cli.stderr()).toBe(0);
      expect(puts).toEqual([{ repository: null }]);
      expect(cli.stdout()).toContain("cleared the dotfiles repository");
    } finally {
      await fake.close();
    }
  });

  it("refuses an unknown manager before any request", async () => {
    const { fake, puts } = await startDotfilesFake(null);
    try {
      const cli = startCli(fake.url, [
        "dotfiles",
        "repo",
        "https://x/dots.git",
        "--manager",
        "yadm",
      ]);
      const exit = await cli.exited;
      expect(exit.code).toBe(1);
      expect(cli.stderr()).toContain("--manager must be one of auto, copy, stow, chezmoi");
      expect(cli.stderr()).toContain("usage: mend dotfiles repo <url>");
      expect(puts).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("prints the server's reason when it cannot clone the repository", async () => {
    const fake = await startFakeMend((request, response) => {
      request.resume();
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ message: "the dotfiles repo https://x/dots.git could not be cloned" }),
      );
    });
    try {
      const cli = startCli(fake.url, ["dotfiles", "repo", "https://x/dots.git"]);
      const exit = await cli.exited;
      expect(exit.code).toBe(1);
      expect(cli.stderr()).toContain("could not be cloned");
      expect(cli.stdout()).not.toContain("saved");
    } finally {
      await fake.close();
    }
  });
});

interface SyncBody {
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly contentsBase64: string;
    readonly mode: string;
  }>;
  readonly source: string;
  readonly merge: boolean;
}

const isSyncBody = (value: unknown): value is SyncBody =>
  typeof value === "object" && value !== null && "files" in value && "merge" in value;

/**
 * A machine with a home of its own: three curated config files, one file that is not on the
 * curated list, and a file beside home that must never be read. The CLI's own config lives
 * outside that home, so nothing but the dotfiles is found there.
 */
const machine = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-cli-dotfiles-sync-"));
  const home = path.join(root, "home");
  const write = (relative: string, contents: string, mode = 0o644) => {
    const target = path.join(home, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    fs.chmodSync(target, mode);
  };
  write(".zshrc", "export EDITOR=vim\n", 0o755);
  write(".gitconfig", "[user]\n  name = me\n");
  write(".config/starship.toml", "add_newline = false\n");
  write(".notes", "not on the curated list\n");
  fs.writeFileSync(path.join(root, "outside"), "beside home, never synced\n");
  return {
    root,
    home,
    env: { HOME: home, XDG_CONFIG_HOME: path.join(root, "config") },
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  };
};

const decoded = (body: SyncBody | undefined) =>
  body?.files.map((entry) => ({
    path: entry.path,
    contents: Buffer.from(entry.contentsBase64, "base64").toString(),
    mode: entry.mode,
  }));

describe("mend dotfiles sync", () => {
  /** A server that keeps every snapshot POST, and answers with the snapshot it would store. */
  const startSyncFake = async (refuse?: string) => {
    const posts: Array<SyncBody> = [];
    const fake = await startFakeMend((request, response) => {
      if (request.url !== "/api/dotfiles/snapshot" || request.method !== "POST") {
        response.statusCode = 404;
        response.end();
        return;
      }
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        const parsed: unknown = JSON.parse(body);
        if (!isSyncBody(parsed)) throw new Error(`not a sync body: ${body}`);
        posts.push(parsed);
        if (refuse !== undefined) {
          response.writeHead(422, { "content-type": "application/json" });
          response.end(JSON.stringify({ _tag: "SettingsFailure", message: refuse }));
          return;
        }
        json(response, {
          repository: null,
          snapshot: {
            sha: "5eed0f5eed0f5eed0f5eed0f5eed0f5eed0f5eed",
            source: parsed.source,
            committedAt: new Date(0).toISOString(),
            files: parsed.files.map((entry) => ({
              path: entry.path,
              bytes: Buffer.from(entry.contentsBase64, "base64").byteLength,
            })),
          },
        });
      });
    });
    return { fake, posts };
  };

  it("without arguments lists what it found under home and uploads nothing", async () => {
    const home = machine();
    const { fake, posts } = await startSyncFake();
    try {
      const cli = startCli(fake.url, ["dotfiles", "sync"], home.env);
      const exit = await cli.exited;
      expect(exit.code, cli.stderr()).toBe(0);
      const out = cli.stdout();
      for (const found of [".zshrc", ".gitconfig", ".config/starship.toml"]) {
        expect(out).toContain(found);
      }
      expect(out).not.toContain(".notes");
      expect(out).toContain("mend dotfiles sync --all");
      expect(posts).toEqual([]);
    } finally {
      await fake.close();
      home.remove();
    }
  });

  it("--all uploads every curated file found, with contents and modes, replacing the snapshot", async () => {
    const home = machine();
    const { fake, posts } = await startSyncFake();
    try {
      const cli = startCli(fake.url, ["dotfiles", "sync", "--all"], home.env);
      const exit = await cli.exited;
      expect(exit.code, cli.stderr()).toBe(0);
      expect(posts).toHaveLength(1);
      expect(posts[0]?.merge).toBe(false);
      expect(posts[0]?.source).toBe(os.hostname());
      expect(decoded(posts[0])).toEqual([
        { path: ".zshrc", contents: "export EDITOR=vim\n", mode: "755" },
        { path: ".config/starship.toml", contents: "add_newline = false\n", mode: "644" },
        { path: ".gitconfig", contents: "[user]\n  name = me\n", mode: "644" },
      ]);
      expect(cli.stdout()).toContain(`synced 3 files from ${os.hostname()} · 5eed0f5`);
    } finally {
      await fake.close();
      home.remove();
    }
  });

  it("uploads exactly the paths named, curated or not, absolute under home or relative", async () => {
    const home = machine();
    const { fake, posts } = await startSyncFake();
    try {
      const cli = startCli(
        fake.url,
        ["dotfiles", "sync", ".notes", path.join(home.home, ".gitconfig")],
        home.env,
      );
      const exit = await cli.exited;
      expect(exit.code, cli.stderr()).toBe(0);
      expect(decoded(posts[0])?.map((entry) => entry.path)).toEqual([".notes", ".gitconfig"]);
      expect(cli.stdout()).toContain("synced 2 files");
    } finally {
      await fake.close();
      home.remove();
    }
  });

  it.each([
    ["a path above home", "../outside"],
    ["an absolute path beside home", "<root>/outside"],
  ])("refuses %s before reading or uploading anything", async (_label, requested) => {
    const home = machine();
    const { fake, posts } = await startSyncFake();
    try {
      const target = requested.replace("<root>", home.root);
      const cli = startCli(fake.url, ["dotfiles", "sync", ".zshrc", target], home.env);
      const exit = await cli.exited;
      expect(exit.code).toBe(1);
      expect(cli.stderr()).toContain(
        `${target} is not under ${home.home} — only files in your home directory sync`,
      );
      expect(posts).toEqual([]);
    } finally {
      await fake.close();
      home.remove();
    }
  });

  it("refuses a named file that does not exist, before uploading anything", async () => {
    const home = machine();
    const { fake, posts } = await startSyncFake();
    try {
      const cli = startCli(fake.url, ["dotfiles", "sync", ".zshrc", ".zshrc-typo"], home.env);
      const exit = await cli.exited;
      expect(exit.code).toBe(1);
      expect(cli.stderr()).toContain(`.zshrc-typo is not a file under ${home.home}`);
      expect(posts).toEqual([]);
    } finally {
      await fake.close();
      home.remove();
    }
  });

  it("prints the server's reason when it refuses the snapshot", async () => {
    const home = machine();
    const { fake, posts } = await startSyncFake(
      "snapshot exceeds the 4MB cap — trim the selection",
    );
    try {
      const cli = startCli(fake.url, ["dotfiles", "sync", "--all"], home.env);
      const exit = await cli.exited;
      expect(exit.code).toBe(1);
      expect(posts).toHaveLength(1);
      expect(cli.stderr()).toContain("snapshot exceeds the 4MB cap — trim the selection");
      expect(cli.stdout()).not.toContain("synced");
    } finally {
      await fake.close();
      home.remove();
    }
  });
});

describe("mend connect claude", () => {
  /**
   * The finding this pins: the credential document Claude Code writes holds `mcpOAuth` beside the
   * Claude grant, and the whole file used to travel — so a person's Figma, Atlassian and Linear
   * refresh tokens reached the platform and every workspace
   * (docs/adr/0005-claude-credentials-and-a-grant-of-mends-own.md).
   */
  it("narrows the login this machine holds, and says what sharing it costs", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-connect-claude-"));
    fs.writeFileSync(
      path.join(configDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat01-access",
          refreshToken: "sk-ant-ort01-refresh",
          expiresAt: 1_789_000_000_000,
          refreshTokenExpiresAt: 1_791_000_000_000,
          subscriptionType: "max",
        },
        mcpOAuth: { "figma:https://figma.com": { refreshToken: "figma-refresh" } },
      }),
    );
    let body = "";
    const fake = await startFakeMend((request, response) => {
      if (request.url === "/api/me/sealant/accounts" && request.method === "POST") {
        request.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        request.on("end", () =>
          json(response, {
            id: "account-1",
            provider: "claude",
            name: "default",
            kind: "credentials-json",
            status: "active",
            metadata: {},
            connectedAt: "2026-09-18T00:00:00.000Z",
            lastUsedAt: null,
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    try {
      // `--use-my-login` is this machine's own credential: what the default did before Mend got a
      // grant of its own, kept for anyone who cannot hold two.
      const cli = startCli(fake.url, ["connect", "claude", "--use-my-login"], {
        CLAUDE_CONFIG_DIR: configDir,
      });
      const exit = await cli.exited;
      expect(exit.code, cli.stderr()).toBe(0);
      await waitFor(() => body !== "");
      const sent = JSON.parse(body) as { readonly secret: string };
      const secret = JSON.parse(sent.secret) as Record<string, unknown>;
      expect(Object.keys(secret)).toEqual(["claudeAiOauth"]);
      expect(sent.secret).not.toContain("figma-refresh");
      expect(sent.secret).toContain("sk-ant-ort01-refresh");
      // The person is told what was held back, and what the grant says about itself.
      expect(cli.stdout() + cli.stderr()).toContain("keeping mcpOAuth on this machine");
      expect(cli.stdout() + cli.stderr()).toContain("grant expires");
      expect(cli.stdout() + cli.stderr()).toContain("whichever refreshes second is signed out");
    } finally {
      await fake.close();
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("mend connect claude, a grant of Mend's own", () => {
  /**
   * The flow ADR 0005 commits to: Mend logs in against its own config directory and sends THAT
   * grant, so its scheduled refresh never rotates the token this machine's Claude is holding.
   */
  it("logs in for itself, sends its own grant, and says the machine's login survived", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-grant-flow-"));
    const personal = path.join(home, "personal-claude");
    fs.mkdirSync(personal, { recursive: true });
    fs.writeFileSync(
      path.join(personal, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { refreshToken: "sk-ant-ort01-mine" } }),
    );
    // A stub claude: `auth login` writes a DIFFERENT grant into whatever CLAUDE_CONFIG_DIR says,
    // and `auth status` reports logged in for any directory holding one.
    const bin = path.join(home, "claude");
    fs.writeFileSync(
      bin,
      `#!/bin/sh
case "$2" in
  login)
    mkdir -p "$CLAUDE_CONFIG_DIR"
    printf '%s' '{"claudeAiOauth":{"refreshToken":"sk-ant-ort01-mends","expiresAt":1789000000000,"refreshTokenExpiresAt":1791000000000},"mcpOAuth":{"figma":{"refreshToken":"figma-refresh"}}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"
    ;;
  status)
    if [ -f "$CLAUDE_CONFIG_DIR/.credentials.json" ]; then
      printf '{"loggedIn":true,"authMethod":"claude.ai","configDirectory":"%s","subscriptionType":"max"}' "$CLAUDE_CONFIG_DIR"
    else
      printf '{"loggedIn":false,"authMethod":"none","configDirectory":"%s"}' "$CLAUDE_CONFIG_DIR"
    fi
    ;;
esac
`,
      { mode: 0o755 },
    );
    let body = "";
    const fake = await startFakeMend((request, response) => {
      if (request.url === "/api/me/sealant/accounts" && request.method === "POST") {
        request.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        request.on("end", () =>
          json(response, {
            id: "account-1",
            provider: "claude",
            name: "default",
            kind: "credentials-json",
            status: "active",
            metadata: {},
            connectedAt: "2026-09-18T00:00:00.000Z",
            lastUsedAt: null,
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    try {
      const cli = startCli(fake.url, ["connect", "claude"], {
        XDG_CONFIG_HOME: path.join(home, "config"),
        CLAUDE_CONFIG_DIR: personal,
        MEND_CLAUDE_BIN: bin,
      });
      const exit = await cli.exited;
      expect(exit.code, cli.stderr()).toBe(0);
      await waitFor(() => body !== "");
      const sent = JSON.parse(body) as { readonly secret: string };
      // Mend's grant, not this machine's, and narrowed on the way out.
      expect(sent.secret).toContain("sk-ant-ort01-mends");
      expect(sent.secret).not.toContain("sk-ant-ort01-mine");
      expect(sent.secret).not.toContain("figma-refresh");
      // The grant landed in Mend's own directory, leaving the machine's Claude untouched.
      const grantFile = path.join(home, "config", "mend", "claude-grant", ".credentials.json");
      expect(fs.existsSync(grantFile)).toBe(true);
      expect(fs.readFileSync(path.join(personal, ".credentials.json"), "utf8")).toContain(
        "sk-ant-ort01-mine",
      );
      const output = cli.stdout() + cli.stderr();
      expect(output).toContain("your own Claude login still works");
      expect(output).toContain("keeping mcpOAuth on this machine");
    } finally {
      await fake.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  /** Two copies of one grant race on refresh, so Mend refuses rather than connect the same one. */
  it("refuses a grant that is the one this machine already holds", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-grant-same-"));
    const personal = path.join(home, "personal-claude");
    const grant = path.join(home, "config", "mend", "claude-grant");
    for (const dir of [personal, grant]) fs.mkdirSync(dir, { recursive: true });
    const shared = JSON.stringify({ claudeAiOauth: { refreshToken: "sk-ant-ort01-shared" } });
    fs.writeFileSync(path.join(personal, ".credentials.json"), shared);
    fs.writeFileSync(path.join(grant, ".credentials.json"), shared);
    const bin = path.join(home, "claude");
    fs.writeFileSync(
      bin,
      `#!/bin/sh
case "$2" in
  status) printf '{"loggedIn":true,"authMethod":"claude.ai","configDirectory":"%s"}' "$CLAUDE_CONFIG_DIR" ;;
esac
`,
      { mode: 0o755 },
    );
    const cli = startCli("http://127.0.0.1:9", ["connect", "claude"], {
      XDG_CONFIG_HOME: path.join(home, "config"),
      CLAUDE_CONFIG_DIR: personal,
      MEND_CLAUDE_BIN: bin,
    });
    const exit = await cli.exited;
    expect(exit.code).toBe(1);
    expect(cli.stderr()).toContain("same grant this machine's Claude holds");
    fs.rmSync(home, { recursive: true, force: true });
  });
});
