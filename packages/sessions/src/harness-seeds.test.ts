import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CLAUDE_ONBOARDING_SEED, CODEX_TRUST_SEED } from "./harness-seeds.ts";

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
      model: "claude-fable-5",
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
      model: "claude-fable-5",
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
