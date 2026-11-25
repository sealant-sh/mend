import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs } from "./verify.mjs";
import {
  boatImagesScript,
  claimSlot,
  describeBoatVm,
  dumpImages,
  liveImagesOf,
  parseBoatImages,
  removeBoatImages,
  setupBoat,
  retireImagesScript,
  funnelFromOutside,
  liveBoatVmsScript,
  parseLiveBoatVms,
  releaseSlot,
  slotDriveArgs,
  slotOfCopy,
  stopBoatSessions,
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
/** A Boat copy whose images the saved data all keeps. */
const noImages = async () => ({ removed: [], left: [], refused: [] });

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

/** A Boat copy whose QEMU reads as running: a process naming its disk. */
const boatCopy = (root, slot) => {
  const dir = join(root, "copies", String(slot));
  mkdirSync(dir, { recursive: true });
  const fake = spawn(process.execPath, [
    "-e",
    "setTimeout(() => {}, 60000)",
    join(dir, "disk.qcow2"),
  ]);
  writeFileSync(join(dir, "qemu.pid"), String(fake.pid));
  writeFileSync(
    join(dir, "copy.json"),
    JSON.stringify({ slot, startedAt: "2026-11-25T02:00:00.000Z", unit: null, boat: { slot: 1 } }),
  );
  return { dir, fake };
};

test("vm down keeps a Boat copy whose Boat VMs are not confirmed gone, and says which and why", async () => {
  const root = scratch();
  const { dir, fake } = boatCopy(root, 3);
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const asked = [];
    const result = await vmDown({
      root,
      slot: 3,
      removeImages: noImages,
      stopBoat: async (_root, _ssh, url, since) => {
        asked.push([url, since]);
        return {
          left: [
            {
              vm: "bx_h84tzje2",
              workspace: "w",
              sessions: [{ id: "45d68fa4-28cc", status: "failed" }],
            },
          ],
          stops: ["mend-boat-check: no active sessions"],
        };
      },
    });
    assert.deepEqual(asked, [["http://127.0.1.3:3105", "2026-11-25T02:00:00.000Z"]]);
    assert.equal(result.steps[0].status, "failed");
    assert.match(
      result.steps[0].detail,
      /^kept: Boat VMs it launched still there: bx_h84tzje2 \(session 45d68fa4 failed\)/,
    );
    assert.match(result.steps[0].detail, /stops: mend-boat-check: no active sessions/);
    assert.ok(existsSync(join(dir, "copy.json")), "the copy is kept");
    assert.equal(fake.exitCode, null, "its VM still runs");
    assert.match(
      result.next[0],
      /^MEND_URL=http:\/\/127\.0\.1\.3:3105: stop each one's session there/,
    );
    assert.match(result.next[1], /vm down 3 --leave-boat-vms/);

    // A copy whose Mend could not say is not taken as having none.
    const unread = await vmDown({
      root,
      slot: 3,
      removeImages: noImages,
      stopBoat: async () => ({ left: null, stops: [] }),
    });
    assert.equal(unread.steps[0].status, "failed");
    assert.match(unread.steps[0].detail, /could not say which Boat VMs/);
    assert.ok(existsSync(join(dir, "copy.json")));

    // --leave-boat-vms is a person's choice: the copy goes and the VMs are named.
    const left = await vmDown({
      root,
      slot: 3,
      leaveBoatVms: true,
      removeImages: noImages,
      stopBoat: async () => ({ left: [{ vm: "bx_1", workspace: "w", sessions: [] }], stops: [] }),
    });
    assert.equal(left.steps[0].status, "passed");
    assert.match(
      left.steps[0].detail,
      /left on Boat by --leave-boat-vms: Boat VMs it launched still there: bx_1 \(no Mend session on its workspace\)/,
    );
    assert.ok(!existsSync(dir));
  } finally {
    fake.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test("vm down deletes a Boat copy once Boat confirms every VM it launched gone", async () => {
  const root = scratch();
  const { dir, fake } = boatCopy(root, 4);
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const result = await vmDown({
      root,
      slot: 4,
      removeImages: noImages,
      stopBoat: async () => ({ left: [], stops: ["mend-boat-check: ✓ stopped 2 sessions"] }),
    });
    assert.equal(result.steps[0].status, "passed");
    assert.match(
      result.steps[0].detail,
      /Boat confirmed every VM it launched gone \(stops: mend-boat-check: ✓ stopped 2 sessions\)/,
    );
    assert.ok(!existsSync(dir));
  } finally {
    fake.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test("vm down stops every live session of each checker account, then waits for Boat's answer on each VM", async () => {
  const root = scratch();
  const home = scratch();
  try {
    mkdirSync(join(root, "cli/node_modules/.bin"), { recursive: true });
    writeFileSync(join(root, "cli/node_modules/.bin/mend"), "");
    for (const kit of ["mend-boat-check", "mend-boat-check-2"])
      mkdirSync(join(home, ".local/share", kit, "cli"), { recursive: true });
    const ran = [];
    const run = (command, args, { env }) => {
      ran.push([
        command.endsWith("/mend") ? "mend" : command,
        ...args,
        env.XDG_CONFIG_HOME.split("/").at(-2),
        env.MEND_URL,
      ]);
      return { status: 0, stdout: "✓ stopped 1 session\n", stderr: "" };
    };
    const answers = [
      "vm=bx_a workspace=w1 sessions=s-1:stopping\nchecked=yes\n",
      "",
      "checked=yes\n",
    ];
    const scripts = [];
    const ssh = (script) => {
      scripts.push(script);
      return { code: 0, stdout: answers.shift() ?? "checked=yes\n", stderr: "" };
    };
    const { left, stops } = await stopBoatSessions(
      root,
      [],
      "http://127.0.1.3:3105",
      "2026-11-25T02:00:00.000Z",
      {
        run,
        ssh,
        home,
        pollMs: 1,
      },
    );
    assert.deepEqual(ran, [
      ["mend", "stop", "--all", "mend-boat-check", "http://127.0.1.3:3105"],
      ["mend", "stop", "--all", "mend-boat-check-2", "http://127.0.1.3:3105"],
    ]);
    assert.deepEqual(stops, [
      "mend-boat-check: ✓ stopped 1 session",
      "mend-boat-check-2: ✓ stopped 1 session",
    ]);
    assert.deepEqual(left, []);
    assert.equal(scripts.length, 3, "an unreadable answer is read again, not taken as none");
    assert.match(scripts[0], /create_issued_at >= '2026-11-25T02:00:00.000Z'/);

    const stuck = await stopBoatSessions(root, [], "u", "t", {
      run,
      ssh: () => ({ code: 0, stdout: "vm=bx_b workspace=w2 sessions=\nchecked=yes\n", stderr: "" }),
      home,
      waitMs: 20,
      pollMs: 5,
    });
    assert.deepEqual(stuck.left, [{ vm: "bx_b", workspace: "w2", sessions: [] }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("the live Boat VM read names each VM's sessions, and says nothing it did not check", () => {
  const script = liveBoatVmsScript("2026-11-25T02:00:00.000Z");
  assert.match(script, /deletion_completed_at is null and absent_at is null/);
  assert.match(script, /where sealant_workspace_id = '\$ws'/);
  assert.equal(parseLiveBoatVms("vm=bx_a workspace=w sessions=\n"), null);
  assert.deepEqual(
    parseLiveBoatVms(
      "vm=bx_a workspace=w1 sessions=11111111-aaaa:failed,22222222-bbbb:running\nchecked=yes\n",
    ),
    [
      {
        vm: "bx_a",
        workspace: "w1",
        sessions: [
          { id: "11111111-aaaa", status: "failed" },
          { id: "22222222-bbbb", status: "running" },
        ],
      },
    ],
  );
  assert.equal(
    describeBoatVm({ vm: "bx_a", sessions: [{ id: "11111111-aaaa", status: "failed" }] }),
    "bx_a (session 11111111 failed)",
  );
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

const ID = (n) => `${String(n).repeat(8)}-aaaa-4aaa-8aaa-${String(n).repeat(12)}`;
const identity = (name) =>
  `{"snapshot": {"kind": "boat-saved-snapshot", "identity": {"name": "${name}", "createdAt": "t", "snapshotId": "s", "sourceSandboxId": "bx_1"}}}`;
/** A pg_dumpall's native_publications block, around other tables' rows. */
const dump = (rows) =>
  [
    "COPY public.other (id) FROM stdin;",
    "x",
    "\\.",
    "COPY public.native_publications (id, build_id, state, publication, reason) FROM stdin;",
    ...rows.map(([id, state, name]) =>
      [id, "b", state, name === null ? "\\N" : identity(name), "\\N"].join("\t"),
    ),
    "\\.",
    "-- PostgreSQL database cluster dump complete",
    "",
  ].join("\n");

test("a dump's Boat images are read by id, with each one's state and snapshot name", () => {
  const root = scratch();
  try {
    const file = join(root, "world.sql");
    writeFileSync(
      file,
      dump([
        [ID(1), "ready", "sealant-dev-boat-stream-1"],
        [ID(2), "removed", "sealant-dev-boat-stream-2"],
        [ID(3), "superseded", null],
        [ID(4), "quarantined", "sealant-dev-boat-stream-4"],
      ]),
    );
    const images = dumpImages(file);
    assert.deepEqual([...images.keys()], [ID(1), ID(2), ID(3), ID(4)]);
    assert.deepEqual(images.get(ID(3)), { state: "superseded", name: null });
    assert.deepEqual(
      liveImagesOf(images).map(([id]) => id),
      [ID(1), ID(4)],
      "a removed image or one with no snapshot holds nothing in Boat",
    );
    // A dump cut short, or one without the table, is not read as one holding no images.
    writeFileSync(file, dump([[ID(1), "ready", "n"]]).replace(/\\\.\n-- Postgre[^]*$/, ""));
    assert.equal(dumpImages(file), null);
    writeFileSync(file, "COPY public.other (id) FROM stdin;\nx\n\\.\n");
    assert.equal(dumpImages(file), null);
    assert.equal(dumpImages(join(root, "missing.sql")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the copy's Boat image read leaves out what holds nothing in Boat, and says nothing it did not check", () => {
  assert.match(boatImagesScript, /state not in \('removed', 'superseded'\)/);
  assert.match(boatImagesScript, /not \(state = 'quarantined' and publication is null\)/);
  assert.equal(parseBoatImages(`image=${ID(1)} state=ready reason=- name=n\n`), null);
  assert.deepEqual(
    parseBoatImages(
      `image=${ID(1)} state=ready reason=- name=n1\nimage=bad state=ready reason=- name=-\nmend=true\nchecked=yes\n`,
    ),
    { images: [{ id: ID(1), state: "ready", reason: null, name: "n1" }], mend: true },
  );
});

test("a removal asks sealant for its own withdrawal, with its guards", () => {
  const script = retireImagesScript([ID(1), ID(2)]);
  assert.match(script, new RegExp(`p\\.id in \\('${ID(1)}', '${ID(2)}'\\)`));
  assert.match(script, /set state = 'retiring', generation = p\.generation \+ 1/);
  assert.match(
    script,
    /p\.state = 'ready' and \(p\.claim_until is null or p\.claim_until <= now\(\)\)/,
  );
  assert.match(script, /c\.state <> 'released'/);
});

/** A copy's sealant: answers the image read from `states`, and moves an image on when retired. */
const fakeCopy = (images, { mend = true, onRetire = () => {} } = {}) => {
  const retired = [];
  const ssh = (script) => {
    if (script.startsWith("# retire-images")) {
      const ids = [...script.matchAll(/'([0-9a-f-]{36})'/g)].map((match) => match[1]);
      retired.push(ids);
      onRetire(ids, images);
      return { code: 0, stdout: "", stderr: "" };
    }
    const lines = [...images.values()]
      .filter(({ state }) => state !== "removed")
      .map(
        ({ id, state, reason, name }) =>
          `image=${id} state=${state} reason=${reason ?? "-"} name=${name ?? "-"}`,
      );
    return { code: 0, stdout: `${lines.join("\n")}\nmend=${mend}\nchecked=yes\n`, stderr: "" };
  };
  return { ssh, retired };
};
const image = (n, state, reason = null) => [
  ID(n),
  { id: ID(n), state, reason, name: `sealant-dev-boat-stream-${n}` },
];

test("vm down removes the images a copy built that the saved data does not keep, and waits for sealant to record them removed", async () => {
  const images = new Map([
    image(1, "ready"), // the saved data's: kept
    image(2, "quarantined", "native-snapshot-identity-mismatch"), // the saved data's: not touched
    image(3, "ready"), // built on the copy
    image(4, "building"), // being built on the copy: ready on the next read
    image(5, "quarantined", "native-snapshot-identity-mismatch"), // built here, refused by sealant
  ]);
  const { ssh, retired } = fakeCopy(images, {
    onRetire: (ids, all) => {
      for (const id of ids) all.get(id).state = "removed";
      if (all.get(ID(4)).state === "building") all.get(ID(4)).state = "ready";
    },
  });
  const saved = () =>
    new Map([
      [ID(1), {}],
      [ID(2), {}],
    ]);
  const result = await removeBoatImages("/vms", [], { ssh, saved, pollMs: 1 });
  assert.deepEqual(retired, [[ID(3)], [ID(4)]], "only the copy's own ready images are retired");
  assert.deepEqual(
    result.removed.map(({ id }) => id),
    [ID(3), ID(4)],
  );
  assert.deepEqual(result.left, []);
  assert.deepEqual(
    result.refused.map(({ id }) => id),
    [ID(5)],
  );
  assert.equal(images.get(ID(1)).state, "ready", "the saved data's image stays");
});

test("an image sealant does not remove in time, or a copy that cannot say, is not confirmed removed", async () => {
  const held = fakeCopy(new Map([image(3, "ready")]));
  const stuck = await removeBoatImages("/vms", [], {
    ssh: held.ssh,
    saved: () => new Map(),
    waitMs: 20,
    pollMs: 5,
  });
  assert.deepEqual(
    stuck.left.map(({ id }) => id),
    [ID(3)],
  );
  assert.ok(held.retired.length >= 1);

  const stopped = fakeCopy(new Map([image(3, "ready")]), { mend: false });
  const off = await removeBoatImages("/vms", [], { ssh: stopped.ssh, saved: () => new Map() });
  assert.deepEqual(stopped.retired, [], "nothing is retired that no sealant would remove");
  assert.equal(off.left.length, 1);
  assert.match(off.why, /Mend is stopped/);

  const unread = await removeBoatImages("/vms", [], {
    ssh: () => ({ code: 1, stdout: "", stderr: "" }),
    saved: () => new Map(),
  });
  assert.equal(unread.left, null);
  const unsaved = await removeBoatImages("/vms", [], { ssh: held.ssh, saved: () => null });
  assert.equal(unsaved.left, null);
  assert.match(unsaved.why, /saved data's images/);

  // A copy holding only the saved data's images asks nothing of sealant.
  const kept = fakeCopy(new Map([image(1, "ready")]));
  const none = await removeBoatImages("/vms", [], {
    ssh: kept.ssh,
    saved: () => new Map([[ID(1), {}]]),
  });
  assert.deepEqual(kept.retired, []);
  assert.deepEqual(none, { removed: [], left: [], refused: [] });
});

test("vm down keeps a Boat copy while an image it built is not confirmed removed, and names what it removed", async () => {
  const root = scratch();
  const { dir, fake } = boatCopy(root, 5);
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const name = (n) => `sealant-dev-boat-stream-${n}`;
    const gone = async () => ({ left: [], stops: [] });
    const kept = await vmDown({
      root,
      slot: 5,
      stopBoat: gone,
      removeImages: async () => ({
        removed: [{ id: ID(3), name: name(3) }],
        left: [{ id: ID(4), state: "ready", reason: null, name: name(4) }],
        refused: [],
      }),
    });
    assert.equal(kept.steps[0].status, "failed");
    assert.match(
      kept.steps[0].detail,
      /^kept: Boat images it built not confirmed removed: sealant-dev-boat-stream-4 \(ready\); removed from Boat the images it built that the saved data does not keep: sealant-dev-boat-stream-3/,
    );
    assert.ok(existsSync(join(dir, "copy.json")), "the copy is kept");
    assert.match(kept.next[1], /vm down 5 --leave-boat-images/);

    const unread = await vmDown({
      root,
      slot: 5,
      stopBoat: gone,
      removeImages: async () => ({
        removed: [],
        left: null,
        refused: [],
        why: "its database did not answer",
      }),
    });
    assert.match(
      unread.steps[0].detail,
      /^kept: its images could not be read: its database did not answer/,
    );
    assert.ok(existsSync(join(dir, "copy.json")));

    const done = await vmDown({
      root,
      slot: 5,
      stopBoat: gone,
      removeImages: async () => ({
        removed: [{ id: ID(3), name: name(3) }],
        left: [],
        refused: [
          {
            id: ID(5),
            state: "quarantined",
            reason: "native-snapshot-identity-mismatch",
            name: name(5),
          },
        ],
      }),
    });
    assert.equal(done.steps[0].status, "passed");
    assert.match(
      done.steps[0].detail,
      /removed from Boat the images it built that the saved data does not keep: sealant-dev-boat-stream-3; left in Boat, refused by sealant \(only the Boat account's owner can delete them\): sealant-dev-boat-stream-5 \(quarantined native-snapshot-identity-mismatch\)/,
    );
    assert.ok(!existsSync(dir));
  } finally {
    fake.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify vm down takes --leave-boat-images", () => {
  assert.equal(parseArgs(["vm", "down", "3", "--leave-boat-images"]).options.leaveBoatImages, true);
});

test("verify vm up takes --will-save", () => {
  assert.equal(parseArgs(["vm", "up", "--boat", "--will-save"]).options.willSave, true);
  assert.equal(parseArgs(["vm", "up", "--boat"]).options.willSave, undefined);
});

test("a Boat copy removes no Boat image unless it is the copy vm save saves (SLNT-1347)", () => {
  const calls = [];
  const setupWith = (answer) => (extra) => {
    calls.push(extra);
    return { status: 0, stdout: answer(extra) };
  };
  const ok = () => "Boat VMs reach this server · answered";

  const off = setupBoat(setupWith(ok), false);
  assert.equal(off.removesImages, false);
  assert.equal(off.retention, "removes no Boat image");
  assert.deepEqual(calls, [["--no-boat-image-retention"]]);

  calls.length = 0;
  assert.equal(setupBoat(setupWith(ok), true).removesImages, true);
  assert.deepEqual(calls, [[]]);

  // A master whose CLI predates the flag refuses it before changing anything, in the CLI's own
  // words (the 25 Nov master's) or setup's: setup runs once more without it, and the result says
  // the copy may remove images.
  for (const refusal of [
    "mend: unknown flag --no-boat-image-retention · usage: mend server setup [--yes] …",
    'Unknown server setup option "--no-boat-image-retention".',
  ]) {
    calls.length = 0;
    const old = setupBoat(
      setupWith((extra) => (extra.length > 0 ? refusal : ok())),
      false,
    );
    assert.deepEqual(calls, [["--no-boat-image-retention"], []]);
    assert.equal(old.removesImages, true);
    assert.match(old.retention, /^REMOVES Boat images: this master's CLI has no/);
    assert.equal(old.out.stdout, ok());
  }

  // Any other failure is setup's, returned as it is.
  calls.length = 0;
  const failed = setupBoat(() => {
    calls.push("once");
    return { status: 1, stdout: "Boat's deployment is not one setup takes" };
  }, false);
  assert.deepEqual(calls, ["once"]);
  assert.equal(failed.out.status, 1);
});
