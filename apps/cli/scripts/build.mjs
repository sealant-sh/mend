import { copyFileSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import manifest from "../package.json" with { type: "json" };

const runtimeDependencies = Object.keys(manifest.dependencies);
for (const name of runtimeDependencies) {
  if (name.startsWith("@mend/") || manifest.dependencies[name].startsWith("workspace:")) {
    throw new Error(`Private workspace dependency must be bundled, not shipped: ${name}`);
  }
}

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
rmSync(new URL("../dist/", import.meta.url), { recursive: true, force: true });
rmSync(new URL("../sourcemaps/", import.meta.url), { recursive: true, force: true });
const result = await build({
  absWorkingDir: packageRoot,
  // Follow the whole import graph, including lazy dashboard and future CLI commands.
  entryPoints: ["src/main.ts"],
  outdir: "dist",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // Keep import.meta-relative package/man paths valid even in shared chunks.
  chunkNames: "[name]-[hash]",
  // Native OpenTUI stays external and behind the dashboard's dynamic import.
  // Undeclared transitive dependencies, including workspace source, are bundled.
  external: runtimeDependencies,
  // Maps for Sentry's stack traces (SLNT-1357), written without a sourceMappingURL comment and
  // moved to sourcemaps/ below: npm ships `files` (dist, man), so the maps never reach a person.
  // The release run uploads them under the package's release, by their app:///dist/ names.
  sourcemap: "external",
  metafile: true,
  logLevel: "info",
});

for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (!dependency.external || isBuiltin(dependency.path)) continue;
    if (
      !runtimeDependencies.some(
        (name) => dependency.path === name || dependency.path.startsWith(`${name}/`),
      )
    ) {
      throw new Error(`Undeclared runtime import in CLI bundle: ${dependency.path}`);
    }
  }
}

// sourcemaps/dist/ holds each chunk beside its map, the pair sentry-cli uploads.
const maps = new URL("../sourcemaps/dist/", import.meta.url);
mkdirSync(maps, { recursive: true });
for (const file of readdirSync(new URL("../dist/", import.meta.url))) {
  if (file.endsWith(".js.map")) {
    renameSync(new URL(`../dist/${file}`, import.meta.url), new URL(file, maps));
  } else if (file.endsWith(".js")) {
    copyFileSync(new URL(`../dist/${file}`, import.meta.url), new URL(file, maps));
  }
}

copyFileSync(
  new URL("../src/agent-skill.md", import.meta.url),
  new URL("../dist/agent-skill.md", import.meta.url),
);
