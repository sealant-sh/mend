import test from "node:test";

test("waits", async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
});
