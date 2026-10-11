import { describe, expect, it } from "vitest";

import {
  conversationFilesOf,
  conversationPlaceOf,
  capturedTranscriptsOf,
  personalPlaceOf,
  relativeTo,
  SHARED_PLACE,
  underPlace,
} from "./person-readers.ts";

const ID = "0199a000-0000-7000-8000-00000000000a";
const OTHER = "0199a000-0000-7000-8000-00000000000b";

describe("where a session's conversation lies (docs/adr/0016, decision 12)", () => {
  it("is the shared home in a shared executor, and the process's person's saved directory in a person one", () => {
    expect(
      conversationPlaceOf({
        layout: "shared",
        person: "alice",
        harness: "claude",
        sharedConversation: null,
      }),
    ).toBe(SHARED_PLACE);
    const alice = conversationPlaceOf({
      layout: "person",
      person: "alice",
      harness: "claude",
      sharedConversation: null,
    });
    expect(alice?.root).toBe("harness/people/alice");
    expect(alice?.carried).toBe("harness/people/alice/.mend-saved/carried-transcripts");
    // Nobody's when the person is not known.
    expect(
      conversationPlaceOf({
        layout: "person",
        person: null,
        harness: "claude",
        sharedConversation: null,
      }),
    ).toBeNull();
  });

  it("is the session's conversation in its owner's directory once shared, never for opencode", () => {
    const shared = conversationPlaceOf({
      layout: "person",
      person: "bob",
      harness: "codex",
      sharedConversation: { owner: "alice", sessionId: "sess-1" },
    });
    expect(shared?.root).toBe("harness/people/alice/conversations/sess-1");
    expect(shared?.carried).toBeNull();
    expect(
      conversationPlaceOf({
        layout: "person",
        person: "alice",
        harness: "opencode",
        sharedConversation: { owner: "alice", sessionId: "sess-1" },
      })?.root,
    ).toBe("harness/people/alice");
  });

  it("reads nothing past its own directory, and maps memory paths both ways", () => {
    const alice = personalPlaceOf("alice");
    expect(relativeTo(alice, "harness/people/alice/.claude/projects/p/x.jsonl")).toBe(
      ".claude/projects/p/x.jsonl",
    );
    expect(relativeTo(alice, "harness/people/alice2/.claude/projects/p/x.jsonl")).toBeNull();
    expect(relativeTo(alice, "harness/people/bob/.claude/projects/p/x.jsonl")).toBeNull();
    expect(relativeTo(SHARED_PLACE, "harness/.claude/projects/p/x.jsonl")).toBe(
      ".claude/projects/p/x.jsonl",
    );
    expect(underPlace(alice, alice.savedPathOf(".codex/memories_1.sqlite"))).toBe(
      "harness/people/alice/codex-db/memories_1.sqlite",
    );
    expect(alice.homePathOf("codex-db/memories_1.sqlite")).toBe(".codex/memories_1.sqlite");
    expect(alice.homePathOf(".mend-saved/agent-memory-delivered.json")).toBe(
      ".mend/agent-memory-delivered.json",
    );
  });
});

describe("a conversation's files, by exact provider session id", () => {
  it("takes Claude's transcript and its directory, a Codex rollout and a pi session, and nothing else", () => {
    const paths = [
      `.claude/projects/-workspace-repo/${ID}.jsonl`,
      `.claude/projects/-workspace-repo/${ID}/tool-results/a.txt`,
      `.claude/projects/-workspace-repo/${OTHER}.jsonl`,
      `.claude/projects/-workspace-repo/memory/MEMORY.md`,
      `.codex/sessions/2026/10/01/rollout-2026-10-01T00-00-00-${ID}.jsonl`,
      `.codex/archived_sessions/rollout-2026-09-01T00-00-00-${ID}.jsonl`,
      `.codex/sessions/2026/10/01/rollout-2026-10-01T00-00-00-${OTHER}.jsonl`,
      `.pi/agent/sessions/--workspace-repo--/2026-10-01T00-00-00_${ID}.jsonl`,
    ];
    expect(conversationFilesOf("claude", ID, paths)).toEqual([
      `.claude/projects/-workspace-repo/${ID}.jsonl`,
      `.claude/projects/-workspace-repo/${ID}/tool-results/a.txt`,
    ]);
    expect(conversationFilesOf("codex", ID, paths)).toEqual([
      `.codex/sessions/2026/10/01/rollout-2026-10-01T00-00-00-${ID}.jsonl`,
      `.codex/archived_sessions/rollout-2026-09-01T00-00-00-${ID}.jsonl`,
    ]);
    expect(conversationFilesOf("pi", ID, paths)).toEqual([
      `.pi/agent/sessions/--workspace-repo--/2026-10-01T00-00-00_${ID}.jsonl`,
    ]);
    expect(conversationFilesOf("opencode", ID, paths)).toEqual([]);
    expect(conversationFilesOf("claude", "not-an-id", paths)).toEqual([]);
    // A path that climbs out of the conversation is never one of its files.
    expect(
      conversationFilesOf("claude", ID, [
        `.claude/projects/-workspace-repo/${ID}/../../../../.bashrc`,
        `.claude/projects/-workspace-repo/${ID}/./x`,
      ]),
    ).toEqual([]);
  });
});

/** A capture listing's entry written at `ms`. */
const entry = (kind: "file" | "symlink", ms: number) => ({
  name: "x",
  kind,
  mode: 0o644,
  size: 1,
  mtime: BigInt(ms) * 1_000_000n,
});

describe("the transcripts the external-agent observer reads in a capture", () => {
  const alice = personalPlaceOf("alice");
  const at = (relative: string) => `${alice.root}/${relative}`;

  it("are the harness's files under the place, newest first, never a carried conversation or a link", () => {
    const files = [
      { path: at(`.claude/projects/-workspace-repo/${ID}.jsonl`), entry: entry("file", 1_000) },
      { path: at(`.claude/projects/-workspace-repo/${OTHER}.jsonl`), entry: entry("file", 3_000) },
      {
        path: at(".claude/projects/-workspace-repo/0199a000-0000-7000-8000-00000000000c.jsonl"),
        entry: entry("symlink", 9_000),
      },
      // Another person's saved directory, though it is newer: never read for Alice.
      {
        path: `${personalPlaceOf("maria").root}/.claude/projects/-workspace-repo/${ID}.jsonl`,
        entry: entry("file", 8_000),
      },
    ];
    expect(capturedTranscriptsOf(alice, "claude", files, new Set())).toEqual([
      { providerSessionId: OTHER, mtimeMs: 3_000 },
      { providerSessionId: ID, mtimeMs: 1_000 },
    ]);
    expect(capturedTranscriptsOf(alice, "claude", files, new Set([OTHER]))).toEqual([
      { providerSessionId: ID, mtimeMs: 1_000 },
    ]);
  });

  it("are none for a harness that keeps no transcript file", () => {
    expect(
      capturedTranscriptsOf(
        alice,
        "opencode",
        [{ path: at(".local/share/opencode/opencode.db"), entry: entry("file", 1_000) }],
        new Set(),
      ),
    ).toEqual([]);
  });
});
