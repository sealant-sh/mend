import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, writeFileSync } from "node:fs";

import {
  prepareT3GatewayState,
  t3GatewaySpecification,
  verifyT3GatewayRoot,
} from "./bundle-supervisor.mjs";

const root = "/tmp/t3-gateway-workers";
execFileSync("sh", ["/scripts/t3-gateway-root.sh", root], { stdio: "inherit" });
cpSync("/gateway", `${root}/app`, { recursive: true });
writeFileSync(`${root}/app/package.json`, '{"type":"module"}');
await prepareT3GatewayState(root);
await verifyT3GatewayRoot(root);
const specification = t3GatewaySpecification(
  { MEND_T3_GATEWAY_ENABLED: "true" },
  { root, entry: "/app/t3-gateway-worker-load.check.js" },
);
const [command, ...args] = specification.command;
const result = spawnSync(command, [...args, process.argv[2] ?? "256", process.argv[3] ?? "1"], {
  env: specification.env,
  encoding: "utf8",
  timeout: 30_000,
});
console.log(
  JSON.stringify({ command: specification.command, status: result.status, signal: result.signal }),
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
assert.equal(
  result.status,
  0,
  `${result.signal ?? result.error ?? "worker failed"}\n${result.stderr}`,
);
