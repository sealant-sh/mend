import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CLAUDE_ONBOARDING_SEED,
  CODEX_TRUST_SEED,
  COPY_REFRESH_TOKEN,
  OPENCODE_SEED,
  PI_SEED,
  withCodexMemory,
  withoutCodexShellSnapshot,
  withHarnessSetup,
} from "./harness-seeds.ts";

const homes: Array<string> = [];
afterEach(() => {
  for (const home of homes.splice(0)) {
    spawnSync("chmod", ["-R", "u+rwx", home]);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

const makeHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-seed-"));
  homes.push(home);
  return home;
};

/** Run a seed the way a launch does, `sh -c <seed> sh <argv…>`, with a harmless argv. */
const runSeed = (seed: string, home: string, token: string | null = "tok-123") => {
  const env: Record<string, string> = { ...process.env, HOME: home } as Record<string, string>;
  if (token === null) delete env["CLAUDE_CODE_OAUTH_TOKEN"];
  else env["CLAUDE_CODE_OAUTH_TOKEN"] = token;
  const result = spawnSync("sh", ["-c", seed, "sh", "sh", "-c", 'echo "ran $IS_SANDBOX"'], {
    encoding: "utf8",
    env,
  });
  expect(result.status).toBe(0);
  return result.stdout;
};

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));

