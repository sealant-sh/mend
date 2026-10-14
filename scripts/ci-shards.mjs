import { spawn } from "node:child_process";
import { glob, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";

import { ciTurboOptions } from "./ci-turbo.mjs";

const engineLanePackage = "@mend/sessions";
const shards = {
  engines: [
    engineLanePackage,
    "@mend/api-server",
    "@mend/db",
    "@mend/jobs",
    "@mend/auth",
    "@mend/inference",
    "@mend/landing",
    "@mend/store",
    "@mend/sealant",
    "@mend/slack",
  ],
  "clients-a": [
    "@mend/t3-gateway",
    "@mend/desktop",
    "@mend/marketing",
    "@mend/mobile",
    "mend",
    "@mend/agent-conversation",
    "@mend/agent-protocol",
    "@mend/api-contracts",
  ],
  "clients-b": [
    "@mend/docs",
    "@mend/web",
    "@mend/domain",
    "@mend/network",
    "@mend/t3-contracts",
    "@mend/workspace-ssh",
  ],
};

// The CLI keeps its package test script; Turbo forwards each native Vitest shard argument.
const cliSplit = {
  package: "@sealant/mend",
  total: 2,
  members: [
    { shard: "clients-a", index: 1 },
    { shard: "clients-b", index: 2 },
  ],
};

const failure = (message) => ({ _tag: "error", message });
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const readInventory = async (root) => {
  try {
    const document = parseDocument(await readFile(join(root, "pnpm-workspace.yaml"), "utf8"));
    if (document.errors.length > 0) return failure("Invalid pnpm-workspace.yaml.");
    const workspace = document.toJS();
    if (
      !isRecord(workspace) ||
      !Array.isArray(workspace.packages) ||
      workspace.packages.length === 0 ||
      workspace.packages.some(
        (pattern) => typeof pattern !== "string" || pattern.trim() === "" || pattern === "!",
      )
    ) {
      return failure("Workspace packages must be a nonempty array of glob patterns.");
    }
    const included = workspace.packages.filter((pattern) => !pattern.startsWith("!"));
    if (included.length === 0)
      return failure("Workspace packages must include a positive pattern.");
    const excluded = workspace.packages
      .filter((pattern) => pattern.startsWith("!"))
      .flatMap((pattern) => [pattern.slice(1), `${pattern.slice(1).replace(/\/+$/, "")}/**`]);
    const inventory = new Map();
    for await (const manifest of glob(
      included.map((pattern) => `${pattern.replace(/\/+$/, "")}/package.json`),
      { cwd: root, exclude: ["**/node_modules/**", "**/bower_components/**", ...excluded] },
    )) {
      // The root test script orchestrates Turbo; it is not a package test task.
      const filename = resolve(root, manifest);
      if (filename === join(root, "package.json")) continue;
      let pkg;
      try {
        pkg = JSON.parse(await readFile(filename, "utf8"));
      } catch {
        return failure(`Cannot read a valid package manifest: ${manifest}.`);
      }
      if (!isRecord(pkg) || typeof pkg.name !== "string" || pkg.name.trim() === "") {
        return failure(`Package manifest needs a nonempty name: ${manifest}.`);
      }
      if (inventory.has(pkg.name)) {
        return failure(`Duplicate workspace package name ${pkg.name}: ${manifest}.`);
      }
      if (pkg.scripts !== undefined && !isRecord(pkg.scripts)) {
        return failure(`Package scripts must be an object: ${manifest}.`);
      }
      const hasTest = pkg.scripts !== undefined && Object.hasOwn(pkg.scripts, "test");
      if (hasTest && (typeof pkg.scripts.test !== "string" || pkg.scripts.test.trim() === "")) {
        return failure(`Package test script must be a nonempty string: ${manifest}.`);
      }
      inventory.set(pkg.name, { manifest, hasTest });
    }
    return { _tag: "ok", inventory };
  } catch {
    return failure("Cannot discover workspace packages from pnpm-workspace.yaml.");
  }
};

const parsePartition = (inventory) => {
  const assigned = new Map();
  const problems = [];
  const boundShards = new Set(["engines", ...cliSplit.members.map((member) => member.shard)]);
  for (const shard of Object.keys(shards)) {
    if (!boundShards.has(shard)) problems.push(`Unbound package shard: ${shard}.`);
  }
  for (const shard of boundShards) {
    if (!Object.hasOwn(shards, shard)) problems.push(`Missing bound package shard: ${shard}.`);
  }
  if (!Object.hasOwn(shards, "engines") || !shards.engines.includes(engineLanePackage)) {
    problems.push(`Missing dedicated engines package assignment: ${engineLanePackage}.`);
  }
  const splitIndices = new Set();
  const splitShards = new Set();
  if (cliSplit.total !== 2 || cliSplit.members.length !== 2) {
    problems.push("CLI split must declare exactly two native Vitest shards.");
  }
  for (const member of cliSplit.members) {
    if (!Object.hasOwn(shards, member.shard) || member.shard === "engines") {
      problems.push(`Unknown CLI client shard: ${member.shard}.`);
    }
    if (splitShards.has(member.shard))
      problems.push(`Duplicate CLI client shard: ${member.shard}.`);
    splitShards.add(member.shard);
    if (!Number.isSafeInteger(member.index) || member.index < 1 || member.index > cliSplit.total) {
      problems.push(`Invalid CLI native shard index: ${member.index}.`);
    }
    if (splitIndices.has(member.index))
      problems.push(`Duplicate CLI native shard index: ${member.index}.`);
    splitIndices.add(member.index);
  }
  for (let index = 1; index <= 2; index++) {
    if (!splitIndices.has(index)) problems.push(`Missing CLI native shard index: ${index}.`);
  }
  assigned.set(cliSplit.package, "native CLI split");
  const cli = inventory.get(cliSplit.package);
  if (cli === undefined) problems.push(`Unknown assigned workspace package: ${cliSplit.package}.`);
  else if (!cli.hasTest) problems.push(`Assigned package has no test script: ${cliSplit.package}.`);
  for (const [shard, names] of Object.entries(shards)) {
    const dedicated = shard === "engines" ? engineLanePackage : cliSplit.package;
    if (names.filter((name) => name !== dedicated).length === 0) {
      problems.push(`Empty ordinary task lane: ${shard}.`);
    }
    for (const name of names) {
      if (assigned.has(name)) {
        problems.push(`Duplicate shard assignment: ${name} (${assigned.get(name)}, ${shard}).`);
      }
      assigned.set(name, shard);
      const pkg = inventory.get(name);
      if (pkg === undefined) problems.push(`Unknown assigned workspace package: ${name}.`);
      else if (!pkg.hasTest) problems.push(`Assigned package has no test script: ${name}.`);
    }
  }
  for (const [name, pkg] of inventory) {
    if (pkg.hasTest && !assigned.has(name)) problems.push(`Missing shard assignment: ${name}.`);
  }
  return problems.length === 0 ? { _tag: "ok" } : failure(problems.join("\n"));
};

const turboArguments = (packages, options) => [
  "exec",
  "turbo",
  "run",
  "test",
  ...options,
  "--concurrency=1",
  ...packages.map((name) => `--filter=${name}`),
];

const runShard = (root, shard, options) =>
  new Promise((settle) => {
    if (process.platform === "win32") {
      settle(failure("The CI shard runner requires POSIX process groups."));
      return;
    }
    const member = cliSplit.members.find((entry) => entry.shard === shard);
    const dedicated = shard === "engines" ? engineLanePackage : cliSplit.package;
    const commands = [
      turboArguments(
        shards[shard].filter((name) => name !== dedicated),
        options,
      ),
      turboArguments([dedicated], options),
    ];
    if (member !== undefined) commands[1].push("--", `--shard=${member.index}/${cliSplit.total}`);
    const children = new Set(
      commands.map((args) =>
        spawn("pnpm", args, {
          cwd: root,
          stdio: "inherit",
          detached: true,
        }),
      ),
    );
    const groups = [...children]
      .map((child) => child.pid)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    let interrupted = null;
    let failed = null;
    let stopping = null;
    const signalGroups = (signal) => {
      for (const group of groups) {
        try {
          process.kill(-group, signal);
        } catch (error) {
          if (error.code !== "ESRCH") {
            const message = `Cannot signal CI process group ${group}: ${error.code ?? "unknown error"}.`;
            console.error(message);
            failed ??= failure(message);
          }
        }
      }
    };
    const cancel = (signal) => {
      signalGroups(signal);
      if (stopping === null && groups.length > 0) {
        // Wrapper close does not prove its descendants stopped. Retain owned group IDs until
        // escalation finishes, including descendants that ignore the graceful signal.
        stopping = new Promise((finishCleanup) =>
          setTimeout(() => {
            signalGroups("SIGKILL");
            finishCleanup();
          }, 2_000),
        );
      }
    };
    const handlers = new Map();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const forward = () => {
        interrupted ??= signal;
        cancel(signal);
      };
      handlers.set(signal, forward);
      process.on(signal, forward);
    }
    const cleanUp = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    for (const child of children) {
      child.once("error", () => {
        failed ??= failure("Cannot start pnpm; install the workspace's declared package manager.");
        cancel("SIGTERM");
      });
      child.once("close", async (code, signal) => {
        children.delete(child);
        if (failed === null && (code !== 0 || signal !== null)) {
          failed = { _tag: "ok", code: code ?? 1, signal };
          cancel("SIGTERM");
        }
        if (children.size === 0) {
          await stopping;
          cleanUp();
          settle(
            interrupted !== null
              ? { _tag: "ok", code: 1, signal: interrupted }
              : (failed ?? { _tag: "ok", code: 0, signal: null }),
          );
        }
      });
    }
  });

