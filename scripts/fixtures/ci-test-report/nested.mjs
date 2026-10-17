import test, { describe, it } from "node:test";

describe("suite", () => {
  it("inner", () => {});
  it.skip("skipped", () => {});
  it.todo("pending");
});

test("top", async (t) => {
  console.log("output from a test");
  await t.test("child", () => {});
});

test("fails", () => {
  throw new Error("boom");
});
