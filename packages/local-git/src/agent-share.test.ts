import { describe, expect, it } from "vitest";

import { retryDelayMs } from "./agent-share.ts";

describe("retryDelayMs", () => {
  it("doubles from a second and caps at thirty", () => {
    expect([1, 2, 3, 6, 7, 20].map(retryDelayMs)).toEqual(
      [1000, 2000, 4000, 32_000, 32_000, 32_000].map((ms) => Math.min(ms, 30_000)),
    );
  });
});
