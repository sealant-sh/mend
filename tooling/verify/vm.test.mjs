import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs } from "./verify.mjs";
import { addressOf, boxSshArgs, hostOf, SLOTS, urlOf, vmDown, vmList, vmUp } from "./vm.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "vm-test-"));

test("each copy has its own loopback address, URL and ssh host", () => {
  const seen = new Set();
  for (let slot = 1; slot <= SLOTS; slot++) {
    assert.match(addressOf(slot), /^127\.0\.1\.\d+$/);
    assert.equal(urlOf(slot), `http://${addressOf(slot)}:3105`);
    assert.equal(hostOf(slot), `mend-check-${slot}`);
    seen.add(addressOf(slot));
  }
  assert.equal(seen.size, SLOTS);
});

test("a copy is named to the box verbs through one ssh config", () => {
  assert.deepEqual(boxSshArgs("/vms", 3), ["-F", "/vms/ssh_config", "mend-check-3"]);
});

test("vm up without a master is blocked and changes nothing", async () => {
  const root = scratch();
  try {
    const result = await vmUp({ root });
    assert.equal(result.steps[0].status, "blocked_by_prerequisite");
    assert.match(result.next[0], /vm build/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("vm up refuses when every slot is taken", async () => {
  const root = scratch();
  try {
    mkdirSync(join(root, "master"), { recursive: true });
    writeFileSync(
      join(root, "master/master.json"),
      JSON.stringify({ version: "v", sha: "s".repeat(40) }),
    );
    for (let slot = 1; slot <= SLOTS; slot++)
      mkdirSync(join(root, "copies", String(slot)), { recursive: true });
    const result = await vmUp({ root });
    assert.equal(result.steps[0].id, "slot");
    assert.equal(result.steps[0].status, "blocked_by_prerequisite");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("vm down removes a copy whose VM is gone, and rewrites the ssh config without it", async () => {
  const root = scratch();
  try {
    for (const slot of [1, 2]) {
      mkdirSync(join(root, "copies", String(slot)), { recursive: true });
      // A pid that is not this copy's QEMU is never signalled.
      writeFileSync(join(root, "copies", String(slot), "qemu.pid"), String(process.pid));
    }
    const result = await vmDown({ root, slot: 1 });
    assert.equal(result.steps[0].status, "passed");
    assert.match(result.steps[0].detail, /not running/);
    const config = readFileSync(join(root, "ssh_config"), "utf8");
    assert.doesNotMatch(config, /mend-check-1\b/);
    assert.match(config, /Host mend-check-2\n {2}HostName 127\.0\.1\.2\n {2}Port 2022/);
    assert.match(config, /StrictHostKeyChecking yes/);
    assert.deepEqual(
      vmList({ root }).copies.map((copy) => [copy.slot, copy.running]),
      [[2, false]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify vm takes its build options", () => {
  const { words, options } = parseArgs([
    "vm",
    "build",
    "--version",
    "0.37.0-next.1.preview.2",
    "--sha",
    "a".repeat(40),
    "--cli",
    "0.37.0-next.1",
    "--cpus",
    "4",
    "--memory",
    "8G",
  ]);
  assert.deepEqual(words, ["vm", "build"]);
  assert.equal(options.vmVersion, "0.37.0-next.1.preview.2");
  assert.equal(options.vmCli, "0.37.0-next.1");
  assert.equal(options.cpus, 4);
  assert.equal(options.memory, "8G");
});
