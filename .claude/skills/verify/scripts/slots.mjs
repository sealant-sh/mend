#!/usr/bin/env node
// The verify skill's machine-wide limit: may this run start a stack, and may it keep the one it
// started?
//
//   node .claude/skills/verify/scripts/slots.mjs [--max 4] [--max-building 2] [--wait <seconds>] \
//     [--mine <label or service id>] [--out <dir>] [--list <file> [--logs <dir>]]
//
// stack.mjs holds one stack per Docker daemon and cannot see any other session's daemon, so the
// limit across the machine is counted here, from the outer Mend. `mend service list` names every
// live Service in every project this account can see; a verify stack is one labelled `stack`
// (`mend service stack`), `st-verify-<run>` (the skill's Launch) or `stack-<run>` (earlier runs). Whether it has finished building is
// read from its own output (`mend service logs <id>`): `verify stack · ready in …` is printed once
// every image is built and the inner server is set up. Until then it is building; a stack whose
// output could not be read is counted as building and said to be unknown.
//
// Before a start (no --mine): a new stack starts building, so a slot is free while fewer than --max
// stacks are live and fewer than --max-building are building. Exit 0: free. Exit 1: none, after
// --wait seconds of looking (default 0), with the stacks that hold the slots named.
//
// After a start (--mine st-verify-<run>): two verifiers can both find a slot and both start. Every
// verifier then ranks the live stacks the same way, by when their Service was registered: the
// server lists Services newest first (ServicesRepo.listAll orders by created_at, descending, and
// GET /services keeps that order), so a Service registered later never outranks an earlier one.
// Stacks that have finished building are admitted first, then building ones, each in rank order
// while the live and building limits leave room. Exit 0: this run's stack is admitted. Exit
// 1: it is over the limit, so stop its Service and take a slot again. A stack whose output could
// not be read counts as building, which can make a later one back off when it need not; it never
// lets one stay over the limit.
//
// Exit 2: the list could not be read. --out writes slots.txt there. --list reads a saved
// `mend service list` output in place of asking the server, and --logs a directory of saved
// `<service id>.log` outputs (a test of the counting, with as many stacks as the files name).
// `mend` is the first one on PATH.

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const max = Number(flag("max", "4"));
const maxBuilding = Number(flag("max-building", "2"));
const waitSeconds = Number(flag("wait", "0"));
const mine = flag("mine");
const out = flag("out");
const listFile = flag("list");
const logsDir = flag("logs");
if (![max, maxBuilding, waitSeconds].every(Number.isFinite) || max < 1 || maxBuilding < 1) {
  process.stderr.write(
    "usage: slots.mjs [--max 4] [--max-building 2] [--wait <seconds>] [--mine <label>] [--out <dir>] [--list <file> [--logs <dir>]]\n",
  );
  process.exit(2);
}

// Mend colours its lines on a terminal: drop the escape sequences (ESC, 27) before matching.
const plain = (text) =>
  text.replaceAll("\r", "").replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

