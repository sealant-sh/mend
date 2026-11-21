import { describe, expect, it } from "vitest";

import { restoreMarks } from "./checkpoint-restores.ts";

const restore = (id: string, actorId: string, createdAt: string) => ({
  id,
  actorId,
  target: { id: "cp-3", ordinal: 3 },
  saved: { id: "cp-5", ordinal: 5 },
  result: { id: "cp-6", ordinal: 6 },
  createdAt,
});

describe("restoreMarks", () => {
  it("says who went back, oldest first: you, a member by name, or someone when the roster can't say", () => {
    const names = new Map([["ada", "Ada Lovelace"]]);
    const marks = restoreMarks(
      [
        restore("r-2", "ada", "2026-11-21T10:05:00.000Z"),
        restore("r-1", "me", "2026-11-21T10:01:00.000Z"),
        restore("r-3", "gone", "2026-11-21T10:09:00.000Z"),
      ],
      "me",
      (userId) => names.get(userId) ?? null,
    );
    expect(marks.map((mark) => [mark.key, mark.who])).toEqual([
      ["restore:r-1", "You"],
      ["restore:r-2", "Ada Lovelace"],
      ["restore:r-3", "Someone"],
    ]);
  });
});
