import * as fs from "node:fs";
import * as path from "node:path";

import { DEFAULT_POOL_MAX } from "@mend/db";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
/** Where a server process's code comes from: the API, and every package it can load. */
const SOURCES = [path.join(ROOT, "apps/api/src"), path.join(ROOT, "packages")];
/** `listenEvents` itself, not a caller. */
const DEFINITION = path.join(ROOT, "packages/db/src/events.ts");

const sourceFiles = (dir: string): ReadonlyArray<string> =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return ["node_modules", "dist", "test", "test-fixtures"].includes(entry.name)
        ? []
        : sourceFiles(at);
    }
    return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [at] : [];
  });

/** Its code without comments, so a comment that names a call does not count as one. */
const codeOf = (file: string) =>
  fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:"'`])\/\/.*$/gmu, "$1");

const files = SOURCES.flatMap(sourceFiles).filter((file) => file !== DEFINITION);
const occurrences = (pattern: RegExp, of: ReadonlyArray<string>) =>
  of.flatMap((file) => [...codeOf(file).matchAll(pattern)].map(() => path.relative(ROOT, file)));

const FIX =
  "subscribe to the events bus (apps/api/src/events-bus.ts) instead of calling listenEvents";

// A hint, not the guard: Mend's pool counts every LISTEN however it is called, and refuses the one
// that would take its last connection (`guardListens`, packages/db/src/events.ts).
describe("the LISTEN connections one server pins (ADR 0017 10a outage, 2026-10-30)", () => {
  it("leave the default pool a connection for queries", () => {
    // Every `listenEvents` stream pins one pooled connection for good, and a server under
    // MEND_MODE=all runs every one of them: at the pool's size, no query runs and the server never
    // answers /api/health. A worker that hears events subscribes to the events bus instead.
    const listeners = occurrences(/\blistenEvents\(/gu, files);
    expect(
      listeners.length,
      `LISTEN connections a server pins: ${listeners.length} (${listeners.join(", ")}), of a default pool of ${DEFAULT_POOL_MAX} · ${FIX}`,
    ).toBeLessThanOrEqual(DEFAULT_POOL_MAX - 1);
  });

  it("are four: the events bus, automatic landing, the session notifier and review prep", () => {
    // The Slack reporter and preview preparation subscribe to the events bus (ADR 0017 step 11).
    expect(occurrences(/\blistenEvents\(/gu, files).toSorted()).toEqual([
      "apps/api/src/automatic-landing.ts",
      "apps/api/src/events-bus.ts",
      "packages/jobs/src/review-prep.ts",
      "packages/jobs/src/session-notifier.ts",
    ]);
  });
});
