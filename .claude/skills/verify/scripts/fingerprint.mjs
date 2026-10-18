#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";

const SLASH = Buffer.from("/");

// A name that is not UTF-8 is printed as hex, so it neither crashes the walk nor collides.
const nameOf = (bytes) => {
  const text = bytes.toString("utf8");
  return Buffer.from(text).equals(bytes) ? text : `bytes:${bytes.toString("hex")}`;
};

export const fingerprint = (root) => {
  const lines = [];
  const top = Buffer.from(root);
  const walk = (dir) => {
    for (const name of readdirSync(dir, { encoding: "buffer" }).toSorted(Buffer.compare)) {
      const full = Buffer.concat([dir, SLASH, name]);
      const stat = lstatSync(full, { bigint: true });
      const content = stat.isFile()
        ? createHash("sha256").update(readFileSync(full)).digest("hex")
        : stat.isSymbolicLink()
          ? readlinkSync(full)
          : "";
      lines.push(
        [
          nameOf(full.subarray(top.length + 1)),
          stat.mode.toString(8),
          stat.size,
          stat.mtimeNs,
          stat.ctimeNs,
          content,
        ].join("|"),
      );
      if (stat.isDirectory()) walk(full);
    }
  };
  walk(top);
  return lines;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    process.stderr.write("usage: fingerprint.mjs <dir>...\n");
    process.exit(2);
  }
  for (const root of roots.map((dir) => resolve(dir))) {
    process.stdout.write(`# ${root}\n${fingerprint(root).join("\n")}\n`);
  }
}
