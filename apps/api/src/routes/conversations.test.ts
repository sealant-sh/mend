import { createHash } from "node:crypto";

import { SessionId } from "@mend/domain";
import {
  CONVERSATION_ARCHIVE_CONTENT_TYPE,
  type ConversationArchiveHeader,
  encodeConversationArchive,
  Session,
} from "@mend/domain/workbench";
import type { SessionEngine } from "@mend/sessions";
import { Effect, Result } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids, makeSession } from "../../test/support/tenancy-harness.ts";
import { checkConversation } from "../conversation-import.ts";

const sharedA = ids("shared-a");
const CLAUDE_ID = "0f9c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const CODEX_ID = "019f2461-b4d9-73b3-973b-7c6daf3cb984";
const SLUG = "-home-ada-src-shop";
const TRANSCRIPT = `.claude/projects/${SLUG}/${CLAUDE_ID}.jsonl`;
const ROLLOUT = `.codex/sessions/2026/11/05/rollout-2026-11-05T10-00-00-${CODEX_ID}.jsonl`;

const jsonl = (...records: ReadonlyArray<unknown>) =>
  records.map((record) => JSON.stringify(record)).join("\n") + "\n";
const claudeTranscript = (id = CLAUDE_ID) =>
  jsonl(
    {
      type: "user",
      sessionId: id,
      uuid: "u1",
      parentUuid: null,
      cwd: "/home/ada/src/shop",
      message: { role: "user", content: "Fix the cart total" },
    },
    {
      type: "assistant",
      sessionId: id,
      uuid: "a1",
      parentUuid: "u1",
      message: {
        id: "msg_1",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Fixed the rounding in /home/ada/src/shop/cart.ts.",
          },
        ],
      },
    },
  );
const codexRollout = (id = CODEX_ID) =>
  jsonl(
    { type: "session_meta", payload: { id, cwd: "/home/ada/src/shop" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Add a test" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Added cart.test.ts." }],
      },
    },
  );

const text = (value: string) => new TextEncoder().encode(value);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

interface ArchiveFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}
const archive = (
  files: ReadonlyArray<ArchiveFile>,
  header: Partial<ConversationArchiveHeader> = {},
): Uint8Array =>
  encodeConversationArchive(
    {
      format: 1,
      harness: "claude",
      nativeId: CLAUDE_ID,
      source: { checkout: "/home/ada/src/shop", home: "/home/ada" },
      title: "Fix the cart total",
      model: "claude-opus-5-5",
      effort: "high",
      permissionMode: "ask",
      files: files.map((file) => ({
        relativePath: file.relativePath,
        byteLength: file.bytes.byteLength,
        sha256: sha256(file.bytes),
      })),
      ...header,
    },
    files,
  );
const claudeFiles: ReadonlyArray<ArchiveFile> = [
  { relativePath: TRANSCRIPT, bytes: text(claudeTranscript()) },
  {
    relativePath: `.claude/projects/${SLUG}/${CLAUDE_ID}/subagents/agent-a1b2c3d4e5f6a7b8c.jsonl`,
    bytes: text(jsonl({ type: "user", sessionId: CLAUDE_ID, isSidechain: true })),
  },
  {
    relativePath: `.claude/projects/${SLUG}/${CLAUDE_ID}/tool-results/shot.png`,
    // Not UTF-8, and not refused for it: a screenshot travels as bytes.
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]),
  },
];
const codexFiles: ReadonlyArray<ArchiveFile> = [
  { relativePath: ROLLOUT, bytes: text(codexRollout()) },
];
const codexHeader: Partial<ConversationArchiveHeader> = {
  harness: "codex",
  nativeId: CODEX_ID,
  title: "Add a test",
  model: null,
  effort: null,
};

const reasonOf = (body: Uint8Array) => {
  const checked = checkConversation(body);
  return Result.isFailure(checked) ? checked.failure.reason : "taken";
};

const corrupted = () => {
  const body = archive(claudeFiles);
  body[body.byteLength - 1] = 0x00;
  return body;
};

