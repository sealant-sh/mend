import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { promisify } from "node:util";

import { WorktreeId } from "@mend/domain";
import { HistoryOperationId } from "@mend/domain/workbench";
import { BlobStore, BlobStoreFsLive } from "@mend/store";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { makePickupTickets, pickupAnswerOf } from "../src/pickup-tickets.ts";
import {
  hydrateRollbackTarget,
  hydrateRollbackRecovery,
  saveRollbackRecovery,
  restoreRollbackFiles,
  verifyRollbackUnchanged,
  retainRollbackFileEvidence,
  type RollbackFileAuthority,
} from "../src/rollback-files.ts";
import { writeFilesPickupExec } from "../src/workspace-files.ts";
import { BINDING } from "./pickup-channel.ts";
import { cleanupRollbackFiles, rollbackFileFixture } from "./support/rollback-files.ts";

const exec = promisify(execFile);
afterEach(cleanupRollbackFiles);

// Opt-in kernel/mount proof. Requires Node and Git >=2.43 in a local image, no downloads or logins.
// MEND_TEST_ROLLBACK_IMAGE can select an already-built workspace image.
describe.runIf(process.env["MEND_TEST_ROLLBACK_MOUNT"] === "1")(
  "the captured per-person mount",
  () => {
    it.each([
      { restoreFiles: true, indexUid: 0, splitIndex: false },
      { restoreFiles: true, indexUid: 40012, splitIndex: false },
      { restoreFiles: false, indexUid: 40012, splitIndex: false },
      { restoreFiles: true, indexUid: 0, splitIndex: true },
    ])(
      "mixed-UID Undo, restore files $restoreFiles, index owner $indexUid, split index $splitIndex",
      async ({ restoreFiles, indexUid, splitIndex }) => {
        const f = await rollbackFileFixture();
        await fs.writeFile(path.join(f.repo, "personal"), "personal baseline\n");
        await fs.writeFile(path.join(f.repo, "script"), "#!/bin/sh\necho baseline\n");
        await fs.chmod(path.join(f.repo, "script"), 0o755);
        await fs.mkdir(path.join(f.repo, "returned"));
        await fs.writeFile(path.join(f.repo, "returned/nested"), "deleted baseline\n");
        await fs.mkdir(path.join(f.repo, "turned"));
        await fs.writeFile(path.join(f.repo, "turned/child"), "directory baseline\n");
        await fs.symlink("tracked", path.join(f.repo, "link"));
        await f.git("add", ".");
        await f.git("commit", "-qm", "metadata fixture");
        const target = (await f.git("rev-parse", "HEAD")).stdout.trim();
        await f.git("repack", "-ad");
        const packRoot = path.join(f.repo, ".git/objects/pack");
        const name = (await fs.readdir(packRoot)).find((value) => value.endsWith(".pack"));
        if (name === undefined) throw new Error("Fixture pack was not created");
        const bytes = await fs.readFile(path.join(packRoot, name));
        const sha = createHash("sha256").update(bytes).digest("hex");
        const key = `target/${sha}`;
        await fs.writeFile(path.join(f.repo, "tracked"), "work before Undo\n");
        await f.git("add", "tracked");
        if (splitIndex) await f.git("update-index", "--split-index");
        const originalIndex = await fs.readFile(path.join(f.repo, ".git/index"));
        await fs.writeFile(path.join(f.repo, "tracked"), "unstaged work before Undo\n");
        await fs.writeFile(path.join(f.repo, "personal"), "personal later\n");
        await fs.writeFile(path.join(f.repo, "script"), "#!/bin/sh\necho later\n");
        await fs.rm(path.join(f.repo, "returned"), { recursive: true });
        await fs.rm(path.join(f.repo, "turned"), { recursive: true });
        await fs.writeFile(path.join(f.repo, "turned"), "later plain file\n");
        await fs.unlink(path.join(f.repo, "link"));
        await fs.symlink("personal", path.join(f.repo, "link"));
        const socketRoot = path.join(f.root, "socket");
        const harnessRoot = path.join(f.root, "harness-home");
        await fs.mkdir(socketRoot);
        await fs.mkdir(harnessRoot);
        const tickets = makePickupTickets();
        const server = http.createServer((request, response) => {
          let input = "";
          request.on("data", (chunk: Buffer) => {
            input += chunk.toString("utf8");
          });
          request.on("end", () => {
            const { ticket } = Schema.decodeUnknownSync(
              Schema.fromJsonString(Schema.Struct({ ticket: Schema.String })),
            )(input);
            const taken = tickets.take(ticket);
            response.writeHead(taken.kind === "taken" ? 200 : 403, {
              "content-type": "application/json",
            });
            response.end(
              JSON.stringify(
                taken.kind === "taken"
                  ? pickupAnswerOf(taken.entry.files)
                  : { message: "Unknown test pickup" },
              ),
            );
          });
        });
        await new Promise<void>((resolve) =>
          server.listen(path.join(socketRoot, "mend.sock"), resolve),
        );
        const container = `mend-rollback-layout-${randomUUID()}`;
        const docker = (...args: string[]) =>
          exec("docker", args, {
            env: { PATH: process.env["PATH"], HOME: f.root },
            maxBuffer: 16 * 1024 * 1024,
            timeout: 15_000,
          });
        let created = false;
        try {
          await docker(
            "run",
            "--pull=never",
            "--network=none",
            "--user=0",
            "--entrypoint=sleep",
            "-d",
            "--name",
            container,
            "--label",
            "mend.test=rollback-mount",
            "--mount",
            `type=bind,src=${harnessRoot},dst=/workspace/harness-home`,
            "--mount",
            `type=bind,src=${f.repo},dst=/workspace/repo`,
            "--mount",
            `type=bind,src=${socketRoot},dst=/run/mend`,
            "-e",
            "HOME=/tmp/fake-root",
            process.env["MEND_TEST_ROLLBACK_IMAGE"] ?? "node:26-trixie",
            "infinity",
          );
          created = true;
          await docker(
            "exec",
            container,
            "sh",
            "-c",
            "mkdir -p /workspace/harness-home/people/asker /tmp/fake-root; " +
              "chown 0:0 /workspace/harness-home; chmod 0755 /workspace/harness-home; " +
              "chmod 0711 /workspace/harness-home/people; chown 40012:40000 /workspace/harness-home/people/asker; " +
              "chmod 0710 /workspace/harness-home/people/asker; " +
              "chown -R 40012:40000 /workspace/repo; " +
              "find /workspace/repo -type d -exec chmod 2775 {} +; " +
              "find /workspace/repo -type f -exec chmod g+rw {} +; " +
              `chown ${indexUid}:40000 /workspace/repo/.git/index; chmod 0664 /workspace/repo/.git/index; ` +
              "chown 0:40000 /workspace/repo/tracked; chmod 0664 /workspace/repo/tracked; " +
              "chmod 0640 /workspace/repo/personal; " +
              "chmod 0640 /workspace/repo/turned; " +
              "chmod 0775 /workspace/repo/script; " +
              "git -C /workspace/repo config core.sharedRepository group; " +
              "git config --system --replace-all safe.directory /workspace/repo",
          );
          const metadata = async (relative: string) =>
            (
              await docker(
                "exec",
                container,
                "stat",
                "-c",
                "%u:%g:%a",
                `/workspace/repo/${relative}`,
              )
            ).stdout.trim();
          const beforeMetadata = await Promise.all(
            [".git/index", "tracked", "personal", "script", "link"].map(metadata),
          );
          const gitMetadata = async () => {
            const result = await docker(
              "exec",
              container,
              "node",
              "-e",
              `
              const fs=require('node:fs'),path=require('node:path'),entries=[];
              const walk=p=>{const s=fs.lstatSync(p);entries.push({path:path.relative('/workspace/repo',p),uid:s.uid,gid:s.gid,mode:s.mode&0o7777,directory:s.isDirectory()});if(s.isDirectory())for(const n of fs.readdirSync(p).sort())walk(path.join(p,n));};
              walk('/workspace/repo/.git');console.log(JSON.stringify(entries));
            `,
            );
            return Schema.decodeUnknownSync(
              Schema.fromJsonString(
                Schema.Array(
                  Schema.Struct({
                    path: Schema.String,
                    uid: Schema.Int,
                    gid: Schema.Int,
                    mode: Schema.Int,
                    directory: Schema.Boolean,
                  }),
                ),
              ),
            )(result.stdout);
          };
          const beforeGit = await gitMetadata();
          const personGit = (...args: string[]) =>
            docker(
              "exec",
              "--user",
              "40012:40000",
              "-w",
              "/workspace/repo",
              container,
              "git",
              "--no-optional-locks",
              ...args,
            );
          await personGit("status", "--porcelain=v1");
          expect((await docker("exec", container, "id", "-u")).stdout.trim()).toBe("0");
          expect(
            (
              await docker("exec", container, "stat", "-c", "%u:%g", "/workspace/repo")
            ).stdout.trim(),
          ).toBe("40012:40000");
          expect(
            (
              await docker(
                "exec",
                container,
                "git",
                "config",
                "--system",
                "--get-all",
                "safe.directory",
              )
            ).stdout.trim(),
          ).toBe("/workspace/repo");
          // The ordinary root exec works using the platform's system config, never a person's home.
          expect(
            (
              await docker(
                "exec",
                "-w",
                "/workspace/repo",
                container,
                "git",
                "rev-parse",
                "--git-path",
                "index",
              )
            ).stdout.trim(),
          ).toBe(".git/index");
          await Effect.runPromise(
            Effect.gen(function* () {
              const blobs = yield* BlobStore;
              yield* blobs.put(key, bytes);
              const authority: RollbackFileAuthority = {
                operationId: HistoryOperationId.make("operation"),
                worktreeId: WorktreeId.make("worktree"),
                workspaceId: "fake-workspace",
                launchId: "fake-launch",
                generation: 1,
                repository: "/workspace/repo",
                journalRoot: "/workspace/harness-home/history",
                nativeRoot: "/workspace/harness-home/people/asker",
                nativePaths: [],
                target,
                blobs,
                execute: (argv) =>
                  Effect.tryPromise({
                    try: async () => ({
                      ...(await docker(
                        "exec",
                        container,
                        "sh",
                        "-c",
                        'umask 077; exec "$@"',
                        "rollback-test",
                        ...argv,
                      )),
                      exitCode: 0,
                    }),
                    catch: (error) => ({ message: String(error) }),
                  }),
                placeRecovery: (files) =>
                  Effect.tryPromise({
                    try: async () => {
                      const argv = writeFilesPickupExec(
                        files.map((file) => ({
                          path: file.path,
                          absent: true,
                          within: {
                            root: "/workspace/harness-home/history",
                            directoryMode: 0o700,
                            fileMode: 0o600,
                          },
                        })),
                        tickets.mint(BINDING, files),
                      );
                      await docker("exec", container, ...argv);
                    },
                    catch: (error) => ({ message: String(error) }),
                  }),
              };
              const recovery = yield* saveRollbackRecovery(authority);
              // Metadata must survive the same retained-blob recovery path as the original bytes.
              yield* Effect.promise(() =>
                docker("exec", container, "rm", "-rf", "/workspace/harness-home/history/operation"),
              );
              yield* hydrateRollbackTarget(authority, [key]);
              if (splitIndex)
                yield* Effect.promise(async () => {
                  for (const entry of beforeGit.filter((e) => /\/sharedindex\./.test(e.path)))
                    await docker("exec", container, "rm", `/workspace/repo/${entry.path}`);
                });
              yield* hydrateRollbackRecovery(authority, recovery);
              if (restoreFiles) yield* restoreRollbackFiles(authority);
              else yield* verifyRollbackUnchanged(authority, recovery);
              const evidence = yield* retainRollbackFileEvidence(authority);
              expect(evidence.byteLength).toBeGreaterThan(0);
              const observed = yield* Effect.promise(() =>
                docker("exec", container, "cat", "/workspace/repo/tracked"),
              );
              expect(observed.stdout).toBe(
                restoreFiles ? "baseline\n" : "unstaged work before Undo\n",
              );
              // A person's next shell/agent must still be able to use Git, without repairing it.
              yield* Effect.promise(() => personGit("status", "--porcelain=v1"));
              yield* Effect.promise(() => personGit("diff", "--cached", "--numstat"));
              expect(
                yield* Effect.promise(() =>
                  Promise.all(
                    [".git/index", "tracked", "personal", "script", "link"].map(metadata),
                  ),
                ),
              ).toEqual(beforeMetadata);
              if (restoreFiles) {
                expect(yield* Effect.promise(() => metadata("returned"))).toBe("0:40000:2775");
                expect(yield* Effect.promise(() => metadata("returned/nested"))).toBe(
                  "0:40000:664",
                );
                expect(yield* Effect.promise(() => metadata("turned"))).toBe("40012:40000:2775");
                const child = yield* Effect.promise(() =>
                  docker(
                    "exec",
                    "--user",
                    "40012:40000",
                    container,
                    "cat",
                    "/workspace/repo/turned/child",
                  ),
                );
                expect(child.stdout).toBe("directory baseline\n");
              } else {
                const index = yield* Effect.promise(() =>
                  fs.readFile(path.join(f.repo, ".git/index")),
                );
                expect(index).toEqual(originalIndex);
              }
              const unreadable = yield* Effect.promise(() =>
                docker(
                  "exec",
                  "--user",
                  "40012:40000",
                  container,
                  "find",
                  "/workspace/repo/.git",
                  "-not",
                  "-readable",
                  "-print",
                ),
              );
              expect(unreadable.stdout).toBe("");
              const afterGit = yield* Effect.promise(gitMetadata);
              for (const entry of beforeGit)
                expect(afterGit.find((e) => e.path === entry.path)).toEqual(entry);
              for (const entry of afterGit.filter(
                (e) => !beforeGit.some((before) => before.path === e.path),
              )) {
                expect(entry.gid).toBe(40000);
                expect(entry.mode & (entry.directory ? 0o070 : 0o040)).toBe(
                  entry.directory ? 0o070 : 0o040,
                );
              }
              if (restoreFiles) yield* restoreRollbackFiles(authority);
              yield* restoreRollbackFiles(authority, "restoreSaved");
              yield* verifyRollbackUnchanged(authority, recovery);
              expect(yield* Effect.promise(() => metadata("turned"))).toBe("40012:40000:640");
              yield* Effect.promise(() => personGit("status", "--porcelain=v1"));
              expect(
                yield* Effect.promise(() =>
                  Promise.all(
                    [".git/index", "tracked", "personal", "script", "link"].map(metadata),
                  ),
                ),
              ).toEqual(beforeMetadata);
            }).pipe(Effect.provide(BlobStoreFsLive(path.join(f.root, "blobs")))),
          );
          expect(await fs.readFile(path.join(f.repo, "tracked"), "utf8")).toBe(
            "unstaged work before Undo\n",
          );
          const index = await docker("exec", container, "sha256sum", "/workspace/repo/.git/index");
          expect(index.stdout.split(" ")[0]).toBe(
            createHash("sha256").update(originalIndex).digest("hex"),
          );
          expect(
            (
              await docker(
                "exec",
                container,
                "sh",
                "-c",
                "test ! -e /tmp/fake-root/.gitconfig && test ! -e /workspace/harness-home/people/asker/.gitconfig",
              )
            ).stderr,
          ).toBe("");
          const observation = await docker(
            "exec",
            container,
            "node",
            "-e",
            "const fs=require('node:fs'),crypto=require('node:crypto'); console.log(crypto.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))",
            `/workspace/harness-home/history/operation/target-${sha}.pack`,
          );
          expect(observation.stdout.trim()).toBe(sha);
          const owner = await docker(
            "exec",
            container,
            "stat",
            "-c",
            "%u:%g:%a",
            "/workspace/harness-home/people/asker",
          );
          expect(owner.stdout.trim()).toBe("40012:40000:710");
        } finally {
          if (created) {
            // Restore only this fixture mount so its non-root test owner can remove it.
            await docker(
              "exec",
              container,
              "find",
              "/workspace/repo",
              "-type",
              "d",
              "-exec",
              "chmod",
              "u+rwx",
              "{}",
              "+",
            );
            await docker(
              "exec",
              container,
              "chown",
              "-R",
              `${process.getuid?.()}:${process.getgid?.()}`,
              "/workspace/harness-home",
              "/workspace/repo",
            );
            await docker("rm", "-f", container);
          }
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
      30_000,
    );
  },
);
