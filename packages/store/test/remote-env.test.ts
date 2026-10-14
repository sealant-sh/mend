import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@mend/test-ci/effect-vitest";
import { Effect, Layer } from "effect";

import { AgentBridge } from "../src/agent-bridge.ts";
import { MendKeys, NO_SIGNER_SSH_COMMAND, noSignerGitEnv } from "../src/git-auth.ts";
import { effectiveGitUrl, resolveRemoteEnv, resolveRemoteEnvForUrls } from "../src/remote-env.ts";

/**
 * Every test reads a git config of its own: the host's global config (an `insteadOf` of the
 * person running the tests) must not decide what these tests see.
 */
let scratch = "";
const saved = new Map<string, string | undefined>();
const setEnv = (name: string, value: string) => {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  process.env[name] = value;
};
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-remote-env-"));
  setEnv("GIT_CONFIG_GLOBAL", path.join(scratch, "gitconfig"));
  setEnv("GIT_CONFIG_NOSYSTEM", "1");
  fs.writeFileSync(path.join(scratch, "gitconfig"), "");
});
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  fs.rmSync(scratch, { recursive: true, force: true });
});
const gitConfig = (...args: ReadonlyArray<string>) =>
  execFileSync("git", ["config", "--global", ...args]);

const sshVersion = spawnSync("ssh", ["-V"], { encoding: "utf8" });
const sshMissing =
  sshVersion.error !== undefined &&
  "code" in sshVersion.error &&
  sshVersion.error.code === "ENOENT";

/** A Mend key that records every ensure: a remote no key signs must never make one. */
const keysLayer = (ensured: Array<string | null>) =>
  Layer.succeed(MendKeys, {
    ensure: (userId) =>
      Effect.sync(() => {
        ensured.push(userId);
        return { publicKey: "ssh-ed25519 AAAA", fingerprint: "256 SHA256:x", privateKeyPath: "/k" };
      }),
    read: () => Effect.succeed(null),
  });

const bridgeLayer = (connected: boolean) =>
  Layer.succeed(AgentBridge, {
    attach: () => Effect.die("not in test"),
    status: () => Effect.succeed({ connected, clientName: null, since: null }),
    socketPath: (userId) => `/bridge/${userId}.sock`,
    begin: () => Effect.succeed(() => {}),
  });

const resolve = (
  mode: "mend-key" | "bridge",
  remote: string | undefined,
  options: { readonly connected?: boolean; readonly ensured?: Array<string | null> } = {},
) =>
  resolveRemoteEnv(mode, "anna", remote).pipe(
    Effect.provide(
      Layer.mergeAll(keysLayer(options.ensured ?? []), bridgeLayer(options.connected ?? false)),
    ),
  );

