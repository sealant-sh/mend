/**
 * Bundle a Mend server entrypoint into one self-contained ESM file with esbuild, so production
 * images run plain `node dist/main.js`: no type stripping, no workspace layout, no node_modules.
 * Run from the app directory: `BUNDLE_ENTRIES=src/main.ts node ../../tooling/scripts/bundle-app.mjs`.
 *
 * Bundling is also a memory decision: Node keeps every loaded script's source text resident and
 * evaluates every module a barrel re-exports, so an unbundled server pays for code it never calls.
 * esbuild tree-shakes side-effect-free packages (Effect declares `sideEffects: []`) and emits ASCII
 * so V8 stores the source at one byte per character.
 *
 * BUNDLE_EXTERNAL (comma-separated) keeps native or optional deps out of the bundle; those must be
 * installed in the runtime image. Anything else that ends up external is a build error.
 */
import { createRequire, isBuiltin } from "node:module";
import { pathToFileURL } from "node:url";

// esbuild is a devDependency of the app being bundled, not of this shared script.
const { build } = await import(
  pathToFileURL(createRequire(pathToFileURL(`${process.cwd()}/`)).resolve("esbuild")).href
);

const list = (value) =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const external = list(process.env.BUNDLE_EXTERNAL);
const entryPoints = list(process.env.BUNDLE_ENTRIES ?? "src/main.ts");

const result = await build({
  entryPoints,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outdir: "dist",
  sourcemap: true,
  charset: "ascii",
  // Comments are the only place non-ASCII survives `charset: "ascii"` (dependency prose is full of
  // curly quotes and dashes), and one such character makes V8 store the whole script two-byte.
  // Whitespace minification drops them; `lineLimit` keeps line numbers meaningful in stack traces.
  minifyWhitespace: true,
  lineLimit: 160,
  legalComments: "none",
  external,
  metafile: true,
  // ESM output; CJS dependencies still expect these globals.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);",
    ].join("\n"),
  },
  logLevel: "info",
});

const undeclared = new Set();
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (!dependency.external || isBuiltin(dependency.path)) continue;
    if (
      !external.some((name) => dependency.path === name || dependency.path.startsWith(`${name}/`))
    ) {
      undeclared.add(dependency.path);
    }
  }
}
if (undeclared.size > 0) {
  throw new Error(`Undeclared external imports in bundle: ${[...undeclared].join(", ")}`);
}
