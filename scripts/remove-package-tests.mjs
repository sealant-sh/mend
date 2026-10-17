import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { testOnly } from "./ci-scope.mjs";

// The mobile-web and packaging lanes skip a change confined to a package's tests
// (scripts/ci-scope.mjs). Each runs this first, after install, so a lane that reads a package
// test file fails instead of silently depending on files a skipped change may alter. It deletes
// exactly the files `testOnly` lets the lanes skip, and fails if there were none: a moved test
// layout must not turn it into a no-op.

/** Every file under `root`/packages that `testOnly` matches, outside node_modules. */
export const packageTestFiles = (root) => {
  const found = [];
  const walk = (relative) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (testOnly(path)) found.push(path);
    }
  };
  if (lstatSync(join(root, "packages"), { throwIfNoEntry: false })?.isDirectory()) {
    walk("packages");
  }
  return found.toSorted();
};

const main = () => {
  const root = process.argv[2] ?? fileURLToPath(new URL("../", import.meta.url));
  const files = packageTestFiles(root);
  if (files.length === 0) {
    console.error(
      `Removed no package test files under ${join(root, "packages")}: the layout scripts/ci-scope.mjs skips has moved, so this step no longer proves the lane needs none of them.`,
    );
    process.exitCode = 1;
    return;
  }
  const counts = new Map();
  for (const path of files) {
    rmSync(join(root, path), { force: true });
    const name = path.split("/")[1];
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const [name, count] of counts) console.log(`packages/${name}: ${count}`);
  console.log(`Removed ${files.length} package test files from ${counts.size} packages.`);
};

if (import.meta.main) main();
