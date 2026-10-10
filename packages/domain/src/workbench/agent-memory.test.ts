import { describe, expect, it } from "vitest";

import { agentMemoryNameOf, agentMemoryPathOf } from "./agent-memory.ts";

describe("agentMemoryPathOf", () => {
  it.each([
    ["MEMORY.md", ".claude/projects/-workspace-repo/memory/MEMORY.md"],
    ["codex:MEMORY.md", ".codex/memories/MEMORY.md"],
    ["memories_1.sqlite", ".codex/memories_1.sqlite"],
    // `mend memory` lists it under codex; the qualified name answered "not in memory"
    // (RC 0.36.0-next.754, B-F3).
    ["codex:memories_1.sqlite", ".codex/memories_1.sqlite"],
    [".codex/memories/notes.md", ".codex/memories/notes.md"],
  ])("finds %s at %s", (name, expected) => {
    expect(agentMemoryPathOf(name)).toBe(expected);
  });

  it("takes back the name a listing shows, qualified by its harness", () => {
    const listed = agentMemoryNameOf(".codex/memories_1.sqlite");
    expect(listed).toEqual({ harness: "codex", name: "memories_1.sqlite" });
    expect(agentMemoryPathOf(`${listed?.harness}:${listed?.name}`)).toBe(
      ".codex/memories_1.sqlite",
    );
  });
});
