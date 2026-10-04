import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { migrationNames } from "./mend-migrations.mjs";

test("the image's migration list is exactly the migrations record, in order", async () => {
  const source = readFileSync(new URL("../packages/db/src/migrations.ts", import.meta.url), "utf8");
  const { migrations } = await import("../packages/db/src/migrations.ts");
  const names = migrationNames(source);
  assert.deepEqual(names, Object.keys(migrations));
  assert.ok(names.length > 100);
  assert.equal(names[0], "0001_init");
});
