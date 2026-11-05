import { describe, expect, it } from "@effect/vitest";
import type { NativeHistoryObservation } from "@mend/domain/workbench";
import { Effect, Exit } from "effect";

import {
  sealNativeHistory,
  readNativeHistorySeed,
  nativeBootstrapArgv,
  prepareNativeHistorySeed,
  nativeHistoryPaths,
} from "../src/index.ts";

const ndjson = (...values: ReadonlyArray<unknown>): string =>
  values.map((value) => JSON.stringify(value) + "\n").join("");
const sourceId = "11111111-1111-4111-8111-111111111111";
const firstId = "22222222-2222-4222-8222-222222222222";
const laterId = "33333333-3333-4333-8333-333333333333";
const codexPath = (id: string) =>
  `.codex/sessions/2026/11/05/rollout-2026-11-05T12-00-00-${id}.jsonl`;
const claudePath = `.claude/projects/-workspace-repo/${sourceId}.jsonl`;
const claude: NativeHistoryObservation = {
  providerVersion: "2.1.318",
  cutoff: { provider: "claude", sessionId: sourceId, throughMessageId: firstId },
};
const codex: NativeHistoryObservation = {
  providerVersion: "0.162.1",
  cutoff: {
    provider: "codex",
    threadId: sourceId,
    throughTurnId: firstId,
    historyMode: "paginated",
  },
};
const meta = (id: string, base?: unknown) => ({
  ordinal: 0,
  type: "session_meta",
  payload: {
    id,
    cli_version: "0.162.1",
    history_mode: "paginated",
    ...(base === undefined ? {} : { history_base: base }),
  },
});
const complete = (ordinal: number, turn_id: string) => ({
  ordinal,
  type: "event_msg",
  payload: { type: "task_complete", turn_id },
});
const assistant = (uuid: string, parentUuid: string | null, text: string) => ({
  type: "assistant",
  uuid,
  parentUuid,
  sessionId: sourceId,
  version: "2.1.318",
  message: { role: "assistant", content: text },
});

