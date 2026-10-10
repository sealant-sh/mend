#!/usr/bin/env node
// A `docker` for lifecycle.e2e.test.mjs: containers, volumes and networks in a JSON file
// ($FAKE_DOCKER_STATE), for the commands the stack's claim, preflight, removal and watchdog send.
// Faults and pauses, each named by an environment variable:
// - FAKE_DOCKER_FAIL_LOOKUPS (a file holding a count): that many `ps` calls fail as an unreachable
//   daemon would;
// - FAKE_DOCKER_CREATE_DELAY_MS: the owner container's `create` is held back that long, and
//   FAKE_DOCKER_CREATING (a file) is written while it waits;
// - FAKE_DOCKER_PAUSE_LIST (a file): while it exists, an unfiltered `ps` (a stack's enumeration)
//   writes `<file>.paused` and waits;
// - FAKE_DOCKER_PAUSE_RM (a file holding a container or volume name): while the file exists, an
//   `rm` or `volume rm` of that name writes `<file>.paused` and waits, before it removes anything;
// - FAKE_DOCKER_BUILD: `hang` makes `build` wait a minute; otherwise `build` fails at once.
import { appendFileSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const statePath = process.env.FAKE_DOCKER_STATE;
const lockPath = `${statePath}.lock`;
appendFileSync(`${statePath}.calls`, `${JSON.stringify(args)}\n`);

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
if (verb === "version") console.log("27.5.1");
else if (verb === "pull") console.log(args.at(-1));
else if (verb === "info" && args.includes("{{.ID}}")) console.log(`FAKE:${statePath}`);
else if (verb === "info") console.log(JSON.stringify({ SecurityOptions: [] }));
else if (verb === "build") {
  if (process.env.FAKE_DOCKER_BUILD === "hang") await sleep(60_000);
  fail("ERROR: the fake daemon builds nothing");
} else if (verb === "buildx") console.log("github.com/docker/buildx v0.20.1");
else if (verb === "create") {
  const name = args[args.indexOf("--name") + 1];
  const delay = Number(process.env.FAKE_DOCKER_CREATE_DELAY_MS ?? 0);
  if (delay > 0 && name === "verify-stack-owner") {
    if (process.env.FAKE_DOCKER_CREATING) writeFileSync(process.env.FAKE_DOCKER_CREATING, "1");
    await sleep(delay);
  }
  const created = await locked((state) => {
    if (state.containers.some((item) => item.Name === `/${name}`)) return null;
    const id = `${String(state.next++).padStart(4, "0")}${"c".repeat(60)}`;
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
  console.log(shown.map((item) => item.Id).join("\n"));
} else if (verb === "inspect") {
  const list = await locked((state) => state.containers);
  console.log(JSON.stringify(list.filter((item) => args.includes(item.Id))));
} else if (verb === "rm") {
  await locked((state) => {
    state.containers = state.containers.filter(
      (item) => !args.includes(item.Id) && !args.includes(item.Name.slice(1)),
    );
  });
} else if (verb === "volume" && sub === "ls")
  console.log((await locked((state) => state.volumes)).join("\n"));
else if (verb === "volume" && sub === "create") {
  await locked((state) => void state.volumes.push(args.at(-1)));
  console.log(args.at(-1));
} else if (verb === "volume" && sub === "rm")
  await locked((state) => {
    state.volumes = state.volumes.filter((name) => !args.includes(name));
  });
else if (verb === "network" && sub === "ls")
  console.log((await locked((state) => state.networks)).join("\n"));
else if (verb === "network" && sub === "rm")
  await locked((state) => {
    state.networks = state.networks.filter((name) => !args.includes(name));
  });
else if (verb === "image") console.log("");
else fail(`fake docker: unexpected ${args.join(" ")}`, 2);
