import { describe, expect, it } from "vitest";

import { uuidV4 } from "#/lib/uuid";

describe("uuidV4", () => {
  it("makes distinct RFC 9562 version 4 ids", () => {
    const ids = Array.from({ length: 64 }, () => uuidV4());

    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
