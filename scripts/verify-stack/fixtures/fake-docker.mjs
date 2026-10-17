#!/usr/bin/env node
// A `docker` for lifecycle.e2e.test.mjs: containers, volumes and networks in a JSON file
// ($FAKE_DOCKER_STATE), for the commands the stack's claim, preflight, removal and watchdog send.
// Containers, volumes and networks are kept as `docker inspect` shows them; `files` holds what a
// `run` wrote into the state volume (the ledger's copy).
// `Anonymous: true` is test-only volume metadata: a hex-shaped name alone does not prove an
// anonymous volume. Container removal releases endpoints and mounts before removing unused
// anonymous volumes, while network/volume removal refuses surviving users.
// Every call is appended to `<state>.calls`, and to `<state>.locks` with whether it inherited the
// stack's lock descriptor (FAKE_DOCKER_LOCK, set by the wrapper from fd 9).
// Faults and pauses, each named by an environment variable:
// - FAKE_DOCKER_FAIL_LOOKUPS (a file holding a count): that many `ps` calls fail as an unreachable
//   daemon would;
// - FAKE_DOCKER_PAUSE_CREATE (a file): while it exists, the owner container's `create` writes
//   FAKE_DOCKER_CREATING (a file) and waits before the claim lands;
// - FAKE_DOCKER_PAUSE_LIST (a file): while it exists, an unfiltered `ps` (a stack's enumeration)
//   writes `<file>.paused` and waits;
// - FAKE_DOCKER_PAUSE_RM (a file holding a container or volume name): while the file exists, an
//   `rm` or `volume rm` of that name writes `<file>.paused` and waits, before it removes anything;
// - FAKE_DOCKER_FAIL_RM (a file holding a container or volume name): removal of that resource
//   fails without changing it while the file exists;
// - FAKE_DOCKER_FAIL_LEDGER_READ (a file holding `{ stdout, stderr }`): reading the state-volume
//   ledger fails with those partial outputs while the file exists;
// - FAKE_DOCKER_PAUSE_PULL (a file): while it exists, a `pull` writes `<file>.paused` and waits;
// - FAKE_DOCKER_RUN (a file holding `{ containers, volumes, networks }` of names, a container's
//   name optionally with its labels and mounted volumes as `[name, labels, volumes]`): a `run`
//   of the
//   inner CLI makes them, as an inner session would; then, while FAKE_DOCKER_PAUSE_RUN (a file)
//   exists, it writes `<file>.paused` and waits;
// - FAKE_DOCKER_BUILD: `hang` writes `<FAKE_DOCKER_PAUSE_BUILD>.paused` and waits while that
//   file exists; `success` enables the explicit orchestration fixture image/setup state;
//   the default still fails every build.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const statePath = process.env.FAKE_DOCKER_STATE;
const lockPath = `${statePath}.lock`;
appendFileSync(`${statePath}.calls`, `${JSON.stringify(args)}\n`);
appendFileSync(
  `${statePath}.locks`,
  `${JSON.stringify({ args, lock: process.env.FAKE_DOCKER_LOCK === "1" })}\n`,
);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function locked(work) {
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch {
      await sleep(5);
    }
  }
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const result = await work(state);
    writeFileSync(statePath, JSON.stringify(state));
    return result;
  } finally {
    rmdirSync(lockPath);
  }
}
const fail = (message, code = 1) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};
const labelsOf = (list) => {
  const labels = {};
  list.forEach((arg, index) => {
    if (list[index - 1] === "--label") {
      const at = arg.indexOf("=");
      labels[arg.slice(0, at)] = arg.slice(at + 1);
    }
  });
  return labels;
};

const failLookups = process.env.FAKE_DOCKER_FAIL_LOOKUPS;
if (args[0] === "ps" && failLookups) {
  const left = Number(readFileSync(failLookups, "utf8"));
  if (left > 0) {
    writeFileSync(failLookups, String(left - 1));
    fail("Cannot connect to the Docker daemon at tcp://docker:2375. Is the docker daemon running?");
  }
}