describe("resolveRemoteEnv", () => {
  it.effect("bridge with nobody sharing still reaches an https remote: no key signs it", () =>
    Effect.gen(function* () {
      const env = yield* resolve("bridge", "https://github.com/octocat/Hello-World.git");
      expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
      // No signer: ssh, should git still run it, refuses instead of using this process's agent.
      expect(env["SSH_AUTH_SOCK"]).toBe("");
      expect(env["GIT_SSH_COMMAND"]).toBe(NO_SIGNER_SSH_COMMAND);
    }),
  );

  it.effect("bridge with nobody sharing refuses an ssh remote, and one it was not told", () =>
    Effect.gen(function* () {
      const ssh = yield* resolve("bridge", "git@github.com:acme/api.git").pipe(Effect.flip);
      expect(ssh._tag).toBe("NoSignerError");
      const unknown = yield* resolve("bridge", undefined).pipe(Effect.flip);
      expect(unknown._tag).toBe("NoSignerError");
    }),
  );

  it.effect("bridge with a share signs an ssh remote through its socket", () =>
    Effect.gen(function* () {
      const env = yield* resolve("bridge", "git@github.com:acme/api.git", { connected: true });
      expect(env["SSH_AUTH_SOCK"]).toBe("/bridge/anna.sock");
    }),
  );

  it.effect("mend-key makes the key for an ssh remote, never for an https one", () =>
    Effect.gen(function* () {
      const ensured: Array<string | null> = [];
      yield* resolve("mend-key", "https://github.com/octocat/Hello-World.git", { ensured });
      expect(ensured).toEqual([]);
      const env = yield* resolve("mend-key", "git@github.com:acme/api.git", { ensured });
      expect(ensured).toEqual(["anna"]);
      expect(env["GIT_SSH_COMMAND"]).toContain("-i '/k'");
    }),
  );

  it.effect("an https origin git rewrites to ssh (insteadOf) gets the signer, or a refusal", () =>
    Effect.gen(function* () {
      gitConfig("url.git@github.com:.insteadOf", "https://github.com/");
      const remote = "https://github.com/acme/api.git";
      const refused = yield* resolve("bridge", remote).pipe(Effect.flip);
      expect(refused._tag).toBe("NoSignerError");
      const ensured: Array<string | null> = [];
      const env = yield* resolve("mend-key", remote, { ensured });
      expect(ensured).toEqual(["anna"]);
      expect(env["GIT_SSH_COMMAND"]).toContain("IdentitiesOnly=yes");
    }),
  );

  it.effect("a push follows pushInsteadOf; a fetch of the same URL does not", () =>
    Effect.gen(function* () {
      gitConfig("url.ssh://git@github.com/.pushInsteadOf", "https://github.com/");
      const remote = "https://github.com/acme/api.git";
      const fetch = yield* resolveRemoteEnv("bridge", "anna", remote, false).pipe(
        Effect.provide(Layer.mergeAll(keysLayer([]), bridgeLayer(false))),
      );
      expect(fetch["GIT_SSH_COMMAND"]).toBe(NO_SIGNER_SSH_COMMAND);
      const push = yield* resolveRemoteEnv("bridge", "anna", remote, true).pipe(
        Effect.provide(Layer.mergeAll(keysLayer([]), bridgeLayer(false))),
        Effect.flip,
      );
      expect(push._tag).toBe("NoSignerError");
    }),
  );
});

