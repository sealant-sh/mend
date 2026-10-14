import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { mainTestFixtures } from "./main-test-fixtures.ts";

const { json, spawning, startCli, startFakeMend, waitFor } = mainTestFixtures();

describe("mend dotfiles", spawning, () => {
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

describe("mend secrets", spawning, () => {
  /** A fake that records every secret-file request and never answers with a file's content. */
  const startSecretsFake = async () => {
    const requests: Array<{
      readonly method: string;
      readonly url: string;
      readonly body: unknown;
    }> = [];
    const fake = await startFakeMend((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        const method = request.method ?? "";
        const url = request.url ?? "";
        requests.push({ method, url, body: body === "" ? null : JSON.parse(body) });
        if (url === "/api/me/secret-files" && method === "GET") {
          json(response, {
            files: [
              {
                id: "a",
                path: ".aws/credentials",
                name: "credentials",
                bytes: 116,
                revision: 1,
                createdAt: "2026-10-01T09:00:00.000Z",
                updatedAt: "2026-10-01T09:00:00.000Z",
              },
            ],
          });
          return;
        }
        if (url === "/api/me/secret-files" && method === "PUT") {
          const parsed = JSON.parse(body) as { readonly path: string; readonly contents: string };
          json(response, {
            action: "created",
            file: {
              id: "b",
              path: parsed.path,
              name: parsed.path,
              bytes: Buffer.byteLength(parsed.contents),
              revision: 1,
              createdAt: "2026-10-03T12:00:00.000Z",
              updatedAt: "2026-10-03T12:00:00.000Z",
            },
          });
          return;
        }
        if (url.startsWith("/api/me/secret-files?path=") && method === "DELETE") {
          json(response, { removed: true });
          return;
        }
        response.statusCode = 404;
        response.end();
      });
    });
    return { fake, requests };
  };

  it("adds a file from --from, lists by path and size, and removes by path", async () => {
    const { fake, requests } = await startSecretsFake();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-cli-secrets-"));
    const source = path.join(dir, "npmrc");
    fs.writeFileSync(source, "//registry.npmjs.org/:_authToken=t\n");
    try {
      const added = startCli(fake.url, ["secrets", "add", "~/.npmrc", "--from", source]);
      expect((await added.exited).code, added.stderr()).toBe(0);
      expect(added.stdout()).toContain("created ~/.npmrc · 35 B");
      expect(added.stdout()).not.toContain("_authToken");
      const listed = startCli(fake.url, ["secrets"]);
      expect((await listed.exited).code, listed.stderr()).toBe(0);
      expect(listed.stdout()).toContain("~/.aws/credentials");
      expect(listed.stdout()).toContain("116 B");
      const removed = startCli(fake.url, ["secrets", "rm", ".aws/credentials"]);
      expect((await removed.exited).code, removed.stderr()).toBe(0);
      expect(removed.stdout()).toContain("removed ~/.aws/credentials");
      expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "PUT /api/me/secret-files",
        "GET /api/me/secret-files",
        "DELETE /api/me/secret-files?path=.aws%2Fcredentials",
      ]);
      expect(requests[0]?.body).toEqual({
        path: ".npmrc",
        encoding: "utf8",
        contents: "//registry.npmjs.org/:_authToken=t\n",
      });
    } finally {
      await fake.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a path sessions capture before any request", async () => {
    const { fake, requests } = await startSecretsFake();
    try {
      const cli = startCli(fake.url, [
        "secrets",
        "add",
        ".claude/settings.json",
        "--from",
        "/dev/null",
      ]);
      expect((await cli.exited).code).toBe(1);
      expect(cli.stderr()).toContain("which sessions capture");
      expect(requests).toEqual([]);
    } finally {
      await fake.close();
    }
  });
});

