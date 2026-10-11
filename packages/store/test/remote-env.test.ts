import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { AgentBridge } from "../src/agent-bridge.ts";
import { MendKeys, NO_SIGNER_SSH_COMMAND, noSignerGitEnv } from "../src/git-auth.ts";
import { parseGitUrlRewrites, resolveRemoteEnv, rewriteGitUrl } from "../src/remote-env.ts";

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

describe("git url rewrites", () => {
  it("reads insteadOf and pushInsteadOf rules from git's config output", () => {
    gitConfig("url.git@github.com:.insteadOf", "https://github.com/");
    gitConfig("url.ssh://git@push.example/.pushInsteadOf", "https://push.example/");
    const output = execFileSync(
      "git",
      ["config", "--null", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"],
      { encoding: "utf8" },
    );
    expect(parseGitUrlRewrites(output)).toEqual([
      { base: "git@github.com:", prefix: "https://github.com/", push: false },
      { base: "ssh://git@push.example/", prefix: "https://push.example/", push: true },
    ]);
  });

  it("applies git's rule: the longest prefix wins, and a push prefers pushInsteadOf", () => {
    const rules = [
      { base: "git@github.com:", prefix: "https://github.com/", push: false },
      { base: "git@github.com:acme-mirror/", prefix: "https://github.com/acme/", push: false },
      { base: "ssh://git@github.com/", prefix: "https://github.com/", push: true },
    ];
    expect(rewriteGitUrl("https://github.com/acme/api.git", rules, false)).toBe(
      "git@github.com:acme-mirror/api.git",
    );
    expect(rewriteGitUrl("https://github.com/acme/api.git", rules, true)).toBe(
      "ssh://git@github.com/acme/api.git",
    );
    expect(rewriteGitUrl("https://gitlab.com/acme/api.git", rules, true)).toBe(
      "https://gitlab.com/acme/api.git",
    );
    // git's own reading of the same config agrees for a fetch.
    gitConfig("url.git@github.com:.insteadOf", "https://github.com/");
    gitConfig("url.git@github.com:acme-mirror/.insteadOf", "https://github.com/acme/");
    const dialed = execFileSync(
      "git",
      ["ls-remote", "--get-url", "https://github.com/acme/api.git"],
      {
        encoding: "utf8",
      },
    ).trim();
    expect(dialed).toBe(rewriteGitUrl("https://github.com/acme/api.git", rules, false));
  });
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

  it("is what ssh itself resolves to no identity and no agent", () => {
    const resolved = spawnSync("sh", ["-c", `${NO_SIGNER_SSH_COMMAND} -G github.com`], {
      encoding: "utf8",
      env: { ...process.env, SSH_AUTH_SOCK: "/run/operator/agent.sock" },
    });
    if (resolved.status !== 0) return; // no ssh client on this machine
    const lines = resolved.stdout.split("\n");
    expect(lines.filter((line) => line.startsWith("identityfile "))).toEqual(["identityfile none"]);
    expect(lines).toContain("identityagent none");
  });
});
