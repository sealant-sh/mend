import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs } from "./verify.mjs";
import {
  claimSlot,
  funnelFromOutside,
  releaseSlot,
  slotDriveArgs,
  slotOfCopy,
} from "./vm-boat.mjs";
import {
  addressOf,
  boxSshArgs,
  holdLoginsScript,
  hostOf,
  LOGIN_CLAIM,
  masterHostKey,
  SLOTS,
  urlOf,
  vmBuild,
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

test("a copy started before the last build reads as on the master before", async () => {
  const root = scratch();
  try {
    mkdirSync(join(root, "master"), { recursive: true });
    writeFileSync(
      join(root, "master/master.json"),
      JSON.stringify({ version: "v2", sha: "b".repeat(40), builtAt: "2026-11-21T08:00:00Z" }),
    );
    for (const [slot, builtAt, version] of [
      [1, "2026-11-20T08:00:00Z", "v1"],
      [2, "2026-11-21T08:00:00Z", "v2"],
    ]) {
      mkdirSync(join(root, "copies", String(slot)), { recursive: true });
      writeFileSync(
        join(root, "copies", String(slot), "copy.json"),
        JSON.stringify({ slot, startedAt: new Date().toISOString(), master: { version, builtAt } }),
      );
    }
    const steps = vmList({ root }).steps;
    assert.match(steps.find((s) => s.id === "copy-1").detail, /on the master before \(v1\)/);
    assert.doesNotMatch(steps.find((s) => s.id === "copy-2").detail, /master before/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a copy stopping during a build keeps the build's ssh block, under the one host key alias", async () => {
  const root = scratch();
  try {
    mkdirSync(join(root, "master-build"), { recursive: true });
    writeFileSync(join(root, "master-build/building"), "1\n");
    mkdirSync(join(root, "copies", "1"), { recursive: true });
    await vmDown({ root, slot: 1 });
    const config = readFileSync(join(root, "ssh_config"), "utf8");
    assert.match(config, /Host mend-check-master\n/);
    assert.match(config, /StrictHostKeyChecking accept-new/);
    assert.deepEqual(
      [...config.matchAll(/HostKeyAlias (\S+)/g)].map((m) => m[1]),
      ["mend-check-vm"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every master gets one host key; the entry of the master before stays in known_hosts", () => {
  const root = scratch();
  try {
    mkdirSync(join(root, "key"), { recursive: true });
    const before =
      "mend-check-vm ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBEFOREBEFOREBEFOREBEFOREBEFOREBEFOREBEFOR";
    writeFileSync(join(root, "known_hosts"), before);
    const first = masterHostKey(root);
    const again = masterHostKey(root);
    assert.equal(again.public, first.public, "made once");
    assert.match(first.private, /BEGIN OPENSSH PRIVATE KEY/);
    assert.deepEqual(readFileSync(join(root, "known_hosts"), "utf8").trim().split("\n"), [
      before,
      `mend-check-vm ${first.public}`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("vm build without what to install changes nothing, and the master stays", async () => {
  const root = scratch();
  try {
    mkdirSync(join(root, "master"), { recursive: true });
    writeFileSync(
      join(root, "master/master.json"),
      JSON.stringify({ version: "v", sha: "s".repeat(40) }),
    );
    const result = await vmBuild({ root });
    assert.equal(result.steps[0].status, "failed");
    assert.match(result.steps[0].detail, /--version <preview>/);
    assert.deepEqual(readdirSync(root).toSorted(), ["master"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Funnel counts as up only when both ports answer through a public address", async () => {
  const asked = [];
  const up = await funnelFromOutside("boat.example.ts.net", {
    resolve: async () => ["192.0.2.7", "192.0.2.8"],
    probe: (name, port, address) => {
      asked.push(`${name}:${port}:${address}`);
      return address === "192.0.2.7" ? "000" : port === 8443 ? "401" : "403";
    },
  });
  assert.equal(up.ok, true);
  assert.match(
    up.detail,
    /8443 answered 401 through 192\.0\.2\.8, 10000 answered 403 through 192\.0\.2\.8/,
  );
  assert.ok(
    asked.includes("boat.example.ts.net:8443:192.0.2.7"),
    "the name is asked through each relay address",
  );

  const dead = await funnelFromOutside("boat.example.ts.net", {
    timeoutMs: 0,
    resolve: async () => ["192.0.2.7"],
    probe: (_name, port) => (port === 8443 ? "401" : "000"),
  });
  assert.equal(dead.ok, false);
  assert.match(
    dead.detail,
    /8443 answered 401 through 192\.0\.2\.7, 10000 last 192\.0\.2\.7: no HTTP answer in 5 s/,
  );
  assert.match(dead.detail, /vm down, then vm up --boat/);

  const unknown = await funnelFromOutside("boat.example.ts.net", {
    timeoutMs: 0,
    resolve: async () => {
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    },
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.detail, /no public A record \(ENOTFOUND\)/);
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
