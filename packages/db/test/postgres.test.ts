import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { postgresTestConfig } from "./postgres.ts";

beforeEach(() => {
  vi.stubEnv("CI", undefined);
  vi.stubEnv("MEND_TEST_DATABASE_URL", undefined);
  vi.stubEnv("MEND_SKIP_POSTGRES_TESTS", undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("PostgreSQL test prerequisites", () => {
  it("requires the local development database by default", () => {
    expect(postgresTestConfig()).toEqual({
      adminUrl: "postgres://mend:mend@localhost:5434/mend",
      skip: false,
    });
  });

  it("allows an explicit opt-out only for an unconfigured local run", () => {
    vi.stubEnv("MEND_SKIP_POSTGRES_TESTS", "1");
    expect(postgresTestConfig().skip).toBe(true);
    vi.stubEnv("CI", "true");
    expect(() => postgresTestConfig()).toThrow("cannot be skipped");
    vi.stubEnv("CI", undefined);
    vi.stubEnv("MEND_TEST_DATABASE_URL", "postgres://localhost:1/unavailable");
    expect(() => postgresTestConfig()).toThrow("cannot be skipped");
  });

  it.each(["postgres:", "postgresql:"])("requires a configured %s server", (protocol) => {
    const adminUrl = `${protocol}//localhost:1/unavailable`;
    vi.stubEnv("MEND_TEST_DATABASE_URL", adminUrl);
    vi.stubEnv("MEND_SKIP_POSTGRES_TESTS", "0");
    expect(postgresTestConfig()).toEqual({ adminUrl, skip: false });
  });

  it.each(["", "not-a-url", "https://localhost/database"])(
    "rejects an invalid configured URL (%j)",
    (url) => {
      vi.stubEnv("MEND_TEST_DATABASE_URL", url);
      expect(() => postgresTestConfig()).toThrow("must be a PostgreSQL URL");
    },
  );

  it("rejects misspelled opt-outs instead of changing the test scope", () => {
    vi.stubEnv("MEND_SKIP_POSTGRES_TESTS", "true");
    expect(() => postgresTestConfig()).toThrow("must be 0 or 1");
  });
});