/** Up to `seconds` of a Service's output: `mend service logs` follows until it is killed. */
const serviceLogs = async (id, seconds = 8) => {
  if (listFile) {
    const file = logsDir ? join(logsDir, `${id}.log`) : null;
    return file && existsSync(file) ? readFileSync(file, "utf8") : "";
  }
  const child = spawn("mend", ["service", "logs", id], { stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => chunks.push(chunk));
  const timer = setTimeout(() => child.kill("SIGTERM"), seconds * 1000);
  try {
    await once(child, "close");
  } catch {
    // It could not start: no output, so the stack's state is unknown.
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks).toString();
};

/** The live verify stacks, each with its build state as its own output says. */
const read = async () => {
  let text;
  if (listFile) text = readFileSync(listFile, "utf8");
  else {
    const run = spawnSync("mend", ["service", "list"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    if (run.status !== 0) {
      process.stderr.write(`slots: mend service list exited ${run.status}\n${run.stderr ?? ""}`);
      process.exit(2);
    }
    text = run.stdout;
  }
  const stacks = [];
  for (const line of plain(text).split("\n")) {
    // `<name> <status> :<port> <service id>`, or since mend#651
    // `<name> <status> :<port> service <service id> · process <process id>`.
    const match =
      /^(\S+)\s+(\S+)\s+:(\S+)\s+(?:service\s+)?([0-9a-f]{8})(?:\s+·\s+process\s+[0-9a-f]{8})?\s*$/.exec(
        line,
      );
    if (!match) continue;
    const [, label, state, port, id] = match;
    if (label !== "stack" && !label.startsWith("stack-") && !label.startsWith("st-verify-"))
      continue;
    stacks.push({ label, state, port, id });
  }
  // Oldest registration first: the server lists newest first.
  stacks.reverse();
  await Promise.all(
    stacks.map(async (stack) => {
      const output = plain(await serviceLogs(stack.id));
      stack.phase = /^verify stack · ready in /m.test(output)
        ? "built"
        : /^verify stack: /m.test(output)
          ? "failed"
          : /^verify stack · /m.test(output)
            ? "building"
            : "unknown";
    }),
  );
  return stacks;
};

const describe = (stack) =>
  `  ${stack.label} · ${
    stack.phase === "built"
      ? "built"
      : stack.phase === "unknown"
        ? "unknown, counted as building"
        : stack.phase === "failed"
          ? "failed, counted as building until its Service ends"
          : "building"
  } · port ${stack.state} · service ${stack.id}`;

const verdictOf = (stacks) => {
  const building = stacks.filter((stack) => stack.phase !== "built").length;
  const lines = [
    `slots · ${stacks.length} verify stack(s) live, ${building} building · limit ${max} live, ${maxBuilding} building`,
    ...stacks.map(describe),
  ];
  if (mine !== undefined) {
    const matches = stacks.filter((stack) => stack.label === mine || stack.id.startsWith(mine));
    if (matches.length !== 1) {
      lines.push(
        matches.length === 0
          ? `slots · ${mine} is not live`
          : `slots · ${mine} names ${matches.length} stacks: pass the Service id`,
      );
      return { free: false, final: true, lines };
    }
    // Built stacks first, then building ones, each in registration order, while the limits leave
    // room: a built stack past --max is over the limit too.
    const admitted = new Set();
    let live = 0;
    let admittedBuilding = 0;
    for (const stack of stacks)
      if (stack.phase === "built" && live < max) {
        admitted.add(stack);
        live += 1;
      }
    for (const stack of stacks)
      if (stack.phase !== "built" && live < max && admittedBuilding < maxBuilding) {
        admitted.add(stack);
        live += 1;
        admittedBuilding += 1;
      }
    const holds = admitted.has(matches[0]);
    lines.push(
      holds
        ? `slots · ${matches[0].label} holds a slot`
        : `slots · ${matches[0].label} is over the limit: stop its Service and take a slot again`,
    );
    return { free: holds, final: true, lines };
  }
  const full =
    stacks.length >= max
      ? `${stacks.length} of ${max} live`
      : building >= maxBuilding
        ? `${building} of ${maxBuilding} building`
        : null;
  lines.push(
    full === null
      ? "slots · a slot is free"
      : `slots · no slot: ${full}; the stacks above hold them`,
  );
  return { free: full === null, final: false, lines };
};

const deadline = Date.now() + waitSeconds * 1000;
let verdict = verdictOf(await read());
while (!verdict.free && !verdict.final && Date.now() < deadline) {
  const pause = Math.min(15_000, Math.max(0, deadline - Date.now()));
  process.stdout.write(`${verdict.lines.at(-1)} · looking again in ${Math.ceil(pause / 1000)} s\n`);
  await new Promise((done) => setTimeout(done, pause));
  verdict = verdictOf(await read());
}
const text = `${verdict.lines.join("\n")}\n`;
if (out) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "slots.txt"), text);
}
process.stdout.write(text);
process.exit(verdict.free ? 0 : 1);
