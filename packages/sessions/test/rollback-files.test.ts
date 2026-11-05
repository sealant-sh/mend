import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import { WorktreeId } from "@mend/domain";
import { HistoryOperationId } from "@mend/domain/workbench";
import { BlobStore, BlobStoreFsLive } from "@mend/store";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { rollbackFilesExec, saveRollbackRecovery } from "../src/rollback-files.ts";

const exec = promisify(execFile);
const roots: string[] = [];
const fixture = async () => {
  const { stdout } = await exec("mktemp", ["-d", "-t", "mend-rollback-files.XXXXXX"]);
  const root = stdout.trim();
  roots.push(root);
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  const git = (...args: string[]) =>
    exec("git", args, {
      cwd: repo,
      env: {
        PATH: process.env["PATH"],
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fake",
        GIT_AUTHOR_EMAIL: "fake@example.invalid",
        GIT_COMMITTER_NAME: "Fake",
        GIT_COMMITTER_EMAIL: "fake@example.invalid",
      },
    });
  await git("init", "-q");
  await fs.writeFile(path.join(repo, "tracked"), "baseline\n");
  await fs.writeFile(path.join(repo, ".gitignore"), "ignored\n");
  await git("add", ".");
  await git("commit", "-qm", "baseline");
  const target = (await git("rev-parse", "HEAD")).stdout.trim();
  const nativeRoot = path.join(root, "native");
  await fs.mkdir(path.join(nativeRoot, ".codex", "sessions"), { recursive: true });
  await fs.writeFile(
    path.join(nativeRoot, ".codex", "sessions", "conversation.jsonl"),
    "native evidence\n",
  );
  const input = {
    operationId: "operation",
    generation: 1,
    repository: repo,
    journalRoot: path.join(root, "history"),
    nativeRoot,
    nativePaths: [".codex/sessions"],
    target,
  };
  const call = async (action: "save" | "restore" | "inspect" | "restoreSaved") => {
    const [program, ...args] = rollbackFilesExec({ ...input, action });
    if (program === undefined) throw new Error("Missing helper command");
    return exec(program, args, {
      env: {
        PATH: process.env["PATH"],
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      maxBuffer: 16 * 1024 * 1024,
    });
  };
  return { root, repo, git, target, input, call };
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    console.info("Removing task fixture", root, await fs.readdir(root));
    await fs.rm(root, { recursive: true });
  }
});

