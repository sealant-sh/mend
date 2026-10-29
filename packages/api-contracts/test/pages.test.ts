import { describe, expect, it } from "vitest";

import * as contracts from "../src/index.ts";

describe("the pages contract", () => {
  it("leaves the frame URL's lifetimes to @mend/domain/workbench, their one import path", () => {
    expect(Object.keys(contracts)).not.toContain("PAGE_FRAME_TTL_MS");
    expect(Object.keys(contracts)).not.toContain("PAGE_FRAME_MIN_URL_LIFE_MS");
  });
});