describe("effectiveGitUrl", () => {
  // Review round 3 of mend#736: the push probe makes a repository and writes a remote into it.
  // Inherited location overrides, or a template, must neither redirect that write nor seed the
  // probe with rules the real push never sees. The global rule below is what the push follows.
  const pushRule = () =>
    gitConfig("url.ssh://git@github.com/.pushInsteadOf", "https://example.invalid/");
  const pushed = "ssh://git@github.com/repo";

  it.effect("writes nothing into a repository GIT_COMMON_DIR or GIT_DIR names", () =>
    Effect.gen(function* () {
      pushRule();
      const victim = path.join(scratch, "victim.git");
      execFileSync("git", ["init", "-q", "--bare", victim]);
      const before = fs.readFileSync(path.join(victim, "config"), "utf8");
      setEnv("GIT_COMMON_DIR", victim);
      setEnv("GIT_DIR", victim);
      expect(yield* effectiveGitUrl("https://example.invalid/repo", true)).toBe(pushed);
      expect(fs.readFileSync(path.join(victim, "config"), "utf8")).toBe(before);
    }),
  );

  it.effect("writes nothing into a config file GIT_CONFIG names", () =>
    Effect.gen(function* () {
      pushRule();
      const redirected = path.join(scratch, "redirected.gitconfig");
      fs.writeFileSync(redirected, "");
      setEnv("GIT_CONFIG", redirected);
      expect(yield* effectiveGitUrl("https://example.invalid/repo", true)).toBe(pushed);
      expect(fs.readFileSync(redirected, "utf8")).toBe("");
    }),
  );

  it.effect("uses no template, from GIT_TEMPLATE_DIR or init.templateDir", () =>
    Effect.gen(function* () {
      pushRule();
      // A template whose config would send this push over https: a longer-prefix rewrite, and
      // a pushurl on the remote name a fixed-name probe would use.
      const template = path.join(scratch, "template");
      fs.mkdirSync(template);
      fs.writeFileSync(
        path.join(template, "config"),
        '[url "https://evil.invalid/"]\n\tpushInsteadOf = https://example.invalid/repo\n[remote "probe"]\n\tpushurl = https://evil.invalid/probe\n',
      );
      setEnv("GIT_TEMPLATE_DIR", template);
      expect(yield* effectiveGitUrl("https://example.invalid/repo", true)).toBe(pushed);
      delete process.env["GIT_TEMPLATE_DIR"];
      gitConfig("init.templateDir", template);
      expect(yield* effectiveGitUrl("https://example.invalid/repo", true)).toBe(pushed);
    }),
  );

  // Review of mend#734: three insteadOf entries, two bases tied on prefix length. git groups
  // values by the first-seen base, so `git@first.invalid:` wins; picking the first matching
  // entry would say `https://second.invalid/` and fail a valid ssh op closed.
  const addTiedRules = (
    kind: "insteadOf" | "pushInsteadOf",
    first: string,
    second = "https://second.invalid/",
  ) => {
    gitConfig("--add", `url.${first}.${kind}`, "https://other.invalid/");
    gitConfig("--add", `url.${second}.${kind}`, "https://example.invalid/");
    gitConfig("--add", `url.${first}.${kind}`, "https://example.invalid/");
  };

  it.effect("answers what git dials for a fetch, ties on prefix length included", () =>
    Effect.gen(function* () {
      addTiedRules("insteadOf", "git@first.invalid:");
      expect(yield* effectiveGitUrl("https://example.invalid/repo", false)).toBe(
        "git@first.invalid:repo",
      );
      expect(yield* effectiveGitUrl("https://plain.invalid/repo", false)).toBe(
        "https://plain.invalid/repo",
      );
    }),
  );

  it.effect("answers what git dials for a push: pushInsteadOf first, then insteadOf", () =>
    Effect.gen(function* () {
      addTiedRules("pushInsteadOf", "ssh://git@first.invalid/");
      gitConfig("--add", "url.git@fetch.invalid:.insteadOf", "https://fetch.invalid/");
      expect(yield* effectiveGitUrl("https://example.invalid/repo", true)).toBe(
        "ssh://git@first.invalid/repo",
      );
      // A fetch of the same URL is not a push: pushInsteadOf leaves it alone.
      expect(yield* effectiveGitUrl("https://example.invalid/repo", false)).toBe(
        "https://example.invalid/repo",
      );
      expect(yield* effectiveGitUrl("https://fetch.invalid/repo", true)).toBe(
        "git@fetch.invalid:repo",
      );
    }),
  );

  it.effect("the tied config signs a fetch and a push with the key, as git will dial ssh", () =>
    Effect.gen(function* () {
      addTiedRules("insteadOf", "git@first.invalid:");
      addTiedRules("pushInsteadOf", "ssh://git@first.invalid/", "https://psecond.invalid/");
      const ensured: Array<string | null> = [];
      yield* resolve("mend-key", "https://example.invalid/repo", { ensured });
      expect(ensured).toEqual(["anna"]);
      const refused = yield* resolveRemoteEnv(
        "bridge",
        "anna",
        "https://example.invalid/repo",
        true,
      ).pipe(Effect.provide(Layer.mergeAll(keysLayer([]), bridgeLayer(false))), Effect.flip);
      expect(refused._tag).toBe("NoSignerError");
    }),
  );

  it.effect(
    "follows git where its rule is not obvious: sections count in the order first seen",
    () =>
      Effect.gen(function* () {
        // `[url "https://second.invalid/"]` is first seen holding an insteadOf, so when it later
        // gains a pushInsteadOf it outranks the ssh base for pushes: git pushes over https here,
        // and no signer is asked for.
        addTiedRules("insteadOf", "git@first.invalid:");
        addTiedRules("pushInsteadOf", "ssh://git@first.invalid/");
        expect(yield* effectiveGitUrl("https://example.invalid/repo", true)).toBe(
          "https://second.invalid/repo",
        );
        const env = yield* resolveRemoteEnv(
          "bridge",
          "anna",
          "https://example.invalid/repo",
          true,
        ).pipe(Effect.provide(Layer.mergeAll(keysLayer([]), bridgeLayer(false))));
        expect(env["GIT_SSH_COMMAND"]).toBe(NO_SIGNER_SSH_COMMAND);
      }),
  );

  it.effect("when git cannot answer, the op needs a signer: never the no-signer path", () =>
    Effect.gen(function* () {
      expect(yield* effectiveGitUrl("-c", false)).toBeNull();
      // An unreadable global config: git refuses, so the https remote is treated as signed.
      fs.writeFileSync(path.join(scratch, "gitconfig"), '[url "broken\n');
      const refused = yield* resolve("bridge", "https://github.com/octocat/Hello-World.git").pipe(
        Effect.flip,
      );
      expect(refused._tag).toBe("NoSignerError");
    }),
  );
});

