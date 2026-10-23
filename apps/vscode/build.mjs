import { build } from "esbuild";
await build({
  entryPoints: { extension: "src/extension.ts", "handoff-worker": "src/handoff-worker-entry.ts" },
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  outdir: "dist",
  sourcemap: true,
});
