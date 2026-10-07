import { describe, expect, it } from "vitest";

import {
  conversationFilesOf,
  conversationPlaceOf,
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
  });
});
