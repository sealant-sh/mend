#!/usr/bin/env -S node --experimental-strip-types
// A local Docker protocol fixture. The CLI still uses its real process and filesystem runtime.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { DockerProtocol } from "./docker-protocol.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(root, "daemon.json");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const args = process.argv.slice(2);
const directory = args[args.indexOf("--project-directory") + 1];
const composeIndex = args.indexOf("-f");
// The command follows the last `-f <file>` pair: compose.yaml, then the generation's overlays.
const composeFiles = [];
let commandIndex = composeIndex;
while (commandIndex >= 0 && args[commandIndex] === "-f") {
  composeFiles.push(args[commandIndex + 1]);
  commandIndex += 2;
}
const command = composeIndex < 0 ? [] : args.slice(commandIndex);
const config =
  composeIndex < 0
    ? null
    : JSON.parse(fs.readFileSync(path.join(directory, "server.json"), "utf8"));
// A generation whose bundle carries the capture store's bucket runs Garage beside Postgres.
const withGarage = config !== null && config.bucket === "garage";
// A generation with an edge host runs Caddy in front, from the overlay the CLI wrote beside it.
const withEdge =
  config !== null &&
  typeof config.edgeHost === "string" &&
  composeFiles.includes(path.join(directory, "compose.edge.yaml")) &&
  fs.existsSync(path.join(directory, "Caddyfile"));