const main = async () => {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !(args[0] === "--check" || Object.hasOwn(shards, args[0]))) {
    console.error("Usage: node scripts/ci-shards.mjs --check|engines|clients-a|clients-b");
    process.exitCode = 1;
    return;
  }
  const root = fileURLToPath(new URL("../", import.meta.url));
  const discovered = await readInventory(root);
  const partition = discovered._tag === "error" ? discovered : parsePartition(discovered.inventory);
  if (partition._tag === "error") {
    console.error(partition.message);
    process.exitCode = 1;
    return;
  }
  if (args[0] === "--check") {
    console.log(
      `CI shards cover ${discovered.inventory.size - [...discovered.inventory.values()].filter((pkg) => !pkg.hasTest).length} test packages; the CLI has two complete native Vitest shards.`,
    );
    return;
  }
  const options = ciTurboOptions(process.env);
  if (options._tag === "error") {
    console.error(options.message);
    process.exitCode = 1;
    return;
  }
  const result = await runShard(root, args[0], options.args);
  if (result._tag === "error") {
    console.error(result.message);
    process.exitCode = 1;
  } else if (result.signal !== null) {
    // An interrupted child or wrapper cannot report success, even after graceful child cleanup.
    process.kill(process.pid, result.signal);
  } else {
    process.exitCode = result.code;
  }
};

await main();
