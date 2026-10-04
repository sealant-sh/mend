#!/usr/bin/env node
// Prints the names of Mend's database migrations, one per line, from packages/db/src/migrations.ts.
// The image build writes them, with Sealant's migration folders, to /app/migrations.txt, so
// `mend server upgrade --from-preview` can check a target carries every migration a server applied
// (docs/adr/0015-next-channel.md).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The keys of `export const migrations = { ... }`, in order. */
export const migrationNames = (source) => {
  const start = source.indexOf("export const migrations = {");
  if (start < 0) throw new Error("packages/db/src/migrations.ts exports no migrations record.");
  const end = source.indexOf("\n};", start);
  return [...source.slice(start, end).matchAll(/^ {2}"([0-9]{4}_[a-z0-9_]+)":/gm)].map(
    (match) => match[1],
  );
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const source = readFileSync(new URL("../packages/db/src/migrations.ts", import.meta.url), "utf8");
  process.stdout.write(`${migrationNames(source).join("\n")}\n`);
}
