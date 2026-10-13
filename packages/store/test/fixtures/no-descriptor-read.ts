import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as path from "node:path";

import { Effect, Layer } from "effect";

import { Store, StoreConfig } from "../../src/store.ts";

const root = process.argv[2];
assert.ok(root, "owned worktree path required");
const store = await Effect.runPromise(
  Effect.gen(function* () {
    return yield* Store;
  }).pipe(
    Effect.provide(Store.layer.pipe(Layer.provide(StoreConfig.layerFor(path.join(root, "store"))))),
  ),
);
const before = await Effect.runPromise(store.readWorktreeFile(root, "dir/file", 1024));
assert.equal(new TextDecoder().decode(before?.bytes), "inside");
const require = createRequire(import.meta.url);
const nodeFs: typeof fs = require("node:fs");
const statSync = nodeFs.statSync;
const probes: string[] = [];
// This fault lasts until this disposable child exits. No Vitest process or sibling test sees it.
Reflect.set(nodeFs, "statSync", (...args: Parameters<typeof fs.statSync>) => {
  const at = String(args[0]);
  for (const base of ["/proc/self/fd/", "/dev/fd/"]) {
    if (at.startsWith(base)) {
      probes.push(base);
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
  }
  return statSync(...args);
});
syncBuiltinESMExports();
const refused = await Effect.runPromise(
  Effect.flip(store.readWorktreeFile(root, "dir/file", 1024)),
);
process.stdout.write(
  JSON.stringify({ tag: refused._tag, stderr: refused.stderr, probes, pid: process.pid }),
);
