import { randomBytes } from "node:crypto";
// Separate processes exercise setup's real filesystem ownership, not a mocked lock.
import * as fs from "node:fs";
import * as path from "node:path";

import { serverCommand } from "../src/server-setup.ts";
import { withServerStore } from "../src/server-store.ts";
import { DockerProtocol } from "./docker-protocol.ts";

const [configDir, operation = "setup", rendezvous = ""] = process.argv.slice(2);
if (!configDir) throw new Error("config directory required");
if (operation === "private-umask") process.umask(0o077);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pause = async (phase) => {
  if (!rendezvous) return;
  fs.writeFileSync(path.join(rendezvous, phase), "ready");
  while (!fs.existsSync(path.join(rendezvous, `release-${phase}`))) await sleep(10);
};

if (operation === "oversized-generation") {
  // RLIMIT_FSIZE produces a real partial write/EFBIG. Kill before releasing the lock,
  // representing process loss during failure handling, without mocking any filesystem method.
  const result = await withServerStore(configDir, async (store) => {
    const committed = store.commit({
      identity: "original identity\n",
      config: "new config\n",
      env: "x".repeat(1024 * 1024),
      compose: "new compose\n",
      postgresInit: "new init\n",
    });
    if (committed._tag === "error") process.kill(process.pid, "SIGKILL");
    return committed;
  });
  console.log(JSON.stringify(result));
} else {
  const daemon = new DockerProtocol();
  const runtime = {
    configDir,
    platform: process.platform,
    cliVersion: "0.23.0",
    randomBytes,
    sleep,
    writeLine: (line) => console.log(line),
    run: async (command, args, options) => {
      const protocol = daemon.run(command, args, options);
      if (protocol !== undefined) return protocol;
      let stdout = "";
      if (args[0] === "context") {
        await pause("context");
        stdout =
          args[1] === "ls"
            ? JSON.stringify({
                Name: "default",
                DockerEndpoint: "unix:///var/run/docker.sock",
                Current: true,
              })
            : "unix:///var/run/docker.sock";
      } else if (args.includes("up")) {
        await pause("compose");
        if (operation === "compose-failure")
          return { status: 1, stdout: "", stderr: "container failed" };
      } else if (args.includes("info")) stdout = "Docker Engine - Community";
      else if (args.includes("image")) stdout = "0.23.0";
      else if (args.includes("compose") && args.includes("config"))
        stdout = "ghcr.io/sealant-sh/mend:0.23.0\npostgres:17-alpine\n";
      else if (args.includes("compose")) stdout = "2.35.0";
      else stdout = "1.45 1.47";
      return { status: 0, stdout, stderr: "" };
    },
    fetchText: async (url) => {
      if (url.endsWith("/api/health")) {
        await pause("health");
        return { status: 200, body: '{"status":"ok","version":"0.23.0"}' };
      }
      const file = url.endsWith("/compose.v2.yaml") ? "compose.v2.yaml" : "postgres-init.sh";
      return {
        status: 200,
        body: fs.readFileSync(new URL(`./docker/${file}`, import.meta.url), "utf8"),
      };
    },
  };
  const result = await serverCommand(["setup"], runtime);
  console.log(JSON.stringify(result));
  process.exitCode = result._tag === "ok" ? 0 : 1;
}
