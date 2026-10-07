import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { LinuxIdentity, OPENCODE_DEFAULT_MODEL } from "@mend/domain/workbench";
import { afterEach, describe, expect, it } from "vitest";

import { personHomeScript } from "./harness-layout.ts";
import {
  CLAUDE_ONBOARDING_SEED,
  CODEX_TRUST_SEED,
  COPY_REFRESH_TOKEN,
  HARNESS_UPDATES_OFF_ENV,
  OPENCODE_CAPTURED_SEED,
  OPENCODE_SEED,
  PI_SEED,
  chatgptCopiesScrubArgv,
  withCodexMemory,
  launchesCodex,
  withCodexMemoryOff,
  withoutCodexShellSnapshot,
  withHarnessSetup,
  withoutCodexDaemon,
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

  it("turns Claude Code's self-updater off for the process it execs", () => {
    // 2026-10-05: a Claude that updated itself inside a workspace left `bin/claude.exe` a stub, and
    // every later `claude` there failed to start. DISABLE_AUTOUPDATER is the switch 2.1.x reads.
    const home = makeHome();
    const result = spawnSync(
      "sh",
      ["-c", CLAUDE_ONBOARDING_SEED, "sh", "sh", "-c", 'echo "updater off: $DISABLE_AUTOUPDATER"'],
      { encoding: "utf8", env: { ...process.env, HOME: home, DISABLE_AUTOUPDATER: "" } },
    );
    expect(result.stdout).toBe("updater off: 1\n");
  });

  it("names every harness's own update switch for the workspace's environment", () => {
    expect(HARNESS_UPDATES_OFF_ENV).toEqual({
      DISABLE_AUTOUPDATER: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      PI_SKIP_VERSION_CHECK: "1",
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
  for (const name of ["XDG_DATA_HOME", "XDG_STATE_HOME", "PI_CODING_AGENT_DIR"]) delete env[name];
  const result = spawnSync("sh", ["-c", seed, "sh", "sh", "-c", "echo ran"], {
    encoding: "utf8",
    env,
  });
  expect(result.status).toBe(0);
  return result.stdout;
};

describe("pi and opencode seeds in a person's home (docs/adr/0016, decision 5)", () => {
  it("write the ChatGPT copies in place: no regular auth.json under P, and every link stays a link", () => {
    const root = makeHome();
    const harnessHome = path.join(root, "harness-home");
    const home = path.join(root, "home", "m3kq7xj2a");
    fs.mkdirSync(harnessHome, { recursive: true });
    const person = new LinuxIdentity({ accountId: "maria-1", name: "m3kq7xj2a", uid: 40_012 });
    const made = spawnSync(
      "sh",
      [
        "-c",
        personHomeScript(person, {
          harnessHome,
          home,
          tmpRoot: path.join(root, "tmp"),
          runRoot: path.join(root, "run"),
        }),
      ],
      { encoding: "utf8" },
    );
    expect(made.status).toBe(0);
    const saved = path.join(harnessHome, "people", "maria-1");
    // Core's copy of Maria's own Codex login, in her home.
    const access = codexCopy(home, 1_800_000_000);
    expect(runToolSeed(OPENCODE_SEED, home)).toBe("ran\n");
    expect(runToolSeed(PI_SEED, home)).toBe("ran\n");
    // opencode's data directory is saved; its auth.json there is a link into the home.
    const inSaved = path.join(saved, ".local/share/opencode/auth.json");
    expect(fs.lstatSync(inSaved).isSymbolicLink()).toBe(true);
    expect(readJson(path.join(home, ".mend/opencode/auth.json"))).toMatchObject({
      openai: { type: "oauth", access, refresh: COPY_REFRESH_TOKEN },
    });
    expect(fs.statSync(path.join(home, ".mend/opencode/auth.json")).mode & 0o777).toBe(0o600);
    // pi's settings, saved, stay a link into P: written through, never replaced.
    const piSettings = path.join(home, ".pi/agent/settings.json");
    expect(fs.lstatSync(piSettings).isSymbolicLink()).toBe(true);
    expect(readJson(path.join(saved, ".pi/agent/settings.json"))).toEqual({
      defaultProvider: "openai-codex",
    });
    // No regular file named auth.json anywhere under P.
    const regular: Array<string> = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "auth.json" && !entry.isSymbolicLink()) regular.push(full);
      }
    };
    walk(saved);
    expect(regular).toEqual([]);
  });
});

describe("a release removes Mend's ChatGPT copies (docs/adr/0016, decision 5)", () => {
  it("drops only the copies, in place, and keeps a login the person made themselves", () => {
    const home = makeHome();
    write(
      path.join(home, ".pi/agent/auth.json"),
      JSON.stringify({
        "openai-codex": { type: "oauth", access: "a", refresh: COPY_REFRESH_TOKEN },
        anthropic: { type: "oauth", access: "mine", refresh: "real" },
      }),
    );
    fs.mkdirSync(path.join(home, ".mend/opencode"), { recursive: true });
    const real = path.join(home, ".mend/opencode/auth.json");
    write(
      real,
      JSON.stringify({ openai: { type: "oauth", access: "b", refresh: COPY_REFRESH_TOKEN } }),
    );
    // opencode's file is reached through the link in its saved data directory: still a file.
    const [command, ...args] = chatgptCopiesScrubArgv(home);
    const run = spawnSync(command ?? "node", args, { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(readJson(path.join(home, ".pi/agent/auth.json"))).toEqual({
      anthropic: { type: "oauth", access: "mine", refresh: "real" },
    });
    expect(readJson(real)).toEqual({});
    // A login the person made in opencode (a real refresh token) stays.
    write(real, JSON.stringify({ openai: { type: "oauth", access: "c", refresh: "real" } }));
    spawnSync(command ?? "node", args, { encoding: "utf8" });
    expect(readJson(real)).toMatchObject({ openai: { refresh: "real" } });
  });

  it("never writes through a link put where a copy was", () => {
    const home = makeHome();
    const target = path.join(home, "target.json");
    write(target, JSON.stringify({ "openai-codex": { refresh: COPY_REFRESH_TOKEN } }));
    fs.mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
    fs.symlinkSync(target, path.join(home, ".pi/agent/auth.json"));
    const [command, ...args] = chatgptCopiesScrubArgv(home);
    expect(spawnSync(command ?? "node", args, { encoding: "utf8" }).status).toBe(0);
    expect(readJson(target)).toEqual({ "openai-codex": { refresh: COPY_REFRESH_TOKEN } });
  });
});

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
    expect(fs.existsSync(path.join(home, ".local", "state", "opencode", "model.json"))).toBe(false);
  });
});