const exists = (path) => {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (condition) => {
  while (!condition()) await sleep(50);
};

const [verb, sub] = args;
const orchestration =
  process.env.FAKE_DOCKER_BUILD === "success"
    ? await locked((state) => state.orchestration ?? null)
    : null;
const imageRecord = (tag, labels = {}) => ({
  Id: `sha256:${createHash("sha256").update(tag).digest("hex")}`,
  Labels: labels,
});

const failRm = process.env.FAKE_DOCKER_FAIL_RM;
if ((verb === "rm" || (verb === "volume" && sub === "rm")) && failRm && exists(failRm)) {
  const name = readFileSync(failRm, "utf8").trim();
  const list = await locked((state) => state.containers);
  const named = list.find((item) => item.Name === `/${name}`)?.Id;
  if (args.includes(name) || (named && args.includes(named)))
    fail(`Error: injected removal failure for ${name}`);
}
const pauseRm = process.env.FAKE_DOCKER_PAUSE_RM;
if ((verb === "rm" || (verb === "volume" && sub === "rm")) && pauseRm && exists(pauseRm)) {
  const name = readFileSync(pauseRm, "utf8").trim();
  const list = await locked((state) => state.containers);
  const named = list.find((item) => item.Name === `/${name}`)?.Id;
  if (args.includes(name) || (named && args.includes(named))) {
    writeFileSync(`${pauseRm}.paused`, "1");
    await waitFor(() => !exists(pauseRm));
  }
}
const pausePull = process.env.FAKE_DOCKER_PAUSE_PULL;
if (verb === "pull" && pausePull && exists(pausePull)) {
  writeFileSync(`${pausePull}.paused`, "1");
  await waitFor(() => !exists(pausePull));
}
const volumeNamed = (name) => (volume) => volume.Name === name;
const volumeUsers = (state, name) =>
  state.containers.filter((item) =>
    (item.Mounts ?? []).some((mount) => mount.Type === "volume" && mount.Name === name),
  );
const networkUsers = (state, network) =>
  state.containers.filter((item) =>
    Object.entries(item.NetworkSettings?.Networks ?? {}).some(([name, details]) =>
      details?.NetworkID ? details.NetworkID === network.Id : name === network.Name,
    ),
  );
/** `--format` of a Go template naming fields only (`{{.Name}}\t{{.CreatedAt}}`), per item. */
const render = (template, item) =>
  template
    .replaceAll("\\t", "\t")
    .replace(/\{\{\.Label "([^"]+)"\}\}/g, (_, label) => String(item.Labels?.[label] ?? ""))
    .replace(/\{\{\.(\w+)\}\}/g, (_, field) => String(item[field] ?? ""));
/** A container as `docker ps --format` sees it. */
const listed = (item) => ({
  ID: item.Id,
  Names: item.Name.slice(1),
  Labels: item.Config?.Labels ?? {},
  Mounts: (item.Mounts ?? []).map((mount) => mount.Name).join(","),
});
const formatOf = () => (args.includes("--format") ? args[args.indexOf("--format") + 1] : null);
const newId = (state, fill) => `${String(state.next++).padStart(4, "0")}${fill.repeat(60)}`;

if (verb === "version") console.log("27.5.1");
else if (verb === "pull") {
  const tag = args.at(-1);
  if (orchestration?.guard === tag && orchestration.guardPullFailure)
    fail("synthetic guard preload refused", 44);
  if (orchestration !== null)
    await locked((state) => {
      (state.images ??= {})[tag] = imageRecord(tag);
    });
  console.log(tag);
} else if (verb === "run" && args.some((arg) => arg.includes("umask 077"))) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  await locked((state) => {
    state.files = { ...state.files, [args.at(-1)]: Buffer.concat(chunks).toString() };
  });
} else if (verb === "run" && args.some((arg) => arg.includes("/state/ledger.json"))) {
  const fault = process.env.FAKE_DOCKER_FAIL_LEDGER_READ;
  if (fault && exists(fault)) {
    const output = JSON.parse(readFileSync(fault, "utf8"));
    process.stdout.write(output.stdout);
    fail(output.stderr, 42);
  }
  const files = await locked((state) => state.files ?? {});
  const copy = Object.entries(files).find(([path]) => path.endsWith("/ledger.json"));
  if (copy) process.stdout.write(copy[1]);
  else process.stdout.write('{"containers":[],"volumes":[],"networks":[]}\n');
} else if (
  verb === "run" &&
  orchestration !== null &&
  args.includes("server") &&
  args[args.indexOf("server") + 1] === "setup"
) {
  await locked((state) => {
    if (!state.networks.some((network) => network.Name === "mend_default"))
      state.networks.push({
        Id: newId(state, "b"),
        Name: "mend_default",
        Labels: { "com.docker.compose.project": "mend" },
      });
  });
  console.log("synthetic offline setup returned; no real inner install executed");
} else if (
  verb === "run" &&
  orchestration !== null &&
  args[args.indexOf("--name") + 1] === "verify-stack-relay"
) {
  const id = await locked((state) => {
    const containerId = newId(state, "a");
    const network = state.networks.find((candidate) => candidate.Name === "mend_default");
    state.containers.push({
      Id: containerId,
      Name: "/verify-stack-relay",
      Config: { Labels: labelsOf(args) },
      NetworkSettings: { Networks: { mend_default: { NetworkID: network.Id } } },
    });
    return containerId;
  });
  console.log(id);
} else if (verb === "run") {
  const script = process.env.FAKE_DOCKER_RUN;
  if (script && exists(script)) {
    const made = JSON.parse(readFileSync(script, "utf8"));
    await locked((state) => {
      for (const made1 of made.containers ?? []) {
        const [name, labels = {}, mounts = [], image] = Array.isArray(made1) ? made1 : [made1];
        state.containers.push({
          Id: newId(state, "a"),
          Name: `/${name}`,
          Config: { Labels: labels, ...(image ? { Image: image } : {}) },
          ...(image ? { Image: `sha256:${createHash("sha256").update(image).digest("hex")}` } : {}),
          Mounts: mounts.map((volume) => ({ Type: "volume", Name: volume })),
        });
      }
      for (const name of made.volumes ?? [])
        state.volumes.push({
          Name: name,
          Labels: {},
          Mountpoint: `/fake/volumes/${name}/_data`,
          CreatedAt: new Date().toISOString(),
        });
      for (const name of made.networks ?? [])
        state.networks.push({ Id: newId(state, "b"), Name: name });
    });
    const pauseRun = process.env.FAKE_DOCKER_PAUSE_RUN;
    if (pauseRun && exists(pauseRun)) {
      writeFileSync(`${pauseRun}.paused`, "1");
      await waitFor(() => !exists(pauseRun));
    }
  }
} else if (verb === "info" && args.includes("{{.ID}}")) console.log(`FAKE:${statePath}`);
else if (verb === "info") console.log(JSON.stringify({ SecurityOptions: [] }));
else if (verb === "build" && orchestration !== null) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const tag = args[args.indexOf("--tag") + 1];
  if (typeof tag !== "string") fail("orchestration build requires a tag");
  await locked((state) => {
    const labels = labelsOf(args);
    if (tag.startsWith("ghcr.io/sealant-sh/mend:"))
      labels["dev.sealant.mend.network-guard-image"] = orchestration.guard;
    (state.images ??= {})[tag] = imageRecord(tag, labels);
    (state.builds ??= []).push({ tag, input: Buffer.concat(chunks).toString() });
  });
  console.log("synthetic build accepted");
} else if (verb === "build") {
  const pauseBuild = process.env.FAKE_DOCKER_PAUSE_BUILD;
  if (process.env.FAKE_DOCKER_BUILD === "hang" && pauseBuild && exists(pauseBuild)) {
    writeFileSync(`${pauseBuild}.paused`, "1");
    await waitFor(() => !exists(pauseBuild));
  }
  fail("ERROR: the fake daemon builds nothing");
} else if (verb === "buildx") console.log("github.com/docker/buildx v0.20.1");
else if (verb === "create") {
  const name = args[args.indexOf("--name") + 1];
  const pauseCreate = process.env.FAKE_DOCKER_PAUSE_CREATE;
  if (pauseCreate && exists(pauseCreate) && name === "verify-stack-owner") {
    if (process.env.FAKE_DOCKER_CREATING) writeFileSync(process.env.FAKE_DOCKER_CREATING, "1");
    await waitFor(() => !exists(pauseCreate));
  }
  const created = await locked((state) => {
    if (state.containers.some((item) => item.Name === `/${name}`)) return null;
    const id = newId(state, "c");
    state.containers.push({ Id: id, Name: `/${name}`, Config: { Labels: labelsOf(args) } });
    return id;
  });
  if (created === null) fail(`Conflict. The container name "/${name}" is already in use`);
  console.log(created);
} else if (verb === "ps") {
  const filter = args.includes("--filter") ? args[args.indexOf("--filter") + 1] : null;
  const pauseList = process.env.FAKE_DOCKER_PAUSE_LIST;
  if (filter === null && pauseList && exists(pauseList)) {
    writeFileSync(`${pauseList}.paused`, "1");
    await waitFor(() => !exists(pauseList));
  }
  const list = await locked((state) => state.containers);
  const shown = list.filter((item) => {
    if (filter === null) return true;
    const exact = /^name=\^(.*)\$$/.exec(filter)?.[1];
    if (exact !== undefined) return item.Name === `/${exact}`;
    const prefix = /^name=\^(.*)$/.exec(filter)?.[1];
    if (prefix !== undefined) return item.Name.startsWith(`/${prefix}`);
    const label = /^label=([^=]+)=(.*)$/.exec(filter);
    if (label) return item.Config.Labels?.[label[1]] === label[2];
    return true;
  });
  const format = formatOf();
  console.log(
    shown.map((item) => (format === null ? item.Id : render(format, listed(item)))).join("\n"),
  );
} else if (verb === "inspect") {
  const list = await locked((state) => state.containers);
  console.log(JSON.stringify(list.filter((item) => args.includes(item.Id))));
} else if (verb === "rm") {
  await locked((state) => {
    const removed = state.containers.filter(
      (item) => args.includes(item.Id) || args.includes(item.Name.slice(1)),
    );
    state.containers = state.containers.filter((item) => !removed.includes(item));
    if (args.includes("--volumes") || args.includes("-v")) {
      const mounted = removed.flatMap((item) =>
        (item.Mounts ?? []).filter((mount) => mount.Type === "volume").map((mount) => mount.Name),
      );
      state.volumes = state.volumes.filter(
        (volume) =>
          !volume.Anonymous ||
          !mounted.includes(volume.Name) ||
          volumeUsers(state, volume.Name).length > 0,
      );
    }
  });
} else if (verb === "volume" && sub === "ls")
  console.log((await locked((state) => state.volumes)).map((volume) => volume.Name).join("\n"));
