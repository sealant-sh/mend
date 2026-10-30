import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";

import { Store, StoreConfig } from "../src/store.ts";

const firstCommit = {
  readme: "# notes-2\n",
  author: { name: "Anna Example", email: "anna@example.com" },
  at: new Date("2026-10-25T12:00:00Z"),
};
const withStore = async (
  run: (store: Store["Service"], root: string) => Effect.Effect<void, unknown>,
) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-new-repository-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* run(yield* Store, root);
      }).pipe(
        Effect.provide(Store.layer.pipe(Layer.provide(Layer.succeed(StoreConfig, { root })))),
      ),
    );
  } finally {
    fs.readdirSync(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
};
const git = (cwd: string, ...args: string[]) =>
  Effect.promise(async () =>
    (await promisify(execFile)("git", args, { cwd, encoding: "utf8" })).stdout.trim(),
  );

describe("Store.createRepository", () => {
  it("ignores the host's global hooks while it initializes the repository", async () =>
    withStore((store, root) =>
      Effect.gen(function* () {
        const hooks = path.join(root, "hooks");
        fs.mkdirSync(hooks);
        fs.writeFileSync(path.join(hooks, "reference-transaction"), "#!/bin/sh\nexit 1\n", {
          mode: 0o755,
        });
        const config = path.join(root, "reject-ref.gitconfig");
        fs.writeFileSync(config, `[core]\n hooksPath = ${hooks}\n`);
        const previous = process.env["GIT_CONFIG_GLOBAL"];
        process.env["GIT_CONFIG_GLOBAL"] = config;
        try {
          const repo = yield* store.createRepository("hooked-host", firstCommit);
          expect(yield* git(repo.storePath, "rev-parse", "main")).toBe(repo.headSha);
        } finally {
          if (previous === undefined) delete process.env["GIT_CONFIG_GLOBAL"];
          else process.env["GIT_CONFIG_GLOBAL"] = previous;
        }
      }),
    ));
  it("creates a private-ready bare SHA-1 repository with the person's root README commit on main and no origin", async () =>
    withStore((store, root) =>
      Effect.gen(function* () {
        const config = path.join(root, "host.gitconfig");
        fs.writeFileSync(
          config,
          "[init]\n defaultBranch = trunk\n defaultObjectFormat = sha256\n[user]\n name = Host\n email = host@example.com\n[commit]\n gpgSign = true\n",
        );
        const previous = process.env["GIT_CONFIG_GLOBAL"];
        process.env["GIT_CONFIG_GLOBAL"] = config;
        try {
          const repo = yield* store.createRepository("project-id", firstCommit);
          expect(repo.defaultBranch).toBe("main");
          expect(yield* git(repo.storePath, "rev-parse", "HEAD")).toBe(repo.headSha);
          expect(yield* git(repo.storePath, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
          expect(yield* git(repo.storePath, "rev-parse", "--is-bare-repository")).toBe("true");
          expect(yield* git(repo.storePath, "rev-parse", "--show-object-format")).toBe("sha1");
          expect(yield* git(repo.storePath, "remote")).toBe("");
          expect(yield* git(repo.storePath, "log", "--all", "--format=%an|%ae|%cn|%ce|%s|%P")).toBe(
            "Anna Example|anna@example.com|Anna Example|anna@example.com|Initial commit|",
          );
          expect(yield* git(repo.storePath, "ls-tree", "--name-only", "HEAD")).toBe("README.md");
          expect(yield* git(repo.storePath, "show", "HEAD:README.md")).toBe("# notes-2");
          expect(yield* git(repo.storePath, "config", "core.sharedRepository")).toBe("group");
          const branches = yield* store.listBranches(repo.storePath);
          expect(branches.map((b) => b.name)).toEqual(["main"]);
          const wt = yield* store.createWorktree(
            repo.storePath,
            { directory: "one", branch: "mend/one" },
            null,
            null,
          );
          expect(yield* git(wt.path, "rev-parse", "HEAD")).toBe(repo.headSha);
          expect(fs.readFileSync(path.join(wt.path, "README.md"), "utf8")).toBe(firstCommit.readme);
        } finally {
          if (previous === undefined) delete process.env["GIT_CONFIG_GLOBAL"];
          else process.env["GIT_CONFIG_GLOBAL"] = previous;
        }
      }),
    ));
  it("never removes a preexisting directory or returns a repository after commit failure", async () =>
    withStore((store, root) =>
      Effect.gen(function* () {
        fs.mkdirSync(path.join(root, "occupied"));
        fs.writeFileSync(path.join(root, "occupied", "canary"), "keep");
        expect(
          Result.isFailure(
            yield* store.createRepository("occupied", firstCommit).pipe(Effect.result),
          ),
        ).toBe(true);
        expect(fs.readFileSync(path.join(root, "occupied", "canary"), "utf8")).toBe("keep");
        expect(
          Result.isFailure(
            yield* store
              .createRepository("failed", { ...firstCommit, at: new Date("invalid") })
              .pipe(Effect.result),
          ),
        ).toBe(true);
        expect(fs.existsSync(path.join(root, "failed"))).toBe(false);
      }),
    ));
});
