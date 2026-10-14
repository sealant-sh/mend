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
      "a changed address",
      (env: string) => env.replace("MEND_BIND_HOST=127.0.0.1", "MEND_BIND_HOST=0.0.0.0"),
      "MEND_BIND_HOST in server.env does not match",
    ],
    [
      "a line every server.env has carried, missing",
      (env: string) => env.replace(/^APP_URL=.*\n/m, ""),
      "APP_URL is missing from server.env",
    ],
    [
      "a Garage line, missing",
      (env: string) => env.replace(/^MEND_GARAGE_RPC_SECRET=.*\n/m, ""),
      "MEND_GARAGE_RPC_SECRET is missing from server.env",
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
