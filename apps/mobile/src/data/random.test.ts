import { afterEach, describe, expect, it, vi } from "vitest";

import { uuidV4 } from "./random";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => vi.unstubAllGlobals());

describe("uuidV4", () => {
  it("is a UUID v4 from Web Crypto without randomUUID", () => {
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes.fill(0xff) });
    expect(uuidV4()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  });

  it("is a UUID v4, a new one each time, where the runtime has no crypto at all", () => {
    vi.stubGlobal("crypto", undefined);
    const made = Array.from({ length: 50 }, uuidV4);
    for (const id of made) expect(id).toMatch(UUID_V4);
    expect(new Set(made).size).toBe(made.length);
  });
});
