import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";

const { cleanups, fixture } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
describe("server lifecycle", { timeout: 30_000 }, () => {
  it.each([
    ["1.0.0-beta.2", "1.0.0-beta.11"],
    ["1.0.0-rc.1", "1.0.0"],
    ["1.9.0", "1.10.0"],
  ])("orders %s before %s and refuses the reverse", async (oldVersion, targetVersion) => {
    const f = await fixture();
    f.update({ images: { [oldVersion]: oldVersion, [targetVersion]: targetVersion } });
    expect(await f.setup(oldVersion)).toEqual({ _tag: "ok" });
    expect(await f.upgrade(targetVersion)).toEqual({ _tag: "ok" });
    const target = f.active();
    expect(await f.upgrade(oldVersion)).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("Refusing downgrade"),
    });
    expect(f.active()).toBe(target);
  });
});