describe("checkConversation", () => {
  it("takes a whole Claude conversation and a Codex one", () => {
    expect(reasonOf(archive(claudeFiles))).toBe("taken");
    expect(reasonOf(archive(codexFiles, codexHeader))).toBe("taken");
  });

  it.each([
    ["damaged", "a body cut short", () => archive(claudeFiles).subarray(0, -1)],
    ["damaged", "a file that differs from its digest", corrupted],
    [
      "path-not-allowed",
      "a login among the files",
      () =>
        archive([...claudeFiles, { relativePath: ".claude/.credentials.json", bytes: text("{}") }]),
    ],
    ["path-not-allowed", "a Codex file in a Claude conversation", () => archive(codexFiles)],
    ["path-duplicated", "a file listed twice", () => archive([...claudeFiles, claudeFiles[0]!])],
    ["transcript-missing", "no transcript", () => archive(claudeFiles.slice(1))],
    [
      "transcript-invalid",
      "another conversation's transcript",
      () =>
        archive([
          {
            relativePath: TRANSCRIPT,
            bytes: text(claudeTranscript("11111111-2222-4333-8444-555555555555")),
          },
        ]),
    ],
    [
      "transcript-invalid",
      "a record that is not JSON",
      () => archive([{ relativePath: TRANSCRIPT, bytes: text('{"type":"user"\n') }]),
    ],
    [
      "transcript-invalid",
      "a rollout of another thread",
      () =>
        archive(
          [
            {
              relativePath: ROLLOUT,
              bytes: text(codexRollout("another-thread")),
            },
          ],
          codexHeader,
        ),
    ],
    [
      "not-rewritable",
      "files from two Claude project folders",
      () =>
        archive([
          ...claudeFiles,
          {
            relativePath: `.claude/projects/-home-ada-elsewhere/${CLAUDE_ID}/tool-results/a.txt`,
            bytes: text("output"),
          },
        ]),
    ],
    [
      "not-rewritable",
      "a Codex ancestor left out",
      () =>
        archive(
          [
            {
              relativePath: ROLLOUT,
              bytes: text(
                jsonl({
                  type: "session_meta",
                  payload: {
                    id: CODEX_ID,
                    history_base: { thread_id: "ancestor" },
                  },
                }),
              ),
            },
          ],
          codexHeader,
        ),
    ],
  ] as const)("refuses with %s: %s", (reason, _what, body) => {
    expect(reasonOf(body())).toBe(reason);
  });
});

let opened: TenancyApi | null = null;
afterEach(async () => {
  await opened?.dispose();
  opened = null;
});

const HANDED_OFF = SessionId.make("session-handed-off");
const CAROLS = SessionId.make("session-carol-handed-off");
const unlaunched = (id: SessionId, owner: string, harness = "claude"): Session =>
  new Session({
    ...makeSession(id, sharedA.project, sharedA.worktree, owner),
    harness,
    status: "starting",
    label: null,
    sealantWorkspaceId: null,
    sealantSessionId: null,
    sealantRunId: null,
    settledAt: null,
    startedAt: null,
  });

const worldWith = async (limits: Parameters<typeof createTenancyApi>[0] = {}) => {
  const seen = { made: new Array<string>(), audits: new Array<string>() };
  let count = 0;
  const provisionSessionIn: SessionEngine["Service"]["provisionSessionIn"] = (worktreeId, input) =>
    Effect.sync(() => {
      count += 1;
      const session = new Session({
        ...unlaunched(
          SessionId.make(`session-imported-${count}`),
          input.ownerUserId ?? "",
          input.harness,
        ),
        worktreeId,
        label: input.label,
      });
      seen.made.push(`${worktreeId}:${input.harness}:${input.label}`);
      opened?.world.addSession(session);
      return session;
    });
  // What the import writes on the session row: its label and its first launch's options.
  const update = (id: SessionId, patch: Partial<Session>) =>
    Effect.sync(() => {
      const row = opened?.world.sessions.get(id);
      if (row !== undefined) opened?.world.addSession(new Session({ ...row, ...patch }));
    });
  const made = await createTenancyApi(limits, {
    sessions: [unlaunched(HANDED_OFF, "alice"), unlaunched(CAROLS, "carol")],
    implement: {
      sessions: {
        setLabel: (id, label) => update(id, { label }),
        setLaunchOptions: (id, options) => update(id, options),
      },
      engine: {
        launchUnderWay: () => false,
        provisionSessionIn,
        detach: (effect) => Effect.forkDetach(effect),
      },
      audit: {
        record: (event) =>
          Effect.sync(() => {
            seen.audits.push(`${event.action}:${event.subjectId}:${JSON.stringify(event.data)}`);
          }),
      },
    },
  });
  opened = made;
  return { api: made, seen };
};

const post = (on: TenancyApi, user: "alice" | "carol" | "dave", body: Uint8Array, query: string) =>
  on.postBytes(
    user,
    `/api/projects/${sharedA.project}/conversations?${query}`,
    body,
    CONVERSATION_ARCHIVE_CONTENT_TYPE,
  );
const lookup = (on: TenancyApi, user: "alice" | "carol") =>
  on.request(
    user,
    "GET",
    `/api/projects/${sharedA.project}/conversations?harness=claude&nativeId=${CLAUDE_ID}`,
  );