const modelFile = (home: string) => path.join(home, ".local", "state", "opencode", "model.json");

describe("opencode's seed: the model it opens on", () => {
  const [providerID, modelID] = OPENCODE_DEFAULT_MODEL.split("/");

  it("names the ChatGPT login's model as the last used one, so the git token's Copilot is not opencode's pick", () => {
    const home = makeHome();
    codexCopy(home, 1_800_000_000);
    expect(runToolSeed(OPENCODE_SEED, home)).toBe("ran\n");
    expect(readJson(modelFile(home))).toEqual({ recent: [{ providerID, modelID }] });
  });

  it("fills an empty list and keeps every other key opencode wrote", () => {
    const home = makeHome();
    codexCopy(home, 1_800_000_000);
    write(
      modelFile(home),
      JSON.stringify({
        recent: [],
        favorite: [{ providerID: "openai", modelID: "gpt-5.5" }],
        variant: { "github-copilot/claude-sonnet-4.6": "default" },
      }),
    );
    runToolSeed(OPENCODE_SEED, home);
    expect(readJson(modelFile(home))).toEqual({
      recent: [{ providerID, modelID }],
      favorite: [{ providerID: "openai", modelID: "gpt-5.5" }],
      variant: { "github-copilot/claude-sonnet-4.6": "default" },
    });
  });

  it("keeps a model picked in opencode, and a file it cannot read as an object", () => {
    const home = makeHome();
    codexCopy(home, 1_800_000_000);
    const picked = JSON.stringify({ recent: [{ providerID: "anthropic", modelID: "opus" }] });
    write(modelFile(home), picked);
    runToolSeed(OPENCODE_SEED, home);
    expect(fs.readFileSync(modelFile(home), "utf8")).toBe(picked);
    write(modelFile(home), "[not an object");
    runToolSeed(OPENCODE_SEED, home);
    expect(fs.readFileSync(modelFile(home), "utf8")).toBe("[not an object");
  });

  it("names the model over the user's own openai login too, and names none without one", () => {
    const home = makeHome();
    write(
      path.join(home, ".local", "share", "opencode", "auth.json"),
      JSON.stringify({ anthropic: { type: "api", key: "sk-ant" } }),
    );
    runToolSeed(OPENCODE_SEED, home);
    expect(fs.existsSync(modelFile(home))).toBe(false);
    write(
      path.join(home, ".local", "share", "opencode", "auth.json"),
      JSON.stringify({
        openai: { type: "oauth", access: "mine", refresh: "real", expires: 1, accountId: "x" },
      }),
    );
    runToolSeed(OPENCODE_SEED, home);
    expect(readJson(modelFile(home))).toEqual({ recent: [{ providerID, modelID }] });
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
    expect(withHarnessSetup("codex", ["codex", "app-server"]).slice(-8)).toEqual([
      "codex",
      "-c",
      "features.shell_snapshot=false",
      "-c",
      "features.daemon_auto_start=false",
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
const mcpAuth = (home: string) => path.join(home, ".local", "share", "opencode", "mcp-auth.json");
const kept = (home: string) => path.join(home, ".mend", "opencode", "mcp-auth.json");

/**
 * The opencode seed a launch gets (`withHarnessSetup`): a capture launch's, or a co-located one's.
 * The environment carries nothing about the mode, as an executor's does not (sealantd consumes
 * its capture variables before any process starts): every `SEALANT_` variable is left out.
 */
const runOpencodeSeed = (home: string, options: { readonly captured?: boolean } = {}) => {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries({ ...process.env, HOME: home }).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        !entry[0].startsWith("SEALANT_") &&
        !entry[0].startsWith("XDG_"),
    ),
  );
  const argv = withHarnessSetup("opencode", ["sh", "-c", "echo ran"], {
    captured: options.captured !== false,
  });
  return spawnSync(argv[0] ?? "sh", argv.slice(1), { encoding: "utf8", env });
};

describe("opencode's seed: MCP logins stay out of saved state", () => {
  it("is a capture launch's alone, decided by Mend: the co-located seed has no MCP block", () => {
    expect(OPENCODE_CAPTURED_SEED).toContain("mcp-auth.json");
    expect(OPENCODE_SEED).not.toContain("mcp-auth.json");
    expect(OPENCODE_CAPTURED_SEED).not.toContain("SEALANT_");
    expect(withHarnessSetup("opencode", ["opencode"], { captured: true })[2]).toBe(
      OPENCODE_CAPTURED_SEED,
    );
    expect(withHarnessSetup("opencode", ["opencode"])[2]).toBe(OPENCODE_SEED);
  });

  it("links mcp-auth.json to the executor's own home, which opencode writes through", () => {
    const home = makeHome();
    expect(runOpencodeSeed(home).stdout).toBe("ran\n");
    expect(fs.lstatSync(mcpAuth(home)).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(mcpAuth(home))).toBe(
      fs.realpathSync(path.join(home, ".mend", "opencode")) + "/mcp-auth.json",
    );
    // opencode writes the file in place: the tokens land outside the saved data directory.
    fs.writeFileSync(mcpAuth(home), '{"server":{"tokens":{"accessToken":"SYNTHETIC-MCP"}}}');
    expect(fs.readFileSync(kept(home), "utf8")).toContain("SYNTHETIC-MCP");
    expect(fs.lstatSync(mcpAuth(home)).isSymbolicLink()).toBe(true);
    // A second launch keeps its own link and the logins behind it.
    runOpencodeSeed(home);
    expect(fs.readFileSync(kept(home), "utf8")).toContain("SYNTHETIC-MCP");
  });

  it("removes, unread, a plain mcp-auth.json a capture brought, maybe another person's", () => {
    const home = makeHome();
    write(mcpAuth(home), '{"server":{"tokens":{"accessToken":"SOMEONE-ELSES"}}}');
    runOpencodeSeed(home);
    expect(fs.lstatSync(mcpAuth(home)).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(kept(home))).toBe(false);
  });

  it("leaves a co-located session's own MCP logins where they are", () => {
    const home = makeHome();
    write(mcpAuth(home), '{"server":{"tokens":{"accessToken":"MINE"}}}');
    expect(runOpencodeSeed(home, { captured: false }).stdout).toBe("ran\n");
    expect(fs.lstatSync(mcpAuth(home)).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(mcpAuth(home), "utf8")).toContain("MINE");
    expect(fs.existsSync(path.join(home, ".mend"))).toBe(false);
  });

  it("two launches into one executor at once both start, on the same link", () => {
    const home = makeHome();
    const env: Record<string, string> = { ...process.env, HOME: home } as Record<string, string>;
    for (const name of ["XDG_DATA_HOME", "XDG_STATE_HOME"]) delete env[name];
    for (let round = 0; round < 5; round++) {
      fs.rmSync(path.join(home, ".local"), { recursive: true, force: true });
      const result = spawnSync(
        "sh",
        [
          "-c",
          's="$1"; shift; for i in 1 2 3 4; do sh -c "$s" sh sh -c "echo ran" & done; wait',
          "sh",
          OPENCODE_CAPTURED_SEED,
        ],
        { encoding: "utf8", env },
      );
      expect(result.stdout, result.stderr).toBe("ran\nran\nran\nran\n");
      expect(fs.lstatSync(mcpAuth(home)).isSymbolicLink()).toBe(true);
    }
  });

  it("does not start opencode when the logins cannot be kept out of saved state", () => {
    const home = makeHome();
    // `~/.mend` a file: no place in the executor's own home to keep them.
    fs.writeFileSync(path.join(home, ".mend"), "");
    write(mcpAuth(home), '{"server":{"tokens":{"accessToken":"SOMEONE-ELSES"}}}');
    const result = runOpencodeSeed(home);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("cannot be kept out of saved state");
    expect(fs.existsSync(mcpAuth(home))).toBe(false);
  });
});

describe("Codex's background server", () => {
  it("is never started by a Codex launch: terminal, resume or app-server", () => {
    const flags = [
      "-c",
      "features.shell_snapshot=false",
      "-c",
      "features.daemon_auto_start=false",
      "-c",
      "features.memories=true",
    ];
    for (const tail of [[], ["resume", "abc"], ["app-server"]]) {
      expect(withHarnessSetup("codex", ["codex", ...tail]).slice(4)).toEqual([
        "codex",
        ...flags,
        ...tail,
      ]);
    }
  });

  it("is left alone when the launch says it itself, and only Codex gets the flag", () => {
    for (const own of [
      ["codex", "-c", "features.daemon_auto_start=true"],
      ["codex", "--no-daemon"],
      ["codex", "--enable", "daemon_auto_start"],
    ]) {
      expect(withoutCodexDaemon(own)).toEqual(own);
    }
    expect(withoutCodexDaemon(["claude"])).toEqual(["claude"]);
    expect(withHarnessSetup("claude", ["claude"])).not.toContain(
      "features.daemon_auto_start=false",
    );
    // A setting whose name starts the same is not this one.
    expect(withoutCodexDaemon(["codex", "-c", "features.daemon_auto_start_v2=true"])).toEqual([
      "codex",
      "-c",
      "features.daemon_auto_start=false",
      "-c",
      "features.daemon_auto_start_v2=true",
    ]);
  });
});

describe("Codex's memory turned off", () => {
  const off = ["-c", "features.memories=false"];
  const unsummarised = ["-c", "memories.generate_memories=false"];

  it("in a join, drops whatever the launch asked, --enable and --config included, and makes no thread to summarise", () => {
    expect(withCodexMemoryOff(["codex", "resume", "abc"], { join: true })).toEqual([
      "codex",
      ...off,
      ...unsummarised,
      "resume",
      "abc",
    ]);
    expect(
      withCodexMemoryOff(
        [
          "codex",
          "--enable",
          "memories",
          "-c",
          "features.memories=true",
          "--config",
          "memories.generate_memories=true",
          "--config=features.memories=true",
          "-c",
          "memories={generate_memories=true}",
          "--enable=memories",
          "-c",
          "model=gpt",
          "app-server",
        ],
        { join: true },
      ),
    ).toEqual(["codex", ...off, ...unsummarised, "-c", "model=gpt", "app-server"]);
    // Every form clap takes, and Codex's `memory_tool` alias. A `features` or `memories` table
    // goes whole: Codex would replace Mend's own settings with it.
    expect(
      withCodexMemoryOff(
        [
          "codex",
          "-cfeatures.memories=true",
          "-c=features.memories=true",
          "-c",
          "features.memory_tool=true",
          "--enable",
          "memory_tool",
          "--enable=memory_tool",
          "-c",
          "features={memories=true, web_search=true}",
          "--config",
          "features={web_search=true}",
          "-c",
          "memories={max_unused_days=3}",
          "-cmodel=gpt",
          "-c",
          "features.web_search=true",
        ],
        { join: true },
      ),
    ).toEqual(["codex", ...off, ...unsummarised, "-cmodel=gpt", "-c", "features.web_search=true"]);
    const [, , script] = withCodexMemoryOff(
      [
        "sh",
        "-c",
        "exec codex -c features.memories=true --dangerously-bypass-approvals-and-sandbox",
      ],
      { join: true },
    );
    expect(script).toBe(
      "exec codex -c features.memories=false -c memories.generate_memories=false --dangerously-bypass-approvals-and-sandbox",
    );
    expect(withCodexMemoryOff(["claude"], { join: true })).toEqual(["claude"]);
  });

  it("in the launcher's own home, turns memory off but keeps their new threads for their memory", () => {
    expect(withCodexMemoryOff(["codex", "--enable", "memories"], { join: false })).toEqual([
      "codex",
      ...off,
    ]);
  });
});

describe("what runs Codex, as Mend launches it", () => {
  it("is decided by the command line, not the harness's name", () => {
    expect(launchesCodex(["codex", "resume", "abc"])).toBe(true);
    expect(launchesCodex(["sh", "-c", 'exec codex -c features.memories=true "$prompt"'])).toBe(
      true,
    );
    expect(launchesCodex(["claude"])).toBe(false);
    expect(launchesCodex(["sh", "-c", "exec claude"])).toBe(false);
  });
});