describe("claude onboarding seed", () => {
  it("seeds a fresh home and execs the argv", () => {
    const home = makeHome();
    expect(runSeed(CLAUDE_ONBOARDING_SEED, home)).toBe("ran 1\n");
    const credential = path.join(home, ".claude", ".credentials.json");
    expect(fs.statSync(credential).mode & 0o777).toBe(0o600);
    expect(readJson(credential)).toMatchObject({ claudeAiOauth: { accessToken: "tok-123" } });
    expect(readJson(path.join(home, ".claude.json"))).toEqual({
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
      projects: {
        "/workspace/repo": { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
      },
    });
    expect(readJson(path.join(home, ".claude", "settings.json"))).toEqual({
      skipDangerousModePermissionPrompt: true,
      model: "fable",
    });
  });

  it("moves Mend's own earlier default to the latest Fable, and keeps a model the user chose", () => {
    const earlier = makeHome();
    write(
      path.join(earlier, ".claude", "settings.json"),
      JSON.stringify({ model: "claude-fable-5" }),
    );
    expect(runSeed(CLAUDE_ONBOARDING_SEED, earlier)).toBe("ran 1\n");
    expect(readJson(path.join(earlier, ".claude", "settings.json"))).toMatchObject({
      model: "fable",
    });

    const chosen = makeHome();
    write(
      path.join(chosen, ".claude", "settings.json"),
      JSON.stringify({ model: "claude-opus-4-8" }),
    );
    expect(runSeed(CLAUDE_ONBOARDING_SEED, chosen)).toBe("ran 1\n");
    expect(readJson(path.join(chosen, ".claude", "settings.json"))).toMatchObject({
      model: "claude-opus-4-8",
    });
  });

  it("merges into the user's settings and claude's state, keeping every other key", () => {
    const home = makeHome();
    const settings = path.join(home, ".claude", "settings.json");
    write(
      settings,
      JSON.stringify(
        { model: "claude-opus-5", hooks: { Stop: [{ command: "say done" }] } },
        null,
        4,
      ),
    );
    write(
      path.join(home, ".claude.json"),
      JSON.stringify({ numStartups: 7, projects: { "/other": { history: ["a"] } } }),
    );
    write(path.join(home, ".claude", ".credentials.json"), '{"mine":true}');
    runSeed(CLAUDE_ONBOARDING_SEED, home);
    expect(readJson(settings)).toEqual({
      model: "claude-opus-5",
      hooks: { Stop: [{ command: "say done" }] },
      skipDangerousModePermissionPrompt: true,
    });
    expect(readJson(path.join(home, ".claude.json"))).toMatchObject({
      numStartups: 7,
      projects: {
        "/other": { history: ["a"] },
        "/workspace/repo": { hasTrustDialogAccepted: true },
      },
    });
    expect(fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf8")).toBe(
      '{"mine":true}',
    );
  });

  it("a file that already says it all is not written: same bytes, same inode", () => {
    const home = makeHome();
    runSeed(CLAUDE_ONBOARDING_SEED, home);
    const settings = path.join(home, ".claude", "settings.json");
    const text = `${JSON.stringify({ skipDangerousModePermissionPrompt: true, model: "x" }, null, 8)}\n`;
    write(settings, text);
    const before = fs.statSync(settings);
    runSeed(CLAUDE_ONBOARDING_SEED, home);
    expect(fs.readFileSync(settings, "utf8")).toBe(text);
    expect(fs.statSync(settings).ino).toBe(before.ino);
  });

  it("never replaces a file it cannot read as a JSON object", () => {
    const home = makeHome();
    const settings = path.join(home, ".claude", "settings.json");
    // A hand edit that left a trailing comma: the user's hooks and permissions are all in it.
    const broken =
      '{\n  "hooks": { "Stop": [{ "command": "say done" }] },\n  "permissions": { "allow": ["Bash(pnpm test)"] },\n}\n';
    write(settings, broken);
    const state = path.join(home, ".claude.json");
    write(state, "[1, 2, 3]");
    runSeed(CLAUDE_ONBOARDING_SEED, home);
    expect(fs.readFileSync(settings, "utf8")).toBe(broken);
    expect(fs.readFileSync(state, "utf8")).toBe("[1, 2, 3]");
    expect(fs.readdirSync(path.join(home, ".claude")).toSorted()).toEqual([
      ".credentials.json",
      "settings.json",
    ]);
  });

  it("an unreadable file and a dangling symlink are left alone; a symlink's target is written in place", () => {
    const home = makeHome();
    const dotfiles = path.join(home, "dotfiles", "settings.json");
    write(dotfiles, JSON.stringify({ theme: "dark" }));
    fs.chmodSync(dotfiles, 0o640);
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.symlinkSync(dotfiles, path.join(home, ".claude", "settings.json"));
    fs.symlinkSync(path.join(home, "missing.json"), path.join(home, ".claude.json"));
    runSeed(CLAUDE_ONBOARDING_SEED, home);
    expect(fs.lstatSync(path.join(home, ".claude", "settings.json")).isSymbolicLink()).toBe(true);
    expect(readJson(dotfiles)).toEqual({
      theme: "dark",
      skipDangerousModePermissionPrompt: true,
      model: "fable",
    });
    expect(fs.statSync(dotfiles).mode & 0o777).toBe(0o640);
    expect(fs.lstatSync(path.join(home, ".claude.json")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(home, "missing.json"))).toBe(false);

    if (process.getuid?.() === 0) return;
    const state = path.join(home, ".claude.json");
    fs.unlinkSync(state);
    write(state, JSON.stringify({ numStartups: 3 }));
    fs.chmodSync(state, 0o000);
    runSeed(CLAUDE_ONBOARDING_SEED, home);
    fs.chmodSync(state, 0o600);
    expect(fs.readFileSync(state, "utf8")).toBe(JSON.stringify({ numStartups: 3 }));
  });
});

describe("claude onboarding seed, temporary names", () => {
  it("a temporary name that is already taken is someone else's file: kept, and another name is used", () => {
    // Review 2026-09-28 (18): the seed's temporary is named by its PID; when a file of that name
    // already existed (a restored home, a reused PID), the exclusive create failed and the cleanup
    // then removed that file. The preload takes both names before the program runs, in its process.
    const home = makeHome();
    write(path.join(home, ".claude.json"), JSON.stringify({ numStartups: 3 }));
    write(path.join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
    const preload = path.join(home, "take-temp-names.cjs");
    const taken = [
      path.join(home, "..claude.json.mend-seed-"),
      path.join(home, ".claude", ".settings.json.mend-seed-"),
    ];
    fs.writeFileSync(
      preload,
      `for(const p of ${JSON.stringify(taken)})require("fs").writeFileSync(p+process.pid,"Saved user work\\n");`,
    );
    const env: Record<string, string> = {
      ...process.env,
      HOME: home,
      NODE_OPTIONS: `--require ${preload}`,
      CLAUDE_CODE_OAUTH_TOKEN: "tok-123",
    } as Record<string, string>;
    const result = spawnSync("sh", ["-c", CLAUDE_ONBOARDING_SEED, "sh", "true"], {
      encoding: "utf8",
      env,
    });
    expect(result.status).toBe(0);
    expect(readJson(path.join(home, ".claude.json"))).toMatchObject({
      numStartups: 3,
      hasCompletedOnboarding: true,
    });
    expect(readJson(path.join(home, ".claude", "settings.json"))).toEqual({
      theme: "dark",
      skipDangerousModePermissionPrompt: true,
      model: "fable",
    });
    for (const prefix of taken) {
      const siblings = fs
        .readdirSync(path.dirname(prefix))
        .filter((name) => name.startsWith(path.basename(prefix)));
      expect(siblings, prefix).toHaveLength(1);
      expect(siblings[0]).toMatch(/-\d+$/);
      expect(fs.readFileSync(path.join(path.dirname(prefix), siblings[0] ?? ""), "utf8")).toBe(
        "Saved user work\n",
      );
    }
  });
});

describe("codex trust seed", () => {
  it("adds the trust table on its own line, even after a last line without a newline", () => {
    const home = makeHome();
    const config = path.join(home, ".codex", "config.toml");
    write(config, 'model = "gpt-6"');
    expect(runSeed(CODEX_TRUST_SEED, home)).toBe("ran \n");
    const text = fs.readFileSync(config, "utf8");
    expect(text.startsWith('model = "gpt-6"\n')).toBe(true);
    expect(text).toContain('\n[projects."/workspace/repo"]\ntrust_level = "trusted"\n');
    // Already trusted: nothing is written.
    runSeed(CODEX_TRUST_SEED, home);
    expect(fs.readFileSync(config, "utf8")).toBe(text);
  });

  it("turns Codex's shell snapshot off in config.toml, for a Codex started by hand too", () => {
    const home = makeHome();
    const config = path.join(home, ".codex", "config.toml");
    // No file: a [features] table of its own.
    runSeed(CODEX_TRUST_SEED, home);
    expect(fs.readFileSync(config, "utf8")).toContain("[features]\nshell_snapshot = false\n");
    // A [features] table of the person's: the key goes into it, the rest is kept, and the mode.
    write(config, 'model = "gpt-6"\n\n[features]\nmemories = true\n\n[tui]\ntheme = "x"\n');
    fs.chmodSync(config, 0o600);
    runSeed(CODEX_TRUST_SEED, home);
    const text = fs.readFileSync(config, "utf8");
    expect(
      text.startsWith('model = "gpt-6"\n\n[features]\nshell_snapshot = false\nmemories = true\n'),
    ).toBe(true);
    expect(text.match(/\[features\]/g)).toHaveLength(1);
    expect(fs.statSync(config).mode & 0o777).toBe(0o600);
    // Root-level dotted keys: a dotted key, never a second definition of the table.
    write(config, 'features.memories = true\n\n[tui]\ntheme = "x"\n');
    runSeed(CODEX_TRUST_SEED, home);
    expect(fs.readFileSync(config, "utf8")).toContain(
      "features.memories = true\n\nfeatures.shell_snapshot = false\n[tui]",
    );
    expect(fs.readFileSync(config, "utf8")).not.toContain("[features]");
    // The person chose: left as it is.
    write(config, "[features]\nshell_snapshot = true\n");
    runSeed(CODEX_TRUST_SEED, home);
    expect(fs.readFileSync(config, "utf8").startsWith("[features]\nshell_snapshot = true\n")).toBe(
      true,
    );
  });
});

/** A Codex login copy as the platform injects it: an access token whose payload carries `exp`. */
const codexCopy = (home: string, exp: number, account = "acct-1") => {
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  write(
    path.join(home, ".codex", "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: `header.${payload}.signature`,
        refresh_token: COPY_REFRESH_TOKEN,
        account_id: account,
      },
    }),
  );
  return `header.${payload}.signature`;
};

