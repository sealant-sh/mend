import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decodeDirObject, encodeDirObject } from "../src/captures.ts";

/**
 * sealantd marks a file, or a SQLite database and its write-ahead log read together, that changed
 * under every read it made as `torn` (`tree.rs` `DirEntry.torn`). A reader that dropped the mark
 * would take a torn database for a whole one (opencode's conversations, review 2026-10-04).
 */
describe("a torn entry", () => {
  it("keeps sealantd's torn mark through decode and encode", async () => {
    const wire = JSON.stringify({
      entries: [
        {
          name: "opencode.db",
          kind: "file",
          mode: 0o644,
          size: 4096,
          mtime: 1,
          group: "opencode.db",
          torn: true,
        },
        { name: "opencode.db-wal", kind: "file", mode: 0o644, size: 8, mtime: 1 },
      ],
    });
    const entries = await Effect.runPromise(
      decodeDirObject("torn", new TextEncoder().encode(wire)),
    );
    expect(entries[0]?.torn).toBe(true);
    expect(entries[1]?.torn).toBeUndefined();
    const again = await Effect.runPromise(decodeDirObject("again", encodeDirObject(entries)));
    expect(again.map((entry) => entry.torn)).toEqual([true, undefined]);
  });
});