describe("retained native history", () => {
  it.effect("gives a shared Codex prefix independent indexed identities and exact ancestor offsets", () =>
    Effect.gen(function* () {
      const ancestorId = "44444444-4444-4444-8444-444444444444";
      const prefix = ndjson(meta(ancestorId), complete(1, "ancestor-turn"));
      const files = [
        { relativePath: codexPath(ancestorId), content: prefix + ndjson(complete(2, "LATER_ANCESTOR")) },
        {
          relativePath: codexPath(sourceId),
          content: ndjson(
            meta(sourceId, {
              thread_id: ancestorId,
              end_ordinal_exclusive: 2,
              end_byte_offset: Buffer.byteLength(prefix),
            }),
            complete(3, firstId),
            complete(4, "LATER_SOURCE"),
          ),
        },
      ];
      const seed = yield* sealNativeHistory({ observation: codex, files });
      const before = JSON.stringify(seed);
      const prepared = yield* prepareNativeHistorySeed({
        ...seed,
        home: "/workspace/harness-home",
        childSessionId: laterId,
        isolateAuxiliary: true,
      });
      // Codex refuses a paginated source ID indexed at another path, even with lastTurnId.
      expect(prepared).toMatchObject({
        cutoff: { ...codex.cutoff, threadId: laterId },
        selectedFile: { relativePath: codexPath(laterId) },
      });
      expect(prepared.files.map((f) => f.relativePath)).not.toContain(codexPath(sourceId));
      expect(prepared.files.map((f) => f.relativePath)).not.toContain(codexPath(ancestorId));
      const resealed = yield* sealNativeHistory({
        observation: { providerVersion: codex.providerVersion, cutoff: prepared.cutoff },
        files: prepared.files,
      });
      expect(resealed.files).toEqual(prepared.files);
      expect(JSON.stringify(prepared)).not.toContain("LATER_ANCESTOR");
      expect(JSON.stringify(prepared)).not.toContain("LATER_SOURCE");
      expect(JSON.stringify(seed)).toBe(before);
      expect(yield* prepareNativeHistorySeed({
        ...seed,
        home: "/workspace/harness-home",
        childSessionId: laterId,
        isolateAuxiliary: true,
      })).toEqual(prepared);
    }),
  );

  it.effect(
    "scopes shared-home recovery to the selected transcript and exact auxiliary closure",
    () =>
      Effect.gen(function* () {
        const task = `.claude/tasks/${sourceId}/1.json`;
        const plan = ".claude/plans/selected.md";
        const files = new Map([
          [
            claudePath,
            ndjson(
              {
                ...assistant(firstId, null, "selected"),
                toolUseResult: { task: { id: "1" } },
                message: { content: [{ type: "text", text: `/root/${plan}` }] },
              },
              assistant(laterId, firstId, "full later response"),
            ),
          ],
          [task, '{"id":"1"}'],
          [plan, "selected plan"],
          [`.claude/projects/-workspace-repo/${laterId}.jsonl`, "OTHER SESSION"],
          [".claude/plans/unrelated.md", "OTHER PLAN"],
          [".claude/.credentials.json", "PRIVATE"],
        ]);
        const read: string[] = [];
        const paths = yield* nativeHistoryPaths({
          provider: "claude",
          sessionId: sourceId,
          paths: [...files.keys()],
          allowUnwritten: false,
          read: (at) =>
            Effect.sync(() => {
              read.push(at);
              return files.get(at) ?? "";
            }),
        });
        expect(paths.nativePaths).toEqual([plan, claudePath, task].toSorted());
        expect(read).toEqual([claudePath]);
        expect(files.get(claudePath)).toContain("full later response");
        expect(
          yield* nativeHistoryPaths({
            provider: "claude",
            sessionId: sourceId,
            paths: [plan, task],
            allowUnwritten: false,
            read: () => Effect.succeed(""),
          }).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
      }),
  );

  it.effect(
    "gives holder-home auxiliary files candidate-owned names without rewriting the source",
    () =>
      Effect.gen(function* () {
        const plan = ".claude/plans/selected.md";
        const output = `.claude/projects/-workspace-repo/${sourceId}/tool-results/output.txt`;
        const content = ndjson(assistant(firstId, null, `/root/${plan} /root/${output}`));
        const seed = yield* sealNativeHistory({
          observation: claude,
          files: [
            { relativePath: claudePath, content },
            { relativePath: plan, content: "SELECTED" },
            { relativePath: output, content: "OUTPUT" },
          ],
        });
        const prepared = yield* prepareNativeHistorySeed({
          ...seed,
          home: "/root",
          childSessionId: laterId,
          isolateAuxiliary: true,
        });
        expect(prepared.files.map((file) => file.relativePath)).toContain(
          `.claude/plans/${laterId}-selected.md`,
        );
        expect(prepared.files.find((file) => file.relativePath === claudePath)?.content).toContain(
          `/root/.claude/projects/-workspace-repo/${laterId}/tool-results/output.txt`,
        );
        expect(seed.files.find((file) => file.relativePath === claudePath)?.content).toBe(content);
      }),
  );

  it.effect(
    "scopes Codex raw recovery to its exact ancestor chain and refuses a missing ancestor",
    () =>
      Effect.gen(function* () {
        const ancestor = ndjson(meta(laterId));
        const selected = ndjson(
          meta(sourceId, {
            thread_id: laterId,
            end_byte_offset: Buffer.byteLength(ancestor),
            end_ordinal_exclusive: 1,
          }),
        );
        const files = new Map([
          [codexPath(sourceId), selected],
          [
            codexPath(laterId),
            ancestor +
              ndjson({
                ordinal: 1,
                type: "response_item",
                payload: { content: "UNRELATED LATER ANCESTOR WORDS" },
              }),
          ],
          [codexPath(firstId), "OTHER SESSION"],
          [".codex/auth.json", "PRIVATE"],
        ]);
        const read: string[] = [];
        const input = {
          provider: "codex" as const,
          sessionId: sourceId,
          paths: [...files.keys()],
          allowUnwritten: false,
          read: (at: string) =>
            Effect.sync(() => {
              read.push(at);
              return files.get(at) ?? "";
            }),
        };
        const closure = yield* nativeHistoryPaths(input);
        expect(
          closure.nativeRefs.find((ref) => ref.relativePath === codexPath(laterId))?.byteLength,
        ).toBe(Buffer.byteLength(ancestor));
        expect(closure.nativePaths).toEqual([codexPath(sourceId), codexPath(laterId)].toSorted());
        expect(read).toEqual([codexPath(sourceId), codexPath(laterId)]);
        files.set(
          codexPath(sourceId),
          ndjson(
            meta(sourceId, {
              thread_id: laterId,
              end_byte_offset: Buffer.byteLength(ancestor) - 1,
              end_ordinal_exclusive: 1,
            }),
          ),
        );
        expect(yield* nativeHistoryPaths(input).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
        });
        expect(
          yield* nativeHistoryPaths({ ...input, paths: [codexPath(sourceId)] }).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
      }),
  );

  it.effect("seals the exact native Codex marker, without later turns or credential files", () =>
    Effect.gen(function* () {
      const content = ndjson(
        meta(sourceId),
        complete(1, firstId),
        { ordinal: 2, type: "response_item", payload: { content: "LATER_SOURCE_INPUT" } },
        complete(3, laterId),
      );
      const files = [
        { relativePath: codexPath(sourceId), content },
        { relativePath: ".codex/auth.json", content: "NEVER_RETAIN" },
      ];
      const seed = yield* sealNativeHistory({ observation: codex, files });
      expect(seed.files).toEqual([
        {
          relativePath: codexPath(sourceId),
          content: ndjson(meta(sourceId), complete(1, firstId)),
        },
      ]);
      expect(files[0]?.content).toBe(content);
      expect(JSON.stringify(seed)).not.toContain("LATER_SOURCE_INPUT");
      expect(JSON.stringify(seed)).not.toContain("NEVER_RETAIN");
      expect((yield* sealNativeHistory({ observation: codex, files })).manifest.id).toBe(
        seed.manifest.id,
      );
    }),
  );

  it.effect("retains Codex paginated ancestors at their exact byte and ordinal boundaries", () =>
    Effect.gen(function* () {
      const ancestorId = "44444444-4444-4444-8444-444444444444";
      const prefix = ndjson(meta(ancestorId), complete(1, "ancestor-turn"));
      const selected = ndjson(
        meta(sourceId, {
          thread_id: ancestorId,
          end_ordinal_exclusive: 2,
          end_byte_offset: Buffer.byteLength(prefix),
        }),
        complete(3, firstId),
      );
      const files = [
        { relativePath: codexPath(sourceId), content: selected },
        {
          relativePath: codexPath(ancestorId),
          content: prefix + ndjson(complete(2, "LATER_ANCESTOR")),
        },
      ];
      const seed = yield* sealNativeHistory({ observation: codex, files });
      expect(seed.files).toHaveLength(2);
      expect(seed.files.find((file) => file.relativePath === codexPath(ancestorId))?.content).toBe(
        prefix,
      );
      expect(
        Exit.isFailure(
          yield* sealNativeHistory({ observation: codex, files: files.slice(0, 1) }).pipe(
            Effect.exit,
          ),
        ),
      ).toBe(true);
      const broken = selected.replace('"end_ordinal_exclusive":2', '"end_ordinal_exclusive":3');
      expect(
        Exit.isFailure(
          yield* sealNativeHistory({
            observation: codex,
            files: [
              { relativePath: codexPath(sourceId), content: broken },
              { relativePath: codexPath(ancestorId), content: prefix },
            ],
          }).pipe(Effect.exit),
        ),
      ).toBe(true);
    }),
  );

  it.effect("seals Claude through the persisted root assistant UUID, preserving one prefix", () =>
    Effect.gen(function* () {
      const content = ndjson(
        assistant(firstId, null, "FIRST"),
        assistant(laterId, firstId, "LATER"),
      );
      const seed = yield* sealNativeHistory({
        observation: claude,
        files: [{ relativePath: claudePath, content }],
      });
      expect(seed.files[0]?.content).toBe(ndjson(assistant(firstId, null, "FIRST")));
      expect(content).toContain("LATER");
      const missingParent = ndjson(assistant(firstId, laterId, "FIRST"));
      expect(
        Exit.isFailure(
          yield* sealNativeHistory({
            observation: claude,
            files: [{ relativePath: claudePath, content: missingParent }],
          }).pipe(Effect.exit),
        ),
      ).toBe(true);
    }),
  );

  // Ordinary coding: Plan twice, update a task/todo, then fork the completed response.
  it.effect(
    "retains selected Plan, todo, task and persisted output bytes without reading unrelated saved files",
    () =>
      Effect.gen(function* () {
        const plan = ".claude/plans/selected-plan.md";
        const task = `.claude/tasks/${sourceId}/1.json`;
        const output = `.claude/projects/-workspace-repo/${sourceId}/tool-results/output.txt`;
        const toolId = "44444444-4444-4444-8444-444444444444";
        const resultId = "55555555-5555-4555-8555-555555555555";
        const transcript = ndjson(
          {
            ...assistant(toolId, null, ""),
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "plan",
                  name: "ExitPlanMode",
                  input: { planFilePath: `/source/${plan}`, plan: "Selected plan" },
                },
                {
                  type: "tool_use",
                  id: "todo",
                  name: "TodoWrite",
                  input: {
                    todos: [{ content: "Selected todo", status: "pending", activeForm: "Doing" }],
                  },
                },
                {
                  type: "tool_use",
                  id: "task",
                  name: "TaskCreate",
                  input: { subject: "Selected task" },
                },
              ],
            },
          },
          {
            type: "user",
            uuid: resultId,
            parentUuid: toolId,
            sessionId: sourceId,
            toolUseResult: { task: { id: "1", subject: "Selected task" } },
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "task",
                  content: `<persisted-output>Full output saved to: /source/${output}\n</persisted-output>`,
                },
              ],
            },
          },
          assistant(firstId, resultId, "Selected response"),
          assistant(laterId, firstId, "LATER RESPONSE"),
        );
        const files = new Map([
          [claudePath, transcript],
          [plan, "Selected plan"],
          [task, JSON.stringify({ id: "1", subject: "Selected task", status: "pending" })],
          [output, "Selected full output"],
          [".claude/settings.json", "PRIVATE_CONFIG"],
          [".claude/.credentials.json", "PRIVATE_LOGIN"],
          [".claude/plans/unrelated.md", "UNRELATED"],
          [`.claude/tasks/${laterId}/1.json`, "UNRELATED"],
        ]);
        const read: string[] = [];
        const seed = yield* readNativeHistorySeed({
          observation: claude,
          paths: [...files.keys()],
          read: (relativePath) =>
            Effect.sync(() => {
              read.push(relativePath);
              return files.get(relativePath) ?? "";
            }),
        });
        expect(read.toSorted()).toEqual([claudePath, plan, task, output].toSorted());
        expect(seed.manifest.files.map((file) => file.relativePath).toSorted()).toEqual(
          read.toSorted(),
        );
        files.set(plan, "LATER plan");
        files.set(task, "LATER task");
        files.set(output, "LATER output");
        expect(JSON.stringify(seed)).not.toMatch(/LATER|PRIVATE|UNRELATED/);
        expect(seed.files.find((file) => file.relativePath === plan)?.content).toBe(
          "Selected plan",
        );
        expect(files.get(claudePath)).toBe(transcript);
      }),
  );

  it.effect(
    "keeps completed inline Plan and TodoWrite history forkable without invented auxiliary files",
    () =>
      Effect.gen(function* () {
        for (const name of ["EnterPlanMode", "ExitPlanMode", "TodoWrite"]) {
          const seed = yield* sealNativeHistory({
            observation: claude,
            files: [
              {
                relativePath: claudePath,
                content: ndjson({
                  ...assistant(firstId, null, ""),
                  message: {
                    role: "assistant",
                    content: [{ type: "tool_use", name, id: "tool-1", input: {} }],
                  },
                }),
              },
            ],
          });
          expect(seed.files).toHaveLength(1);
        }
      }),
  );

  it.effect(
    "prepares auxiliary files in the child's own home and task namespace from immutable bytes",
    () =>
      Effect.gen(function* () {
        const output = `.claude/projects/-workspace-repo/${sourceId}/tool-results/selected.txt`;
        const task = `.claude/tasks/${sourceId}/1.json`;
        const todo = `.claude/todos/${sourceId}-agent-${sourceId}.json`;
        const plan = ".claude/plans/selected.md";
        const seed = yield* sealNativeHistory({
          observation: claude,
          files: [
            {
              relativePath: claudePath,
              content: ndjson({
                ...assistant(firstId, null, ""),
                toolUseResult: { task: { id: "1" } },
                message: {
                  role: "assistant",
                  content: [
                    { type: "tool_use", name: "Read", input: { file_path: `/old/${output}` } },
                    { type: "text", text: `Read /old/${plan}` },
                    { type: "tool_use", name: "TodoWrite", id: "todo", input: { todos: [] } },
                  ],
                },
              }),
            },
            { relativePath: output, content: "SELECTED OUTPUT" },
            { relativePath: task, content: '{"id":"1","subject":"SELECTED TASK"}' },
            { relativePath: todo, content: "[]" },
            { relativePath: plan, content: "SELECTED PLAN" },
          ],
        });
        const original = JSON.stringify(seed);
        const prepared = yield* prepareNativeHistorySeed({
          ...seed,
          home: "/child",
          childSessionId: laterId,
        });
        expect(prepared.files.map((file) => file.relativePath)).toContain(
          `.claude/tasks/${laterId}/1.json`,
        );
        expect(prepared.files.map((file) => file.relativePath)).toContain(
          `.claude/todos/${laterId}-agent-${laterId}.json`,
        );
        expect(prepared.files.find((file) => file.relativePath === claudePath)?.content).toContain(
          `/child/${output}`,
        );
        expect(prepared.files.find((file) => file.relativePath === claudePath)?.content).toContain(
          `/child/${plan}`,
        );
        expect(JSON.stringify(prepared)).not.toContain("/old/");
        expect(JSON.stringify(seed)).toBe(original);
        const altered = seed.files.map((file) =>
          file.relativePath === output ? { ...file, content: "LATER OUTPUT" } : file,
        );
        expect(
          Exit.isFailure(
            yield* prepareNativeHistorySeed({
              manifest: seed.manifest,
              files: altered,
              home: "/child",
              childSessionId: laterId,
            }).pipe(Effect.exit),
          ),
        ).toBe(true);
      }),
  );

  it.effect(
    "refuses incomplete persisted output, ambiguous files, unknown task lists and missing task files",
    () =>
      Effect.gen(function* () {
        for (const content of [
          ndjson({ ...assistant(firstId, null, ""), toolUseResult: { task: { id: "1" } } }),
          ndjson(
            assistant(
              firstId,
              null,
              "<persisted-output>Full output saved to: /tmp/arbitrary.txt</persisted-output>",
            ),
          ),
          ndjson(
            assistant(
              firstId,
              null,
              `<persisted-output>Full output saved to: /old/.claude/projects/-workspace-repo/${sourceId}/tool-results/present.txt</persisted-output><persisted-output>Missing /tmp/unknown.txt</persisted-output>`,
            ),
          ),
          ndjson(assistant(firstId, null, `Read /old/.claude/tasks/${laterId}/1.json`)),
        ])
          expect(
            Exit.isFailure(
              yield* sealNativeHistory({
                observation: claude,
                files: [{ relativePath: claudePath, content }],
              }).pipe(Effect.exit),
            ),
          ).toBe(true);
        const file = { relativePath: ".claude/plans/selected.md", content: "selected" };
        expect(
          Exit.isFailure(
            yield* sealNativeHistory({
              observation: claude,
              files: [
                {
                  relativePath: claudePath,
                  content: ndjson(assistant(firstId, null, "Read /old/.claude/plans/selected.md")),
                },
                file,
                file,
              ],
            }).pipe(Effect.exit),
          ),
        ).toBe(true);
      }),
  );

  it.effect(
    "ignores native prompt tool definitions and permits a Plan allocation with no saved plan yet",
    () =>
      Effect.gen(function* () {
        const content = ndjson(
          {
            type: "attachment",
            attachment: {
              type: "prompt_snapshot",
              tools: [{ name: "Task" }],
              systemPrompt: ["Example .claude/tasks/list/1.json"],
            },
          },
          {
            type: "attachment",
            attachment: {
              type: "plan_mode",
              planFilePath: "/old/.claude/plans/allocated.md",
              planExists: false,
            },
          },
          {
            type: "user",
            toolUseResult: { plan: null, filePath: "/old/.claude/plans/allocated.md" },
          },
          assistant(firstId, null, "The plan is still being discussed"),
        );
        const seed = yield* sealNativeHistory({
          observation: claude,
          files: [{ relativePath: claudePath, content }],
        });
        expect(seed.files).toHaveLength(1);
      }),
  );

  it.effect(
    "preserves native task deletion numbering while excluding locks and later task files",
    () =>
      Effect.gen(function* () {
        const watermark = `.claude/tasks/${sourceId}/.highwatermark`;
        const task = `.claude/tasks/${sourceId}/1.json`;
        const content = ndjson(
          { type: "user", toolUseResult: { task: { id: "2" } } },
          {
            type: "user",
            toolUseResult: { success: true, taskId: "2", statusChange: { to: "deleted" } },
          },
          { type: "user", toolUseResult: { tasks: [{ id: "1" }] } },
          assistant(firstId, null, "Selected task state"),
        );
        const files = [
          { relativePath: claudePath, content },
          { relativePath: task, content: '{"id":"1","subject":"Kept task"}' },
          { relativePath: watermark, content: "2" },
          { relativePath: `.claude/tasks/${sourceId}/.lock`, content: "LOCK" },
          {
            relativePath: `.claude/tasks/${sourceId}/3.json`,
            content: '{"id":"3","subject":"LATER TASK"}',
          },
        ];
        const seed = yield* sealNativeHistory({ observation: claude, files });
        expect(seed.files.map((file) => file.relativePath).toSorted()).toEqual(
          [claudePath, watermark, task].toSorted(),
        );
        expect(
          Exit.isFailure(
            yield* sealNativeHistory({
              observation: claude,
              files: files.filter((file) => file.relativePath !== watermark),
            }).pipe(Effect.exit),
          ),
        ).toBe(true);
      }),
  );

  it.effect("refuses unprovable cursors and incomplete/auxiliary native history", () =>
    Effect.gen(function* () {
      for (const content of [
        ndjson(assistant(laterId, null, "LATER")),
        ndjson(assistant(firstId, null, "FIRST"), assistant(firstId, null, "DUPLICATE")),
        ndjson(assistant(firstId, null, "FIRST")).trimEnd(),
        ndjson(assistant(firstId, null, "Read /home/fake/.claude/plans/selected.md")),
        ndjson(assistant(firstId, null, "Read /home/fake/.claude/tasks/selected/1.json")),
        ndjson(
          assistant(firstId, null, "<persisted-output>/tool-results/needed.txt</persisted-output>"),
        ),
      ])
        expect(
          Exit.isFailure(
            yield* sealNativeHistory({
              observation: claude,
              files: [{ relativePath: claudePath, content }],
            }).pipe(Effect.exit),
          ),
        ).toBe(true);
    }),
  );

  it.effect("refuses native task or subagent state whose auxiliary closure is not retained", () =>
    Effect.gen(function* () {
      for (const name of ["TaskCreate", "Agent"]) {
        const content = ndjson({
          ...assistant(firstId, null, ""),
          message: {
            role: "assistant",
            content: [{ type: "tool_use", name, id: "tool-1", input: {} }],
          },
        });
        expect(
          Exit.isFailure(
            yield* sealNativeHistory({
              observation: claude,
              files: [{ relativePath: claudePath, content }],
            }).pipe(Effect.exit),
          ),
        ).toBe(true);
      }
      const content = ndjson(
        meta(sourceId),
        {
          ordinal: 1,
          type: "response_item",
          payload: { type: "function_call", name: "spawn_agent", arguments: "{}" },
        },
        complete(2, firstId),
      );
      expect(
        Exit.isFailure(
          yield* sealNativeHistory({
            observation: codex,
            files: [{ relativePath: codexPath(sourceId), content }],
          }).pipe(Effect.exit),
        ),
      ).toBe(true);
    }),
  );

  it("uses native Claude cutoff switches without a prompt or inherited resume identity", () => {
    const argv = nativeBootstrapArgv(
      ["claude", "--print", "--resume", sourceId, "--settings", "{}"],
      {
        cutoff: claude.cutoff,
        sourcePath: "/private/retained.jsonl",
        childSessionId: laterId,
      },
    );
    expect(argv).toEqual([
      "claude",
      "--print",
      "--settings",
      "{}",
      "--resume",
      "/private/retained.jsonl",
      "--fork-session",
      "--session-id",
      laterId,
      "--resume-session-at",
      firstId,
    ]);
  });
});
