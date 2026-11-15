import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  type NativeConversationRewriteInput,
  type NativeHistoryFile,
  rewriteNativeConversation,
} from "../src/index.ts";

const ndjson = (...values: ReadonlyArray<unknown>): string =>
  values.map((value) => JSON.stringify(value) + "\n").join("");
const recordsOf = (content: string): ReadonlyArray<unknown> =>
  content
    .slice(0, -1)
    .split("\n")
    .map((line): unknown => JSON.parse(line));
const contentOf = (files: ReadonlyArray<NativeHistoryFile>, relativePath: string): string => {
  const file = files.find((candidate) => candidate.relativePath === relativePath);
  if (file === undefined) throw new Error(`missing ${relativePath}`);
  return file.content;
};

const sessionId = "11111111-1111-4111-8111-111111111111";
const shop = { checkout: "/home/ana/code/shop", home: "/home/ana" };
const mend = { checkout: "/workspace/repo", home: "/var/lib/mend/h" };
const toolResult = `.claude/projects/-home-ana-code-shop/${sessionId}/tool-results/out.txt`;

const rollout = (id: string) =>
  `.codex/sessions/2026/11/15/rollout-2026-11-15T10-00-00-${id}.jsonl`;
const meta = (id: string, base?: unknown) => ({
  ordinal: 0,
  type: "session_meta",
  payload: {
    id,
    cwd: "/home/ana/code/shop",
    history_mode: "paginated",
    history_base: base ?? null,
  },
});

const rewriteText = (text: string, places = { source: shop, target: mend }) =>
  rewriteNativeConversation({
    provider: "claude",
    ...places,
    files: [{ relativePath: toolResult, content: text }],
  }).pipe(Effect.map(({ files, report }) => ({ text: files[0]?.content, report })));

