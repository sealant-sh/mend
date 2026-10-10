// Runs as root in the bundle's base image (scripts/bundle-packaging.test.mjs): builds the gateway's
// root as the Dockerfile does, starts a probe there through the bundle's real start chain
// (t3GatewaySpecification), and prints what the probe saw of itself and what /proc says of it.
import { execFileSync, spawn } from "node:child_process";
import { chownSync, readFileSync, statSync, writeFileSync } from "node:fs";

import {
  prepareT3GatewayState,
  t3GatewaySpecification,
  verifyT3GatewayRoot,
} from "./bundle-supervisor.mjs";

const root = "/tmp/t3-gateway-root";
execFileSync("sh", ["/scripts/t3-gateway-root.sh", root], { stdio: "inherit" });
writeFileSync(
  `${root}/app/probe.js`,
  `const fs = require("node:fs");
   const sees = {};
   for (const at of ["/scripts", "/var/run/docker.sock", "/proc", "/etc/passwd", "/state"]) {
     sees[at] = fs.existsSync(at);
   }
   let wrote = false;
   try { fs.writeFileSync("/state/written", "x"); wrote = true; } catch {}
   // Review 643-R2-1: the gateway plants links in its state, to what root runs on its next start.
   fs.symlinkSync("/usr/bin/setpriv", "/state/planted-inside");
   fs.symlinkSync(${JSON.stringify(`${root}/usr/bin/setpriv`)}, "/state/planted-outside");
   let escaped = false;
   try { fs.writeFileSync("/app/written", "x"); escaped = true; } catch {}
   process.stdout.write(JSON.stringify({
     uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(),
     env: process.env, sees, wrote, writesOutsideState: escaped,
   }) + "\\n");
   setTimeout(() => {}, 3000);`,
);
await prepareT3GatewayState(root);

// The bundle's own environment, secrets and all: none of it may reach the gateway.
const bundle = {
  ...process.env,
  MEND_T3_GATEWAY_ENABLED: "true",
  DATABASE_URL: "postgresql://mend:secret@postgres:5432/mend",
  SEALANT_DATABASE_URL: "postgresql://sealant:secret@postgres:5432/sealant",
  BETTER_AUTH_SECRET: "better-auth-secret",
  SEALANT_SERVICE_KEY: "slt_svc_secret",
  SEALANT_CREDENTIALS_KEY: "credentials-key",
  AWS_SECRET_ACCESS_KEY: "capture-store-secret",
  WORKSPACE_SSH_GATEWAY_TOKEN: "ssh-gateway-token",
};
const specification = t3GatewaySpecification(bundle, { root, entry: "/app/probe.js" });
const [command, ...args] = specification.command;
const child = spawn(command, args, {
  env: specification.env,
  stdio: ["ignore", "pipe", "inherit"],
});
const seen = await new Promise((resolve, reject) => {
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
    if (out.includes("\n")) resolve(JSON.parse(out));
  });
  child.once("error", reject);
});
// The same process, after every exec of the chain: what the kernel holds for it.
const status = Object.fromEntries(
  readFileSync(`/proc/${child.pid}/status`, "utf8")
    .split("\n")
    .map((line) => line.split(":\t"))
    .filter(([key]) =>
      [
        "Uid",
        "Gid",
        "Groups",
        "CapInh",
        "CapPrm",
        "CapEff",
        "CapBnd",
        "CapAmb",
        "NoNewPrivs",
      ].includes(key),
    )
    .map(([key, value]) => [key, value.trim()]),
);
const limits = readFileSync(`/proc/${child.pid}/limits`, "utf8");
const nice = Number(readFileSync(`/proc/${child.pid}/stat`, "utf8").split(" ")[18]);
child.kill();

// The next two starts, as the supervisor runs them: root prepares the state, following nothing.
const owner = (path) => {
  const entry = statSync(path);
  return `${entry.uid}:${entry.gid}`;
};
await verifyT3GatewayRoot(root);
await prepareT3GatewayState(root);
await prepareT3GatewayState(root);
const links = {
  rootSetpriv: owner(`${root}/usr/bin/setpriv`),
  containerSetpriv: owner("/usr/bin/setpriv"),
  state: owner(`${root}/state`),
};
// A file of the root the gateway owns is refused before anything runs.
chownSync(`${root}/usr/bin/setpriv`, 10120, 10120);
const tampered = await verifyT3GatewayRoot(root).then(
  () => "started",
  (error) => String(error.message),
);
process.stdout.write(`${JSON.stringify({ seen, status, limits, nice, links, tampered })}\n`);
