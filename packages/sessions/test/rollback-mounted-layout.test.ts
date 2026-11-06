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

// Opt-in kernel/mount proof. Requires the declared image locally, no downloads or real logins.
describe.runIf(process.env["MEND_TEST_ROLLBACK_MOUNT"] === "1")(
  "the captured per-person mount",
  () => {
    it.each([true, false])(
      "mixed-UID Undo, restore files %s",
      async (restoreFiles) => {
        const f = await rollbackFileFixture();
        await f.git("repack", "-ad");
        const packRoot = path.join(f.repo, ".git/objects/pack");
        const name = (await fs.readdir(packRoot)).find((value) => value.endsWith(".pack"));
        if (name === undefined) throw new Error("Fixture pack was not created");
        const bytes = await fs.readFile(path.join(packRoot, name));
        const sha = createHash("sha256").update(bytes).digest("hex");
        const key = `target/${sha}`;
        await fs.writeFile(path.join(f.repo, "tracked"), "work before Undo\n");
        await f.git("add", "tracked");
        const originalIndex = await fs.readFile(path.join(f.repo, ".git/index"));
        await fs.writeFile(path.join(f.repo, "tracked"), "unstaged work before Undo\n");
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
            "node:26-bookworm",
            "sleep",
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
              "git config --system --add safe.directory /workspace/repo",
          );
          expect((await docker("exec", container, "id", "-u")).stdout.trim()).toBe("0");
          expect(
            (
              await docker("exec", container, "stat", "-c", "%u:%g", "/workspace/repo")
            ).stdout.trim(),
          ).toBe("40012:40000");
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
                target: f.target,
                blobs,
                execute: (argv) =>
                  Effect.tryPromise({
                    try: async () => ({
                      ...(await docker("exec", container, ...argv)),
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
              yield* hydrateRollbackTarget(authority, [key]);
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
              yield* restoreRollbackFiles(authority, "restoreSaved");
              yield* verifyRollbackUnchanged(authority, recovery);
            }).pipe(Effect.provide(BlobStoreFsLive(path.join(f.root, "blobs")))),
          );
          expect(await fs.readFile(path.join(f.repo, "tracked"), "utf8")).toBe(
            "unstaged work before Undo\n",
          );
          expect(await fs.readFile(path.join(f.repo, ".git/index"))).toEqual(originalIndex);
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
