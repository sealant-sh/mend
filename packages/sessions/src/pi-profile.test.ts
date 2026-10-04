import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { piProfileDigest } from "@mend/db";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { PI_SEED } from "./harness-seeds.ts";
import {
  PI_PROFILE_HOME_DIR,
  PI_PROFILE_KEPT_DIR,
  PI_PROFILE_PROGRAM,
  PI_PROFILE_SECRET_FILE,
  clearPiProfile,
  clearPiProfileExec,
  materializePiProfile,
  planPiProfile,
} from "./pi-profile.ts";

const dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const tempDir = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));

type ProfileFile = {
  readonly path: string;
  readonly encoding: "utf8" | "base64";
  readonly contents: string;
};

const profileOf = (files: ReadonlyArray<ProfileFile>) => ({
  digest: piProfileDigest(files),
  files,
});

const extension: ProfileFile = {
  path: "extensions/git-info/index.ts",
  encoding: "utf8",
  contents: "export default () => {};\n",
};
const banner: ProfileFile = {
  path: "extensions/git-info/banner.png",
  encoding: "base64",
  contents: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]).toString("base64"),
};

describe("delivering a pi profile into a harness home", () => {
  const deliver = (home: string, files: ReadonlyArray<ProfileFile>) =>
    Effect.runPromise(materializePiProfile(home, planPiProfile(profileOf(files))));

  it("writes the profile's files, bytes and all, where pi's agent directory holds them", async () => {
    const home = tempDir("mend-pi-home-");
    await deliver(home, [extension, banner]);
    const root = path.join(home, PI_PROFILE_HOME_DIR);
    expect(root).toBe(path.join(home, ".pi/agent/mend/profile"));
    expect(fs.readFileSync(path.join(root, extension.path), "utf8")).toBe(extension.contents);
    expect([...fs.readFileSync(path.join(root, banner.path))]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x00, 0xff,
    ]);
  });

  it("leaves a profile already in place alone, whatever the session installed inside it", async () => {
    const home = tempDir("mend-pi-home-");
    await deliver(home, [extension]);
    const root = path.join(home, PI_PROFILE_HOME_DIR);
    write(path.join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    const written = path.join(root, extension.path);
    fs.utimesSync(written, new Date(0), new Date(0));

    const outcomes = await deliver(home, [extension]);
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["unchanged"]);
    // Not written again: its time is the one the test set.
    expect(fs.statSync(written).mtimeMs).toBe(0);
    expect(fs.existsSync(path.join(root, "node_modules", "dep", "index.js"))).toBe(true);
  });

  it("leaves a profile restored without its mcp.json unchanged, and writes the mcp.json again", async () => {
    // The platform never saves `root/mcp.json` (it can hold the person's keys): a profile restored
    // from a capture lacks it, and must still read as delivered, keeping what the session
    // installed in it.
    const mcp: ProfileFile = {
      path: PI_PROFILE_SECRET_FILE,
      encoding: "utf8",
      contents: '{"mcpServers":{"docs":{"headers":{"Authorization":"Bearer x"}}}}',
    };
    const home = tempDir("mend-pi-home-");
    await deliver(home, [extension, mcp]);
    const root = path.join(home, PI_PROFILE_HOME_DIR);
    write(path.join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    fs.rmSync(path.join(root, PI_PROFILE_SECRET_FILE));

    const outcomes = await deliver(home, [extension, mcp]);
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["unchanged"]);
    expect(fs.readFileSync(path.join(root, PI_PROFILE_SECRET_FILE), "utf8")).toBe(mcp.contents);
    expect(fs.existsSync(path.join(root, "node_modules", "dep", "index.js"))).toBe(true);
    // A changed mcp.json alone is written over the restored one, still unchanged.
    const edited = { ...mcp, contents: '{"mcpServers":{}}' };
    expect((await deliver(home, [extension, edited])).map((o) => o.outcome)).toEqual(["unchanged"]);
    expect(fs.readFileSync(path.join(root, PI_PROFILE_SECRET_FILE), "utf8")).toBe(edited.contents);
  });

  it("takes out a profile when the session's owner has none", async () => {
    const home = tempDir("mend-pi-home-");
    await deliver(home, [extension]);
    await Effect.runPromise(clearPiProfile(home));
    expect(fs.existsSync(path.join(home, PI_PROFILE_HOME_DIR))).toBe(false);
    // In a workspace, through exec.
    await deliver(home, [extension]);
    const [command, ...args] = clearPiProfileExec(home);
    expect(spawnSync(command ?? "", args).status).toBe(0);
    expect(fs.existsSync(path.join(home, PI_PROFILE_HOME_DIR))).toBe(false);
    expect(fs.existsSync(path.join(home, ".pi/agent"))).toBe(true);
  });

  it("moves a changed profile directory aside whole, never deleting it, then writes the new one", async () => {
    const home = tempDir("mend-pi-home-");
    await deliver(home, [extension]);
    const root = path.join(home, PI_PROFILE_HOME_DIR);
    // The agent edited an extension in the session.
    write(path.join(root, extension.path), "export default () => { edited(); };\n");

    const outcomes = await deliver(home, [extension, banner]);
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["kept"]);
    const kept = outcomes[0]?.detail ?? "";
    expect(kept.startsWith(`${PI_PROFILE_KEPT_DIR}/`)).toBe(true);
    expect(fs.readFileSync(path.join(home, kept, extension.path), "utf8")).toContain("edited");
    expect(fs.readFileSync(path.join(root, extension.path), "utf8")).toBe(extension.contents);
    expect(fs.existsSync(path.join(root, banner.path))).toBe(true);
  });

  it("writes nothing into a harness home that was never made", async () => {
    const home = path.join(tempDir("mend-pi-home-"), "absent");
    const delivered = await Effect.runPromise(
      Effect.flip(materializePiProfile(home, planPiProfile(profileOf([extension])))),
    );
    expect(delivered._tag).toBe("PiProfileDeliveryError");
    expect(fs.existsSync(home)).toBe(false);
  });
});

