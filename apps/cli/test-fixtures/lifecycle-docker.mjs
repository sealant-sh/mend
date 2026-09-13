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
const command = composeIndex < 0 ? [] : args.slice(composeIndex + 2);
const config =
  composeIndex < 0
    ? null
    : JSON.parse(fs.readFileSync(path.join(directory, "server.json"), "utf8"));
// A generation whose bundle carries the capture store's bucket runs Garage beside Postgres.
const withGarage = config !== null && config.bucket === "garage";
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
    `ghcr.io/sealant-sh/mend:${config.serverVersion}\npostgres:17-alpine${withGarage ? "\ndxflrs/garage:v2.4.1" : ""}`,
  );
} else if (command[0] === "ps") {
  if (command.includes("--services"))
    out(
      [
        state.appRunning ? "mend" : "",
        state.postgresRunning ? "postgres" : "",
        withGarage && state.postgresRunning ? "garage" : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  else
    out(
      `mend ${state.appRunning ? "running" : "exited"}\npostgres ${state.postgresRunning ? "running" : "exited"}${withGarage ? `\ngarage ${state.postgresRunning ? "running" : "exited"}` : ""}`,
    );
} else if (command[0] === "logs") out("bounded fixture log");
else if (command[0] === "down") {
  state.appRunning = false;
  state.postgresRunning = false;
  state.downArgs = command;
  save();
  if (state.fail === "down") fail();
} else if (command[0] === "stop") {
  state.appRunning = false;
  if (command.at(-1) !== "mend") state.postgresRunning = false;
  save();
  if (state.fail === "stop") fail();
} else if (command[0] === "up") {
  state.postgresRunning = true;
  if (command.at(-1) !== "postgres") {
    state.appRunning = true;
    state.version = config.serverVersion;
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
