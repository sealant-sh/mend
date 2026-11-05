import { describe, expect, it } from "@effect/vitest";
import type { NativeHistoryObservation } from "@mend/domain/workbench";
import { Effect, Exit } from "effect";

import { sealNativeHistory, readNativeHistorySeed, nativeForkArgv } from "../src/index.ts";

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
    const argv = nativeForkArgv(["claude", "--print", "--resume", sourceId, "--settings", "{}"], {
      cutoff: claude.cutoff,
      sourcePath: "/private/retained.jsonl",
      childSessionId: laterId,
    });
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