/**
 * A stand-in `npm` on PATH: it records each call, "installs" a package by writing its
 * `package.json`, fails one named `broken` as a native build without `make` does, and makes a
 * `node_modules` for `ci` and a bare `install`.
 */
const fakeNpm = (bin: string, log: string) => {
  write(
    path.join(bin, "npm"),
    [
      "#!/bin/sh",
      `echo "$PWD $*" >> ${JSON.stringify(log)}`,
      'if [ "$1" = install ] && [ "$3" = --prefix ]; then',
      '  case "$2" in broken*) echo "gyp ERR! stack Error: not found: make" >&2; exit 1 ;; esac',
      '  name="${2%@*}"; version="${2##*@}"',
      '  mkdir -p "$4/node_modules/$name"',
      '  printf \'{"name":"%s","version":"%s"}\' "$name" "$version" > "$4/node_modules/$name/package.json"',
      "  exit 0",
      "fi",
      "mkdir -p node_modules",
    ].join("\n"),
  );
  fs.chmodSync(path.join(bin, "npm"), 0o755);
};

const setUp = () => {
  const root = tempDir("mend-pi-agent-");
  const agent = path.join(root, "agent");
  const bin = path.join(root, "bin");
  const log = path.join(root, "npm.log");
  fakeNpm(bin, log);
  const profile = path.join(agent, "mend", "profile");
  write(
    path.join(profile, "settings.json"),
    JSON.stringify({
      theme: "github-dark-default",
      defaultProvider: "openai-codex",
      packages: [
        "npm:good@1.0.0",
        "npm:broken@2.0.0",
        { source: "npm:filtered@3.0.0", extensions: [] },
        "./mend/profile/packages/local",
      ],
    }),
  );
  write(path.join(profile, "package.json"), JSON.stringify({ dependencies: { zod: "4.4.3" } }));
  write(path.join(profile, "package-lock.json"), "{}");
  write(
    path.join(profile, "packages", "local", "package.json"),
    JSON.stringify({ dependencies: { "pi-tui-kit": "^0.59.0" } }),
  );
  // One extension imports only what the profile's package.json names; one brings its own.
  write(
    path.join(profile, "extensions", "covered", "package.json"),
    JSON.stringify({ dependencies: { zod: "4.4.3" } }),
  );
  write(
    path.join(profile, "extensions", "own", "package.json"),
    JSON.stringify({ dependencies: { "left-pad": "1.3.0" } }),
  );
  write(path.join(profile, "root", "mcp.json"), '{"mcpServers":{}}');
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}` };
  const run = () =>
    spawnSync(process.execPath, ["-e", PI_PROFILE_PROGRAM, agent], { encoding: "utf8", env });
  const calls = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => line.replaceAll(agent, "$A"))
      : [];
  const clearCalls = () => fs.rmSync(log, { force: true });
  return { agent, profile, env, run, calls, clearCalls };
};

describe("setting up a delivered pi profile before pi starts", () => {
  it("has no single quote in it, since it rides sh -c inside them", () => {
    expect(PI_PROFILE_PROGRAM).not.toContain("'");
  });

  it("does nothing where no profile was delivered", () => {
    const agent = path.join(tempDir("mend-pi-agent-"), "agent");
    const result = spawnSync(process.execPath, ["-e", PI_PROFILE_PROGRAM, agent], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(fs.existsSync(agent)).toBe(false);
  });

  it("installs what the extensions import and every declared package, and leaves out one that fails", () => {
    const { agent, profile, run, calls } = setUp();
    const result = run();
    expect(result.status).toBe(0);
    expect(calls()).toEqual([
      "$A/mend/profile ci --omit=dev --ignore-scripts --legacy-peer-deps --no-audit --no-fund",
      "$A/mend/profile rebuild",
      "$A/mend/profile/extensions/own install --no-package-lock --omit=dev --ignore-scripts --legacy-peer-deps --no-audit --no-fund",
      "$A/mend/profile/extensions/own rebuild",
      "$A/mend/profile/packages/local install --no-package-lock --omit=dev --ignore-scripts --legacy-peer-deps --no-audit --no-fund",
      "$A/mend/profile/packages/local rebuild",
      "$A install good@1.0.0 --prefix $A/npm --legacy-peer-deps --no-audit --no-fund",
      "$A install broken@2.0.0 --prefix $A/npm --legacy-peer-deps --no-audit --no-fund",
      "$A install filtered@3.0.0 --prefix $A/npm --legacy-peer-deps --no-audit --no-fund",
    ]);
    // pi's own npm root, made as pi makes it.
    expect(readJson(path.join(agent, "npm", "package.json"))).toEqual({
      name: "pi-extensions",
      private: true,
    });
    expect(result.stderr).toContain(
      "mend: pi package broken@2.0.0 did not install, so this session runs without it: gyp ERR! stack Error: not found: make",
    );
    expect(readJson(path.join(agent, "settings.json"))).toEqual({
      theme: "github-dark-default",
      defaultProvider: "openai-codex",
      packages: [
        "./mend/profile",
        "npm:good@1.0.0",
        { source: "npm:filtered@3.0.0", extensions: [] },
        "./mend/profile/packages/local",
      ],
    });
    expect(fs.statSync(path.join(agent, "settings.json")).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(agent, "mcp.json"), "utf8")).toBe('{"mcpServers":{}}');
    expect(fs.statSync(path.join(agent, "mcp.json")).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(profile, "node_modules", ".mend-installed"))).toBe(true);
  });

  it("installs nothing again on the next launch, and tries the failed package again", () => {
    const { run, calls, clearCalls } = setUp();
    run();
    clearCalls();
    const result = run();
    expect(result.status).toBe(0);
    expect(calls()).toEqual([
      "$A install broken@2.0.0 --prefix $A/npm --legacy-peer-deps --no-audit --no-fund",
    ]);
  });

  it("keeps what the session changed, takes the profile's changes otherwise, and keeps the session's own packages", () => {
    const { agent, profile, run } = setUp();
    run();
    const settings = path.join(agent, "settings.json");
    const session = readJson(settings) as { packages: Array<unknown> };
    write(
      settings,
      JSON.stringify({
        ...session,
        theme: "light",
        defaultThinkingLevel: "high",
        packages: [...session.packages, "npm:own@1.0.0"],
      }),
    );
    // The person saved a new profile: another theme, a new setting, one package fewer.
    write(
      path.join(profile, "settings.json"),
      JSON.stringify({
        theme: "contrast",
        defaultProvider: "anthropic",
        tuiMode: "fullscreen",
        packages: ["npm:good@1.0.0"],
      }),
    );
    expect(run().status).toBe(0);
    expect(readJson(settings)).toEqual({
      // The session chose its own theme: it stays.
      theme: "light",
      // Unchanged in the session since the last delivery: the profile's new value.
      defaultProvider: "anthropic",
      defaultThinkingLevel: "high",
      tuiMode: "fullscreen",
      packages: ["./mend/profile", "npm:good@1.0.0", "npm:own@1.0.0"],
    });
  });

  it("leaves an mcp.json the session changed as it is, and says so", () => {
    const { agent, profile, run } = setUp();
    run();
    write(path.join(agent, "mcp.json"), '{"mcpServers":{"mine":{}}}');
    write(path.join(profile, "root", "mcp.json"), '{"mcpServers":{"new":{}}}');
    const result = run();
    expect(result.stderr).toContain(
      "mend: mcp.json was changed in this session, so the profile did not replace it",
    );
    expect(fs.readFileSync(path.join(agent, "mcp.json"), "utf8")).toBe(
      '{"mcpServers":{"mine":{}}}',
    );
  });

  it("takes a profile that is gone back out of the settings, unless the session changed them", () => {
    // Someone else's profile was delivered here; this session's owner has none, so Mend took the
    // directory out before pi starts.
    const { agent, profile, run } = setUp();
    run();
    const settings = path.join(agent, "settings.json");
    const session = readJson(settings) as { packages: Array<unknown> };
    write(
      settings,
      JSON.stringify({
        ...session,
        defaultThinkingLevel: "high",
        defaultProvider: "anthropic",
        packages: [...session.packages, "npm:own@1.0.0"],
      }),
    );
    fs.rmSync(profile, { recursive: true });
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("mend: no pi profile is connected for this session");
    expect(readJson(settings)).toEqual({
      // Changed in the session: the session's own.
      defaultProvider: "anthropic",
      defaultThinkingLevel: "high",
      packages: ["npm:own@1.0.0"],
    });
    // The copied mcp.json was the profile's, unchanged: gone, with the records.
    expect(fs.existsSync(path.join(agent, "mcp.json"))).toBe(false);
    expect(fs.existsSync(path.join(agent, "mend", "delivered-settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(agent, "mend", "delivered-files.json"))).toBe(false);
    // The next launch has nothing to undo.
    const again = run();
    expect(again.status).toBe(0);
    expect(again.stderr).toBe("");
  });

  it("leaves a settings.json it cannot read as it is", () => {
    const { agent, run } = setUp();
    write(path.join(agent, "settings.json"), "{ not json");
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "mend: settings.json could not be read, so your profile settings were not applied",
    );
    expect(fs.readFileSync(path.join(agent, "settings.json"), "utf8")).toBe("{ not json");
  });

  it("runs before the login in pi's seed, so the profile's provider stands", () => {
    const { agent, env, calls } = setUp();
    const result = spawnSync("sh", ["-c", PI_SEED, "sh", "sh", "-c", "echo ran"], {
      encoding: "utf8",
      env: { ...env, HOME: path.dirname(agent), PI_CODING_AGENT_DIR: agent },
    });
    expect(calls()).toHaveLength(9);
    expect(result.stdout).toBe("ran\n");
    // No Codex copy here, so no login; the profile's settings were applied by the seed.
    expect(readJson(path.join(agent, "settings.json"))).toMatchObject({
      defaultProvider: "openai-codex",
      theme: "github-dark-default",
    });
  });
});
