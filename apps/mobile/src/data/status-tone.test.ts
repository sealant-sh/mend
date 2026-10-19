import { describe, expect, it } from "vitest";

import { toneOf } from "./status-tone";

describe("toneOf", () => {
  it("gives only waiting the waiting tone; idle is live work that asks nothing", () => {
    expect(toneOf("waiting")).toBe("waiting");
    expect(toneOf("idle")).toBe("live");
    expect(toneOf("running")).toBe("live");
    expect(toneOf("completed")).toBe("observed");
    expect(toneOf("failed")).toBe("breakage");
    expect(toneOf("stopped")).toBe("pending");
  });
});