else if (verb === "volume" && sub === "inspect") {
  const list = await locked((state) => state.volumes);
  const format = formatOf();
  const names = args
    .slice(2)
    .filter((arg, index, all) => arg !== "--format" && all[index - 1] !== "--format");
  const found = list.filter((volume) => names.includes(volume.Name));
  console.log(
    format === null
      ? JSON.stringify(found)
      : found.map((volume) => render(format, volume)).join("\n"),
  );
  if (names.some((name) => !list.some(volumeNamed(name)))) fail("Error: no such volume");
} else if (verb === "volume" && sub === "create") {
  const name = args.at(-1);
  await locked((state) => {
    if (!state.volumes.some(volumeNamed(name)))
      state.volumes.push({
        Name: name,
        Labels: labelsOf(args),
        Mountpoint: `/fake/volumes/${name}/_data`,
        CreatedAt: new Date().toISOString(),
      });
  });
  console.log(name);
} else if (verb === "volume" && sub === "rm") {
  const blocked = await locked((state) => {
    const inUse = state.volumes.filter(
      (volume) => args.includes(volume.Name) && volumeUsers(state, volume.Name).length > 0,
    );
    state.volumes = state.volumes.filter(
      (volume) => !args.includes(volume.Name) || inUse.includes(volume),
    );
    return inUse.map((volume) => volume.Name);
  });
  if (blocked.length > 0) fail(`Error: volume ${blocked.join(", ")} is in use`);
} else if (verb === "network" && sub === "ls") {
  const format = formatOf();
  console.log(
    (await locked((state) => state.networks))
      .map((network) =>
        format === null
          ? network.Id
          : render(format, { ID: network.Id, Name: network.Name, Labels: network.Labels }),
      )
      .join("\n"),
  );
} else if (verb === "network" && sub === "inspect") {
  const asked = args.slice(2);
  const found = await locked((state) =>
    state.networks
      .filter((network) => asked.includes(network.Id) || asked.includes(network.Name))
      .map((network) => ({
        ...network,
        Containers: Object.fromEntries(
          networkUsers(state, network).map((item) => [item.Id, { Name: item.Name.slice(1) }]),
        ),
      })),
  );
  console.log(JSON.stringify(found));
  if (found.length < asked.length) fail("Error: no such network");
} else if (verb === "network" && sub === "rm") {
  const blocked = await locked((state) => {
    const inUse = state.networks.filter(
      (network) =>
        (args.includes(network.Name) || args.includes(network.Id)) &&
        networkUsers(state, network).length > 0,
    );
    state.networks = state.networks.filter(
      (network) =>
        (!args.includes(network.Name) && !args.includes(network.Id)) || inUse.includes(network),
    );
    return inUse.map((network) => network.Name);
  });
  if (blocked.length > 0) fail(`Error: network ${blocked.join(", ")} has active endpoints`);
} else if (verb === "image" && orchestration !== null && sub === "inspect") {
  const tag = args.at(-1);
  const item = await locked((state) => state.images?.[tag]);
  if (item === undefined) fail(`Error: no such image ${tag}`);
  const format = formatOf();
  if (format === "{{.Id}}") console.log(item.Id);
  else if (format === "{{json .}}") console.log(JSON.stringify(item));
  else if (format === '{{index .Config.Labels "dev.sealant.mend.network-guard-image"}}')
    console.log(item.Labels["dev.sealant.mend.network-guard-image"] ?? "");
  else fail("unexpected orchestration image format", 2);
} else if (verb === "image") console.log("");
else fail(`fake docker: unexpected ${args.join(" ")}`, 2);
