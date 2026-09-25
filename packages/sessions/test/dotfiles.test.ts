import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { makeSourcePolicy } from "@mend/store";
import { Effect, Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  DOTFILES_CLONE_BOUNDS,
  DOTFILES_LOCAL_GIT_ENV,
  dotfilesCloneEnv,
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
