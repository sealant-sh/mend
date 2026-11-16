import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  type ConversationArchiveHeader,
  decodeConversationArchive,
  encodeConversationArchive,
  isImportedConversationPath,
} from "./imported-conversation.ts";
import { NativeFileRef } from "./native-history.ts";

const isNativeConversationFile = (relativePath: string): boolean =>
  Schema.is(NativeFileRef)({
    relativePath,
    sha256: "0".repeat(64),
    byteLength: 0,
  });

const ID = "0f9c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const SLUG = "-home-ada-src-shop";

describe("isImportedConversationPath", () => {
  it.each([
    // What a fork's seal already takes.
    `.claude/projects/${SLUG}/${ID}.jsonl`,
    `.claude/projects/${SLUG}/${ID}/tool-results/toolu_01.txt`,
    `.claude/tasks/${ID}/3.json`,
    `.claude/todos/${ID}-agent-${ID}.json`,
    ".claude/plans/brave-otter.md",
    // What an imported conversation also carries.
    `.claude/projects/${SLUG}/${ID}/tool-results/mcp-blob-1794436312011-r8nni8.png`,
    `.claude/projects/${SLUG}/${ID}/subagents/agent-a1b2c3d4e5f6a7b8c.jsonl`,
    `.claude/projects/${SLUG}/${ID}/subagents/agent-a1b2c3d4e5f6a7b8c.meta.json`,
    `.claude/projects/${SLUG}/${ID}/subagents/workflows/wf_5a87406b-233/agent-ac8afee059ac6d959.jsonl`,
    `.claude/projects/${SLUG}/${ID}/subagents/workflows/wf_5a87406b-233/journal.jsonl`,
  ])("takes the Claude file %s", (path) => {
    expect(isImportedConversationPath("claude", path)).toBe(true);
    expect(isImportedConversationPath("codex", path)).toBe(false);
  });

  it.each([
    ".codex/sessions/2026/11/05/rollout-2026-11-05T10-00-00-019f2461-b4d9.jsonl",
    // Codex moves an archived rollout into one flat directory.
    ".codex/archived_sessions/rollout-2026-07-02T22-50-10-019f2461-b4d9.jsonl",
  ])("takes the Codex file %s", (path) => {
    expect(isImportedConversationPath("codex", path)).toBe(true);
  });

  it.each([
    [".claude/.credentials.json", "a login"],
    [".claude/settings.json", "a setting"],
    [".codex/auth.json", "a login"],
    [".codex/config.toml", "a setting"],
    [`.claude/tasks/${ID}/.lock`, "a lock"],
    [`.claude/projects/${SLUG}/${ID}/tool-results/../../../../.credentials.json`, "a traversal"],
    [`.claude/projects/${SLUG}/${ID}/tool-results/run.sh`, "a script"],
    [`.claude/projects/${SLUG}/${ID}/workflows/scripts/guide.js`, "a workflow script"],
    [".codex/sessions/2026/11/05/rollout-x.jsonl.zst", "a compressed rollout"],
    [`/home/ada/.claude/projects/${SLUG}/${ID}.jsonl`, "an absolute path"],
  ])("refuses %s (%s)", (path) => {
    expect(isImportedConversationPath(path.includes(".codex") ? "codex" : "claude", path)).toBe(
      false,
    );
  });

  it("takes every file a fork's seal takes", () => {
    for (const path of [
      `.claude/projects/${SLUG}/${ID}.jsonl`,
      `.claude/projects/${SLUG}/${ID}/tool-results/a.json`,
      ".codex/archived_sessions/2026/01/02/rollout-2026-01-02T00-00-00-abc.jsonl",
    ]) {
      expect(isNativeConversationFile(path)).toBe(true);
      expect(isImportedConversationPath(path.startsWith(".codex") ? "codex" : "claude", path)).toBe(
        true,
      );
    }
  });
});

const bytes = (text: string) => new TextEncoder().encode(text);
const header = (files: ConversationArchiveHeader["files"]): ConversationArchiveHeader => ({
  format: 1,
  harness: "claude",
  nativeId: ID,
  source: { checkout: "/home/ada/src/shop", home: "/home/ada" },
  title: "Fix the cart total",
  files,
});

describe("conversation archive", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
  const transcript = bytes('{"type":"user"}\n');
  const files = [
    {
      relativePath: `.claude/projects/${SLUG}/${ID}.jsonl`,
      byteLength: transcript.byteLength,
      sha256: "a".repeat(64),
    },
    {
      relativePath: `.claude/projects/${SLUG}/${ID}/tool-results/shot.png`,
      byteLength: png.byteLength,
      sha256: "b".repeat(64),
    },
  ];

  it("carries each file's bytes, a screenshot's included, back as they were", () => {
    const body = encodeConversationArchive(header(files), [
      { relativePath: files[0]!.relativePath, bytes: transcript },
      { relativePath: files[1]!.relativePath, bytes: png },
    ]);
    const decoded = decodeConversationArchive(body);
    expect(Result.isSuccess(decoded)).toBe(true);
    if (!Result.isSuccess(decoded)) return;
    expect(decoded.success.header.title).toBe("Fix the cart total");
    expect(decoded.success.entries.map((entry) => [...entry.bytes])).toEqual([
      [...transcript],
      [...png],
    ]);
  });

  it("refuses a body whose bytes are not exactly the files its header names", () => {
    const whole = encodeConversationArchive(header(files), [
      { relativePath: files[0]!.relativePath, bytes: transcript },
      { relativePath: files[1]!.relativePath, bytes: png },
    ]);
    for (const body of [whole.subarray(0, whole.byteLength - 1), new Uint8Array([...whole, 0])])
      expect(Result.isFailure(decodeConversationArchive(body))).toBe(true);
  });

  it("refuses a body with no header Mend reads", () => {
    for (const body of [
      bytes("no header line at all"),
      bytes("not json\n"),
      bytes(`${JSON.stringify({ ...header(files), format: 2 })}\n`),
      bytes(
        `${JSON.stringify({ ...header(files), source: { checkout: "shop", home: "/home/ada" } })}\n`,
      ),
    ])
      expect(Result.isFailure(decodeConversationArchive(body))).toBe(true);
  });
});
