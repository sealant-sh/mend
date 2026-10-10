import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { SessionId } from "@mend/domain";
import {
  RepositoryCloneUrl,
  type RepositoryCloneUrl as RepositoryCloneUrlValue,
} from "@mend/domain/workbench";
import { Effect, Layer, Result, Schedule } from "effect";

import {
  GRAFTED_REPOSITORY_REASON,
  SHALLOW_REPOSITORY_REASON,
  Store,
  StoreConfig,
  unsupportedRepositoryReason,
} from "../src/store.ts";

const sessionId = SessionId.make("01TEST");
/** Worktree identity as the engine derives it for unnamed worktrees. */
const wtIdentity = (id: string) => ({ directory: `wt-${id}`, branch: `mend/wt/${id}` });

/** True when the mode carries the shared-group contract: setgid + group rwx. */
const setgidGroupWrite = (target: string) => {
  const mode = fs.statSync(target).mode & 0o7777;
  return (mode & 0o2070) === 0o2070;
};

/** A throwaway origin repo with one commit — what a user would adopt. */
const makeOrigin = (dir: string) => {
  const run = (...args: ReadonlyArray<string>) =>
    execFileSync("git", [...args], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "origin",
        GIT_AUTHOR_EMAIL: "origin@localhost",
        GIT_COMMITTER_NAME: "origin",
        GIT_COMMITTER_EMAIL: "origin@localhost",
      },
    });
  fs.mkdirSync(dir, { recursive: true });
  run("init", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  fs.writeFileSync(path.join(dir, "app.ts"), "export const answer = 41\n");
  run("add", "-A");
  run("commit", "-m", "initial");
};

const reservePort = async (): Promise<number> => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No test port available.");
  server.close();
  await once(server, "close");
  return address.port;
};

