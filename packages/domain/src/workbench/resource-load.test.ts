import { Redacted } from "effect";
import { describe, expect, it } from "vitest";

import {
  dumpFormat,
  loadCanAdvance,
  loadIsLive,
  parsePullUrl,
  scrubLoadMessage,
} from "./resource-load.ts";

describe("resource loads", () => {
  it("parses password once and displays only host and database", () => {
    const password = "load-test/secret@value";
    const parsed = parsePullUrl(
      Redacted.make(
        `postgres://alice:${encodeURIComponent(password)}@staging:5432/app?sslmode=require`,
      ),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.label).toBe("staging:5432/app");
    expect(parsed.value.connection).toBe("postgres://alice@staging:5432/app?sslmode=require");
    expect(Redacted.value(parsed.value.password)).toBe(password);
    expect(JSON.stringify(parsed)).not.toContain(password);
    expect(
      scrubLoadMessage(
        `bad ${password} ${encodeURIComponent(password)} postgres://alice:bad@host/db`,
        password,
      ),
    ).not.toContain(password);
  });
  it.each([
    "postgres://u:p@db/app?password=hidden",
    "postgres://u:p@db/app?service=hidden",
    "postgres://u:p%0Ass@db/app",
    "http://u:p@db/app",
    "not-a-url",
  ])("refuses credential side channels without echoing input", (raw) => {
    const parsed = parsePullUrl(Redacted.make(raw));
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain(raw);
  });
  it("detects custom dumps from magic, including truncated and plain sources", () => {
    expect(dumpFormat(new TextEncoder().encode("PGDMPanything"))).toBe("custom");
    expect(dumpFormat(new TextEncoder().encode("PGDM"))).toBe("plain");
    expect(dumpFormat(new TextEncoder().encode("CREATE TABLE foo (id int);"))).toBe("plain");
  });
  it("permits only the ordered state machine, including failure before installation", () => {
    expect(loadCanAdvance("receiving", "restoring")).toBe(true);
    expect(loadCanAdvance("restoring", "installing")).toBe(true);
    expect(loadCanAdvance("installing", "saving")).toBe(true);
    expect(loadCanAdvance("saving", "done")).toBe(true);
    expect(loadCanAdvance("receiving", "done")).toBe(false);
    expect(loadCanAdvance("done", "failed")).toBe(false);
    expect(loadIsLive("saving")).toBe(true);
    expect(loadIsLive("failed")).toBe(false);
  });
});