const envOf = () => {
  const values = new Map();
  for (const line of fs.readFileSync(path.join(directory, "server.env"), "utf8").split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
};
fs.appendFileSync(
  path.join(root, "calls.jsonl"),
  `${JSON.stringify({ args, command, locked: fs.existsSync(path.join(root, "config/server.lock/owner.json")), directory: config === null ? null : directory, active: fs.existsSync(path.join(root, "config/active")) ? fs.readlinkSync(path.join(root, "config/active")) : null, appRunning: state.appRunning, postgresRunning: state.postgresRunning, poisoned: Object.keys(process.env).some((key) => key.startsWith("COMPOSE_") || key === "MEND_VERSION" || key === "DOCKER_HOST") })}\n`,
);
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const out = (value) => process.stdout.write(`${value}\n`);
const fail = () => {
  process.stderr.write("fixture operation failed\n");
  process.exit(1);
};

// Release images live in daemon state, not the probe protocol: uninstall untags them here.
if (
  args[2] === "image" &&
  args[3] === "rm" &&
  !String(args.at(-1)).includes("/mend-registry-probe/")
) {
  const image = args.at(-1);
  const version = image.split(":").at(-1);
  if (!state.images[version]) fail();
  delete state.images[version];
  save();
  out(`Untagged: ${image}`);
  process.exit(0);
}

// The edge container by its Compose labels: what the CLI lists and removes when a generation
// without an edge finds one still running. Answered from this daemon's state, not the protocol's.
const edgeLabelFilter = "label=com.docker.compose.service=edge";
if (args[2] === "container" && args[3] === "ls" && args.includes(edgeLabelFilter)) {
  out(state.edgeRunning ? "mend-edge-1" : "");
  process.exit(0);
}
if (args[2] === "container" && args[3] === "rm" && args.includes("mend-edge-1")) {
  if (!state.edgeRunning) fail();
  state.edgeRunning = false;
  state.removedEdge = (state.removedEdge ?? 0) + 1;
  save();
  out("mend-edge-1");
  process.exit(0);
}

// Persist the same named-volume and separate local/remote image protocol used by setup tests.
const protocolFile = path.join(root, "docker-protocol.json");
const saved = fs.existsSync(protocolFile) ? JSON.parse(fs.readFileSync(protocolFile, "utf8")) : {};
const daemon = new DockerProtocol();
for (const kind of ["volumes", "containers", "networks", "local", "remote"]) {
  for (const [name, value] of saved[kind] ?? []) daemon[kind].set(name, value);
}
// Docker cannot observe its caller's timer. Deadline forwarding is recorded at the runtime edge.
const protocol = daemon.run("docker", args, { timeoutMs: 60_000 });
if (protocol !== undefined) {
  fs.writeFileSync(
    protocolFile,
    JSON.stringify({
      ...Object.fromEntries(
        ["volumes", "containers", "networks", "local", "remote"].map((kind) => [
          kind,
          [...daemon[kind]],
        ]),
      ),
      pulled: args[3] === "pull" ? args.at(-1) : saved.pulled,
    }),
  );
  process.stdout.write(protocol.stdout);
  process.stderr.write(protocol.stderr);
  process.exit(protocol.status ?? 1);
}

if (args[0] === "context") out("unix:///var/run/docker.sock");
else if (args.includes("{{.Client.APIVersion}} {{.Server.APIVersion}}")) out("1.47 1.47");
else if (args[2] === "info") out("Docker Engine - Community");
else if (args.includes("compose") && args.includes("version")) out("2.35.0");
else if (args.includes("image")) {
  const image = args[args.indexOf("inspect") + 1];
  if (image === "postgres:17-alpine") out("sha256:postgres");
  else if (image === "dxflrs/garage:v2.4.1") out("sha256:garage");
  else if (image === "caddy:2.10-alpine") out("sha256:caddy");
  else {
    const version = image.split(":").at(-1);
    if (!state.images[version]) fail();
    out(state.images[version]);
  }
} else if (args.includes("pull")) {
  if (state.fail === "pull") fail();
  const version = args.at(-1).split(":").at(-1);
  state.images[version] = version;
  save();
} else if (command[0] === "config") {
  if (state.fail === "compose-config") fail();
  out(
    `ghcr.io/sealant-sh/mend:${config.serverVersion}\npostgres:17-alpine${withGarage ? "\ndxflrs/garage:v2.4.1" : ""}${withEdge ? "\ncaddy:2.10-alpine" : ""}`,
  );
} else if (command[0] === "ps") {
  if (command.includes("--services"))
    out(
      [
        state.appRunning ? "mend" : "",
        state.postgresRunning ? "postgres" : "",
        withGarage && state.postgresRunning ? "garage" : "",
        // A running edge shows whether or not the active generation still declares it.
        state.edgeRunning ? "edge" : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  else
    out(
      `mend ${state.appRunning ? "running" : "exited"}\npostgres ${state.postgresRunning ? "running" : "exited"}${withGarage ? `\ngarage ${state.postgresRunning ? "running" : "exited"}` : ""}${withEdge || state.edgeRunning ? `\nedge ${state.edgeRunning ? "running" : "exited"}` : ""}`,
    );
} else if (command[0] === "exec" && command.includes("edge")) {
  // `mend server status` asks Caddy's data for the host's certificate: a path when it holds one.
  if (!withEdge || !state.edgeRunning) fail();
  if (typeof state.certificate === "string") out(state.certificate);
  else fail();
} else if (command[0] === "logs") out("bounded fixture log");
else if (command[0] === "down") {
  state.appRunning = false;
  state.postgresRunning = false;
  state.edgeRunning = false;
  state.downArgs = command;
  state.downFiles = composeFiles.map((file) => path.basename(file));
  save();
  if (state.fail === "down") fail();
} else if (command[0] === "stop") {
  state.appRunning = false;
  if (command.at(-1) !== "mend") {
    state.postgresRunning = false;
    state.edgeRunning = false;
  }
  save();
  if (state.fail === "stop") fail();
} else if (command[0] === "up") {
  state.postgresRunning = true;
  if (command.at(-1) !== "postgres") {
    // An `up` without the edge overlay that fails before it did anything, leaving the active
    // generation edge-less while whatever ran keeps running.
    if (state.fail === "no-edge-up" && !withEdge) fail();
    state.appRunning = true;
    // The edge runs when its overlay is among the files. Without it, Compose does not know the
    // service and leaves a running edge alone; the CLI removes that container itself, by label.
    if (withEdge) state.edgeRunning = true;
    state.version = config.serverVersion;
    state.upFiles = composeFiles.map((file) => path.basename(file));
    save();
    if (state.fail === "target-pause" && state.version !== "0.23.0") {
      fs.writeFileSync(path.join(root, "target-started"), String(process.pid));
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
    if (state.fail === "target-start" && state.version !== "0.23.0") fail();
    if (state.fail === "old-start" && state.version === "0.23.0") fail();
  }
  save();
} else if (command[0] === "exec" && command.includes("garage")) {
  // The bucket init runs after `up`; `status` names the node, `bucket info` shows Mend's key.
  if (!withGarage || !state.postgresRunning) fail();
  const sub = command.slice(command.indexOf("/etc/garage.toml") + 1);
  if (sub[0] === "status") out("==== HEALTHY NODES ====\n0123456789abcdef  garage  127.0.0.1:3901");
  else if (sub[0] === "bucket" && sub[1] === "info")
    out(`==== BUCKET INFORMATION ====\nRWO ${envOf().get("MEND_GARAGE_KEY_ID")} mend`);
  else out("");
} else if (command[0] === "exec") {
  if (state.appRunning || !state.postgresRunning || !command.includes("pg_dumpall")) fail();
  out(
    "-- PostgreSQL database cluster dump\nCREATE DATABASE mend;\nCREATE DATABASE sealant_control_plane;",
  );
  if (state.fail === "backup-stall") {
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    fs.writeFileSync(
      path.join(root, "dump-pids.json"),
      JSON.stringify({ parent: process.pid, child: child.pid }),
    );
    process.on("SIGTERM", () => {});
    await new Promise(() => {});
  }
  if (state.fail === "backup" || state.fail === "old-start") {
    process.stderr.write("sensitive SQL must not escape backup failure\n");
    process.exit(1);
  }
} else fail();
