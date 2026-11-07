import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  NativeHistoryError,
  prepareNativeHistorySeed,
  readNativeHistorySeed,
} from "@mend/agent-protocol";
import {
  BlobStore,
  BlobStoreFsLive,
  captureKeys,
  listCaptureFiles,
  readCaptureFileBytes,
} from "@mend/store";
import { buildManifest, snapshotDirectory, uploadObjects } from "@mend/store/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { nativeSeedProbeArgv } from "../src/native-fork-seed.ts";
import { writeFilesPickupExec } from "../src/workspace-files.ts";
import { runExec, startPickupChannel } from "./pickup-channel.ts";

const sourceId = "11111111-1111-4111-8111-111111111111";
const messageId = "22222222-2222-4222-8222-222222222222";
const childId = "33333333-3333-4333-8333-333333333333";
const transcript = `.claude/projects/-workspace-repo/${sourceId}.jsonl`;
const plan = ".claude/plans/selected-plan.md";
const task = `.claude/tasks/${sourceId}/1.json`;
const output = `.claude/projects/-workspace-repo/${sourceId}/tool-results/selected.txt`;

// A person plans, writes tasks and reads a large result, then forks after the source continues.
describe.each(["captured", "colocated"])("%s selected native closure", (storage) => {
  it("delivers the sealed auxiliary state after later writes and source deletion", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-native-closure-"));
    const source = path.join(tmp, "source");
    const child = path.join(tmp, "child");
    const channel = await startPickupChannel();
    const files = new Map([
      [
        transcript,
        JSON.stringify({
          type: "assistant",
          sessionId: sourceId,
          version: "2.1.318",
          uuid: messageId,
          parentUuid: null,
          toolUseResult: { task: { id: "1" } },
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "plan",
                name: "ExitPlanMode",
                input: { planFilePath: `${source}/${plan}`, plan: "SELECTED PLAN" },
              },
              {
                type: "tool_use",
                id: "todo",
                name: "TodoWrite",
                input: {
                  todos: [{ content: "SELECTED TODO", status: "pending", activeForm: "Doing" }],
                },
              },
              {
                type: "text",
                text: `<persisted-output>Full output saved to: ${source}/${output}\n</persisted-output>`,
              },
            ],
          },
        }) + "\n",
      ],
      [plan, "SELECTED PLAN"],
      [task, '{"id":"1","subject":"SELECTED TASK"}'],
      [output, "SELECTED OUTPUT"],
      [".claude/settings.json", "PRIVATE_CONFIG"],
      [".claude/.credentials.json", "PRIVATE_LOGIN"],
      [".claude/plans/unrelated.md", "UNRELATED"],
    ]);
    try {
      for (const [at, content] of files) {
        fs.mkdirSync(path.dirname(path.join(source, at)), { recursive: true });
        fs.writeFileSync(path.join(source, at), content);
      }
      const snapshot = snapshotDirectory(source, captureKeys("wt-native", 1), { chunkSize: 64 });
      const built = buildManifest({
        worktreeId: "wt-native",
        n: 1,
        parent: null,
        epoch: 1,
        seq: 1,
        kind: "checkpoint",
        git: { packs: [], refs: {}, head: "refs/heads/main", fsck: "verified" },
        workspace: { root: snapshot.root, packs: snapshot.packs },
        bulk: { root: "", packs: [], platform: "linux-x86_64" },
      });
      const seed = await Effect.runPromise(
        Effect.gen(function* () {
          yield* uploadObjects(snapshot.objects);
          const blobs = yield* BlobStore;
          const paths =
            storage === "captured"
              ? (yield* listCaptureFiles(built.manifest, "workspace", ""))
                  .filter((file) => file.entry.kind === "file")
                  .map((file) => file.path)
              : [...files.keys()];
          return yield* readNativeHistorySeed({
            observation: {
              providerVersion: "2.1.318",
              cutoff: { provider: "claude", sessionId: sourceId, throughMessageId: messageId },
            },
            paths,
            read: (at) =>
              (storage === "captured"
                ? readCaptureFileBytes(built.manifest, "workspace", at).pipe(
                    Effect.map((bytes) => new TextDecoder().decode(bytes)),
                    Effect.provideService(BlobStore, blobs),
                  )
                : Effect.sync(() => fs.readFileSync(path.join(source, at), "utf8"))
              ).pipe(
                Effect.mapError(
                  () => new NativeHistoryError({ message: "Selected native state missing" }),
                ),
              ),
          });
        }).pipe(Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs")))),
      );
      for (const at of [plan, task, output])
        fs.writeFileSync(path.join(source, at), "LATER SOURCE STATE");
      const after = fs.readFileSync(path.join(source, plan), "utf8");
      const prepared = await Effect.runPromise(
        prepareNativeHistorySeed({ ...seed, home: child, childSessionId: childId }),
      );
      expect(fs.readFileSync(path.join(source, plan), "utf8")).toBe(after);
      fs.readdirSync(source);
      fs.rmSync(source, { recursive: true });
      fs.mkdirSync(child);
      const ticket = channel.mint(
        prepared.files.map((file) => ({
          path: path.join(child, file.relativePath),
          bytes: new TextEncoder().encode(file.content),
        })),
      );
      const result = await runExec(
        writeFilesPickupExec(
          prepared.files.map((file) => ({
            path: path.join(child, file.relativePath),
            within: { root: child, directoryMode: 0o700, fileMode: 0o600 },
          })),
          ticket,
        ),
        channel.env,
      );
      expect(result.status).toBe(0);
      const [command, ...args] = nativeSeedProbeArgv(child, prepared.refs);
      expect(execFileSync(command ?? "node", args, { encoding: "utf8" })).toBe("[]");
      expect(fs.readFileSync(path.join(child, plan), "utf8")).toBe("SELECTED PLAN");
      expect(
        fs.readFileSync(path.join(child, `.claude/tasks/${childId}/1.json`), "utf8"),
      ).toContain("SELECTED TASK");
      expect(fs.readFileSync(path.join(child, output), "utf8")).toBe("SELECTED OUTPUT");
      expect(fs.readFileSync(path.join(child, transcript), "utf8")).toContain(`${child}/${output}`);
      expect(JSON.stringify(prepared)).not.toMatch(/PRIVATE|UNRELATED|LATER SOURCE/);
      expect(prepared.files).toHaveLength(4);
    } finally {
      await channel.close();
      fs.readdirSync(tmp);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
