import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { LinuxIdentity, OPENCODE_DEFAULT_MODEL } from "@mend/domain/workbench";
import { afterEach, describe, expect, it } from "vitest";

import { personHomeScript } from "./harness-layout.ts";
import {
  CLAUDE_ONBOARDING_SEED,
  CLAUDE_PLUGINS_BUDGET_MS,
  claudeOnboardingSeed,
  CODEX_TRUST_SEED,
  COPY_REFRESH_TOKEN,
  HARNESS_UPDATES_OFF_ENV,
  NO_PAGER_ENV,
  OPENCODE_CAPTURED_SEED,
  OPENCODE_PERSON_SEED,
  OPENCODE_SEED,
  PI_PERSON_SEED,
  PI_SEED,
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

  it("pages through cat, and leaves GIT_PAGER to a person's own git config", () => {
    expect(NO_PAGER_ENV).toEqual({ PAGER: "cat" });
    // git reads GIT_PAGER before core.pager, PAGER after it: a person's pager stays theirs.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-pager-"));
    const git = (env: Readonly<Record<string, string>>) =>
      spawnSync("git", ["var", "GIT_PAGER"], {
        encoding: "utf8",
        env: { PATH: process.env["PATH"] ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1", ...env },
      }).stdout.trim();
    expect(git(NO_PAGER_ENV)).toBe("cat");
    fs.writeFileSync(path.join(home, ".gitconfig"), "[core]\n\tpager = delta\n");
    expect(git(NO_PAGER_ENV)).toBe("delta");
    fs.rmSync(home, { recursive: true, force: true });
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

/**
 * A stand-in `claude` for the plugin step: it logs each call (argv, working directory, the
 * updater switch, whether it has a stdin), writes what `plugin marketplace add` and `plugin
 * install` would (the marketplace named after its repository, `acme/tools` → `acme-tools`), and
 * says something on stdout and stderr, which nobody should see. `FAKE_CLAUDE_MODE`: `ok`, `fail`
 * (exit 1) or `hang` (starts a child that sleeps, writes its pid, and never exits).
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs=require("fs"),path=require("path"),h=require("os").homedir(),args=process.argv.slice(2);
const said=process.env.FAKE_SEED_STDERR?fs.readFileSync(process.env.FAKE_SEED_STDERR,"utf8"):null;
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG,JSON.stringify({args,cwd:process.cwd(),updater:process.env.DISABLE_AUTOUPDATER??null,said})+"\\n");
process.stdout.write("claude says something on stdout\\n");process.stderr.write("and on stderr\\n");
const mode=process.env.FAKE_CLAUDE_MODE||"ok";
if(mode==="hang"){const c=require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{stdio:"ignore"});fs.writeFileSync(process.env.FAKE_CLAUDE_LOG+".sleep",String(c.pid));setInterval(()=>{},1000);return}
if(mode==="fail")process.exit(1);
const dir=h+"/.claude/plugins";fs.mkdirSync(dir,{recursive:true});
const read=p=>{try{return JSON.parse(fs.readFileSync(p,"utf8"))}catch{return null}};
if(args[1]==="marketplace"){const k=dir+"/known_marketplaces.json",known=read(k)||{},name=args[3].split("#")[0].replace("/","-");
fs.mkdirSync(dir+"/marketplaces/"+name,{recursive:true});known[name]={source:args[3],installLocation:dir+"/marketplaces/"+name};fs.writeFileSync(k,JSON.stringify(known))}
if(args[1]==="install"){const f=dir+"/installed_plugins.json",list=read(f)||{version:2,plugins:{}},at=dir+"/cache/"+args[2];
fs.mkdirSync(at,{recursive:true});list.plugins[args[2]]=[{scope:"user",installPath:at}];fs.writeFileSync(f,JSON.stringify(list))}
`;

/** A home, a repository and a bin holding the fake `claude` (and `node`, and nothing else). */
const pluginScene = () => {
  const root = makeHome();
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  return { root, home, repo, bin, log: path.join(root, "claude.log") };
};

type PluginScene = ReturnType<typeof pluginScene>;

/** The seed over `scene`, as a launch runs it; its stdout, its stderr and how long it took. */
const runPluginSeed = (
  scene: PluginScene,
  options: { readonly mode?: string; readonly budgetMs?: number; readonly claude?: boolean } = {},
) => {
  const seed = claudeOnboardingSeed({
    repo: scene.repo,
    ...(options.budgetMs === undefined ? {} : { pluginBudgetMs: options.budgetMs }),
  });
  const bin = options.claude === false ? path.join(scene.root, "bin-without-claude") : scene.bin;
  if (options.claude === false) {
    fs.mkdirSync(bin, { recursive: true });
    if (!fs.existsSync(path.join(bin, "node")))
      fs.symlinkSync(process.execPath, path.join(bin, "node"));
  }
  const started = Date.now();
  const result = spawnSync(
    "/bin/sh",
    ["-c", seed, "sh", "/bin/sh", "-c", 'echo "ran $IS_SANDBOX"'],
    {
      encoding: "utf8",
      env: {
        PATH: bin,
        HOME: scene.home,
        FAKE_CLAUDE_LOG: scene.log,
        FAKE_CLAUDE_MODE: options.mode ?? "ok",
      },
    },
  );
  expect(result.status).toBe(0);
  return { stdout: result.stdout, stderr: result.stderr, tookMs: Date.now() - started };
};

/** The calls the fake `claude` saw. */
const claudeCalls = (scene: PluginScene) =>
  fs.existsSync(scene.log)
    ? fs
        .readFileSync(scene.log, "utf8")
        .trim()
        .split("\n")
        .map(
          (
            line,
          ): {
            args: Array<string>;
            cwd: string;
            updater: string | null;
            said: string | null;
          } => JSON.parse(line),
        )
    : [];

describe("claude onboarding seed: the plugins its settings enable", () => {
  it("installs what the person's and the repository's settings enable, in Claude's order, and names it", () => {
    const scene = pluginScene();
    write(
      path.join(scene.home, ".claude", "settings.json"),
      JSON.stringify({
        enabledPlugins: { "pstack@pstack-claude": true, "noisy@acme-tools": true },
        extraKnownMarketplaces: {
          "pstack-claude": { source: { source: "github", repo: "ypanagidis/pstack" } },
        },
      }),
    );
    write(
      path.join(scene.repo, ".claude", "settings.json"),
      JSON.stringify({
        enabledPlugins: { "lint@acme-tools": true, "off@acme-tools": false },
        extraKnownMarketplaces: {
          "acme-tools": { source: { source: "github", repo: "acme/tools", ref: "v2" } },
        },
      }),
    );
    // The repository's local settings come last: their `false` turns the person's `true` off.
    write(
      path.join(scene.repo, ".claude", "settings.local.json"),
      JSON.stringify({ enabledPlugins: { "noisy@acme-tools": false } }),
    );
    const { stdout, stderr } = runPluginSeed(scene);
    // A protocol launch's stdout is Claude's alone: nothing of the step's, nor of its `claude`s.
    expect(stdout).toBe("ran 1\n");
    expect(stderr).toBe(
      `mend: installing Claude plugins · pstack@pstack-claude, lint@acme-tools …\n` +
        "mend: Claude plugins · installed: pstack@pstack-claude, lint@acme-tools\n",
    );
    const calls = claudeCalls(scene);
    expect(calls.map((call) => call.args)).toEqual([
      ["plugin", "marketplace", "add", "ypanagidis/pstack"],
      ["plugin", "install", "pstack@pstack-claude", "--scope", "user"],
      ["plugin", "marketplace", "add", "acme/tools#v2"],
      ["plugin", "install", "lint@acme-tools", "--scope", "user"],
    ]);
    for (const call of calls) {
      expect(call.cwd).toBe(fs.realpathSync(scene.repo));
      expect(call.updater).toBe("1");
    }
    // The seed's own merge still ran first.
    expect(readJson(path.join(scene.home, ".claude", "settings.json"))).toMatchObject({
      skipDangerousModePermissionPrompt: true,
    });
  });

  it("skips a plugin already installed for the user and on disk, and a marketplace Claude knows", () => {
    const scene = pluginScene();
    write(
      path.join(scene.repo, ".claude", "settings.json"),
      JSON.stringify({
        enabledPlugins: { "here@m": true, "gone@m": true, "elsewhere@m": true },
        extraKnownMarketplaces: { m: { source: { source: "github", repo: "acme/m" } } },
      }),
    );
    const plugins = path.join(scene.home, ".claude", "plugins");
    fs.mkdirSync(path.join(plugins, "cache", "here"), { recursive: true });
    fs.mkdirSync(path.join(plugins, "marketplaces", "m"), { recursive: true });
    write(
      path.join(plugins, "known_marketplaces.json"),
      JSON.stringify({ m: { installLocation: path.join(plugins, "marketplaces", "m") } }),
    );
    write(
      path.join(plugins, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "here@m": [{ scope: "user", installPath: path.join(plugins, "cache", "here") }],
          // Listed, but its files went with an earlier executor.
          "gone@m": [{ scope: "user", installPath: path.join(plugins, "cache", "gone") }],
          // Installed for another project only.
          "elsewhere@m": [
            {
              scope: "project",
              projectPath: "/somewhere/else",
              installPath: path.join(plugins, "cache", "here"),
            },
          ],
        },
      }),
    );
    const { stderr } = runPluginSeed(scene);
    expect(stderr).toBe(
      `mend: installing Claude plugins · gone@m, elsewhere@m …\n` +
        "mend: Claude plugins · installed: gone@m, elsewhere@m · already installed: here@m\n",
    );
    expect(claudeCalls(scene).map((call) => call.args)).toEqual([
      ["plugin", "install", "gone@m", "--scope", "user"],
      ["plugin", "install", "elsewhere@m", "--scope", "user"],
    ]);

    // The next launch in the executor finds them all and starts no `claude`.
    fs.rmSync(scene.log);
    expect(runPluginSeed(scene).stderr).toBe(
      "mend: Claude plugins · already installed: here@m, gone@m, elsewhere@m\n",
    );
    expect(claudeCalls(scene)).toEqual([]);
  });

  it("says nothing and starts no claude when no plugin is enabled", () => {
    const scene = pluginScene();
    write(
      path.join(scene.repo, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "off@m": false }, model: "x" }),
    );
    // A settings file that is not JSON is read as nothing, and left as it is.
    write(path.join(scene.repo, ".claude", "settings.local.json"), "{ not json");
    const { stdout, stderr } = runPluginSeed(scene);
    expect(stdout).toBe("ran 1\n");
    expect(stderr).toBe("");
    expect(claudeCalls(scene)).toEqual([]);
    expect(fs.readFileSync(path.join(scene.repo, ".claude", "settings.local.json"), "utf8")).toBe(
      "{ not json",
    );
  });

  it("puts no name or source in an argv that it has not checked, and no credentials in a URL", () => {
    const scene = pluginScene();
    write(
      path.join(scene.repo, ".claude", "settings.json"),
      JSON.stringify({
        enabledPlugins: {
          "--help@m": true,
          "a b@m": true,
          "x@$(touch pwned)": true,
          "good@private": true,
          "fine@https-m": true,
        },
        extraKnownMarketplaces: {
          private: {
            source: { source: "git", url: "https://person:ghp_secret@github.com/a/b.git" },
          },
          "https-m": { source: { source: "git", url: "https://github.com/a/m.git", ref: "main" } },
        },
      }),
    );
    const { stderr } = runPluginSeed(scene);
    expect(stderr).toBe(
      `mend: installing Claude plugins · good@private, fine@https-m …\n` +
        "mend: Claude plugins · installed: good@private, fine@https-m\n",
    );
    const calls = claudeCalls(scene).map((call) => call.args);
    expect(calls).toEqual([
      // A source with credentials in it is not used: Claude is left to find the marketplace.
      ["plugin", "install", "good@private", "--scope", "user"],
      ["plugin", "marketplace", "add", "https://github.com/a/m.git#main"],
      ["plugin", "install", "fine@https-m", "--scope", "user"],
    ]);
    expect(JSON.stringify(calls)).not.toContain("ghp_secret");
    expect(fs.existsSync(path.join(scene.repo, "pwned"))).toBe(false);
  });

  it("a plugin that cannot be installed is said in one line, and Claude starts anyway", () => {
    const scene = pluginScene();
    write(
      path.join(scene.repo, ".claude", "settings.json"),
      JSON.stringify({
        enabledPlugins: { "a@m": true, "b@m": true, "c@n": true },
        extraKnownMarketplaces: { m: { source: { source: "github", repo: "acme/m" } } },
      }),
    );
    const failing = runPluginSeed(scene, { mode: "fail" });
    expect(failing.stdout).toBe("ran 1\n");
    expect(failing.stderr).toBe(
      `mend: installing Claude plugins · a@m, b@m, c@n …\n` +
        "mend: Claude plugins · not installed: a@m (marketplace not added: exit 1), b@m (marketplace not added: exit 1), c@n (exit 1)\n",
    );
    // The marketplace that could not be added is tried once.
    expect(claudeCalls(scene).map((call) => call.args)).toEqual([
      ["plugin", "marketplace", "add", "acme/m"],
      ["plugin", "install", "c@n", "--scope", "user"],
    ]);

    const missing = pluginScene();
    write(
      path.join(missing.repo, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "a@m": true } }),
    );
    const noClaude = runPluginSeed(missing, { claude: false });
    expect(noClaude.stdout).toBe("ran 1\n");
    expect(noClaude.stderr).toBe(
      `mend: installing Claude plugins · a@m …\n` +
        "mend: Claude plugins · not installed: a@m (claude did not start)\n",
    );
  });

  it("is bounded: a claude that hangs is killed with what it started, and the launch goes on", () => {
    const scene = pluginScene();
    write(
      path.join(scene.repo, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "a@m": true, "b@m": true } }),
    );
    const { stdout, stderr, tookMs } = runPluginSeed(scene, { mode: "hang", budgetMs: 1500 });
    expect(stdout).toBe("ran 1\n");
    expect(stderr).toBe(
      `mend: installing Claude plugins · a@m, b@m …\n` +
        "mend: Claude plugins · not installed: a@m (timed out), b@m (timed out)\n",
    );
    expect(tookMs).toBeLessThan(10_000);
    // One budget for the whole step: the second plugin started no claude of its own.
    expect(claudeCalls(scene)).toHaveLength(1);
    // The hung claude's own child went with it (its process group was killed).
    const sleeper = Number(fs.readFileSync(`${scene.log}.sleep`, "utf8"));
    const alive = () => {
      try {
        process.kill(sleeper, 0);
        return true;
      } catch {
        return false;
      }
    };
    const until = Date.now() + 2000;
    while (alive() && Date.now() < until) spawnSync("sleep", ["0.05"]);
    expect(alive()).toBe(false);
  });

  it("says what it is installing before the first install starts, so a terminal is not blank", () => {
    const scene = pluginScene();
    write(
      path.join(scene.repo, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "here@m": true, "new@m": true } }),
    );
    const plugins = path.join(scene.home, ".claude", "plugins");
    fs.mkdirSync(path.join(plugins, "cache", "here"), { recursive: true });
    write(
      path.join(plugins, "installed_plugins.json"),
      JSON.stringify({
        plugins: {
          "here@m": [{ scope: "user", installPath: path.join(plugins, "cache", "here") }],
        },
      }),
    );
    // The seed's stderr goes to a file the fake `claude` reads when it starts.
    const said = path.join(scene.root, "seed.stderr");
    const fd = fs.openSync(said, "w");
    const result = spawnSync(
      "/bin/sh",
      ["-c", claudeOnboardingSeed({ repo: scene.repo }), "sh", "/bin/sh", "-c", "echo ran"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", fd],
        env: {
          PATH: scene.bin,
          HOME: scene.home,
          FAKE_CLAUDE_LOG: scene.log,
          FAKE_SEED_STDERR: said,
        },
      },
    );
    fs.closeSync(fd);
    expect(result.stdout).toBe("ran\n");
    expect(claudeCalls(scene).map((call) => call.said)).toEqual([
      "mend: installing Claude plugins · new@m …\n",
    ]);
    expect(fs.readFileSync(said, "utf8")).toBe(
      "mend: installing Claude plugins · new@m …\n" +
        "mend: Claude plugins · installed: new@m · already installed: here@m\n",
    );
  });

  it("is what every Claude launch starts behind, protocol and terminal alike, reading /workspace/repo", () => {
    expect(withHarnessSetup("claude", ["claude", "-p"])).toEqual([
      "sh",
      "-c",
      CLAUDE_ONBOARDING_SEED,
      "sh",
      "claude",
      "-p",
    ]);
    expect(CLAUDE_ONBOARDING_SEED).toContain(
      `'/workspace/repo' ${CLAUDE_PLUGINS_BUDGET_MS} 3>&2 2>/dev/null;`,
    );
    expect(CLAUDE_PLUGINS_BUDGET_MS).toBe(30_000);
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
  /** Maria's home as a person's first process makes it, with her saved directory `P`. */
  const mariasHome = () => {
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
    return { home, saved: path.join(harnessHome, "people", "maria-1") };
  };

  it("write no ChatGPT login of their own: Core wrote it (sealant#336), and every link stays a link", () => {
    const { home, saved } = mariasHome();
    // A Codex login in her home, as Core writes it: the person seeds never copy it.
    codexCopy(home, 1_800_000_000);
    expect(runToolSeed(OPENCODE_PERSON_SEED, home)).toBe("ran\n");
    expect(runToolSeed(PI_PERSON_SEED, home)).toBe("ran\n");
    expect(fs.existsSync(path.join(home, ".mend/opencode/auth.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".pi/agent/auth.json"))).toBe(false);
    // pi's settings stay a link into P, and nothing names a provider without a login.
    const piSettings = path.join(home, ".pi/agent/settings.json");
    expect(fs.lstatSync(piSettings).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(saved, ".pi/agent/settings.json"))).toBe(false);
    // opencode's data directory is saved; its auth.json there is a link into the home.
    expect(fs.lstatSync(path.join(saved, ".local/share/opencode/auth.json")).isSymbolicLink()).toBe(
      true,
    );
  });

  it("with the logins Core wrote, pi defaults to ChatGPT and opencode opens on its model, written through the links", () => {
    const { home, saved } = mariasHome();
    const login = { type: "oauth", access: "a", refresh: "core-copy", expires: 1, accountId: "x" };
    write(path.join(home, ".pi/agent/auth.json"), JSON.stringify({ "openai-codex": login }));
    write(path.join(home, ".mend/opencode/auth.json"), JSON.stringify({ openai: login }));
    expect(runToolSeed(PI_PERSON_SEED, home)).toBe("ran\n");
    expect(runToolSeed(OPENCODE_PERSON_SEED, home)).toBe("ran\n");
    expect(readJson(path.join(saved, ".pi/agent/settings.json"))).toEqual({
      defaultProvider: "openai-codex",
    });
    expect(fs.lstatSync(path.join(home, ".pi/agent/settings.json")).isSymbolicLink()).toBe(true);
    // Core's logins are left exactly as Core wrote them.
    expect(readJson(path.join(home, ".pi/agent/auth.json"))).toEqual({ "openai-codex": login });
    expect(readJson(path.join(home, ".mend/opencode/auth.json"))).toEqual({ openai: login });
    const [providerID, modelID] = OPENCODE_DEFAULT_MODEL.split("/");
    expect(readJson(path.join(home, ".local/state/opencode/model.json"))).toMatchObject({
      recent: [{ providerID, modelID }],
    });
    // A provider the person chose stays theirs.
    write(path.join(saved, ".pi/agent/settings.json"), JSON.stringify({ defaultProvider: "x" }));
    runToolSeed(PI_PERSON_SEED, home);
    expect(readJson(path.join(saved, ".pi/agent/settings.json"))).toEqual({
      defaultProvider: "x",
    });
  });

  it("are what a person executor's pi and opencode start behind, and only there", () => {
    expect(withHarnessSetup("pi", ["pi"], { person: true })[2]).toBe(PI_PERSON_SEED);
    expect(withHarnessSetup("opencode", ["opencode"], { captured: true, person: true })[2]).toBe(
      OPENCODE_PERSON_SEED,
    );
    expect(withHarnessSetup("pi", ["pi"], { captured: true })[2]).toBe(PI_SEED);
    expect(withHarnessSetup("opencode", ["opencode"], { captured: true })[2]).toBe(
      OPENCODE_CAPTURED_SEED,
    );
    expect(OPENCODE_PERSON_SEED).toContain("mcp-auth.json");
    for (const seed of [PI_PERSON_SEED, OPENCODE_PERSON_SEED]) {
      expect(seed).not.toContain(".codex/auth.json");
    }
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
