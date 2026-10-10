import { describe, expect, it } from "vitest";

import { instanceIdOf } from "./instance-id.ts";

describe("instanceIdOf", () => {
  // The same vector is in apps/cli/src/server-setup.test.ts: setup and the server must agree.
  it("derives the shared test vector", () => {
    expect(instanceIdOf("ab".repeat(32))).toBe("95478bc04554a28d7584e2e232e451e0");
  });

  it("differs between installs", () => {
    expect(instanceIdOf("ab".repeat(32))).not.toBe(instanceIdOf("cd".repeat(32)));
  });
});
