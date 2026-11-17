// Single-host Mend-only entrypoint. The bundle image uses bundle-supervisor.mjs; this remains the
// host/standalone pair and shares the same fatal-child and signal semantics.
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { supervise } from "./process-supervisor.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const flags = ["--experimental-strip-types"];

const webPort = process.env.PORT ?? "3105";
const apiPort = process.env.MEND_API_SERVER_PORT ?? "3101";

await supervise(async (supervisor) => {
  await supervisor.start({
    name: "mend-api",
    command: [node, ...flags, path.join(repoRoot, "apps/api/src/main.ts")],
    env: { ...process.env, PORT: apiPort, MEND_WEB_PORT: webPort },
    stdio: "inherit",
  });
  await supervisor.start({
    name: "mend-web",
    command: [node, ...flags, path.join(repoRoot, "apps/web-old/src/entry/main.ts")],
    env: {
      ...process.env,
      PORT: webPort,
      MEND_API_URL: process.env.MEND_API_URL ?? `http://localhost:${apiPort}`,
    },
    stdio: "inherit",
  });
});
