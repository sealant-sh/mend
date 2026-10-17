import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";

const { cleanups, fixture, asBoxOn773 } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("the edge and the posture", { timeout: 120_000 }, () => {
  it.each([
    [
      "a line no render of the config carries",
      (env: string) => `${env}MEND_SURPRISE=1\n`,
      "server.env has MEND_SURPRISE, which the persisted server config does not account for",
    ],
    [
      "a Garage secret that is not the identity's",
      (env: string) =>
        env.replace(/^MEND_GARAGE_KEY_SECRET=.*$/m, `MEND_GARAGE_KEY_SECRET=${"0".repeat(64)}`),
      "MEND_GARAGE_KEY_SECRET in server.env does not match",
    ],
    [
      "an identity secret that is not the identity's",
      (env: string) =>
        env.replace(/^BETTER_AUTH_SECRET=.*$/m, `BETTER_AUTH_SECRET=${"0".repeat(64)}`),
      "server.env does not match the persisted server config and identity",
    ],
  ])("refuses an older generation with %s, and changes nothing", async (_, damage, message) => {
    const f = await fixture();
    await asBoxOn773(f);
    const old = f.active();
    const envFile = path.join(old, "server.env");
    const damaged = damage(fs.readFileSync(envFile, "utf8"));
    fs.writeFileSync(envFile, damaged);
    const commands = f.calls().length;
    expect(await f.upgrade()).toMatchObject({
      _tag: "error",
      message: expect.stringContaining(message),
    });
    expect(f.active()).toBe(old);
    expect(fs.readFileSync(envFile, "utf8")).toBe(damaged);
    expect(f.calls().length).toBe(commands);
  });
});