describe("rewriteNativeConversation", () => {
  it.effect.each([
    { name: "the checkout itself", input: "/home/ana/code/shop", expected: "/workspace/repo" },
    {
      name: "a file inside it",
      input: "/home/ana/code/shop/src/a.ts",
      expected: "/workspace/repo/src/a.ts",
    },
    {
      name: "a line reference",
      input: "/home/ana/code/shop/a.ts:12",
      expected: "/workspace/repo/a.ts:12",
    },
    {
      name: "the end of a sentence",
      input: "cd /home/ana/code/shop.",
      expected: "cd /workspace/repo.",
    },
    { name: "a quoted path", input: `"/home/ana/code/shop"`, expected: `"/workspace/repo"` },
    {
      name: "a sibling with a suffix",
      input: "/home/ana/code/shop-2/a.ts",
      expected: "/home/ana/code/shop-2/a.ts",
    },
    {
      name: "a longer name",
      input: "/home/ana/code/shopping",
      expected: "/home/ana/code/shopping",
    },
    {
      name: "a dotted sibling",
      input: "/home/ana/code/shop.git",
      expected: "/home/ana/code/shop.git",
    },
    {
      name: "the path under another root",
      input: "/mnt/home/ana/code/shop",
      expected: "/mnt/home/ana/code/shop",
    },
  ])("rewrites the checkout only as a whole path prefix: $name", ({ input, expected }) =>
    Effect.gen(function* () {
      const { text } = yield* rewriteText(input);
      expect(text).toBe(expected);
    }),
  );

  it.effect("reports paths under the source home it leaves, and nothing else", () =>
    Effect.gen(function* () {
      const { text, report } = yield* rewriteText(
        "see /home/ana/code/shop/a.ts, /home/ana/code/shop-2/b.ts and /home/ana/notes.md. /etc/hosts",
      );
      expect(text).toBe(
        "see /workspace/repo/a.ts, /home/ana/code/shop-2/b.ts and /home/ana/notes.md. /etc/hosts",
      );
      expect(report).toEqual({
        rewritten: 1,
        leftovers: ["/home/ana/code/shop-2/b.ts", "/home/ana/notes.md"],
        leftoversTruncated: false,
      });
    }),
  );

  it.effect("rewrites a checkout inside the home before the home's harness state", () =>
    Effect.gen(function* () {
      const worktree = { checkout: "/home/ana/.t3/worktrees/shop/fix-login", home: "/home/ana" };
      const { text, report } = yield* rewriteText(
        [
          "/home/ana/.t3/worktrees/shop/fix-login/src/a.ts",
          "/home/ana/.t3/worktrees/shop/fix-login-2/src/a.ts",
          "/home/ana/.claude/plans/quiet-plan.md",
          "/home/ana/.codex/sessions/2026/11/15/rollout.jsonl",
        ].join("\n"),
        { source: worktree, target: mend },
      );
      expect(text).toBe(
        [
          "/workspace/repo/src/a.ts",
          "/home/ana/.t3/worktrees/shop/fix-login-2/src/a.ts",
          "/var/lib/mend/h/.claude/plans/quiet-plan.md",
          "/var/lib/mend/h/.codex/sessions/2026/11/15/rollout.jsonl",
        ].join("\n"),
      );
      expect(report.leftovers).toEqual(["/home/ana/.t3/worktrees/shop/fix-login-2/src/a.ts"]);
    }),
  );

  it.effect("leaves signed thinking byte for byte while the tool call beside it moves", () =>
    Effect.gen(function* () {
      const thinking = {
        type: "thinking",
        thinking: "Read /home/ana/code/shop/a.ts and /home/ana/private/x.md first.",
        signature: "c2lnbmVk",
      };
      const redacted = { type: "redacted_thinking", data: "ZW5j+/home/ana/code/shop/x==" };
      const transcript = `.claude/projects/-home-ana-code-shop/${sessionId}.jsonl`;
      const { files, report } = yield* rewriteNativeConversation({
        provider: "claude",
        source: shop,
        target: mend,
        files: [
          {
            relativePath: transcript,
            content: ndjson(
              {
                type: "assistant",
                sessionId,
                message: {
                  content: [
                    thinking,
                    redacted,
                    {
                      type: "tool_use",
                      id: "toolu_1",
                      name: "Read",
                      input: { file_path: "/home/ana/code/shop/a.ts" },
                    },
                  ],
                },
              },
              {
                type: "user",
                sessionId,
                message: {
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: "toolu_1",
                      content: "1\texport {} // /home/ana/code/shop/a.ts",
                    },
                  ],
                },
              },
            ),
          },
        ],
      });
      const content = contentOf(files, `.claude/projects/-workspace-repo/${sessionId}.jsonl`);
      expect(content).toContain(JSON.stringify(thinking));
      expect(content).toContain(JSON.stringify(redacted));
      expect(recordsOf(content)).toMatchObject([
        { message: { content: [{}, {}, { input: { file_path: "/workspace/repo/a.ts" } }] } },
        { message: { content: [{ content: "1\texport {} // /workspace/repo/a.ts" }] } },
      ]);
      expect(report).toEqual({ rewritten: 2, leftovers: [], leftoversTruncated: false });
    }),
  );

  it.effect("rewrites paths inside nested escaped JSON and in object keys", () =>
    Effect.gen(function* () {
      const transcript = `.claude/projects/-home-ana-code-shop/${sessionId}.jsonl`;
      const { files } = yield* rewriteNativeConversation({
        provider: "claude",
        source: shop,
        target: mend,
        files: [
          {
            relativePath: transcript,
            content: ndjson({
              type: "user",
              toolUseResult: {
                raw: JSON.stringify({ args: JSON.stringify({ path: "/home/ana/code/shop/a.ts" }) }),
                files: { "/home/ana/code/shop/a.ts": { lines: 3 } },
              },
            }),
          },
        ],
      });
      const [record] = recordsOf(
        contentOf(files, `.claude/projects/-workspace-repo/${sessionId}.jsonl`),
      );
      expect(record).toEqual({
        type: "user",
        toolUseResult: {
          raw: JSON.stringify({ args: JSON.stringify({ path: "/workspace/repo/a.ts" }) }),
          files: { "/workspace/repo/a.ts": { lines: 3 } },
        },
      });
    }),
  );

  it.effect("moves Claude's project folder across the transcript, tool results and subagents", () =>
    Effect.gen(function* () {
      const folder = `.claude/projects/-home-ana-code-shop`;
      const plan = ".claude/plans/quiet-plan.md";
      const task = `.claude/tasks/${sessionId}/1.json`;
      const message = (uuid: string, parentUuid: string | null, text: string) => ({
        type: "user",
        uuid,
        parentUuid,
        sessionId,
        timestamp: "2026-11-15T10:00:00.000Z",
        cwd: "/home/ana/code/shop",
        gitBranch: "fix-login",
        message: { content: text },
      });
      const { files } = yield* rewriteNativeConversation({
        provider: "claude",
        source: shop,
        target: { ...mend, gitBranch: "mend/fix-login" },
        files: [
          {
            relativePath: `${folder}/${sessionId}.jsonl`,
            content: ndjson(
              message(
                "22222222-2222-4222-8222-222222222222",
                null,
                `<persisted-output>/home/ana/.claude/projects/-home-ana-code-shop/${sessionId}/tool-results/out.txt</persisted-output>`,
              ),
              message(
                "33333333-3333-4333-8333-333333333333",
                "22222222-2222-4222-8222-222222222222",
                "Plan saved to ~/.claude/plans/quiet-plan.md",
              ),
            ),
          },
          {
            relativePath: `${folder}/${sessionId}/tool-results/out.txt`,
            content: "/home/ana/code/shop\n",
          },
          {
            relativePath: `${folder}/${sessionId}/subagents/agent-a1.jsonl`,
            content: ndjson({
              ...message("44444444-4444-4444-8444-444444444444", null, "go"),
              isSidechain: true,
            }),
          },
          { relativePath: plan, content: "Edit /home/ana/code/shop/a.ts\n" },
          {
            relativePath: task,
            content: JSON.stringify({ id: "1", subject: "in /home/ana/code/shop" }, null, 2),
          },
        ],
      });
      const to = `.claude/projects/-workspace-repo`;
      expect(files.map((file) => file.relativePath)).toEqual([
        `${to}/${sessionId}.jsonl`,
        `${to}/${sessionId}/tool-results/out.txt`,
        `${to}/${sessionId}/subagents/agent-a1.jsonl`,
        plan,
        task,
      ]);
      const transcript = contentOf(files, `${to}/${sessionId}.jsonl`);
      expect(transcript.endsWith("\n")).toBe(true);
      expect(recordsOf(transcript)).toEqual([
        {
          ...message(
            "22222222-2222-4222-8222-222222222222",
            null,
            `<persisted-output>/var/lib/mend/h/.claude/projects/-workspace-repo/${sessionId}/tool-results/out.txt</persisted-output>`,
          ),
          cwd: "/workspace/repo",
          gitBranch: "mend/fix-login",
        },
        {
          ...message(
            "33333333-3333-4333-8333-333333333333",
            "22222222-2222-4222-8222-222222222222",
            "Plan saved to /var/lib/mend/h/.claude/plans/quiet-plan.md",
          ),
          cwd: "/workspace/repo",
          gitBranch: "mend/fix-login",
        },
      ]);
      expect(contentOf(files, `${to}/${sessionId}/tool-results/out.txt`)).toBe("/workspace/repo\n");
      expect(
        recordsOf(contentOf(files, `${to}/${sessionId}/subagents/agent-a1.jsonl`)),
      ).toMatchObject([{ cwd: "/workspace/repo", gitBranch: "mend/fix-login", isSidechain: true }]);
      expect(contentOf(files, plan)).toBe("Edit /workspace/repo/a.ts\n");
      expect(contentOf(files, task)).toBe(
        JSON.stringify({ id: "1", subject: "in /workspace/repo" }, null, 2),
      );
    }),
  );

  describe("Codex", () => {
    const ChildMeta = Schema.Struct({
      payload: Schema.Struct({ history_base: Schema.Struct({ end_byte_offset: Schema.Number }) }),
    });
    const parentId = "01a1aaaa-0000-7000-8000-000000000001";
    const childId = "01a1bbbb-0000-7000-8000-000000000002";
    const reasoning = {
      type: "reasoning",
      summary: [],
      encrypted_content: "gAAAA+/home/ana/code/shop/x==",
    };
    const parentRecords = [
      meta(parentId),
      { ordinal: 1, type: "turn_context", payload: { cwd: "/home/ana/code/shop" } },
      { ordinal: 2, type: "response_item", payload: reasoning },
      {
        ordinal: 3,
        type: "response_item",
        payload: { type: "message", content: "after the fork" },
      },
    ];
    const parent = ndjson(...parentRecords);
    // The child continues the parent through its first three records.
    const boundary = Buffer.byteLength(ndjson(...parentRecords.slice(0, 3)));

    it.effect("moves an ancestor boundary to the same record's end in the rewritten ancestor", () =>
      Effect.gen(function* () {
        const { files } = yield* rewriteNativeConversation({
          provider: "codex",
          source: shop,
          target: mend,
          files: [
            {
              relativePath: rollout(childId),
              content: ndjson(
                meta(childId, {
                  thread_id: parentId,
                  end_byte_offset: boundary,
                  end_ordinal_exclusive: 3,
                }),
                { ordinal: 3, type: "turn_context", payload: { cwd: "/home/ana/code/shop" } },
              ),
            },
            { relativePath: rollout(parentId), content: parent },
          ],
        });
        const rewrittenParent = contentOf(files, rollout(parentId));
        const [childMeta, childContext] = recordsOf(contentOf(files, rollout(childId)));
        expect(childContext).toEqual({
          ordinal: 3,
          type: "turn_context",
          payload: { cwd: "/workspace/repo" },
        });
        const offset =
          Schema.decodeUnknownSync(ChildMeta)(childMeta).payload.history_base.end_byte_offset;
        expect(offset).not.toBe(boundary);
        const kept = Buffer.from(rewrittenParent).subarray(0, offset).toString();
        expect(recordsOf(kept)).toEqual([
          { ...meta(parentId), payload: { ...meta(parentId).payload, cwd: "/workspace/repo" } },
          { ordinal: 1, type: "turn_context", payload: { cwd: "/workspace/repo" } },
          { ordinal: 2, type: "response_item", payload: reasoning },
        ]);
        expect(rewrittenParent).toContain(JSON.stringify(reasoning));
      }),
    );

    it.effect("fails when a rollout's ancestor is not among the files", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          rewriteNativeConversation({
            provider: "codex",
            source: shop,
            target: mend,
            files: [
              {
                relativePath: rollout(childId),
                content: ndjson(
                  meta(childId, {
                    thread_id: parentId,
                    end_byte_offset: boundary,
                    end_ordinal_exclusive: 3,
                  }),
                ),
              },
            ],
          }),
        );
        expect(error._tag).toBe("NativeHistoryError");
      }),
    );
  });

  it.effect.each([
    { name: "a truncated last record", broken: `{"type":"user"}\n{"type":"assis` },
    { name: "a line that is not JSON", broken: `{"type":"user"}\nnot json\n` },
  ])("fails the whole rewrite on $name", ({ broken }) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        rewriteNativeConversation({
          provider: "claude",
          source: shop,
          target: mend,
          files: [
            { relativePath: toolResult, content: "/home/ana/code/shop" },
            {
              relativePath: `.claude/projects/-home-ana-code-shop/${sessionId}.jsonl`,
              content: broken,
            },
          ],
        }),
      );
      expect(error._tag).toBe("NativeHistoryError");
    }),
  );

  describe("repeated rewrites", () => {
    const input: NativeConversationRewriteInput = {
      provider: "claude",
      source: shop,
      target: mend,
      files: [
        {
          relativePath: `.claude/projects/-home-ana-code-shop/${sessionId}.jsonl`,
          content:
            ndjson(
              {
                type: "user",
                cwd: "/home/ana/code/shop",
                message: { content: "~/.claude/plans/p.md" },
              },
              {
                type: "assistant",
                message: {
                  content: [
                    { type: "thinking", thinking: "in /home/ana/code/shop", signature: "c2ln" },
                  ],
                },
              },
            ) +
            // A record as another writer formats it; untouched records keep their bytes.
            `{ "type": "system",  "note": "caf\\u00e9", "n": 1.0 }\n`,
        },
      ],
    };

    it.effect("finds nothing on a second pass", () =>
      Effect.gen(function* () {
        const once = yield* rewriteNativeConversation(input);
        const twice = yield* rewriteNativeConversation({ ...input, files: once.files });
        expect(once.report.rewritten).toBe(2);
        expect(twice.files).toEqual(once.files);
        expect(twice.report.rewritten).toBe(0);
      }),
    );

    it.effect("returns the input unchanged when the target is the source", () =>
      Effect.gen(function* () {
        const same = yield* rewriteNativeConversation({ ...input, target: shop });
        expect(same.files).toEqual(input.files);
        expect(same.report.rewritten).toBe(0);
      }),
    );
  });
});
