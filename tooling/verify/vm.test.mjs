import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs } from "./verify.mjs";
import { claimSlot, releaseSlot, slotDriveArgs, slotOfCopy } from "./vm-boat.mjs";
import {
  addressOf,
  boxSshArgs,
  holdLoginsScript,
  hostOf,
  LOGIN_CLAIM,
  SLOTS,
  urlOf,
  vmDown,
  vmList,
  vmSave,
  vmUp,
} from "./vm.mjs";

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

test("verify vm up takes --boat", () => {
  const { words, options } = parseArgs(["vm", "up", "--boat"]);
  assert.deepEqual(words, ["vm", "up"]);
  assert.equal(options.boat, true);
});

const slots = (root, count) => {
  for (let slot = 1; slot <= count; slot++) {
    mkdirSync(join(root, "boat-slots", String(slot)), { recursive: true });
    writeFileSync(
      join(root, "boat-slots", String(slot), "slot.json"),
      JSON.stringify({ dnsName: `mend-check-boat-${slot}.example.ts.net` }),
    );
  }
};

test("two copies claiming at once get different Boat slots, and a live claim is never taken", () => {
  const root = scratch();
  try {
    slots(root, 2);
    const running = () => true;
    assert.equal(claimSlot(root, 1, running), 1);
    assert.equal(claimSlot(root, 5, running), 2);
    assert.equal(claimSlot(root, 6, running), null, "both slots are held");
    // The loser of a race cleans up only its own claim.
    releaseSlot(root, 1, 6);
    assert.equal(slotOfCopy(root, 1), 1);
    releaseSlot(root, 1, 1);
    assert.equal(slotOfCopy(root, 1), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale claim (its copy gone, past the grace) is taken over; a young one is not", () => {
  const root = scratch();
  try {
    slots(root, 1);
    const claim = join(root, "boat-slots/1/claim.json");
    writeFileSync(claim, JSON.stringify({ copy: 3, at: new Date().toISOString() }));
    assert.equal(
      claimSlot(root, 4, () => false),
      null,
      "a copy still booting keeps its slot",
    );
    writeFileSync(claim, JSON.stringify({ copy: 3, at: "2026-01-01T00:00:00Z" }));
    assert.equal(
      claimSlot(root, 4, () => true),
      null,
      "a running copy keeps its slot",
    );
    assert.equal(
      claimSlot(root, 4, () => false),
      1,
      "a crashed copy's slot is free again",
    );
    assert.equal(JSON.parse(readFileSync(claim, "utf8")).copy, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Boat slot's disk is attached by serial, behind the copy's own disk", () => {
  assert.deepEqual(slotDriveArgs("/vms", 2), [
    "-drive",
    "file=/vms/boat-slots/2/tailnet.img,if=none,id=tailnet,format=raw,cache=writeback",
    "-device",
    "virtio-blk-pci,drive=tailnet,serial=mendtailnet",
  ]);
});

test("vm save refuses a copy that is not running, and leaves the saved data as it was", async () => {
  const root = scratch();
  try {
    mkdirSync(join(root, "box"), { recursive: true });
    writeFileSync(join(root, "box", "world.sql"), "the last good data");
    const result = await vmSave({ root, repoRoot: process.cwd(), slot: 3 });
    assert.equal(result.steps[0].status, "blocked_by_prerequisite");
    assert.equal(readFileSync(join(root, "box", "world.sql"), "utf8"), "the last good data");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a saved copy's logins are held against refresh by a claim no sweeper reaches", () => {
  assert.ok(Date.parse(LOGIN_CLAIM) > Date.parse("2900-01-01"));
  assert.match(holdLoginsScript, /docker stop --time 60 mend-mend-1/);
  assert.match(holdLoginsScript, /set refresh_claimed_until = '2999-01-01 00:00:00\+00'/);
  assert.match(holdLoginsScript, /kind in \('auth-json', 'credentials-json'\)/);
});

test("verify vm save takes a copy's number", () => {
  const { words } = parseArgs(["vm", "save", "2"]);
  assert.deepEqual(words, ["vm", "save", "2"]);
});
