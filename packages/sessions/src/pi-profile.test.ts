import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  materializePiProfile,
  piProfileInSharedWorkspace,
  preparePiProfileExec,
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

  it("moves a profile aside, never deleting it, when the session has none of its owner's", async () => {
    const home = tempDir("mend-pi-home-");
    await deliver(home, [extension]);
    const root = path.join(home, PI_PROFILE_HOME_DIR);
    write(path.join(root, extension.path), "export default () => { fixedInSession(); };\n");
    const outcomes = await Effect.runPromise(materializePiProfile(home, null));
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["kept"]);
    const kept = outcomes[0]?.detail ?? "";
    expect(kept.startsWith(`${PI_PROFILE_KEPT_DIR}/`)).toBe(true);
    expect(fs.readFileSync(path.join(home, kept, extension.path), "utf8")).toContain(
      "fixedInSession",
    );
    expect(fs.existsSync(root)).toBe(false);
    // Nothing there: nothing moved.
    const again = await Effect.runPromise(materializePiProfile(home, null));
    expect(again.map((outcome) => outcome.outcome)).toEqual(["absent"]);
  });

  it("fails when the profile there cannot be moved aside", async () => {
    const home = tempDir("mend-pi-home-");
    await deliver(home, [extension]);
    // The kept directory's parent is a file: the move cannot happen.
    write(path.join(home, ".mend"), "not a directory");
    for (const plan of [null, planPiProfile(profileOf([extension, banner]))]) {
      const failed = await Effect.runPromise(Effect.flip(materializePiProfile(home, plan)));
      expect(failed._tag).toBe("PiProfileDeliveryError");
      expect(fs.existsSync(path.join(home, PI_PROFILE_HOME_DIR, extension.path))).toBe(true);
      expect(fs.existsSync(path.join(home, PI_PROFILE_HOME_DIR, banner.path))).toBe(false);
    }
  });

  it("takes another person's delivered settings back out before the owner's profile goes in", () => {
    // B's profile was delivered and set up in this worktree's harness home; A launches.
    const home = tempDir("mend-pi-home-");
    const agent = path.join(home, ".pi/agent");
    write(path.join(agent, "mend/profile/settings.json"), JSON.stringify({ theme: "theirs" }));
    write(
      path.join(agent, "settings.json"),
      JSON.stringify({
        theme: "theirs",
        defaultThinkingLevel: "high",
        packages: ["./mend/profile", "npm:theirs@1.0.0", "npm:session-own@1.0.0"],
      }),
    );
    write(
      path.join(agent, "mend/delivered-settings.json"),
      JSON.stringify({ theme: "theirs", packages: ["./mend/profile", "npm:theirs@1.0.0"] }),
    );
    write(path.join(agent, "mcp.json"), '{"mcpServers":{"theirs":{}}}');
    const mcpSha = createHash("sha256").update('{"mcpServers":{"theirs":{}}}').digest("hex");
    write(path.join(agent, "mend/delivered-files.json"), JSON.stringify({ "mcp.json": mcpSha }));
    const kept = ".mend/pi-profile-kept/test";
    const [command, ...args] = preparePiProfileExec(home, kept, null);
    const run = spawnSync(command ?? "sh", args, { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`skill kept ${PI_PROFILE_HOME_DIR}`);
    // What the session changed stays; what B's delivery put there goes.
    expect(readJson(path.join(agent, "settings.json"))).toEqual({
      defaultThinkingLevel: "high",
      packages: ["npm:session-own@1.0.0"],
    });
    expect(fs.existsSync(path.join(agent, "mcp.json"))).toBe(false);
    expect(fs.existsSync(path.join(agent, "mend/delivered-settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(agent, "mend/delivered-files.json"))).toBe(false);
    // Every file it touched has a copy beside the moved profile.
    const copy = path.join(home, kept, ".pi/agent");
    expect((readJson(path.join(copy, "settings.json")) as { theme: string }).theme).toBe("theirs");
    expect(fs.existsSync(path.join(copy, "mcp.json"))).toBe(true);
    expect(fs.existsSync(path.join(copy, "mend/delivered-settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(copy, "mend/profile/settings.json"))).toBe(true);
  });

  it("knows a delivered package pi rewrote, and refuses rather than guess over files that do not parse", () => {
    const home = tempDir("mend-pi-home-");
    const agent = path.join(home, ".pi/agent");
    const prepare = () => {
      const [command, ...args] = preparePiProfileExec(home, ".mend/pi-profile-kept/t", null);
      return spawnSync(command ?? "sh", args, { encoding: "utf8" });
    };
    write(
      path.join(agent, "mend/delivered-settings.json"),
      JSON.stringify({
        packages: [
          "./mend/profile",
          "npm:theirs@1.0.0",
          "git:github.com/b/ext@v1",
          "https://b:TOKEN@github.com/b/other.git",
        ],
      }),
    );
    // pi rewrote each in the session: an extension turned off, a re-pin, a normalised source.
    const settings = {
      packages: [
        { source: "git:github.com/b/ext@v1", extensions: ["-noisy"] },
        "npm:theirs@2.0.0",
        "git:git@github.com:b/other",
        "npm:session-own@1.0.0",
      ],
    };
    // A BOM is pi's to skip, and ours.
    write(path.join(agent, "settings.json"), `﻿${JSON.stringify(settings)}`);
    const run = prepare();
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(readJson(path.join(agent, "settings.json"))).toEqual({
      packages: ["npm:session-own@1.0.0"],
    });

    // A settings.json that does not parse: left, with the records, and the launch refuses.
    write(path.join(agent, "mend/delivered-settings.json"), JSON.stringify({ theme: "theirs" }));
    write(path.join(agent, "settings.json"), "{ not json");
    const broken = prepare();
    expect(broken.status).not.toBe(0);
    expect(broken.stderr).toContain("~/.pi/agent/settings.json does not parse");
    expect(fs.readFileSync(path.join(agent, "settings.json"), "utf8")).toBe("{ not json");
    expect(fs.existsSync(path.join(agent, "mend/delivered-settings.json"))).toBe(true);

    // A record that does not parse: never read as empty.
    write(path.join(agent, "settings.json"), JSON.stringify({ theme: "theirs" }));
    write(path.join(agent, "mend/delivered-settings.json"), "{ not json");
    const unreadable = prepare();
    expect(unreadable.status).not.toBe(0);
    expect(unreadable.stderr).toContain("delivered-settings.json does not parse");
    expect(readJson(path.join(agent, "settings.json"))).toEqual({ theme: "theirs" });
  });

  it("says why when the profile there cannot be moved aside", () => {
    const home = tempDir("mend-pi-home-");
    write(path.join(home, PI_PROFILE_HOME_DIR, extension.path), extension.contents);
    write(path.join(home, ".mend"), "not a directory");
    const [command, ...args] = preparePiProfileExec(home, ".mend/pi-profile-kept/t", null);
    const run = spawnSync(command ?? "sh", args, { encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain(`skill error ${PI_PROFILE_HOME_DIR}`);
    expect(run.stderr).toContain(
      "mend: the pi profile there could not be moved aside: skill error",
    );
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

  it("keeps a delivered package the session changed in pi, matched as pi matches it", () => {
    const { agent, run } = setUp();
    run();
    const settings = path.join(agent, "settings.json");
    const session = readJson(settings) as { packages: Array<unknown> };
    // The person turned one extension of a delivered package off in pi: pi rewrote the entry.
    const toggled = { source: "npm:good@1.0.0", extensions: ["-loud"] };
    write(
      settings,
      JSON.stringify({
        ...session,
        packages: session.packages.map((e) => (e === "npm:good@1.0.0" ? toggled : e)),
      }),
    );
    expect(run().status).toBe(0);
    const after = readJson(settings) as { packages: Array<unknown> };
    expect(after.packages).toContainEqual(toggled);
    expect(after.packages).not.toContain("npm:good@1.0.0");
    // And the record says what the profile delivered, so a later undo knows it.
    const record = readJson(path.join(agent, "mend", "delivered-settings.json")) as {
      packages: Array<unknown>;
    };
    expect(record.packages).toContain("npm:good@1.0.0");
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

describe("a pi launch into a workspace other processes hold", () => {
  it("sets the profile up when no pi runs there, leaves the owner's own, and refuses beside another person's", () => {
    expect(piProfileInSharedWorkspace("a", [])).toBe("prepare");
    expect(piProfileInSharedWorkspace(null, [])).toBe("prepare");
    expect(piProfileInSharedWorkspace("a", ["a", "a"])).toBe("running");
    expect(piProfileInSharedWorkspace("a", ["a", "b"])).toBe("refuse");
    expect(piProfileInSharedWorkspace("a", [null])).toBe("refuse");
    expect(piProfileInSharedWorkspace(null, [null])).toBe("refuse");
  });
});