/** Run pi's or opencode's seed with no XDG or pi overrides, so each reads its default paths. */
const runToolSeed = (seed: string, home: string) => {
  const env: Record<string, string> = { ...process.env, HOME: home } as Record<string, string>;
  for (const name of ["XDG_DATA_HOME", "PI_CODING_AGENT_DIR"]) delete env[name];
  const result = spawnSync("sh", ["-c", seed, "sh", "sh", "-c", "echo ran"], {
    encoding: "utf8",
    env,
  });
  expect(result.status).toBe(0);
  return result.stdout;
};

describe("pi and opencode seeds: the ChatGPT login from the Codex copy", () => {
  it("writes pi's openai-codex login from the Codex copy, a copy that cannot refresh", () => {
    const home = makeHome();
    const access = codexCopy(home, 1_800_000_000);
    expect(runToolSeed(PI_SEED, home)).toBe("ran\n");
    const auth = path.join(home, ".pi", "agent", "auth.json");
    expect(readJson(auth)).toEqual({
      "openai-codex": {
        type: "oauth",
        access,
        refresh: COPY_REFRESH_TOKEN,
        expires: 1_800_000_000_000,
        accountId: "acct-1",
      },
    });
    expect(fs.statSync(auth).mode & 0o777).toBe(0o600);
    // pi's own default is Google: with no choice of the user's, it runs on this login.
    expect(readJson(path.join(home, ".pi", "agent", "settings.json"))).toEqual({
      defaultProvider: "openai-codex",
    });
  });

  it("writes opencode's openai login under its data directory", () => {
    const home = makeHome();
    const access = codexCopy(home, 1_800_000_000);
    expect(runToolSeed(OPENCODE_SEED, home)).toBe("ran\n");
    expect(readJson(path.join(home, ".local", "share", "opencode", "auth.json"))).toMatchObject({
      openai: { type: "oauth", access, refresh: COPY_REFRESH_TOKEN },
    });
  });

  it("never replaces a login made in the session, nor a provider the user chose", () => {
    const home = makeHome();
    codexCopy(home, 1_800_000_000);
    const own = {
      type: "oauth",
      access: "mine",
      refresh: "real-refresh",
      expires: 1,
      accountId: "x",
    };
    write(path.join(home, ".pi", "agent", "auth.json"), JSON.stringify({ "openai-codex": own }));
    write(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ defaultProvider: "anthropic" }),
    );
    runToolSeed(PI_SEED, home);
    expect(readJson(path.join(home, ".pi", "agent", "auth.json"))).toEqual({ "openai-codex": own });
    expect(readJson(path.join(home, ".pi", "agent", "settings.json"))).toEqual({
      defaultProvider: "anthropic",
    });
  });

  it("replaces its own earlier copy with the newer one, and keeps other providers", () => {
    const home = makeHome();
    write(
      path.join(home, ".pi", "agent", "auth.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "old",
          refresh: COPY_REFRESH_TOKEN,
          expires: 1,
          accountId: "a",
        },
        anthropic: { type: "api_key", key: "sk-ant" },
      }),
    );
    const access = codexCopy(home, 1_900_000_000);
    runToolSeed(PI_SEED, home);
    expect(readJson(path.join(home, ".pi", "agent", "auth.json"))).toMatchObject({
      "openai-codex": { access, expires: 1_900_000_000_000 },
      anthropic: { type: "api_key", key: "sk-ant" },
    });
  });

  it("writes nothing without a Codex login, and the harness still runs", () => {
    const home = makeHome();
    expect(runToolSeed(PI_SEED, home)).toBe("ran\n");
    expect(runToolSeed(OPENCODE_SEED, home)).toBe("ran\n");
    expect(fs.existsSync(path.join(home, ".pi", "agent", "auth.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".local", "share", "opencode", "auth.json"))).toBe(false);
  });
});

describe("Codex's memory (docs/adr/0009, Codex)", () => {
  it("is on in every Codex launch, terminal or app-server, unless the launch names it itself", () => {
    expect(withCodexMemory(["codex", "resume", "abc"])).toEqual([
      "codex",
      "-c",
      "features.memories=true",
      "resume",
      "abc",
    ]);
    expect(withHarnessSetup("codex", ["codex", "app-server"]).slice(-6)).toEqual([
      "codex",
      "-c",
      "features.shell_snapshot=false",
      "-c",
      "features.memories=true",
      "app-server",
    ]);
    const own = ["codex", "-c", "features.memories=false"];
    expect(withCodexMemory(own)).toEqual(own);
    expect(withCodexMemory(["claude"])).toEqual(["claude"]);
  });
});

describe("Codex's shell snapshot", () => {
  it("is off in every Codex launch, unless the launch names it itself", () => {
    expect(withoutCodexShellSnapshot(["codex", "resume", "abc"])).toEqual([
      "codex",
      "-c",
      "features.shell_snapshot=false",
      "resume",
      "abc",
    ]);
    const own = ["codex", "-c", "features.shell_snapshot=true"];
    expect(withoutCodexShellSnapshot(own)).toEqual(own);
    expect(withoutCodexShellSnapshot(["claude"])).toEqual(["claude"]);
    // Another feature whose name starts the same is not this one.
    expect(withoutCodexShellSnapshot(["codex", "-c", "features.shell_snapshot_v2=true"])).toEqual([
      "codex",
      "-c",
      "features.shell_snapshot=false",
      "-c",
      "features.shell_snapshot_v2=true",
    ]);
  });
});
