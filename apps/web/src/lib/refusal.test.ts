import { describe, expect, it } from "vitest";

import { failureWords, refusalTagOf } from "#/lib/refusal";
import { refusedWith as refused } from "#/lib/refusal-fixture";

describe("a refusal from the web tier", () => {
  it("names its tag beside the words, never in them", () => {
    const error = refused("StoreFailure", "Already declared on this project: verify-proj");
    expect(refusalTagOf(error)).toBe("StoreFailure");
    expect(failureWords(error, "x")).toBe("Already declared on this project: verify-proj");
  });

  it("has no tag when it did not come from the API", () => {
    expect(refusalTagOf(new Error("Failed to fetch"))).toBeNull();
    expect(refusalTagOf(refused(null, "The Mend server is not answering."))).toBeNull();
  });

  it("falls back to the caller's words when it has none", () => {
    expect(failureWords(new Error(""), "Not saved.")).toBe("Not saved.");
    expect(failureWords(undefined, "Not saved.")).toBe("Not saved.");
  });
});
