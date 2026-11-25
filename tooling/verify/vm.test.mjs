import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  packCli,
  SLOTS,
  unitArgs,
  unitOf,
  urlOf,
  vmBuild,
  vmDown,
  vmList,
  vmSave,
  SAVED,
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

test("a copy's QEMU runs in a transient unit of its own, named for its copies directory and slot", () => {
  assert.match(unitOf("/a", 1), /^mend-check-vm-[0-9a-f]{8}-1\.service$/);
  assert.notEqual(unitOf("/a", 1), unitOf("/a", 2));
  assert.notEqual(unitOf("/a", 1), unitOf("/b", 1));
  const args = unitArgs(unitOf("/a", 3), "/a/copies/3", 3, ["-name", "mend-check-3", "-daemonize"]);
  // The user's manager forks QEMU, waits for it to daemonize, and drops the unit once it exits.
  for (const flag of ["--user", "--collect", "--service-type=forking"])
    assert.ok(args.includes(flag));
  assert.ok(args.includes("--property=PIDFile=/a/copies/3/qemu.pid"));
  assert.deepEqual(args.slice(args.indexOf("--")), [
    "--",
    "qemu-system-x86_64",
    "-name",
    "mend-check-3",
    "-daemonize",
  ]);
});

test("vm list names a running copy's unit, and says when a copy has none", async () => {
  const root = scratch();
  const fakes = [];
  try {
    for (const [slot, unit] of [
      [1, unitOf(root, 1)],
      [2, null],
    ]) {
      const dir = join(root, "copies", String(slot));
      mkdirSync(dir, { recursive: true });
      // A process whose command line names the copy's disk reads as its QEMU.
      const fake = spawn(process.execPath, [
        "-e",
        "setTimeout(() => {}, 60000)",
        join(dir, "disk.qcow2"),
      ]);
      fakes.push(fake);
      writeFileSync(join(dir, "qemu.pid"), String(fake.pid));
      writeFileSync(
        join(dir, "copy.json"),
        JSON.stringify({ slot, startedAt: new Date().toISOString(), unit }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    const list = vmList({ root });
    assert.deepEqual(
      list.copies.map((copy) => [copy.slot, copy.running, copy.unit]),
      [
        [1, true, unitOf(root, 1)],
        [2, true, null],
      ],
    );
    assert.match(
      list.steps.find((s) => s.id === "copy-1").detail,
      /mend-check-vm-[0-9a-f]{8}-1\.service/,
    );
    assert.match(
      list.steps.find((s) => s.id === "copy-2").detail,
      /dies with the process that started it/,
    );
  } finally {
    for (const fake of fakes) fake.kill();
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

    // --cli is refused: the master's CLI is packed from --sha, never npm's next tag (SLNT-1343).
    const withCli = await vmBuild({
      root,
      version: "v",
      sha: "s".repeat(40),
      cli: "0.37.0-next.1742",
    });
    assert.equal(withCli.steps[0].status, "failed");
    assert.match(withCli.steps[0].detail, /packs the mend CLI from --sha/);
    assert.deepEqual(withCli.next, [`pnpm verify vm build --version v --sha ${"s".repeat(40)}`]);
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

test("vm save keeps Boat's build journals with the data, and the ones before as .prev", () => {
  const boat = SAVED.find(({ name }) => name === "mend-boat-state.tgz");
  assert.ok(boat, "the Boat state is saved");
  assert.equal(boat.prev, "mend-boat-state.prev.tgz");
  assert.match(boat.read, /mend_mend-boat-state/);
  assert.match(boat.read, /--exclude='\*\.lock'/);
  // A copy that never set Boat up still has the journals its master was built with.
  assert.match(boat.read, /else\n {2}cat \/root\/main-run\/mend-boat-state\.tgz/);
  assert.equal(new Set(SAVED.map(({ prev }) => prev)).size, SAVED.length);
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

test("the master's CLI is packed from the preview's commit, stamped with its version, in a worktree removed after", () => {
  const out = scratch();
  const calls = [];
  const exec = (command, args, options = {}) => {
    calls.push({ line: [command, ...args].join(" "), cwd: options.cwd ?? null });
    if (command === "pnpm" && args[2] === "pack") {
      mkdirSync(args[4], { recursive: true });
      writeFileSync(join(args[4], "sealant-mend-0.37.0-next.1751.preview.334.tgz"), "");
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    const packed = packCli({
      repoRoot: "/repo",
      sha: "c".repeat(40),
      version: "0.37.0-next.1751.preview.334",
      out,
      run: exec,
    });
    assert.equal(packed.ok, true);
    assert.equal(packed.tarball, join(out, "sealant-mend-0.37.0-next.1751.preview.334.tgz"));
    const lines = calls.map(({ line }) => line);
    const added = lines.find((line) => line.startsWith("git -C /repo worktree add"));
    assert.match(added, new RegExp(`--detach \\S+/src ${"c".repeat(40)}$`));
    const stamp = calls.find(({ line }) => line.startsWith("npm pkg set"));
    assert.equal(stamp.line, "npm pkg set version=0.37.0-next.1751.preview.334");
    assert.match(stamp.cwd, /\/src\/apps\/cli$/);
    assert.ok(lines.indexOf(stamp.line) < lines.findIndex((line) => line.includes(" pack ")));
    assert.match(lines.at(-1), /^git -C \/repo worktree remove --force \S+\/src$/);
    assert.ok(!lines.some((line) => line.includes("npm view") || line.includes("dist-tags")));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a commit the checkout lacks is fetched, and a pack that fails says which step and still removes its worktree", () => {
  const out = scratch();
  const calls = [];
  const exec = (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    if (line.includes("cat-file")) return { code: 1, stdout: "", stderr: "" };
    if (command === "pnpm" && args[0] === "install")
      return { code: 1, stdout: "", stderr: "ERR_PNPM_OUTDATED_LOCKFILE  lockfile out of date" };
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    const packed = packCli({
      repoRoot: "/repo",
      sha: "d".repeat(40),
      version: "1.0.0",
      out,
      run: exec,
    });
    assert.equal(packed.ok, false);
    assert.match(packed.detail, /^pnpm install: ERR_PNPM_OUTDATED_LOCKFILE/);
    assert.ok(calls.includes(`git -C /repo fetch --quiet origin ${"d".repeat(40)}`));
    assert.match(calls.at(-1), /worktree remove --force/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("the git phase leaves server.env alone: every mend server command refuses a line its config cannot render", () => {
  const script = readFileSync(new URL("./vm-provision.sh", import.meta.url), "utf8");
  const git = script.slice(script.indexOf("\ngit)\n"), script.indexOf("\nseal)\n"));
  assert.ok(git.length > 0);
  assert.doesNotMatch(git, /server\.env"?\s*$/m);
  assert.doesNotMatch(git, />>\s*"?\$env_file/);
  assert.doesNotMatch(
    git.replace(/^\s*#.*$/gm, ""),
    /server\.env|MEND_OPERATOR_ALLOWED_PRIVATE_EGRESS/,
  );
});