describe("mend dotfiles sync", spawning, () => {
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

  it.each(["explicit", "all"])(
    "keeps outside symlink bytes out of %s sync requests",
    async (selection) => {
      const home = machine();
      const { fake, posts } = await startSyncFake();
      fs.unlinkSync(path.join(home.home, ".zshrc"));
      fs.symlinkSync(path.join(home.root, "outside"), path.join(home.home, ".zshrc"));
      try {
        const cli = startCli(
          fake.url,
          ["dotfiles", "sync", selection === "all" ? "--all" : ".zshrc"],
          home.env,
        );
        const exit = await cli.exited;
        expect(cli.stdout() + cli.stderr()).not.toContain("beside home, never synced");
        if (selection === "explicit") {
          expect(exit.code, cli.stderr()).toBe(1);
          expect(cli.stderr()).toContain(".zshrc resolves outside your home directory");
          expect(posts).toEqual([]);
        } else {
          expect(exit.code, cli.stderr()).toBe(0);
          expect(posts).toHaveLength(1);
          expect(decoded(posts[0])).toEqual([
            { path: ".config/starship.toml", contents: "add_newline = false\n", mode: "644" },
            { path: ".gitconfig", contents: "[user]\n  name = me\n", mode: "644" },
          ]);
        }
      } finally {
        await fake.close();
        home.remove();
      }
    },
  );

  it("syncs an internal file link through a symlinked home using its logical path and mode", async () => {
    const home = machine();
    const { fake, posts } = await startSyncFake();
    fs.renameSync(path.join(home.home, ".zshrc"), path.join(home.home, "shellrc"));
    fs.symlinkSync("shellrc", path.join(home.home, ".zshrc"));
    const alias = path.join(home.root, "alias");
    fs.symlinkSync(home.home, alias);
    try {
      const cli = startCli(fake.url, ["dotfiles", "sync", ".zshrc"], { ...home.env, HOME: alias });
      expect((await cli.exited).code, cli.stderr()).toBe(0);
      expect(posts).toHaveLength(1);
      expect(decoded(posts[0])).toEqual([
        { path: ".zshrc", contents: "export EDITOR=vim\n", mode: "755" },
      ]);
    } finally {
      await fake.close();
      home.remove();
    }
  });

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

describe("mend connect claude", spawning, () => {
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
          expiresAt: 1_890_000_000_000,
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

describe("mend connect claude, a grant of Mend's own", spawning, () => {
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
    printf '%s' '{"claudeAiOauth":{"refreshToken":"sk-ant-ort01-mends","expiresAt":1890000000000,"refreshTokenExpiresAt":1892000000000},"mcpOAuth":{"figma":{"refreshToken":"figma-refresh"}}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"
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
      // Nothing of the login stays here (ADR 0008): no kept grant, no throwaway directory left.
      const mendDir = path.join(home, "config", "mend");
      expect(fs.existsSync(path.join(mendDir, "claude-grant"))).toBe(false);
      expect(fs.readdirSync(mendDir).filter((name) => name.startsWith("claude-login-"))).toEqual(
        [],
      );
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
  it("refuses a login that is the one this machine already holds", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-grant-same-"));
    const personal = path.join(home, "personal-claude");
    fs.mkdirSync(personal, { recursive: true });
    const shared = JSON.stringify({ claudeAiOauth: { refreshToken: "sk-ant-ort01-shared" } });
    fs.writeFileSync(path.join(personal, ".credentials.json"), shared);
    // A Claude that ignored the isolation and logged the same account in.
    const bin = path.join(home, "claude");
    fs.writeFileSync(
      bin,
      `#!/bin/sh
case "$2" in
  login) mkdir -p "$CLAUDE_CONFIG_DIR"; printf '%s' '${shared}' > "$CLAUDE_CONFIG_DIR/.credentials.json" ;;
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

  /**
   * Alpha 2026-10-01: a reconnect re-sent the grant an older CLI kept, whose refresh token the
   * server had spent days before, and replaced a login with a dead one. A reconnect logs in anew.
   */
  it("logs in anew even when an older mend kept a grant, sends the new one, and removes the old", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-grant-fresh-"));
    const personal = path.join(home, "personal-claude");
    fs.mkdirSync(personal, { recursive: true });
    const kept = path.join(home, "config", "mend", "claude-grant");
    fs.mkdirSync(kept, { recursive: true });
    fs.writeFileSync(
      path.join(kept, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { refreshToken: "sk-ant-ort01-spent" } }),
    );
    const logins = path.join(home, "logins");
    const bin = path.join(home, "claude");
    fs.writeFileSync(
      bin,
      `#!/bin/sh
case "$2" in
  login)
    echo x >> '${logins}'
    mkdir -p "$CLAUDE_CONFIG_DIR"
    printf '%s' '{"claudeAiOauth":{"refreshToken":"sk-ant-ort01-fresh"}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"
    ;;
  status)
    if [ -f "$CLAUDE_CONFIG_DIR/.credentials.json" ]; then
      printf '{"loggedIn":true,"authMethod":"claude.ai","configDirectory":"%s"}' "$CLAUDE_CONFIG_DIR"
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
      expect(sent.secret).toContain("sk-ant-ort01-fresh");
      expect(sent.secret).not.toContain("sk-ant-ort01-spent");
      expect(fs.readFileSync(logins, "utf8").trim().split("\n")).toHaveLength(1);
      expect(fs.existsSync(kept)).toBe(false);
      expect(cli.stdout() + cli.stderr()).toContain("removed the copy an older mend kept");
    } finally {
      await fake.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
