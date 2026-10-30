import { execFile } from "node:child_process";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";

const reference = process.argv[2];
if (reference === undefined) throw new Error("Pass the local t3code reference checkout.");
const pin = "v0.1.2";
const read = async (path) =>
  (
    await promisify(execFile)("git", ["-C", reference, "show", `${pin}:${path}`], {
      encoding: "utf8",
    })
  ).stdout;
const license = await read("LICENSE");
await build({
  stdin: {
    contents:
      'export { deriveThreadQueueWorkflowState } from "packages/client-runtime/src/state/threadWorkflows.ts"; export { applyOrchestrationV2ProjectionEvent } from "packages/client-runtime/src/state/orchestrationV2Projection.ts";',
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: resolve(dirname(fileURLToPath(import.meta.url)), "steering-client.mjs"),
  banner: {
    js: `/* oxlint-disable -- Generated verbatim from t3code ${pin}; regenerate with sync.mjs. */\n/*\n${license}\n*/`,
  },
  plugins: [
    {
      name: "local-t3code-ref",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, ({ path, importer }) => {
          if (path === "@t3tools/contracts") return { path: "@mend/t3-contracts", external: true };
          const source = path.startsWith("@t3tools/shared/")
            ? `packages/shared/src/${path.slice("@t3tools/shared/".length)}`
            : path.startsWith(".")
              ? posix.join(posix.dirname(importer), path)
              : path;
          return { path: source.endsWith(".ts") ? source : `${source}.ts`, namespace: "upstream" };
        });
        builder.onLoad({ filter: /.*/, namespace: "upstream" }, async ({ path }) => ({
          contents: await read(path),
          loader: "ts",
        }));
      },
    },
  ],
});
