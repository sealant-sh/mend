import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";

const { cleanups, fixture } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
describe("server lifecycle", { timeout: 30_000 }, () => {
  it.each([
    ["1.0.0-alpha", "1.0.0-alpha.1"],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta"],
    ["1.0.0-alpha.beta", "1.0.0-beta"],
    // A release dry run's stamp (release-cli.yml): above main's next.N and the stable before it,
    // so the dry run upgrades from them; below next.N+1 and the stable after it.
    ["0.36.0-next.988", "0.36.0-next.988.dryrun.38931186422.1"],
    ["0.35.1", "0.36.0-next.988.dryrun.38931186422.1"],
    ["0.36.0-next.988.dryrun.38931186422.1", "0.36.0-next.989"],
    ["0.36.0-next.988.dryrun.38931186422.1", "0.36.0"],
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