describe("rollback authoritative Git files", () => {
  it("retains raw files, actual staging, object closure and allowlisted native state without changing HEAD", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo, "tracked"), "staged\n");
    await f.git("add", "tracked");
    await fs.writeFile(path.join(f.repo, "tracked"), "unstaged\n");
    await fs.writeFile(path.join(f.repo, "untracked"), "new words\n");
    await fs.symlink("tracked", path.join(f.repo, "link"));
    await fs.writeFile(path.join(f.repo, "ignored"), "preserve ignored\n");
    const index = await fs.readFile(path.join(f.repo, ".git", "index"));
    const saved = await f.call("save");
    expect(saved.stdout).toContain('"saved"');
    expect(await fs.readFile(path.join(f.repo, ".git", "index"))).toEqual(index);
    expect((await f.git("rev-parse", "HEAD")).stdout.trim()).toBe(f.target);
    const files = JSON.parse(
      await fs.readFile(path.join(f.input.journalRoot, "operation", "files.json"), "utf8"),
    );
    expect(files.find((file: { path: string }) => file.path === "tracked")).toMatchObject({
      bytes: Buffer.from("unstaged\n").toString("base64"),
      mode: "100644",
    });
    expect(files.find((file: { path: string }) => file.path === "link")).toMatchObject({
      bytes: Buffer.from("tracked").toString("base64"),
      mode: "120000",
    });
    expect(files.some((file: { path: string }) => file.path === "ignored")).toBe(false);
    expect(await fs.readFile(path.join(f.input.journalRoot, "operation", "index"))).toEqual(index);
    expect(
      (await fs.stat(path.join(f.input.journalRoot, "operation", "objects.pack"))).size,
    ).toBeGreaterThan(20);
  });

  it("restores managed files as unstaged differences, preserves ignored files and recovers original staging", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo, "tracked"), "staged\n");
    await f.git("add", "tracked");
    await fs.writeFile(path.join(f.repo, "tracked"), "unstaged\n");
    await fs.writeFile(path.join(f.repo, "untracked"), "keep in recovery\n");
    await fs.writeFile(path.join(f.repo, "ignored"), "ignored survives\n");
    const before = await fs.readFile(path.join(f.repo, ".git", "index"));
    await f.call("save");
    await f.call("restore");
    expect(await fs.readFile(path.join(f.repo, "tracked"), "utf8")).toBe("baseline\n");
    expect(await fs.readFile(path.join(f.repo, "ignored"), "utf8")).toBe("ignored survives\n");
    expect((await f.git("diff", "--cached", "--name-only")).stdout).toBe("");
    expect((await f.git("rev-parse", "HEAD")).stdout.trim()).toBe(f.target);
    await f.call("restoreSaved");
    expect(await fs.readFile(path.join(f.repo, "tracked"), "utf8")).toBe("unstaged\n");
    expect(await fs.readFile(path.join(f.repo, "untracked"), "utf8")).toBe("keep in recovery\n");
    expect(await fs.readFile(path.join(f.repo, ".git", "index"))).toEqual(before);
  });
  it("preserves another Git writer's index lock and refuses before any file effect", async () => {
    const f = await fixture();
    const lock = path.join(f.repo, ".git", "index.lock");
    await fs.writeFile(lock, "another writer");
    await expect(f.call("save")).rejects.toThrow();
    expect(await fs.readFile(lock, "utf8")).toBe("another writer");
    expect(await fs.readFile(path.join(f.repo, "tracked"), "utf8")).toBe("baseline\n");
  });

  it("refuses a divergent editor write while retaining the original recovery", async () => {
    const f = await fixture();
    await f.call("save");
    await fs.writeFile(path.join(f.repo, "tracked"), "editor writes after save\n");
    await expect(f.call("restore")).rejects.toThrow();
    expect(await fs.readFile(path.join(f.repo, "tracked"), "utf8")).toBe(
      "editor writes after save\n",
    );
    const saved = await fs.readFile(
      path.join(f.input.journalRoot, "operation", "files.json"),
      "utf8",
    );
    await expect(f.call("save")).resolves.toBeDefined();
    expect(
      await fs.readFile(path.join(f.input.journalRoot, "operation", "files.json"), "utf8"),
    ).toBe(saved);
  });

  it("leaves later commits and branch unchanged and makes the selected tree an unstaged reverse diff", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo, "tracked"), "later committed\n");
    await f.git("commit", "-qam", "later");
    const head = (await f.git("rev-parse", "HEAD")).stdout;
    const branch = (await f.git("symbolic-ref", "HEAD")).stdout;
    await f.call("save");
    await f.call("restore");
    await f.call("restore");
    expect((await f.git("rev-parse", "HEAD")).stdout).toBe(head);
    expect((await f.git("symbolic-ref", "HEAD")).stdout).toBe(branch);
    expect((await f.git("diff", "--cached", "--name-only")).stdout).toBe("");
    expect((await f.git("diff", "--name-only")).stdout.trim()).toBe("tracked");
  });
  it("independently retains and verifies all recovery objects through the public execution boundary", async () => {
    const f = await fixture();
    const { operationId: _operationId, ...input } = f.input;
    const calls: ReadonlyArray<string>[] = [];
    const saved = await Effect.runPromise(
      Effect.gen(function* () {
        const blobs = yield* BlobStore;
        const recovery = yield* saveRollbackRecovery({
          ...input,
          operationId: HistoryOperationId.make("operation"),
          worktreeId: WorktreeId.make("worktree"),
          workspaceId: "fake-workspace",
          launchId: "fake-launch",
          blobs,
          execute: (argv) => {
            calls.push(argv);
            const [program, ...args] = argv;
            return Effect.tryPromise({
              try: async () => {
                if (program === undefined) throw new Error("Missing helper");
                const result = await exec(program, args, {
                  env: {
                    PATH: process.env["PATH"],
                    HOME: f.root,
                    GIT_CONFIG_NOSYSTEM: "1",
                    GIT_CONFIG_GLOBAL: "/dev/null",
                  },
                  maxBuffer: 16 * 1024 * 1024,
                });
                return { ...result, exitCode: 0 };
              },
              catch: () => ({ message: "Fake public exec failed" }),
            });
          },
        });
        for (const object of [
          recovery.index,
          recovery.files,
          recovery.objects,
          recovery.native,
          recovery.journal,
        ]) {
          expect((yield* blobs.get(object.key)).byteLength).toBe(object.byteLength);
        }
        return recovery;
      }).pipe(Effect.provide(BlobStoreFsLive(path.join(f.root, "blobs")))),
    );
    expect(saved.id).toBe("recovery-operation");
    expect(calls).toHaveLength(7);
    expect(calls.map((argv) => argv.slice(3).join(" ")).join(" ")).not.toContain("native evidence");
    expect(calls.map((argv) => argv.slice(3).join(" ")).join(" ")).not.toContain("baseline\n");
  });
});