const waitForPort = async (port: number): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Git test server did not listen on ${port}.`);
};

const withStore = async <A, E>(
  work: (
    tmp: string,
    origin: string,
    source: RepositoryCloneUrlValue,
  ) => Effect.Effect<A, E, Store>,
): Promise<A> => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-store-test-"));
  const origin = path.join(tmp, "origin");
  makeOrigin(origin);
  const port = await reservePort();
  const daemon = spawn(
    "git",
    [
      "daemon",
      "--reuseaddr",
      "--export-all",
      `--base-path=${tmp}`,
      "--listen=127.0.0.1",
      `--port=${port}`,
      tmp,
    ],
    { stdio: "ignore" },
  );
  try {
    await waitForPort(port);
    const source = RepositoryCloneUrl.make(`git://127.0.0.1:${port}/origin`);
    const storeLayer = Store.layer.pipe(
      Layer.provide(StoreConfig.layerFor(path.join(tmp, "store"))),
    );
    return await Effect.runPromise(
      work(tmp, origin, source).pipe(Effect.provide(storeLayer), Effect.orDie),
    );
  } finally {
    daemon.kill();
    if (daemon.exitCode === null) await once(daemon, "exit");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

describe("Store", () => {
  it("lists a tree's root entries, a directory with a trailing slash, under a cap", async () => {
    await withStore((tmp) =>
      Effect.gen(function* () {
        const store = yield* Store;
        const repo = path.join(tmp, "nested");
        makeOrigin(repo);
        fs.mkdirSync(path.join(repo, "src", "lib"), { recursive: true });
        fs.writeFileSync(path.join(repo, "src", "lib", "retry.ts"), "export {}\n");
        execFileSync("git", ["add", "-A"], { cwd: repo });
        execFileSync(
          "git",
          ["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-m", "src"],
          { cwd: repo },
        );

        expect(yield* store.listTopLevel(repo, "main", 10)).toEqual({
          files: ["README.md", "app.ts", "src/"],
          truncated: false,
        });
        expect(yield* store.listTopLevel(repo, "main", 2)).toEqual({
          files: ["README.md", "app.ts"],
          truncated: true,
        });
      }),
    );
  });

  it("terminates clone options for actual network adoption and reference clones", async () => {
    await withStore((tmp, _origin, source) =>
      Effect.gen(function* () {
        const store = yield* Store;
        const trace = path.join(tmp, "clone.trace");
        const env = { GIT_TERMINAL_PROMPT: "0", GIT_TRACE: trace };
        const adopted = yield* store.adopt("args", source, env);
        const reference = yield* store.cloneReference("_references/args", source, "main", env);
        expect(reference.headSha).toBe(adopted.headSha);
        expect(fs.readFileSync(path.join(reference.path, "README.md"), "utf8")).toBe("# fixture\n");
        const commands = fs.readFileSync(trace, "utf8");
        expect(commands).toContain(`clone --bare -- ${source} ${adopted.storePath}`);
        expect(commands).toContain(`clone --depth 1 --branch main -- ${source} ${reference.path}`);
      }),
    );
  });

  it("refuses to adopt a SHA-256 repository, and leaves nothing behind", async () => {
    await withStore((tmp, _origin, source) =>
      Effect.gen(function* () {
        const store = yield* Store;
        // A SHA-256 origin, served beside the fixture's.
        const sha256 = path.join(tmp, "sha256");
        fs.mkdirSync(sha256);
        execFileSync("git", ["init", "-q", "-b", "main", "--object-format=sha256"], {
          cwd: sha256,
        });
        fs.writeFileSync(path.join(sha256, "README.md"), "# sha256\n");
        execFileSync("git", ["add", "-A"], { cwd: sha256 });
        execFileSync(
          "git",
          ["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "one"],
          { cwd: sha256 },
        );
        const refusedSha256 = yield* store
          .adopt("sha256", RepositoryCloneUrl.make(source.replace(/origin$/, "sha256")), {
            GIT_TERMINAL_PROMPT: "0",
          })
          .pipe(Effect.result);
        expect(Result.isFailure(refusedSha256)).toBe(true);
        if (Result.isFailure(refusedSha256)) {
          expect(refusedSha256.failure.cause.stderr).toBe(
            "Mend doesn't support SHA-256 repositories yet.",
          );
        }
        expect(fs.existsSync(path.join(tmp, "store/sha256"))).toBe(false);
        // A SHA-1 origin adopts as before.
        const adopted = yield* store.adopt("files", source, { GIT_TERMINAL_PROMPT: "0" });
        expect(adopted.defaultBranch).toBe("main");
      }),
    );
  });

  // Verify proof run 9 (2026-10-10): a project adopted from a shallow repository never saved a
  // Stop — the base pack stops at the shallow boundary, and the capture's closure walk reads the
  // boundary's parents. A full clone of a shallow source is shallow too, so adoption refuses it.
  it("refuses to adopt a shallow repository, and leaves nothing behind", async () => {
    await withStore((tmp, origin, source) =>
      Effect.gen(function* () {
        const store = yield* Store;
        const commit = (message: string) => {
          fs.appendFileSync(path.join(origin, "app.ts"), `// ${message}\n`);
          execFileSync("git", ["add", "-A"], { cwd: origin });
          execFileSync(
            "git",
            ["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", message],
            { cwd: origin },
          );
        };
        commit("two");
        commit("three");
        // A shallow repository served beside the origin (a `--depth` mirror, a CI checkout).
        execFileSync("git", [
          "clone",
          "-q",
          "--bare",
          "--depth",
          "1",
          `file://${origin}`,
          path.join(tmp, "shallow"),
        ]);
        const refused = yield* store
          .adopt("shallow", RepositoryCloneUrl.make(source.replace(/origin$/, "shallow")), {
            GIT_TERMINAL_PROMPT: "0",
          })
          .pipe(Effect.result);
        expect(Result.isFailure(refused)).toBe(true);
        if (Result.isFailure(refused)) {
          expect(refused.failure.cause.stderr).toBe(SHALLOW_REPOSITORY_REASON);
        }
        expect(fs.existsSync(path.join(tmp, "store/shallow"))).toBe(false);

        // A shallow local checkout adopts through its origin (the CLI sends `git remote get-url
        // origin`; local paths are refused): the store is the origin's full history.
        const checkout = path.join(tmp, "checkout");
        execFileSync("git", ["clone", "-q", "--depth", "1", source, checkout]);
        expect(
          execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: checkout })
            .toString()
            .trim(),
        ).toBe("true");
        const originOfCheckout = execFileSync("git", ["remote", "get-url", "origin"], {
          cwd: checkout,
        })
          .toString()
          .trim();
        const adopted = yield* store.adopt("checkout", RepositoryCloneUrl.make(originOfCheckout), {
          GIT_TERMINAL_PROMPT: "0",
        });
        expect(
          execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: adopted.storePath })
            .toString()
            .trim(),
        ).toBe("false");
        expect(
          execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: adopted.storePath })
            .toString()
            .trim(),
        ).toBe("3");
      }),
    );
  });

  // Astra review of mend#654: `info/grafts` cuts the base pack as a shallow boundary does, while
  // git calls the repository complete. A clone never copies grafts, so only a store edited on the
  // host has them; a session start refuses it. Replace refs do not cut the pack (`pack-objects`
  // ignores them) and are not refused.
  it("refuses a repository whose grafts cut its history, and not one with only replace refs", async () => {
    await withStore((tmp, _origin, source) =>
      Effect.gen(function* () {
        const store = yield* Store;
        const adopted = yield* store.adopt("grafted", source, { GIT_TERMINAL_PROMPT: "0" });
        const repo = adopted.storePath;
        const head = adopted.headSha;
        const second = execFileSync(
          "git",
          [
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@localhost",
            "commit-tree",
            `${head}^{tree}`,
            "-p",
            head,
            "-m",
            "second",
          ],
          { cwd: repo },
        )
          .toString()
          .trim();
        execFileSync("git", ["update-ref", "refs/heads/main", second], { cwd: repo });
        expect(yield* unsupportedRepositoryReason(repo)).toBeNull();
        const grafts = path.join(repo, "info", "grafts");
        // Only comments: no commit is grafted.
        fs.writeFileSync(grafts, "# no grafts\n\n");
        expect(yield* unsupportedRepositoryReason(repo)).toBeNull();
        fs.writeFileSync(grafts, `${second}\n`);
        expect(
          execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: repo })
            .toString()
            .trim(),
        ).toBe("false");
        expect(yield* unsupportedRepositoryReason(repo)).toBe(GRAFTED_REPOSITORY_REASON);
        fs.rmSync(grafts);
        execFileSync("git", ["replace", "--graft", second], { cwd: repo });
        expect(yield* unsupportedRepositoryReason(repo)).toBeNull();
      }),
    );
  });

  it("reports actual Git clone transport failures with positional sources", async () => {
    await withStore((tmp, _origin, source) =>
      Effect.gen(function* () {
        const store = yield* Store;
        const missing = RepositoryCloneUrl.make(`${source}-missing`);
        const adopted = yield* store
          .adopt("missing", missing, { GIT_TERMINAL_PROMPT: "0" })
          .pipe(Effect.result);
        expect(Result.isFailure(adopted)).toBe(true);
        if (Result.isFailure(adopted)) {
          expect(adopted.failure._tag).toBe("AdoptError");
          expect(adopted.failure.cause.args).toEqual([
            "clone",
            "--bare",
            "--",
            missing,
            path.join(tmp, "store/missing/repo.git"),
          ]);
          expect(adopted.failure.cause.exitCode).toBe(128);
          expect(adopted.failure.cause.stderr).toContain(
            "access denied or repository not exported",
          );
        }
        expect(fs.existsSync(path.join(tmp, "store/missing/repo.git"))).toBe(false);

        const reference = yield* store
          .cloneReference("_references/missing", missing, null, {})
          .pipe(Effect.result);
        expect(Result.isFailure(reference)).toBe(true);
        if (Result.isFailure(reference)) {
          expect(reference.failure._tag).toBe("ReferenceCloneError");
          expect(reference.failure.cause.args).toEqual([
            "clone",
            "--depth",
            "1",
            "--",
            missing,
            path.join(tmp, "store/_references/missing"),
          ]);
          expect(reference.failure.cause.exitCode).toBe(128);
          expect(reference.failure.cause.stderr).toContain(
            "access denied or repository not exported",
          );
        }
      }),
    );
  });

  it("keeps a credential out of a failed git run's error: args, stderr and the source", async () => {
    await withStore(() =>
      Effect.gen(function* () {
        const store = yield* Store;
        // Port 1 refuses: the clone fails before any credential could be offered.
        const reference = yield* store
          .cloneReference(
            "_references/token",
            "https://oauth2:TOKEN-SECRET@127.0.0.1:1/org/repo.git",
            null,
            { GIT_TERMINAL_PROMPT: "0" },
          )
          .pipe(Effect.result);
        expect(Result.isFailure(reference)).toBe(true);
        if (Result.isFailure(reference)) {
          expect(JSON.stringify(reference.failure)).not.toContain("TOKEN-SECRET");
          expect(reference.failure.source).toBe("https://127.0.0.1:1/org/repo.git");
          expect(reference.failure.cause.args).toContain("https://127.0.0.1:1/org/repo.git");
        }
      }),
    );
  });

  it("takes a login or token out of every remote URL, and leaves a clean config alone", async () => {
    await withStore((_tmp, _origin, source) =>
      Effect.gen(function* () {
        const store = yield* Store;
        const adopted = yield* store.adopt("scrub", source, {});
        const config = (...args: ReadonlyArray<string>) =>
          execFileSync("git", ["config", ...args], { cwd: adopted.storePath, encoding: "utf8" });
        // What a server before 0.36 left behind for a URL adopted with a token.
        config(
          "--add",
          "remote.origin.pushurl",
          "https://oauth2:TOKEN-SECRET@example.invalid/o/r.git",
        );
        config("remote.mirror.url", "https://ghp_TOKEN-SECRET@example.invalid/o/r.git");
        config("remote.login.url", "ssh://git:TOKEN-SECRET@example.invalid/o/r.git");
        // Quotes and angle brackets are userinfo like any other character (review of mend#640).
        config("remote.quoted.url", "http://user:se'cret<TOKEN-SECRET>@example.invalid/o/r.git");

        expect(yield* store.scrubRemoteCredentials(adopted.storePath)).toBe(4);
        const remotes = config("--get-regexp", String.raw`^remote\.`);
        expect(remotes).not.toContain("TOKEN-SECRET");
        expect(remotes).toContain(`remote.origin.url ${source}`);
        expect(remotes).toContain("remote.origin.pushurl https://example.invalid/o/r.git");
        expect(remotes).toContain("remote.mirror.url https://example.invalid/o/r.git");
        expect(remotes).toContain("remote.login.url ssh://git@example.invalid/o/r.git");
        expect(remotes).toContain("remote.quoted.url http://example.invalid/o/r.git");

        expect(yield* store.scrubRemoteCredentials(adopted.storePath)).toBe(0);
        // The origin that needed no credential still fetches.
        yield* store.refreshFromOrigin(adopted.storePath, {});
      }),
    );
  });

  it("refuses to fetch or open a worktree while a remote still holds a token, and cleans it first once it can", async () => {
    await withStore((_tmp, _origin, source) =>
      Effect.gen(function* () {
        const store = yield* Store;
        const adopted = yield* store.adopt("gated", source, {});
        const config = (...args: ReadonlyArray<string>) =>
          execFileSync("git", ["config", ...args], { cwd: adopted.storePath, encoding: "utf8" });
        config("remote.origin.pushurl", "https://user:se'TOKEN-SECRET@example.invalid/o/r.git");
        // Another git holds the config for longer than the gate waits: nothing runs with the token.
        const lock = path.join(adopted.storePath, "config.lock");
        fs.writeFileSync(lock, "");
        const refused = yield* store.refreshFromOrigin(adopted.storePath, {}).pipe(Effect.flip);
        expect(refused.stderr).toContain("has not yet removed a login or token");
        expect(JSON.stringify(refused)).not.toContain("TOKEN-SECRET");
        const worktree = yield* store
          .createWorktree(adopted.storePath, wtIdentity("gated"), null, null)
          .pipe(Effect.flip);
        expect(worktree.stderr).toContain("has not yet removed a login or token");
        // The lock goes: the next fetch cleans the remote first, then runs.
        fs.rmSync(lock);
        yield* store.refreshFromOrigin(adopted.storePath, {});
        expect(config("--get", "remote.origin.pushurl").trim()).toBe(
          "https://example.invalid/o/r.git",
        );
      }),
    );
  });

  it("reads what git reads: a multiline value is cleaned whole, an include or url rewrite with a token refuses", async () => {
    await withStore((tmp, _origin, source) =>
      Effect.gen(function* () {
        const store = yield* Store;
        const adopted = yield* store.adopt("effective", source, {});
        const config = (...args: ReadonlyArray<string>) =>
          execFileSync("git", ["config", ...args], { cwd: adopted.storePath, encoding: "utf8" });
        // A value with a newline in it is one value (review 2 of mend#640, N2).
        config("remote.origin.pushurl", "https://user:LINE\nTOKEN-SECRET@example.invalid/o/r.git");
        expect(yield* store.scrubRemoteCredentials(adopted.storePath)).toBe(1);
        expect(config("-z", "--get-all", "remote.origin.pushurl")).toBe(
          "https://example.invalid/o/r.git\0",
        );
        yield* store.createWorktree(adopted.storePath, wtIdentity("after-multiline"), null, null);

        // A credential in an included file is not Mend's to edit: nothing runs while it is there (N1).
        const included = path.join(tmp, "included.gitconfig");
        fs.writeFileSync(
          included,
          `[remote "origin"]\n\tpushurl = http://user:se'TOKEN-SECRET@example.invalid/o/r.git\n`,
        );
        config("include.path", included);
        const refused = yield* store.refreshFromOrigin(adopted.storePath, {}).pipe(Effect.flip);
        expect(refused.stderr).toContain("has not yet removed a login or token");
        expect(refused.stderr).toContain("included.gitconfig");
        expect(JSON.stringify(refused)).not.toContain("TOKEN-SECRET");
        const worktree = yield* store
          .createWorktree(adopted.storePath, wtIdentity("included"), null, null)
          .pipe(Effect.flip);
        expect(worktree.stderr).toContain("included.gitconfig");
        expect(fs.readFileSync(included, "utf8")).toContain("TOKEN-SECRET");
        // The include is cleaned by whoever owns it; then everything runs again.
        fs.writeFileSync(
          included,
          `[remote "origin"]\n\tpushurl = http://example.invalid/o/r.git\n`,
        );
        yield* store.refreshFromOrigin(adopted.storePath, {});

        // A url rewrite that puts a token into every matching remote refuses the same way.
        config(
          "url.https://ghp_TOKEN-SECRET@example.invalid/.insteadOf",
          "https://example.invalid/",
        );
        const rewrite = yield* store.scrubRemoteCredentials(adopted.storePath).pipe(Effect.flip);
        expect(rewrite.stderr).toContain("url.insteadOf");
        expect(JSON.stringify(rewrite)).not.toContain("TOKEN-SECRET");
      }),
    );
  });

  it("cleans a remote once when the sweep and several fetches race for it", async () => {
    await withStore((_tmp, _origin, source) =>
      Effect.gen(function* () {
        const store = yield* Store;
        const adopted = yield* store.adopt("race", source, {});
        const config = (...args: ReadonlyArray<string>) =>
          execFileSync("git", ["config", ...args], { cwd: adopted.storePath, encoding: "utf8" });
        config("remote.origin.pushurl", "https://user:TOKEN-SECRET@example.invalid/o/r.git");
        // Everyone queues behind a held lock, then all go at once (review 2 of mend#640, N3).
        const lock = path.join(adopted.storePath, "config.lock");
        fs.writeFileSync(lock, "");
        setTimeout(() => fs.rmSync(lock, { force: true }), 150);
        yield* Effect.all(
          [
            store
              .scrubRemoteCredentials(adopted.storePath)
              .pipe(Effect.retry({ times: 20, schedule: Schedule.spaced("25 millis") })),
            ...Array.from({ length: 6 }, () => store.refreshFromOrigin(adopted.storePath, {})),
          ],
          { concurrency: "unbounded" },
        );
        expect(config("-z", "--get-all", "remote.origin.pushurl")).toBe(
          "https://example.invalid/o/r.git\0",
        );
        expect(config("--get-all", "remote.origin.url").trim()).toBe(source);
      }),
    );
  });

  it("never consumes a reference source as a clone option", async () => {
    await withStore((tmp) =>
      Effect.gen(function* () {
        const store = yield* Store;
        // Reference sources also allow local paths. This option-shaped value must
        // be a positional source; disabling transports keeps the test offline.
        const source = "--upload-pack=foo@host:repo";
        const result = yield* store
          .cloneReference("_references/option", source, null, {
            GIT_ALLOW_PROTOCOL: "",
            GIT_TERMINAL_PROMPT: "0",
          })
          .pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.cause.args).toEqual([
            "clone",
            "--depth",
            "1",
            "--",
            source,
            path.join(tmp, "store/_references/option"),
          ]);
          expect(result.failure.cause.stderr).toContain("transport 'ssh' not allowed");
          expect(result.failure.cause.stderr).not.toContain("usage: git clone");
        }
      }),
    );
  });

  it("adopts, worktrees, checkpoints, and slices", async () => {
    await withStore((tmp, _origin, source) =>
      Effect.gen(function* () {
        const store = yield* Store;

        // Adopt: bare clone in the store, default branch discovered.
        const adopted = yield* store.adopt("fixture", source, { GIT_TERMINAL_PROMPT: "0" });
        expect(adopted.defaultBranch).toBe("main");
        expect(fs.existsSync(adopted.storePath)).toBe(true);

        // Session worktree on its own branch from the default branch.
        const wt = yield* store.createWorktree(
          adopted.storePath,
          wtIdentity(sessionId),
          null,
          null,
        );
        expect(wt.branch).toBe(`mend/wt/${sessionId}`);
        expect(wt.baseSha).toBe(adopted.headSha);
        expect(wt.baseRef).toBe("main");
        expect(fs.existsSync(path.join(wt.path, "app.ts"))).toBe(true);

        // "Agent" edits a tracked file and adds an untracked one.
        fs.writeFileSync(path.join(wt.path, "app.ts"), "export const answer = 42\n");
        const cp1 = yield* store.checkpoint(wt.path, sessionId, 1, null);

        fs.writeFileSync(path.join(wt.path, "extra.ts"), "export const extra = true\n");
        const cp2 = yield* store.checkpoint(wt.path, sessionId, 2, cp1.sha);

        // Checkpoints never touch the visible branch, HEAD, or the files.
        const head = yield* store.headSha(wt.path);
        expect(head).toBe(adopted.headSha);
        expect(fs.readFileSync(path.join(wt.path, "app.ts"), "utf8")).toContain("42");

        // The slice cp1..cp2 contains only the untracked-then-snapshotted file.
        const slice = yield* store.diffRange(wt.path, cp1.sha, cp2.sha);
        expect(slice).toContain("extra.ts");
        expect(slice).not.toContain("answer");

        // Full change: worktree vs base sees the tracked edit AND the untracked file.
        const full = yield* store.diffWorktree(wt.path, wt.baseSha);
        expect(full).toContain("-export const answer = 41");
        expect(full).toContain("+export const answer = 42");
        expect(full).toContain("extra.ts");
        const liveFiles = yield* store.changedFiles(wt.path, wt.baseSha, null);
        expect(liveFiles.map((f) => f.path).toSorted()).toEqual(["app.ts", "extra.ts"]);

        // Per-file counts across base → cp2 (includes the untracked file via the snapshot).
        const files = yield* store.changedFiles(wt.path, wt.baseSha, cp2.sha);
        const paths = files.map((f) => f.path).toSorted();
        expect(paths).toEqual(["app.ts", "extra.ts"]);
        expect(yield* store.worktreeMatchesCommit(wt.path, cp2.sha)).toBe(true);

        fs.renameSync(path.join(wt.path, "extra.ts"), path.join(wt.path, "renamed.ts"));
        fs.writeFileSync(path.join(wt.path, "asset.bin"), Buffer.from([0, 1, 2, 3]));
        expect(yield* store.worktreeMatchesCommit(wt.path, cp2.sha)).toBe(false);
        const cp3 = yield* store.checkpoint(wt.path, sessionId, 3, cp2.sha);
        execFileSync("git", ["config", "diff.renames", "false"], { cwd: wt.path });
        const renamePatch = yield* store.diffRange(wt.path, cp2.sha, cp3.sha);
        expect(renamePatch).toContain("rename from extra.ts");
        expect(yield* store.worktreeMatchesCommit(wt.path, cp3.sha)).toBe(true);
        const facts = yield* store.diffFileFacts(wt.path, cp2.sha, cp3.sha);
        expect(facts).toEqual([
          {
            oldPath: null,
            newPath: "asset.bin",
            status: "added",
            additions: 0,
            deletions: 0,
            binary: true,
          },
          {
            oldPath: "extra.ts",
            newPath: "renamed.ts",
            status: "renamed",
            additions: 0,
            deletions: 0,
            binary: false,
          },
        ]);

        // Review rendering options stay paired: a whitespace-only edit disappears
        // from both the patch and its file facts when whitespace is ignored.
        fs.writeFileSync(path.join(wt.path, "app.ts"), "export  const answer = 42\n");
        const cp4 = yield* store.checkpoint(wt.path, sessionId, 4, cp3.sha);
        expect(yield* store.diffRange(wt.path, cp3.sha, cp4.sha)).toContain("app.ts");
        expect(yield* store.diffRange(wt.path, cp3.sha, cp4.sha, { ignoreWhitespace: true })).toBe(
          "",
        );
        expect(yield* store.diffFileFacts(wt.path, cp3.sha, cp4.sha)).toHaveLength(1);
        expect(
          yield* store.diffFileFacts(wt.path, cp3.sha, cp4.sha, { ignoreWhitespace: true }),
        ).toEqual([]);
        const noContext = yield* store.diffRange(wt.path, cp3.sha, cp4.sha, { contextLines: 0 });
        expect(noContext).toContain("@@ -1 +1 @@");

        // Worktree removal leaves the checkpoint refs intact in the bare repo.
        yield* store.removeWorktree(adopted.storePath, wt.name);
        const survivingDiff = yield* store.diffRange(adopted.storePath, cp1.sha, cp2.sha);
        expect(survivingDiff).toContain("extra.ts");
      }),
    );
  });

  it("keeps the store group-writable so a root-side git cannot lock uid 1000 out", async () => {
    await withStore((_tmp, _origin, source) =>
      Effect.gen(function* () {
        const store = yield* Store;
        const adopted = yield* store.adopt("fixture", source, { GIT_TERMINAL_PROMPT: "0" });

        const shared = () =>
          execFileSync("git", ["config", "--get", "core.sharedRepository"], {
            cwd: adopted.storePath,
          })
            .toString()
            .trim();

        // Adoption applies the policy: config + setgid group-writable directories, so files a
        // root-side `git gc` creates stay writable by this uid through the shared group.
        expect(shared()).toBe("group");
        expect(setgidGroupWrite(path.join(adopted.storePath, "refs"))).toBe(true);
        expect(setgidGroupWrite(path.join(adopted.storePath, "refs", "heads"))).toBe(true);

        // A store from before the policy heals on the next worktree create.
        execFileSync("git", ["config", "--unset", "core.sharedRepository"], {
          cwd: adopted.storePath,
        });
        fs.chmodSync(path.join(adopted.storePath, "refs"), 0o755);
        const wt = yield* store.createWorktree(
          adopted.storePath,
          wtIdentity(sessionId),
          null,
          null,
        );
        expect(shared()).toBe("group");
        expect(setgidGroupWrite(path.join(adopted.storePath, "refs"))).toBe(true);
        // The worktree's own gitdir metadata (where checkpoints write) is covered too.
        expect(setgidGroupWrite(path.join(adopted.storePath, "worktrees", wt.name))).toBe(true);
      }),
    );
  });

  it("freshens bases from origin, lists branches, and refreshes", async () => {
    await withStore((_tmp, origin, source) =>
      Effect.gen(function* () {
        const store = yield* Store;
        const runOrigin = (...args: ReadonlyArray<string>) =>
          execFileSync("git", [...args], {
            cwd: origin,
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: "origin",
              GIT_AUTHOR_EMAIL: "origin@localhost",
              GIT_COMMITTER_NAME: "origin",
              GIT_COMMITTER_EMAIL: "origin@localhost",
            },
          });

        const adopted = yield* store.adopt("fixture", source, { GIT_TERMINAL_PROMPT: "0" });

        // Origin moves on after adoption: main advances, a feature branch appears.
        fs.writeFileSync(path.join(origin, "app.ts"), "export const answer = 42\n");
        runOrigin("commit", "-am", "advance main");
        const newMainSha = String(runOrigin("rev-parse", "HEAD")).trim();
        runOrigin("checkout", "-b", "feature/x");
        fs.writeFileSync(path.join(origin, "feature.ts"), "export const x = 1\n");
        runOrigin("add", "-A");
        runOrigin("commit", "-m", "feature work");
        const featureSha = String(runOrigin("rev-parse", "HEAD")).trim();
        runOrigin("checkout", "main");

        // A worktree with remoteEnv freshens: it bases on origin's CURRENT main,
        // not the store's adoption-time head.
        const fresh = yield* store.createWorktree(adopted.storePath, wtIdentity(sessionId), null, {
          GIT_TERMINAL_PROMPT: "0",
        });
        expect(fresh.baseRef).toBe("main");
        expect(fresh.baseSha).toBe(newMainSha);
        expect(fresh.baseSha).not.toBe(adopted.headSha);

        // A never-fetched branch resolves too, by name, at origin's tip.
        const onFeature = yield* store.createWorktree(
          adopted.storePath,
          wtIdentity("01TEST2"),
          "feature/x",
          { GIT_TERMINAL_PROMPT: "0" },
        );
        expect(onFeature.baseRef).toBe("feature/x");
        expect(onFeature.baseSha).toBe(featureSha);

        // Null remoteEnv skips the fetch — offline still provisions, on what the store has.
        const offline = yield* store.createWorktree(
          adopted.storePath,
          wtIdentity("01TEST3"),
          null,
          null,
        );
        expect(offline.baseSha).toBe(newMainSha); // already fetched above

        // Refresh pulls every head; the listing reads current, session branches never appear.
        yield* store.refreshFromOrigin(adopted.storePath, { GIT_TERMINAL_PROMPT: "0" });
        const branches = yield* store.listBranches(adopted.storePath);
        const names = branches.map((b) => b.name);
        expect(names).toContain("main");
        expect(names).toContain("feature/x");
        expect(names.some((n) => n.startsWith("mend/session/") || n.startsWith("mend/wt/"))).toBe(
          false,
        );
        expect(branches.find((b) => b.name === "main")?.isDefault).toBe(true);
        expect(branches.find((b) => b.name === "main")?.sha).toBe(newMainSha);
        expect(branches.find((b) => b.name === "feature/x")?.sha).toBe(featureSha);
      }),
    );
  });
});
