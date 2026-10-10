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
// Only a Compose command takes `-f <file>`; `container rm -f` is a force flag.
const composeIndex = args[2] === "compose" ? args.indexOf("-f") : -1;
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
// The mirrors run from the overlay the CLI wrote beside compose.yaml, with the images it names.
const mirrorsFile = path.join(directory ?? "", "compose.mirrors.yaml");
const mirrorsOverlay =
  config !== null && composeFiles.includes(mirrorsFile) ? fs.readFileSync(mirrorsFile, "utf8") : "";
const mirrorImages = [...mirrorsOverlay.matchAll(/^ {4}image: (\S+)$/gm)].map((match) => match[1]);
const mirrorServices = ["npm-mirror", "docker-mirror"].filter((service) =>
  mirrorsOverlay.includes(`\n  ${service}:\n`),
);
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

// Release images live in daemon state, not the probe protocol: uninstall untags them here. The
// bundle's other images (Postgres, Garage, the mirrors') are always there until something removes
// them; `removedImages` remembers which did.
if (
  args[2] === "image" &&
  args[3] === "rm" &&
  !String(args.at(-1)).includes("/mend-registry-probe/") &&
  !String(args.at(-1)).startsWith("ghcr.io/sealant-sh/mend:")
) {
  const image = args.at(-1);
  if ((state.removedImages ?? []).includes(image)) {
    process.stderr.write(`Error response from daemon: No such image: ${image}\n`);
    process.exit(1);
  }
  if ((state.imagesInUse ?? []).includes(image)) {
    process.stderr.write(`Error response from daemon: conflict: unable to remove ${image}\n`);
    process.exit(1);
  }
  // Refused while another of the list still tags it, and gone with that one: Docker removes an
  // image whose last tag goes, so the next ask finds nothing.
  if ((state.imagesRefusedOnce ?? []).includes(image)) {
    state.imagesRefusedOnce = state.imagesRefusedOnce.filter((name) => name !== image);
    state.removedImages = [...(state.removedImages ?? []), image];
    save();
    process.stderr.write(
      `Error response from daemon: conflict: unable to delete ${image} (must be forced) - image is referenced in multiple repositories\n`,
    );
    process.exit(1);
  }
  state.removedImages = [...(state.removedImages ?? []), image];
  save();
  out(`Untagged: ${image}`);
  process.exit(0);
}
if (args[2] === "image" && args[3] === "inspect" && (state.removedImages ?? []).includes(args[4])) {
  process.stderr.write(`Error: No such image: ${args[4]}\n`);
  process.exit(1);
}
// The host's user-namespace sysctl file, as uninstall's helper container reads and removes it.
if (args[2] === "run" && args.some((arg) => arg.includes("/host/sysctl.d"))) {
  const file = state.sysctl ?? "absent";
  if (args.includes("mend-uninstall-userns")) {
    if (file !== "mend") process.exit(4);
    state.sysctl = "absent";
    state.sysctlRestored = args.slice(args.indexOf("mend-uninstall-userns") + 2);
    save();
    process.exit(0);
  }
  if (file === "absent") process.exit(3);
  out(
    `${file === "mend" ? "# written by mend server setup; mend uninstall removes it\n# previous: kernel.apparmor_restrict_unprivileged_userns = 1\n" : ""}kernel.apparmor_restrict_unprivileged_userns = 0`,
  );
  process.exit(0);
}
if (args[2] === "system" && args[3] === "df") {
  if (state.buildCache)
    out(JSON.stringify({ Type: "Build Cache", TotalCount: "38", Size: state.buildCache }));
  process.exit(0);
}
if (args[2] === "builder" && args[3] === "prune") {
  state.buildCache = null;
  state.prunedBuildCache = true;
  save();
  process.exit(0);
}
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
  if (state.fail === "container-ls") fail();
  // Name and the working directory Compose recorded: the generation the edge was started from.
  out(state.edgeRunning ? `mend-edge-1\t${state.edgeDirectory ?? ""}` : "");
  process.exit(0);
}
// When the Docker mirror started: its proxy counters count from then.
if (args[2] === "container" && args[3] === "inspect" && args.at(-1) === "mend-docker-mirror") {
  out("2026-10-10T08:00:00.123456Z");
  process.exit(0);
}
// The mirrors' containers, by service, and the generation each was started from; a mirror turned
// off keeps its container until the CLI removes it by label, as Compose leaves it.
const mirrorLabel = args.find((arg) =>
  /^label=com\.docker\.compose\.service=(npm|docker)-mirror$/.test(arg),
);
if (args[2] === "container" && args[3] === "ls" && mirrorLabel !== undefined) {
  const service = mirrorLabel.slice("label=com.docker.compose.service=".length);
  const started = (state.mirrorContainers ?? {})[service];
  out(started === undefined ? "" : `mend-${service}-1\t${started}`);
  process.exit(0);
}
if (
  args[2] === "container" &&
  args[3] === "rm" &&
  args.some((arg) => /^mend-(npm|docker)-mirror-1$/.test(arg))
) {
  for (const name of args.filter((arg) => /^mend-(npm|docker)-mirror-1$/.test(arg)))
    delete state.mirrorContainers[name.slice("mend-".length, -"-1".length)];
  save();
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
for (const kind of ["volumes", "containers", "networks", "facts", "local", "remote"]) {
  for (const [name, value] of saved[kind] ?? []) daemon[kind].set(name, value);
}
// Docker cannot observe its caller's timer. Deadline forwarding is recorded at the runtime edge.
const protocol = daemon.run("docker", args, { timeoutMs: 60_000 });
if (protocol !== undefined) {
  fs.writeFileSync(
    protocolFile,
    JSON.stringify({
      ...Object.fromEntries(
        ["volumes", "containers", "networks", "facts", "local", "remote"].map((kind) => [
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
// `mend server upgrade --from-preview` reads the target image's list of migrations.
else if (args[2] === "run" && args.at(-1) === "/app/migrations.txt") {
  const version = args.at(-2).split(":").at(-1);
  const manifest = state.manifests?.[version];
  if (manifest === undefined || !state.images[version]) fail();
  out(manifest);
} else if (args.includes("{{.Client.APIVersion}} {{.Server.APIVersion}}")) {
  // A stopped daemon: the client answers for itself, the server does not.
  if (state.fail === "docker-down") {
    out("1.47 ");
    process.stderr.write(
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n",
    );
    process.exit(1);
  }
  out("1.47 1.47");
} else if (args[2] === "info") out("Docker Engine - Community");
else if (args.includes("compose") && args.includes("version")) out("2.35.0");
else if (args.includes("image")) {
  const image = args[args.indexOf("inspect") + 1];
  // Uninstall reads each image's size beside its id.
  const sized = (id) => (args.some((arg) => arg.includes("{{.Size}}")) ? `${id}\t100000000` : id);
  if (image === "postgres:17-alpine") out(sized("sha256:postgres"));
  else if (image === "dxflrs/garage:v2.4.1") out(sized("sha256:garage"));
  // Present unless the test says the edge's image was never pulled here.
  else if (image === "caddy:2.10-alpine") {
    if (state.edgeImage === false) fail();
    out(sized("sha256:caddy"));
  } else if (image.startsWith("nginx:") || image.startsWith("registry:"))
    out(sized(`sha256:${image}`));
  else {
    const version = image.split(":").at(-1);
    if (!state.images[version]) fail();
    // The image the worker runs to guard each workspace's network, named by its label.
    if (args.some((arg) => arg.includes("dev.sealant.mend.network-guard-image"))) {
      out(state.guardImage ?? "");
    } else if (args.some((arg) => arg.includes("{{.Size}}"))) {
      out(`sha256:${version}\t${state.imageSize ?? 1000}`);
    }
    // The t3code gateway's label: "1" on an image that carries it, empty on one before it.
    else if (args.some((arg) => arg.includes("dev.sealant.mend.t3-gateway"))) {
      out(state.gatewayImages?.includes(version) ? "1" : "");
    } else out(state.images[version]);
  }
} else if (args.includes("pull")) {
  if (state.fail === "pull") fail();
  const version = args.at(-1).split(":").at(-1);
  state.images[version] = version;
  save();
} else if (command[0] === "config") {
  if (state.fail === "compose-config") fail();
  out(
    `ghcr.io/sealant-sh/mend:${config.serverVersion}\npostgres:17-alpine${withGarage ? "\ndxflrs/garage:v2.4.1" : ""}${withEdge ? "\ncaddy:2.10-alpine" : ""}${mirrorImages.map((image) => `\n${image}`).join("")}`,
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
        ...(state.postgresRunning ? Object.keys(state.mirrorContainers ?? {}) : []),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  else
    out(
      `mend ${state.appRunning ? "running" : "exited"}\npostgres ${state.postgresRunning ? "running" : "exited"}${withGarage ? `\ngarage ${state.postgresRunning ? "running" : "exited"}` : ""}${withEdge || state.edgeRunning ? `\nedge ${state.edgeRunning ? "running" : "exited"}` : ""}`,
    );
} else if (command[0] === "exec" && command.includes("edge")) {
  // `mend server status` asks Caddy's data for the host's certificate: a path when it holds one,
  // else what `ls` says of a glob that matched nothing.
  if (!withEdge || !state.edgeRunning) fail();
  if (typeof state.certificate === "string") out(state.certificate);
  else {
    process.stderr.write("ls: /data/caddy/certificates/*/x/x.crt: No such file or directory\n");
    process.exit(1);
  }
} else if (command[0] === "exec" && command.some((arg) => arg.startsWith("du -sk "))) {
  // Each mirror's disk probe: its cache's KiB, the KiB free on its disk, the Docker guard's state.
  out(
    `2048\n${state.mirrorFreeKiB ?? 1048576}\n${command.includes("docker-mirror") ? (state.mirrorGuard ?? "running") : ""}`,
  );
} else if (command[0] === "exec" && command.includes("docker-mirror")) {
  // The registry's proxy counters.
  out(
    'registry_proxy_hits_total{type="blob"} 3\nregistry_proxy_hits_total{type="manifest"} 2\nregistry_proxy_misses_total{type="blob"} 1\nregistry_proxy_misses_total{type="manifest"} 2',
  );
} else if (command[0] === "logs" && command.includes("npm-mirror")) {
  // nginx's request lines: one tarball served from the cache, one fetched.
  out('{"uri":"/a/-/a-1.0.0.tgz","cache":"HIT"}\n{"uri":"/b/-/b-1.0.0.tgz","cache":"MISS"}');
} else if (command[0] === "logs") out("bounded fixture log");
else if (command[0] === "down") {
  // Compose removes its project's networks and volumes, all but those a container still holds.
  if (fs.existsSync(protocolFile)) {
    const daemonState = JSON.parse(fs.readFileSync(protocolFile, "utf8"));
    const held = (kind) =>
      new Set((daemonState.facts ?? []).flatMap(([, facts]) => facts[kind] ?? []));
    for (const [kind, holder] of [
      ["networks", "networks"],
      ["volumes", "mounts"],
    ]) {
      daemonState[kind] = (daemonState[kind] ?? []).filter(
        ([name, labels]) =>
          labels?.["com.docker.compose.project"] !== "mend" || held(holder).has(name),
      );
    }
    fs.writeFileSync(protocolFile, JSON.stringify(daemonState));
  }
  state.appRunning = false;
  state.postgresRunning = false;
  state.edgeRunning = false;
  state.mirrorContainers = {};
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
    if (withEdge) {
      state.edgeRunning = true;
      state.edgeDirectory = directory;
    }
    state.mirrorContainers = {
      ...state.mirrorContainers,
      ...Object.fromEntries(mirrorServices.map((service) => [service, directory])),
    };
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
} else if (command[0] === "exec" && command.includes("psql")) {
  // What each database applied: Mend's mend_migrations names, Sealant's drizzle "name|created_at".
  if (!state.postgresRunning) fail();
  const database = command.find((arg) => arg.startsWith("--dbname="))?.slice("--dbname=".length);
  out((state.applied?.[database] ?? []).join("\n"));
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
    "-- PostgreSQL database cluster dump\nCREATE DATABASE mend;\nCREATE DATABASE sealant_control_plane;\n--\n-- PostgreSQL database cluster dump complete\n--\n",
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
