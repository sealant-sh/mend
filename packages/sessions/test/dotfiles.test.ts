import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { type GitAccessMode, InstanceRolesRepo, UserGitAccessRepo } from "@mend/db";
import { AgentBridge, makeSourcePolicy, MendKeys, NO_SIGNER_MESSAGE } from "@mend/store";
import { Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  DOTFILES_CLONE_BOUNDS,
  DOTFILES_HOST_ENV,
  DOTFILES_LOCAL_GIT_ENV,
  DOTFILES_OWNER_ENV,
  DotfilesCloner,
  dotfilesCloneAccess,
  dotfilesCloneEnv,
  dotfilesCloneIdentity,
  makeDotfilesClonerLayer,
  resolveRepositoryArchive,
  snapshotArchive,
} from "../src/dotfiles.ts";

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const extract = (base64: string): string => {
  const dir = tmp("mend-dotfiles-extract-");
  const archive = path.join(dir, "a.tar.gz");
  fs.writeFileSync(archive, Buffer.from(base64, "base64"));
  fs.mkdirSync(path.join(dir, "out"));
  execFileSync("tar", ["-xzf", archive, "-C", path.join(dir, "out")]);
  return path.join(dir, "out");
};

describe("resolveRepositoryArchive", () => {
  it("wraps a store snapshot as a copy-manager archive that never bootstraps", () => {
    const data = Buffer.from("snapshot-tarball").toString("base64");
    // The snapshot rides untouched — the store already packed it — with copy semantics.
    expect(snapshotArchive({ data })).toEqual({ data, manager: "copy", bootstrap: false });
  });

  it("packs the remote's default branch with the repository's manager and bootstrap", async () => {
    const origin = tmp("mend-dotfiles-origin-");
    execFileSync("git", ["init", "--initial-branch", "trunk"], { cwd: origin });
    fs.writeFileSync(path.join(origin, ".vimrc"), "set nocompatible\n");
    execFileSync("git", ["add", "."], { cwd: origin });
    execFileSync("git", ["commit", "-m", "init"], {
      cwd: origin,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });

    const archive = await Effect.runPromise(
      // A non-"main" default branch: the ref-less clone must take the remote's default.
      resolveRepositoryArchive({
        url: origin,
        ref: null,
        subdirectory: null,
        manager: "auto",
        bootstrap: true,
      }),
    );
    expect(archive.manager).toBe("auto");
    expect(archive.bootstrap).toBe(true);
    const out = extract(archive.data);
    expect(fs.readFileSync(path.join(out, ".vimrc"), "utf8")).toBe("set nocompatible\n");
    expect(fs.existsSync(path.join(out, ".git"))).toBe(false);
  });

  it("re-roots the archive at the configured subdirectory", async () => {
    const origin = tmp("mend-dotfiles-subdir-origin-");
    execFileSync("git", ["init", "--initial-branch", "trunk"], { cwd: origin });
    // The common shape: a home mirror in a subfolder, surrounded by repo clutter.
    fs.mkdirSync(path.join(origin, "dots", ".config", "zsh"), { recursive: true });
    fs.writeFileSync(path.join(origin, "dots", ".zshenv"), "export ZDOTDIR=~/.config/zsh\n");
    fs.writeFileSync(path.join(origin, "dots", ".config", "zsh", ".zshrc"), "setopt AUTOCD\n");
    fs.writeFileSync(path.join(origin, "README.md"), "not a dotfile\n");
    fs.writeFileSync(path.join(origin, "install.sh"), "#!/bin/sh\n");
    execFileSync("git", ["add", "."], { cwd: origin });
    execFileSync("git", ["commit", "-m", "init"], {
      cwd: origin,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });

    const archive = await Effect.runPromise(
      resolveRepositoryArchive({
        url: origin,
        ref: null,
        subdirectory: "dots",
        manager: "auto",
        bootstrap: true,
      }),
    );
    const out = extract(archive.data);
    // The subtree's CONTENTS are the archive root — ready to land at ~.
    expect(fs.readFileSync(path.join(out, ".zshenv"), "utf8")).toBe(
      "export ZDOTDIR=~/.config/zsh\n",
    );
    expect(fs.readFileSync(path.join(out, ".config", "zsh", ".zshrc"), "utf8")).toBe(
      "setopt AUTOCD\n",
    );
    // Root clutter stays behind — including the desktop-oriented bootstrap.
    expect(fs.existsSync(path.join(out, "README.md"))).toBe(false);
    expect(fs.existsSync(path.join(out, "install.sh"))).toBe(false);
    expect(fs.existsSync(path.join(out, "dots"))).toBe(false);
  });

  it("fails readable when the subdirectory does not exist in the repo", async () => {
    const origin = tmp("mend-dotfiles-badsubdir-origin-");
    execFileSync("git", ["init", "--initial-branch", "trunk"], { cwd: origin });
    fs.writeFileSync(path.join(origin, ".vimrc"), "set nocompatible\n");
    execFileSync("git", ["add", "."], { cwd: origin });
    execFileSync("git", ["commit", "-m", "init"], {
      cwd: origin,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });

    const result = await Effect.runPromise(
      resolveRepositoryArchive({
        url: origin,
        ref: null,
        subdirectory: "does-not-exist",
        manager: "auto",
        bootstrap: true,
      }).pipe(Effect.result),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(String(result)).toMatch(/has no directory does-not-exist at its default branch/);
  });

  it("fails readable when the repo cannot be cloned", async () => {
    const result = await Effect.runPromise(
      resolveRepositoryArchive({
        url: path.join(os.tmpdir(), "mend-dotfiles-does-not-exist"),
        ref: null,
        subdirectory: null,
        manager: "auto",
        bootstrap: true,
      }).pipe(Effect.result),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(String(result)).toMatch(/dotfiles clone/);
  });
});

/** A committed origin repo; `file://` clones of it honour `--filter` (the server side allows it). */
const originWith = (files: Readonly<Record<string, string | Buffer>>): string => {
  const origin = tmp("mend-dotfiles-bounded-origin-");
  execFileSync("git", ["init", "--initial-branch", "trunk"], { cwd: origin });
  execFileSync("git", ["config", "uploadpack.allowFilter", "true"], { cwd: origin });
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(origin, name)), { recursive: true });
    fs.writeFileSync(path.join(origin, name), content);
  }
  execFileSync("git", ["add", "."], { cwd: origin });
  execFileSync("git", ["commit", "-m", "init"], {
    cwd: origin,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  return origin;
};

/** Incompressible bytes, so pack and archive sizes track the file size. */
const noise = (bytes: number): Buffer => {
  const out = Buffer.alloc(bytes);
  let state = 0x9e3779b9;
  for (let index = 0; index < bytes; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[index] = state >>> 24;
  }
  return out;
};

const repository = (url: string, subdirectory: string | null = null) => ({
  url,
  ref: null,
  subdirectory,
  manager: "auto" as const,
  bootstrap: false,
});

const failureOf = async (effect: ReturnType<typeof resolveRepositoryArchive>): Promise<string> => {
  const result = await Effect.runPromise(effect.pipe(Effect.result));
  expect(Result.isFailure(result)).toBe(true);
  return String(result);
};

describe("bounding the dotfiles clone", () => {
  it("stops a clone that stalls at the deadline and kills git", async () => {
    // A git:// server that accepts and never answers: the clone waits on the socket forever.
    const closed: Array<Promise<void>> = [];
    const server = net.createServer((socket) => {
      closed.push(new Promise((resolve) => socket.on("close", () => resolve())));
      // Read (and drop) the request, so the peer's close is seen when git dies.
      socket.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const started = Date.now();
      const message = await failureOf(
        resolveRepositoryArchive(repository(`git://127.0.0.1:${port}/dots.git`), {
          bounds: { ...DOTFILES_CLONE_BOUNDS, timeoutMs: 400 },
        }),
      );
      expect(message).toMatch(/was stopped after 0\.4s/);
      expect(message).toMatch(/0\.4s to clone and pack/);
      expect(Date.now() - started).toBeLessThan(5_000);
      // The connection closes because git was killed, not because the server gave up.
      expect(closed).toHaveLength(1);
      await closed[0];
    } finally {
      server.close();
    }
  });

  it("never downloads a file above the per-file bound and names it", async () => {
    const origin = originWith({
      "dots/.vimrc": "set nocompatible\n",
      "dots/Library/cache.bin": noise(96 * 1024),
    });
    const message = await failureOf(
      resolveRepositoryArchive(repository(`file://${origin}`, "dots"), {
        bounds: { ...DOTFILES_CLONE_BOUNDS, maxFileBytes: 32 * 1024 },
      }),
    );
    expect(message).toMatch(/has files larger than 32KB, which Mend does not download/);
    expect(message).toMatch(/dots\/Library\/cache\.bin/);
  });

  it("never fetches a left-out file after the clone, on git older than 2.45 too", async () => {
    const origin = originWith({ ".vimrc": "x\n", "big.bin": noise(96 * 1024) });
    const checkout = path.join(tmp("mend-dotfiles-lazy-"), "c");
    execFileSync(
      "git",
      [
        "clone",
        "--no-checkout",
        "--depth",
        "1",
        "--filter=blob:limit=32768",
        `file://${origin}`,
        checkout,
      ],
      { stdio: "pipe" },
    );
    const missing = () =>
      execFileSync("git", ["rev-list", "--objects", "--missing=print", "HEAD"], {
        cwd: checkout,
        encoding: "utf8",
      })
        .split("\n")
        .filter((line) => line.startsWith("?"));
    expect(missing()).toHaveLength(1);
    // git before 2.45 (the Mend image ships 2.39) ignores GIT_NO_LAZY_FETCH and would fetch the
    // blob here, unbounded and past the pinned address; the rest of the env must refuse it.
    const { GIT_NO_LAZY_FETCH: _ignoredByOldGit, ...olderGitEnv } = DOTFILES_LOCAL_GIT_ENV;
    const { GIT_NO_LAZY_FETCH: _inherited, ...parentEnv } = process.env;
    expect(() =>
      execFileSync("git", ["cat-file", "-t", "HEAD:big.bin"], {
        cwd: checkout,
        env: { ...parentEnv, ...olderGitEnv },
        stdio: "pipe",
      }),
    ).toThrow(/not allowed/);
    expect(missing()).toHaveLength(1);

    // Through the resolver: a subdirectory naming that file is refused with a readable message.
    const message = await failureOf(
      resolveRepositoryArchive(repository(`file://${origin}`, "big.bin"), {
        bounds: { ...DOTFILES_CLONE_BOUNDS, maxFileBytes: 32 * 1024 },
      }),
    );
    expect(message).toMatch(/has no directory big\.bin/);
  });

  it("packs a tree whose large files sit outside the applied subdirectory", async () => {
    const origin = originWith({
      "dots/.vimrc": "set nocompatible\n",
      "assets/wallpaper.bin": noise(96 * 1024),
    });
    const archive = await Effect.runPromise(
      resolveRepositoryArchive(repository(`file://${origin}`, "dots"), {
        bounds: { ...DOTFILES_CLONE_BOUNDS, maxFileBytes: 32 * 1024 },
      }),
    );
    const out = extract(archive.data);
    expect(fs.readFileSync(path.join(out, ".vimrc"), "utf8")).toBe("set nocompatible\n");
  });

  it("stops a clone larger than the clone bound", async () => {
    const origin = originWith({ ".vimrc": "x\n", "blob.bin": noise(256 * 1024) });
    const message = await failureOf(
      resolveRepositoryArchive(repository(`file://${origin}`), {
        bounds: { ...DOTFILES_CLONE_BOUNDS, maxCloneBytes: 64 * 1024 },
      }),
    );
    expect(message).toMatch(/was stopped at more than 64KB cloned/);
  });

  it("refuses an archive over the platform cap as it streams", async () => {
    const origin = originWith({ ".vimrc": "x\n", "blob.bin": noise(64 * 1024) });
    const message = await failureOf(
      resolveRepositoryArchive(repository(`file://${origin}`), {
        bounds: { ...DOTFILES_CLONE_BOUNDS, maxArchiveBytes: 16 * 1024 },
      }),
    );
    expect(message).toMatch(/packs to more than 16KB/);
  });
});

describe("the dotfiles clone environment", () => {
  const tenant = makeSourcePolicy({
    profile: "tenant",
    allowedHosts: [],
    resolve: async () => ["140.82.112.3"],
  });
  const source = "ssh://git@git.example.test/me/dots.git";

  it("keeps BatchMode when the tenant policy pins ssh to the checked address", async () => {
    const clearance = await Effect.runPromise(tenant.check(source, { isOperator: true }));
    const env = dotfilesCloneEnv((base) => tenant.pinnedEnv(clearance, base));
    expect(env).toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND:
        "ssh -o BatchMode=yes -o HostName=140.82.112.3 -o HostKeyAlias=git.example.test",
    });
    // No pin (operator profile, or no repository) leaves the defaults as they are.
    expect(dotfilesCloneEnv()).toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    });
  });

  it("dials ssh with BatchMode and the pinned address", async () => {
    // A stand-in `ssh` on PATH records how git invoked it, then refuses the connection.
    const bin = tmp("mend-dotfiles-fake-ssh-");
    const argvFile = path.join(bin, "argv");
    fs.writeFileSync(
      path.join(bin, "ssh"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\necho 'Permission denied (publickey).' >&2\nexit 255\n`,
      { mode: 0o755 },
    );
    const clearance = await Effect.runPromise(tenant.check(source, { isOperator: true }));
    const message = await failureOf(
      resolveRepositoryArchive(repository(source), {
        pinCloneEnv: (base) => ({
          ...tenant.pinnedEnv(clearance, base),
          PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        }),
      }),
    );
    expect(message).toMatch(/dotfiles clone of \S+ failed: [\s\S]*Permission denied/);
    const argv = fs.readFileSync(argvFile, "utf8").split("\n");
    expect(argv).toContain("BatchMode=yes");
    expect(argv).toContain("HostName=140.82.112.3");
    expect(argv).toContain("HostKeyAlias=git.example.test");
    // Host key checking is left to ssh's own configuration, as before.
    expect(argv.some((arg) => arg.startsWith("StrictHostKeyChecking"))).toBe(false);
  });
});

// ─── Whose git access a dotfiles clone uses ─────────────────────────────────────────────────

const KEY_PATH = "/keys/users/owner-1/id_ed25519";

/** Every key the stub was asked to make, by owner. */
const mendKeysLayer = (ensured: Array<string | null> = []): Layer.Layer<MendKeys> =>
  Layer.succeed(MendKeys, {
    ensure: (userId) =>
      Effect.sync(() => {
        ensured.push(userId);
        return {
          publicKey: "ssh-ed25519 AAAA owner@example.test",
          fingerprint: "256 SHA256:owner",
          privateKeyPath: KEY_PATH,
        };
      }),
    read: () => Effect.succeed(null),
  });

const agentBridgeLayer = (
  connected: boolean,
  begun: Array<string> = [],
): Layer.Layer<AgentBridge> =>
  Layer.succeed(AgentBridge, {
    attach: () => Effect.die("not in test"),
    status: () => Effect.succeed({ connected, clientName: null, since: null }),
    socketPath: (userId) => `/bridge/${userId}.sock`,
    begin: (userId, description) =>
      Effect.sync(() => {
        begun.push(`${userId}: ${description}`);
        return () => {};
      }),
  });

const accessOf = (
  identity: Parameters<typeof dotfilesCloneAccess>[0],
  layers: {
    readonly keys?: Layer.Layer<MendKeys>;
    readonly bridge?: Layer.Layer<AgentBridge>;
  } = {},
) =>
  Effect.runPromise(
    dotfilesCloneAccess(identity, "owner-1").pipe(
      Effect.provide(
        Layer.mergeAll(layers.keys ?? mendKeysLayer(), layers.bridge ?? agentBridgeLayer(false)),
      ),
      Effect.result,
    ),
  );

/** The rule, for one URL under one tenancy and role. */
const identityOf = (
  url: string,
  tenancy: "single" | "multi",
  ownerIsOperator: boolean,
  ownerGitAccess: GitAccessMode | null = null,
) => dotfilesCloneIdentity({ url, tenancy, ownerIsOperator, ownerGitAccess });

describe("whose git access a dotfiles clone uses", () => {
  const SSH = "git@github.com:owner/dots.git";
  const SSH_URL = "ssh://git@git.example.test:2222/owner/dots.git";
  const HTTPS = "https://github.com/owner/dots.git";
  const GIT = "git://git.example.test/owner/dots.git";

  it("lends the host's setup only to the operator of a single-tenant install", () => {
    for (const url of [SSH, SSH_URL, HTTPS, GIT]) {
      expect(identityOf(url, "single", true)).toEqual({ kind: "host" });
    }
  });

  it("signs an ssh URL with the owner's git access, the Mend key unless they chose the bridge", () => {
    for (const [tenancy, operator] of [
      ["single", false],
      ["multi", false],
      ["multi", true],
    ] as const) {
      for (const url of [SSH, SSH_URL]) {
        expect(identityOf(url, tenancy, operator)).toEqual({ kind: "owner-ssh", mode: "mend-key" });
        expect(identityOf(url, tenancy, operator, "mend-key")).toEqual({
          kind: "owner-ssh",
          mode: "mend-key",
        });
        expect(identityOf(url, tenancy, operator, "bridge")).toEqual({
          kind: "owner-ssh",
          mode: "bridge",
        });
      }
    }
  });

  it("clones HTTPS and git:// with no credential for everyone else, the multi operator too", () => {
    for (const [tenancy, operator] of [
      ["single", false],
      ["multi", false],
      ["multi", true],
    ] as const) {
      for (const url of [HTTPS, "http://git.example.test/owner/dots.git", GIT]) {
        expect(identityOf(url, tenancy, operator, "bridge")).toEqual({ kind: "none" });
      }
    }
  });

  it("the host kind clones with the host's own setup, prompts off", async () => {
    const result = await accessOf({ kind: "host" });
    expect(result).toEqual(Result.succeed({ identity: { kind: "host" }, env: DOTFILES_HOST_ENV }));
  });

  it("the no-credential kind reads none of the host's git or ssh setup", async () => {
    const result = await accessOf({ kind: "none" });
    expect(result).toEqual(Result.succeed({ identity: { kind: "none" }, env: DOTFILES_OWNER_ENV }));
    expect(DOTFILES_OWNER_ENV).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "0",
      GIT_CONFIG_PARAMETERS: "",
      SSH_AUTH_SOCK: "",
      GIT_SSH_COMMAND: "ssh -F /dev/null -o IdentityFile=none -o BatchMode=yes",
    });
  });

  it("signs with the owner's Mend key only: no agent, no ssh config", async () => {
    const ensured: Array<string | null> = [];
    const result = await accessOf(
      { kind: "owner-ssh", mode: "mend-key" },
      { keys: mendKeysLayer(ensured) },
    );
    expect(ensured).toEqual(["owner-1"]);
    expect(result).toEqual(
      Result.succeed({
        identity: { kind: "owner-ssh", mode: "mend-key" },
        env: {
          ...DOTFILES_OWNER_ENV,
          GIT_SSH_COMMAND: `ssh -i '${KEY_PATH}' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes -F /dev/null -o IdentityFile=none`,
          SSH_AUTH_SOCK: "",
        },
      }),
    );
  });

  it("signs through the owner's own connected signer when their git access is the bridge", async () => {
    const result = await accessOf(
      { kind: "owner-ssh", mode: "bridge" },
      { bridge: agentBridgeLayer(true) },
    );
    expect(Result.isSuccess(result) ? result.success.env : null).toMatchObject({
      SSH_AUTH_SOCK: "/bridge/owner-1.sock",
      GIT_SSH_COMMAND:
        "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -F /dev/null -o IdentityFile=none",
      GIT_CONFIG_GLOBAL: "/dev/null",
    });
  });

  it("offers none of the host's default key files, through the Mend key or the bridge", async () => {
    // ssh finds its default keys (~/.ssh/id_*) through the passwd entry, not HOME, and adds
    // them whenever no -i is given: a bridge clone would offer the host's own key after the
    // owner's agent. `ssh -G` prints the identities a connection would offer, without one.
    const home = os.userInfo().homedir;
    for (const mode of ["mend-key", "bridge"] as const) {
      const result = await accessOf(
        { kind: "owner-ssh", mode },
        { bridge: agentBridgeLayer(true) },
      );
      if (!Result.isSuccess(result)) throw new Error(`the ${mode} access resolved`);
      const env = result.success.env;
      const printed = execFileSync(
        "sh",
        ["-c", `${env["GIT_SSH_COMMAND"] ?? ""} -G git.example.test`],
        { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "ignore"] },
      ).toString("utf8");
      const identities = printed
        .split("\n")
        .filter((line) => line.startsWith("identityfile "))
        .map((line) => line.slice("identityfile ".length));
      expect(identities.length).toBeGreaterThan(0);
      expect(
        identities.filter((identity) => identity.startsWith("~") || identity.startsWith(home)),
      ).toEqual([]);
    }
  });

  it("refuses, readable, when the owner's bridge has nobody sharing; it never falls back", async () => {
    const result = await accessOf({ kind: "owner-ssh", mode: "bridge" });
    expect(Result.isFailure(result)).toBe(true);
    expect(String(result)).toContain(
      `the dotfiles repository signs with your connected signer: ${NO_SIGNER_MESSAGE}`,
    );
  });

  it("keeps the owner's key and BatchMode when the tenant policy pins ssh", async () => {
    const tenant = makeSourcePolicy({
      profile: "tenant",
      allowedHosts: [],
      resolve: async () => ["140.82.112.3"],
    });
    const clearance = await Effect.runPromise(tenant.check(SSH, { isOperator: false }));
    const result = await accessOf({ kind: "owner-ssh", mode: "mend-key" });
    if (!Result.isSuccess(result)) throw new Error("the Mend key resolved");
    const env = dotfilesCloneEnv((base) => tenant.pinnedEnv(clearance, base), result.success);
    expect(env["GIT_SSH_COMMAND"]).toBe(
      `ssh -i '${KEY_PATH}' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes -F /dev/null -o IdentityFile=none -o HostName=140.82.112.3 -o HostKeyAlias=github.com`,
    );
  });
});

/** The cloner production builds, over stub keys, bridge and repositories. */
const clonerLayer = (options: {
  readonly tenancy: "single" | "multi";
  readonly ownerIsOperator: boolean;
  readonly gitAccess?: GitAccessMode | null;
  readonly bridge?: Layer.Layer<AgentBridge>;
  readonly asked?: Array<string>;
}): Layer.Layer<DotfilesCloner> =>
  makeDotfilesClonerLayer(options.tenancy).pipe(
    Layer.provide(
      Layer.mergeAll(
        mendKeysLayer(),
        options.bridge ?? agentBridgeLayer(false),
        Layer.mock(UserGitAccessRepo, {
          mode: (userId) =>
            Effect.sync(() => {
              options.asked?.push(`git access of ${userId}`);
              return options.gitAccess ?? null;
            }),
        }),
        Layer.mock(InstanceRolesRepo, {
          isOperator: (userId) =>
            Effect.sync(() => {
              options.asked?.push(`operator role of ${userId}`);
              return options.ownerIsOperator;
            }),
        }),
      ),
    ),
  );

const cloneAs = (
  layer: Layer.Layer<DotfilesCloner>,
  url: string,
  pinCloneEnv?: (env: Readonly<Record<string, string>>) => Record<string, string>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cloner = yield* DotfilesCloner;
      return yield* cloner.archive(
        "owner-1",
        repository(url),
        pinCloneEnv === undefined ? {} : { pinCloneEnv },
      );
    }).pipe(Effect.provide(layer), Effect.result),
  );

/**
 * An HTTP git remote that refuses everyone (401) and records the Authorization header of every
 * request: a credential the host holds shows up here if the clone was lent one.
 */
const refusingRemote = async (): Promise<{
  readonly url: string;
  readonly authorizations: Array<string | null>;
  readonly close: () => Promise<void>;
}> => {
  const authorizations: Array<string | null> = [];
  const server = http.createServer((request, response) => {
    authorizations.push(request.headers.authorization ?? null);
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="dots"' });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}/owner/dots.git`,
    authorizations,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

/**
 * The host's own HTTPS credentials, as an operator's shell would have them: a `.netrc` in HOME
 * and a credential helper in git's global config. Restores the environment after `run`.
 */
const withHostCredentials = async <A>(run: (helperLog: string) => Promise<A>): Promise<A> => {
  const dir = tmp("mend-dotfiles-host-creds-");
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  fs.writeFileSync(
    path.join(home, ".netrc"),
    "machine 127.0.0.1 login netrc-user password netrc-pass\n",
  );
  const helperLog = path.join(dir, "helper.log");
  const gitconfig = path.join(dir, "gitconfig");
  fs.writeFileSync(
    gitconfig,
    `[credential]\n\thelper = "!f() { echo called >> '${helperLog}'; echo username=helper-user; echo password=helper-pass; }; f"\n`,
  );
  const saved = { HOME: process.env["HOME"], GIT_CONFIG_GLOBAL: process.env["GIT_CONFIG_GLOBAL"] };
  process.env["HOME"] = home;
  process.env["GIT_CONFIG_GLOBAL"] = gitconfig;
  try {
    return await run(helperLog);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

describe("DotfilesCloner", () => {
  it("lends the operator of a single-tenant install the host's HTTPS credentials", async () => {
    const remote = await refusingRemote();
    try {
      const asked: Array<string> = [];
      const result = await withHostCredentials(async (helperLog) => {
        const cloned = await cloneAs(
          clonerLayer({ tenancy: "single", ownerIsOperator: true, asked }),
          remote.url,
        );
        // The host's helper answered: the clone ran with the host's identity, by the rule.
        expect(fs.existsSync(helperLog)).toBe(true);
        return cloned;
      });
      expect(Result.isFailure(result)).toBe(true);
      expect(asked).toContain("operator role of owner-1");
      expect(remote.authorizations).toContain(basic("netrc-user", "netrc-pass"));
      expect(remote.authorizations).toContain(basic("helper-user", "helper-pass"));
    } finally {
      await remote.close();
    }
  });

  for (const [tenancy, ownerIsOperator] of [
    ["multi", true],
    ["multi", false],
    ["single", false],
  ] as const) {
    it(`never lends the host's HTTPS credentials (${tenancy} tenancy, ${ownerIsOperator ? "operator" : "member"})`, async () => {
      const remote = await refusingRemote();
      try {
        const result = await withHostCredentials(async (helperLog) => {
          const cloned = await cloneAs(clonerLayer({ tenancy, ownerIsOperator }), remote.url);
          expect(fs.existsSync(helperLog)).toBe(false);
          return cloned;
        });
        // Asked, and refused, with nothing: no .netrc login, no helper's answer.
        expect(remote.authorizations.length).toBeGreaterThan(0);
        expect(remote.authorizations.every((header) => header === null)).toBe(true);
        expect(Result.isFailure(result)).toBe(true);
        expect(String(result)).toContain(
          "Mend clones your HTTPS dotfiles repository without a credential, so only a public one clones. For a private repository, save its SSH URL",
        );
      } finally {
        await remote.close();
      }
    });
  }

  it("clones a public repository with none of the host's setup", async () => {
    const origin = originWith({ "dots/.vimrc": "set nocompatible\n" });
    const result = await withHostCredentials(() =>
      cloneAs(clonerLayer({ tenancy: "multi", ownerIsOperator: false }), `file://${origin}`),
    );
    expect(Result.isSuccess(result)).toBe(true);
  });

  it("signs a multi-tenant owner's ssh clone with their Mend key, and says where to add it", async () => {
    // A stand-in `ssh` on PATH records how git invoked it, then refuses the key.
    const bin = tmp("mend-dotfiles-owner-ssh-");
    const argvFile = path.join(bin, "argv");
    fs.writeFileSync(
      path.join(bin, "ssh"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\necho 'git@github.com: Permission denied (publickey).' >&2\nexit 255\n`,
      { mode: 0o755 },
    );
    const asked: Array<string> = [];
    const result = await cloneAs(
      clonerLayer({ tenancy: "multi", ownerIsOperator: true, asked }),
      "git@github.com:owner/dots.git",
      (base) => ({ ...base, PATH: `${bin}:${process.env["PATH"] ?? ""}` }),
    );
    // Multi tenancy has no host identity to lend, so the role is never asked.
    expect(asked).toEqual(["git access of owner-1"]);
    const argv = fs.readFileSync(argvFile, "utf8").split("\n");
    expect(argv.slice(0, 2)).toEqual(["-i", KEY_PATH]);
    expect(argv).toContain("IdentitiesOnly=yes");
    expect(argv).toContain("BatchMode=yes");
    expect(argv[argv.indexOf("-F") + 1]).toBe("/dev/null");
    expect(String(result)).toMatch(
      /dotfiles clone of git@github\.com:owner\/dots\.git failed: The remote refused the Mend key \(permission denied\)\. Add your Mend public key to your git account's SSH keys/,
    );
  });

  it("attributes a bridge-signed clone to the owner's share client", async () => {
    const begun: Array<string> = [];
    const bin = tmp("mend-dotfiles-bridge-ssh-");
    fs.writeFileSync(
      path.join(bin, "ssh"),
      "#!/bin/sh\necho 'Permission denied (publickey).' >&2\nexit 255\n",
      { mode: 0o755 },
    );
    const result = await cloneAs(
      clonerLayer({
        tenancy: "multi",
        ownerIsOperator: false,
        gitAccess: "bridge",
        bridge: agentBridgeLayer(true, begun),
      }),
      "git@github.com:owner/dots.git",
      (base) => ({ ...base, PATH: `${bin}:${process.env["PATH"] ?? ""}` }),
    );
    expect(begun).toEqual(["owner-1: dotfiles clone → git@github.com:owner/dots.git"]);
    expect(String(result)).toContain("The remote refused the connected signer's keys");
  });
});
