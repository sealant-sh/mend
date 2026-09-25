import { describe, expect, it } from "vitest";

import type { AgentItemDto } from "./feed.ts";
import { AgentItemCursorStalled, readAgentItemsAfter } from "./items.ts";

const item = (id: string, seq: number, text = id): AgentItemDto => ({
  id,
  seq,
  turnId: "turn-1",
  kind: "assistant-message",
  status: "in-progress",
  title: null,
  text,
  createdAt: "2026-08-21T10:00:00.000Z",
  updatedAt: "2026-08-21T10:00:00.000Z",
});

describe("readAgentItemsAfter", () => {
  it("pages on from the highest sequence until a short page and keeps each item once", async () => {
    const asked: Array<number> = [];
    const pages: Record<number, ReadonlyArray<AgentItemDto>> = {
      4: [item("a", 5), item("b", 6)],
      6: [item("a", 7, "grown")],
    };
    const items = await readAgentItemsAfter(
      async (after) => {
        asked.push(after);
        return pages[after] ?? [];
      },
      4,
      2,
    );
    expect(asked).toEqual([4, 6]);
    expect(items.map((row) => [row.id, row.text])).toEqual([
      ["a", "grown"],
      ["b", "b"],
    ]);
  });

  it("refuses a full page that does not move the cursor", async () => {
    await expect(
      readAgentItemsAfter(async () => [item("a", 3), item("b", 2)], 3, 2),
    ).rejects.toBeInstanceOf(AgentItemCursorStalled);
  });
});