describe("already-cleared authentication", () => {
  it.effect("authenticates already-cleared URLs without a second rewrite", () =>
    Effect.gen(function* () {
      gitConfig("url.git@second.invalid:.insteadOf", "https://first.invalid/");
      const layers = Layer.mergeAll(keysLayer([]), bridgeLayer(false));
      const env = yield* resolveRemoteEnvForUrls("bridge", "anna", [
        "https://first.invalid/repo",
      ]).pipe(Effect.provide(layers));
      expect(env["GIT_SSH_COMMAND"]).toBe(NO_SIGNER_SSH_COMMAND);
      for (const urls of [
        [],
        ["not a URL"],
        ["https://first.invalid/repo", "git@second.invalid:repo"],
      ]) {
        const refusal = yield* resolveRemoteEnvForUrls("bridge", "anna", urls).pipe(
          Effect.provide(layers),
          Effect.flip,
        );
        expect(refusal._tag).toBe("NoSignerError");
      }
    }),
  );
});

describe("the no-signer env", () => {
  it("makes the ssh git runs anyway refuse: no agent, no default keys, no ssh config", () => {
    // A fake ssh records what git hands it, the way the review reproduced the leak.
    const bin = path.join(scratch, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "ssh"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${scratch}/ssh-args"\nprintf '%s' "$SSH_AUTH_SOCK" > "${scratch}/ssh-sock"\nexit 255\n`,
      { mode: 0o755 },
    );
    gitConfig("url.git@github.com:.insteadOf", "https://github.com/");
    spawnSync("git", ["ls-remote", "https://github.com/acme/api.git"], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        SSH_AUTH_SOCK: "/run/operator/agent.sock",
        ...noSignerGitEnv(),
      },
    });
    const args = fs.readFileSync(path.join(scratch, "ssh-args"), "utf8").split("\n");
    expect(fs.readFileSync(path.join(scratch, "ssh-sock"), "utf8")).toBe("");
    expect(args.slice(0, 2)).toEqual(["-F", "/dev/null"]);
    for (const option of ["IdentityFile=none", "IdentityAgent=none", "IdentitiesOnly=yes"]) {
      expect(args).toContain(option);
    }
  });

  it.skipIf(sshMissing)("is what ssh itself resolves to no identity and no agent", () => {
    expect(sshVersion.error).toBeUndefined();
    expect(sshVersion.status, sshVersion.stderr).toBe(0);
    const resolved = spawnSync("sh", ["-c", `${NO_SIGNER_SSH_COMMAND} -G github.com`], {
      encoding: "utf8",
      env: { ...process.env, SSH_AUTH_SOCK: "/run/operator/agent.sock" },
    });
    expect(resolved.error).toBeUndefined();
    expect(resolved.status, resolved.stderr).toBe(0);
    const lines = resolved.stdout.split("\n");
    expect(lines.filter((line) => line.startsWith("identityfile "))).toEqual(["identityfile none"]);
    expect(lines).toContain("identityagent none");
  });
});
