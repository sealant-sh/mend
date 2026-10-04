import { execFileSync } from "node:child_process";

import { Effect } from "effect";
import { Migrator } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";

import { migrationProblems } from "./server-setup.ts";

const hash = (character: string) => character.repeat(64);

/** The image's list, as scripts/mend-migrations.mjs writes it from packages/db. */
const mendKeys = execFileSync(
  "node",
  [new URL("../../../scripts/mend-migrations.mjs", import.meta.url).pathname],
  { encoding: "utf8" },
)
  .trim()
  .split("\n");

describe("what --from-preview compares", () => {
  it("reads Mend's rows the way Effect's migrator stores the real migrations", async () => {
    // Effect's own loader turns each record key into the [id, name] it inserts in mend_migrations.
    const loaded = await Effect.runPromise(
      Migrator.fromRecord(Object.fromEntries(mendKeys.map((key) => [key, Effect.void]))),
    );
    const stored = loaded.map(([id, name]) => ({ id, name }));
    expect(stored.length).toBe(mendKeys.length);
    expect(stored[0]).toEqual({ id: 1, name: "init" });
    const manifest = mendKeys.map((key) => `mend ${key}`).join("\n");
    // A server that applied all of them can take an image that lists all of them.
    expect(migrationProblems({ mend: stored, sealant: [] }, manifest)).toEqual([]);
    // One the image lacks is named, in the image's own spelling.
    const last = mendKeys.at(-1) ?? "";
    expect(
      migrationProblems(
        { mend: stored, sealant: [] },
        mendKeys
          .slice(0, -1)
          .map((key) => `mend ${key}`)
          .join("\n"),
      ),
    ).toEqual([`mend ${last} is applied here and not in the target`]);
  });

  it("refuses a target migration Effect would skip, below the highest applied id", () => {
    // The box ran 0101 from a preview branch; main later merged 0100 under it.
    const manifest = ["mend 0099_a", "mend 0100_y", "mend 0101_x"].join("\n");
    expect(
      migrationProblems(
        {
          mend: [
            { id: 99, name: "a" },
            { id: 101, name: "x" },
          ],
          sealant: [],
        },
        manifest,
      ),
    ).toEqual(["mend 0100_y would never run: this server already applied 101"]);
    // A renumbered migration does not pass as the same one.
    expect(
      migrationProblems({ mend: [{ id: 101, name: "y" }], sealant: [] }, "mend 0102_y"),
    ).toEqual(["mend 0101_y is applied here and not in the target"]);
  });

  it("compares Sealant's migrations by folder and drizzle's hash", () => {
    const manifest = [
      `sealant 20260901120000_ledger ${hash("a")}`,
      `sealant 20261003093819_stop ${hash("b")}`,
    ].join("\n");
    expect(
      migrationProblems(
        {
          mend: [],
          sealant: [
            { name: "", createdAt: String(Date.UTC(2026, 8, 1, 12, 0, 0)), hash: hash("a") },
            { name: "20261003093819_stop", createdAt: "1", hash: hash("c") },
            { name: "20261004000000_unmerged", createdAt: "2", hash: hash("d") },
          ],
        },
        manifest,
      ),
    ).toEqual([
      "sealant 20261003093819_stop changed after this server applied it",
      "sealant 20261004000000_unmerged is applied here and not in the target",
    ]);
  });
});
