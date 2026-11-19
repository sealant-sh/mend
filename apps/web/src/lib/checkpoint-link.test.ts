import { describe, expect, it } from "vitest";

import { checkpointOfHash } from "./checkpoint-link.ts";

describe("a checkpoint's link", () => {
  it("reads the checkpoint a pull request's link names", () => {
    expect(checkpointOfHash("checkpoint-6")).toBe(6);
    expect(checkpointOfHash("#checkpoint-12")).toBe(12);
    expect(checkpointOfHash("land")).toBeNull();
    expect(checkpointOfHash("checkpoint-")).toBeNull();
  });
});