describe("POST /projects/:id/conversations", () => {
  it("lands a conversation in the session a handoff made, its history shown and its options kept", async () => {
    const { api, seen } = await worldWith();
    expect(await (await lookup(api, "alice")).json()).toEqual({
      session: null,
    });
    const response = await post(api, "alice", archive(claudeFiles), `session=${HANDED_OFF}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      replayed: false,
      turns: 1,
      session: {
        id: HANDED_OFF,
        label: "Fix the cart total",
        model: "claude-opus-5-5",
        effort: "high",
      },
    });
    const turns = [...api.world.turns.values()].filter((turn) => turn.sessionId === HANDED_OFF);
    expect(turns.map((turn) => [turn.input, turn.imported, turn.status])).toEqual([
      ["Fix the cart total", true, "completed"],
    ]);
    expect(seen.made).toEqual([]);
    // The event says it happened and how much arrived; never a path or a byte of it.
    expect(seen.audits).toHaveLength(1);
    expect(seen.audits[0]).toMatch(/^session\.conversation_imported:session-handed-off:/);
    expect(seen.audits[0]).not.toMatch(/cart|\.claude|shop/);
  });

  it("makes a new session in the worktree for each further thread of the checkout", async () => {
    const { api, seen } = await worldWith();
    const first = await post(api, "alice", archive(claudeFiles), `worktree=${sharedA.worktree}`);
    const second = await post(
      api,
      "alice",
      archive(codexFiles, codexHeader),
      `worktree=${sharedA.worktree}`,
    );
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(seen.made).toEqual([
      `${sharedA.worktree}:claude:Fix the cart total`,
      `${sharedA.worktree}:codex:Add a test`,
    ]);
    const [a, b] = [await first.json(), await second.json()];
    expect(a.session.id).not.toBe(b.session.id);
    expect([a.turns, b.turns]).toEqual([1, 1]);
  });

  it("answers the same conversation imported again with the session it made, making nothing", async () => {
    const { api, seen } = await worldWith();
    const first = await (
      await post(api, "alice", archive(claudeFiles), `worktree=${sharedA.worktree}`)
    ).json();
    const again = await post(api, "alice", archive(claudeFiles), `session=${HANDED_OFF}`);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      replayed: true,
      turns: 1,
      session: { id: first.session.id },
    });
    expect(seen.made).toHaveLength(1);
    expect(seen.audits).toHaveLength(1);
    expect((await (await lookup(api, "alice")).json()).session.id).toBe(first.session.id);
    // Carol importing her own copy is hers; nothing of alice's is named to her.
    expect(await (await lookup(api, "carol")).json()).toEqual({
      session: null,
    });
  });

  it.each([
    [
      "a session an agent already started in",
      `session=${sharedA.session}`,
      codexFiles,
      codexHeader,
      "session-launched",
    ],
    [
      "a session of another harness",
      `session=${HANDED_OFF}`,
      codexFiles,
      codexHeader,
      "harness-mismatch",
    ],
    ["neither a session nor a worktree", "", claudeFiles, {}, "wrong-target"],
    [
      "both a session and a worktree",
      `session=${HANDED_OFF}&worktree=${sharedA.worktree}`,
      claudeFiles,
      {},
      "wrong-target",
    ],
  ] as const)(
    "refuses %s by name, importing nothing",
    async (_what, query, files, header, reason) => {
      const { api, seen } = await worldWith();
      const response = await post(api, "alice", archive(files, header), query);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        _tag: "ConversationImportRefused",
        reason,
        message: expect.stringMatching(/nothing was imported$/),
      });
      expect(seen.audits).toEqual([]);
      expect([...api.world.turns.values()].filter((turn) => turn.imported)).toEqual([]);
    },
  );

  it("names neither another person's session nor a project the caller cannot see", async () => {
    const { api } = await worldWith();
    const theirs = await post(api, "alice", archive(claudeFiles), `session=${CAROLS}`);
    expect(theirs.status).toBe(404);
    const unseen = await post(api, "dave", archive(claudeFiles), `worktree=${sharedA.worktree}`);
    expect(unseen.status).toBe(404);
  });

  it("refuses a conversation over the server's limit by its size, making nothing", async () => {
    const { api, seen } = await worldWith({ conversationBytes: 64 });
    const body = archive(claudeFiles);
    const response = await post(api, "alice", body, `worktree=${sharedA.worktree}`);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      budget: "conversationBytes",
      limit: 64,
      message: expect.stringContaining(`this conversation is ${body.byteLength} bytes`),
    });
    expect(seen.made).toEqual([]);
  });
});
