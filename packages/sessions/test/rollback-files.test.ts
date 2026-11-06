import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import { WorktreeId } from "@mend/domain";
import { HistoryOperationId } from "@mend/domain/workbench";
import { BlobStore, BlobStoreFsLive } from "@mend/store";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  rollbackFilesExec,
  hydrateRollbackTarget,
  saveRollbackRecovery,
  hydrateRollbackRecovery,
  restoreRollbackFiles,
  retainRollbackFileEvidence,
  type RollbackFileAuthority,
} from "../src/rollback-files.ts";

const exec = promisify(execFile);
import { writeFilesPickupExec } from "../src/workspace-files.ts";
import { startPickupChannel, runExec } from "./pickup-channel.ts";
import { rollbackFileFixture as fixture, cleanupRollbackFiles } from "./support/rollback-files.ts";
afterEach(cleanupRollbackFiles);

describe("rollback authoritative Git files", () => {
  it("delivers a target pack before the first save into a fresh harness-home journal", async () => {
    const f = await fixture();
    await f.git("repack", "-ad");
    const packs = path.join(f.repo, ".git/objects/pack");
    const packed = (await fs.readdir(packs)).find((name) => name.endsWith(".pack"));
    if (packed === undefined) throw new Error("Fixture pack was not created");
    const bytes = await fs.readFile(path.join(packs, packed));
    const sha = createHash("sha256").update(bytes).digest("hex");
    const key = `target/${sha}`;
    const channel = await startPickupChannel();
    const tokenFile = path.join(f.root, "fake-channel-token");
    await fs.writeFile(tokenFile, "pickup-channel-test-token-0123456789");
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const blobs = yield* BlobStore;
          yield* blobs.put(key, bytes);
          const authority: RollbackFileAuthority = {
            ...f.input,
            operationId: HistoryOperationId.make("operation"),
            worktreeId: WorktreeId.make("worktree"),
            workspaceId: "workspace",
            launchId: "launch",
            blobs,
            execute: (argv) =>
              Effect.tryPromise({
                try: async () => {
                  const result = await runExec(argv, { GIT_CONFIG_GLOBAL: "/dev/null" });
                  return { ...result, exitCode: result.status ?? 1 };
                },
                catch: (error) => ({ message: String(error) }),
              }),
            placeRecovery: (files) =>
              Effect.tryPromise({
                try: async () => {
                  const argv = writeFilesPickupExec(
                    files.map((file) => ({
                      path: file.path,
                      absent: true,
                      within: { root: f.input.journalRoot, directoryMode: 0o700, fileMode: 0o600 },
                    })),
                    channel.mint(files),
                  );
                  const result = await runExec(argv, {
                    ...channel.env,
                    MEND_SESSION_TOKEN_FILE: tokenFile,
                  });
                  if (result.status !== 0) throw new Error(result.stderr);
                },
                catch: (error) => ({ message: String(error) }),
              }),
          };
          yield* hydrateRollbackTarget(authority, [key]);
        }).pipe(Effect.provide(BlobStoreFsLive(path.join(f.root, "blobs")))),
      );
      expect(
        await fs.readFile(path.join(f.input.journalRoot, "operation", `target-${sha}.pack`)),
      ).toEqual(bytes);
      expect((await fs.stat(f.input.journalRoot)).mode & 0o777).toBe(0o700);
      expect(await fs.readFile(path.join(f.repo, "tracked"), "utf8")).toBe("baseline\n");
    } finally {
      await channel.close();
    }
  });

  it("keeps the original recovery for the same Undo when public exec redacts its bytes", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo, "tracked"), "work before Undo\n");
    const originalIndex = await fs.readFile(path.join(f.repo, ".git/index"));
    let redactPack = true;
    await Effect.runPromise(
      Effect.gen(function* () {
        const blobs = yield* BlobStore;
        const authority: RollbackFileAuthority = {
          ...f.input,
          operationId: HistoryOperationId.make("operation"),
          worktreeId: WorktreeId.make("worktree"),
          workspaceId: "fake-workspace",
          launchId: "fake-launch",
          blobs,
          execute: (argv) =>
            Effect.tryPromise({
              try: async () => {
                const [command, ...args] = argv;
                if (command === undefined) throw new Error("Missing helper");
                const request = Schema.decodeUnknownSync(
                  Schema.fromJsonString(
                    Schema.Struct({ artifact: Schema.optional(Schema.String) }),
                  ),
                )(argv.at(-1) ?? "{}");
                const result = await exec(command, args, {
                  env: { PATH: process.env["PATH"], HOME: f.root, GIT_CONFIG_GLOBAL: "/dev/null" },
                  maxBuffer: 16 * 1024 * 1024,
                });
                // Core next.794 also redacts token-shaped matches inside opaque base64 packs.
                return {
                  ...result,
                  stdout:
                    redactPack && request.artifact === "objects.pack"
                      ? result.stdout.slice(0, 20) + "***REDACTED***" + result.stdout.slice(40)
                      : result.stdout,
                  exitCode: 0,
                };
              },
              catch: (error) => ({ message: String(error) }),
            }),
        };
        const refusal = yield* saveRollbackRecovery(authority).pipe(Effect.flip);
        expect(refusal.message).toBe(
          "Mend couldn't read the saved recovery intact. Nothing changed. Your earlier state is still saved.",
        );
        expect(yield* Effect.promise(() => fs.readFile(path.join(f.repo, "tracked"), "utf8"))).toBe(
          "work before Undo\n",
        );
        expect(yield* Effect.promise(() => fs.readFile(path.join(f.repo, ".git/index")))).toEqual(
          originalIndex,
        );
        const manifestPath = path.join(f.input.journalRoot, "operation/save.json");
        const originalManifest = yield* Effect.promise(() => fs.readFile(manifestPath));
        const recoveryRef = "refs/mend/history/operation/recovery";
        const savedSha = (yield* Effect.promise(() =>
          f.git("rev-parse", recoveryRef),
        )).stdout.trim();
        expect((yield* Effect.promise(() => f.git("show", `${savedSha}:tracked`))).stdout).toBe(
          "work before Undo\n",
        );
        // A later byte-exact Core read can finish this same operation from its retained save.
        redactPack = false;
        const recovery = yield* saveRollbackRecovery(authority);
        expect(recovery.operationId).toBe("operation");
        expect(recovery.checkpoint.sha).toBe(savedSha);
        expect(yield* Effect.promise(() => fs.readFile(manifestPath))).toEqual(originalManifest);
        expect((yield* blobs.get(recovery.objects.key)).byteLength).toBe(
          recovery.objects.byteLength,
        );
      }).pipe(Effect.provide(BlobStoreFsLive(path.join(f.root, "blobs")))),
    );
  });

  it("saves and restores through the platform's repository alias", async () => {
    const f = await fixture();
    const repository = path.join(f.root, "workspace-repo");
    await fs.symlink(f.repo, repository);
    await fs.writeFile(path.join(f.repo, "tracked"), "later work\n");
    const index = await fs.readFile(path.join(f.repo, ".git", "index"));
    const call = async (action: "save" | "restore" | "restoreSaved") => {
      const [program, ...args] = rollbackFilesExec({ ...f.input, repository, action });
      if (program === undefined) throw new Error("Missing helper command");
      return exec(program, args, {
        env: { PATH: process.env["PATH"], HOME: f.root, GIT_CONFIG_GLOBAL: "/dev/null" },
      });
    };
    await call("save");
    await call("restore");
    expect(await fs.readFile(path.join(f.repo, "tracked"), "utf8")).toBe("baseline\n");
    expect((await f.git("rev-parse", "HEAD")).stdout.trim()).toBe(f.target);
    expect(await fs.readlink(repository)).toBe(f.repo);
    await call("restoreSaved");
    expect(await fs.readFile(path.join(f.repo, "tracked"), "utf8")).toBe("later work\n");
    expect(await fs.readFile(path.join(f.repo, ".git", "index"))).toEqual(index);
  });

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
    const manifest = JSON.parse(saved.stdout).manifest;
    expect(manifest.checkpoint).toMatchObject({ ref: "refs/mend/history/operation/recovery" });
    expect((await f.git("show", `${manifest.checkpoint.sha}:untracked`)).stdout).toBe(
      "new words\n",
    );
    expect((await f.git("rev-parse", manifest.checkpoint.ref)).stdout.trim()).toBe(
      manifest.checkpoint.sha,
    );
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

  it("archives only the selected conversation files from a person's shared saved directory", async () => {
    const f = await fixture();
    await fs.writeFile(
      path.join(f.input.nativeRoot, ".codex/sessions/other-person.jsonl"),
      "other session words",
    );
    const [program, ...args] = rollbackFilesExec({
      ...f.input,
      action: "save",
      nativePaths: [".codex/sessions/conversation.jsonl"],
    });
    if (program === undefined) throw new Error("Missing helper");
    await exec(program, args, {
      env: { PATH: process.env["PATH"], HOME: f.root, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    const native = JSON.parse(
      await fs.readFile(path.join(f.input.journalRoot, "operation", "native.json"), "utf8"),
    );
    expect(native).toEqual([
      {
        path: ".codex/sessions/conversation.jsonl",
        mode: "100644",
        bytes: Buffer.from("native evidence\n").toString("base64"),
      },
    ]);
  });

  it("saves only the verified ancestor prefix and refuses changed native bytes", async () => {
    const f = await fixture();
    const relativePath = ".codex/sessions/conversation.jsonl";
    const prefix = "native evidence\n";
    const file = path.join(f.input.nativeRoot, relativePath);
    await fs.writeFile(file, prefix + "later ancestor words\n");
    const nativeRefs = [
      {
        relativePath,
        byteLength: Buffer.byteLength(prefix),
        sha256: createHash("sha256").update(prefix).digest("hex"),
      },
    ];
    const call = async (operationId: string) => {
      const [program, ...args] = rollbackFilesExec({
        ...f.input,
        action: "save",
        operationId,
        nativePaths: [relativePath],
        nativeRefs,
      });
      if (program === undefined) throw new Error("Missing helper");
      return exec(program, args, {
        env: { PATH: process.env["PATH"], HOME: f.root, GIT_CONFIG_GLOBAL: "/dev/null" },
      });
    };
    await call("operation");
    const native = JSON.parse(
      await fs.readFile(path.join(f.input.journalRoot, "operation/native.json"), "utf8"),
    );
    expect(native).toEqual([
      { path: relativePath, mode: "100644", bytes: Buffer.from(prefix).toString("base64") },
    ]);
    expect(await fs.readFile(file, "utf8")).toBe(prefix + "later ancestor words\n");
    await fs.writeFile(file, "changed evidence\n");
    await expect(call("changed-operation")).rejects.toThrow(/Native history changed/);
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
  it("restores file and directory transitions and recovers both original shapes", async () => {
    const f = await fixture();
    await fs.unlink(path.join(f.repo, "tracked"));
    await fs.mkdir(path.join(f.repo, "tracked"));
    await fs.writeFile(path.join(f.repo, "tracked", "child"), "directory work\n");
    await f.call("save");
    await f.call("restore");
    expect(await fs.readFile(path.join(f.repo, "tracked"), "utf8")).toBe("baseline\n");
    await f.call("restoreSaved");
    expect(await fs.readFile(path.join(f.repo, "tracked", "child"), "utf8")).toBe(
      "directory work\n",
    );
    expect((await f.git("rev-parse", "HEAD")).stdout.trim()).toBe(f.target);
  });

  it("applies the journal when recovery storage is on another filesystem", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo, "tracked"), "save across devices\n");
    await f.call("save");
    const [command, flag, source, payload] = rollbackFilesExec({ ...f.input, action: "restore" });
    if (
      command === undefined ||
      flag === undefined ||
      source === undefined ||
      payload === undefined
    )
      throw new Error("Missing helper");
    const differentDevice = `const boundaryFs=require("node:fs"), boundaryRename=boundaryFs.renameSync, boundaryLink=boundaryFs.linkSync;
      boundaryFs.renameSync=(from,to)=>{if(String(from).startsWith(${JSON.stringify(f.repo)})&&String(to).includes("restore-originals"))throw Object.assign(new Error("cross-device rename"),{code:"EXDEV"});return boundaryRename(from,to);};
      boundaryFs.linkSync=(from,to)=>{if(String(from).includes("staged-")&&!String(to).includes("history"))throw Object.assign(new Error("cross-device link"),{code:"EXDEV"});return boundaryLink(from,to);};\n`;
    await exec(command, [flag, differentDevice + source, payload], {
      env: { PATH: process.env["PATH"], HOME: f.root, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    expect(await fs.readFile(path.join(f.repo, "tracked"), "utf8")).toBe("baseline\n");
    await f.call("restoreSaved");
    expect(await fs.readFile(path.join(f.repo, "tracked"), "utf8")).toBe("save across devices\n");
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
  it("finishes the retained journal after an exited helper without replacing the original save", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo, "tracked"), "recover these words\n");
    await f.call("save");
    const manifestPath = path.join(f.input.journalRoot, "operation", "save.json");
    const originalSave = await fs.readFile(manifestPath);
    const [program, flag, source, payload] = rollbackFilesExec({ ...f.input, action: "restore" });
    if (
      program === undefined ||
      flag === undefined ||
      source === undefined ||
      payload === undefined
    )
      throw new Error("Missing helper");
    const injectExit = `const injectedFs = require("node:fs"); const injectedRename = injectedFs.renameSync; injectedFs.renameSync = (from,to) => { injectedRename(from,to); if (String(to).endsWith("/restore.json") && JSON.parse(injectedFs.readFileSync(to,"utf8")).entries.some(e=>e.state==="oldMoved")) process.exit(99); };\n`;
    await expect(
      exec(program, [flag, injectExit + source, payload], {
        env: { PATH: process.env["PATH"], HOME: f.root, GIT_CONFIG_GLOBAL: "/dev/null" },
      }),
    ).rejects.toMatchObject({ code: 99 });
    await expect(f.call("restore")).rejects.toThrow();
    const restart = rollbackFilesExec({
      ...f.input,
      generation: 2,
      previousExecutionExited: true,
      action: "restore",
    });
    const [nextProgram, ...args] = restart;
    if (nextProgram === undefined) throw new Error("Missing helper");
    await exec(nextProgram, args, {
      env: { PATH: process.env["PATH"], HOME: f.root, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    expect(await fs.readFile(path.join(f.repo, "tracked"), "utf8")).toBe("baseline\n");
    expect(await fs.readFile(manifestPath)).toEqual(originalSave);
    expect((await f.git("rev-parse", "HEAD")).stdout.trim()).toBe(f.target);
  });

  it("reconstructs the original raw files and staging from retained storage after journal loss", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repo, "tracked"), "staged recovery\n");
    await f.git("add", "tracked");
    await fs.writeFile(path.join(f.repo, "tracked"), "unstaged recovery\n");
    const originalIndex = await fs.readFile(path.join(f.repo, ".git/index"));
    await Effect.runPromise(
      Effect.gen(function* () {
        const blobs = yield* BlobStore;
        const authority: RollbackFileAuthority = {
          ...f.input,
          operationId: HistoryOperationId.make("operation"),
          worktreeId: WorktreeId.make("worktree"),
          workspaceId: "fake-workspace",
          launchId: "fake-launch",
          blobs,
          execute: (argv) =>
            Effect.tryPromise({
              try: async () => {
                const [command, ...args] = argv;
                if (command === undefined) throw new Error("Missing helper");
                return {
                  ...(await exec(command, args, {
                    env: {
                      PATH: process.env["PATH"],
                      HOME: f.root,
                      GIT_CONFIG_GLOBAL: "/dev/null",
                    },
                    maxBuffer: 16 * 1024 * 1024,
                  })),
                  exitCode: 0,
                };
              },
              catch: (error) => ({ message: String(error) }),
            }),
          placeRecovery: (files) =>
            Effect.tryPromise({
              try: async () => {
                for (const file of files) {
                  await fs.mkdir(path.dirname(file.path), { recursive: true });
                  await fs.writeFile(file.path, file.bytes, { flag: "wx" });
                }
              },
              catch: (error) => ({ message: String(error) }),
            }),
        };
        const saved = yield* saveRollbackRecovery(authority);
        console.info(
          "Removing task-owned lost journal",
          f.input.journalRoot,
          yield* Effect.promise(() => fs.readdir(f.input.journalRoot)),
        );
        yield* Effect.promise(() => fs.rm(f.input.journalRoot, { recursive: true }));
        const replacement = { ...authority, generation: 2, workspaceId: "replacement-workspace" };
        yield* hydrateRollbackRecovery(replacement, saved);
        yield* hydrateRollbackRecovery(replacement, saved);
        yield* restoreRollbackFiles(replacement);
        expect(yield* Effect.promise(() => fs.readFile(path.join(f.repo, "tracked"), "utf8"))).toBe(
          "baseline\n",
        );
        const evidence = yield* retainRollbackFileEvidence(replacement);
        const retained = JSON.parse(Buffer.from(yield* blobs.get(evidence.key)).toString("utf8"));
        expect(retained).toMatchObject({
          operationId: "operation",
          generation: 2,
          journal: { complete: true, indexInstalled: true },
          head: { oid: f.target },
        });
        expect(retained.native[0].bytes).toBe(Buffer.from("native evidence\n").toString("base64"));
        yield* restoreRollbackFiles(replacement, "restoreSaved");
        expect(yield* Effect.promise(() => fs.readFile(path.join(f.repo, "tracked"), "utf8"))).toBe(
          "unstaged recovery\n",
        );
        expect(yield* Effect.promise(() => fs.readFile(path.join(f.repo, ".git/index")))).toEqual(
          originalIndex,
        );
      }).pipe(Effect.provide(BlobStoreFsLive(path.join(f.root, "blobs")))),
    );
  });

  it("hydrates an exact retained target pack before saving without changing files or staging", async () => {
    const f = await fixture();
    const source = path.join(f.root, "source");
    await f.git("clone", "-q", f.repo, source);
    await fs.writeFile(path.join(source, "tracked"), "retained target words\n");
    await f.git("-C", source, "add", "tracked");
    await f.git("-C", source, "commit", "-qm", "foreign target");
    const target = (await f.git("-C", source, "rev-parse", "HEAD")).stdout.trim();
    await f.git("-C", source, "repack", "-ad");
    const packDirectory = path.join(source, ".git/objects/pack");
    const packName = (await fs.readdir(packDirectory)).find((name) => name.endsWith(".pack"));
    if (packName === undefined) throw new Error("Missing fixture pack");
    const pack = await fs.readFile(path.join(packDirectory, packName));
    const index = await fs.readFile(path.join(f.repo, ".git/index"));
    await expect(f.git("cat-file", "-e", target)).rejects.toThrow();
    await Effect.runPromise(
      Effect.gen(function* () {
        const blobs = yield* BlobStore;
        const key = `target/${createHash("sha256").update(pack).digest("hex")}`;
        yield* blobs.put(key, pack);
        yield* hydrateRollbackTarget(
          {
            ...f.input,
            operationId: HistoryOperationId.make("operation"),
            worktreeId: WorktreeId.make("worktree"),
            workspaceId: "fake",
            launchId: "fake",
            blobs,
            placeRecovery: (files) =>
              Effect.tryPromise({
                try: async () => {
                  for (const file of files) {
                    await fs.mkdir(path.dirname(file.path), { recursive: true });
                    await fs.writeFile(file.path, file.bytes, { flag: "wx" });
                  }
                },
                catch: (error) => ({ message: String(error) }),
              }),
            execute: (argv) =>
              Effect.tryPromise({
                try: async () => {
                  const [command, ...args] = argv;
                  if (command === undefined) throw new Error("Missing helper");
                  return {
                    ...(await exec(command, args, {
                      env: { PATH: process.env["PATH"], GIT_CONFIG_GLOBAL: "/dev/null" },
                    })),
                    exitCode: 0,
                  };
                },
                catch: (error) => ({ message: String(error) }),
              }),
          },
          [key],
        );
      }).pipe(Effect.provide(BlobStoreFsLive(path.join(f.root, "blobs")))),
    );
    expect((await f.git("show", `${target}:tracked`)).stdout).toBe("retained target words\n");
    expect(await fs.readFile(path.join(f.repo, "tracked"), "utf8")).toBe("baseline\n");
    expect(await fs.readFile(path.join(f.repo, ".git/index"))).toEqual(index);
    expect((await f.git("rev-parse", "HEAD")).stdout.trim()).toBe(f.target);
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
