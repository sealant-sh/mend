import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";

import { mainMigrations, restoreScript, saveScript, storeLoadScript, sshRunner } from "./box.mjs";
import { telemetryFlags } from "./stack.mjs";
import {
  boatOn,
  claimSlot,
  funnelFromOutside,
  joinedSlots,
  releaseSlot,
  slotAdd,
  slotDriveArgs,
  slotHolder,
  slotOfCopy,
  slotRemove,
  describeBoatImage,
  describeBoatVm,
  dumpImages,
  liveImagesOf,
  removeBoatImages,
  stopBoatSessions,
} from "./vm-boat.mjs";

// Check VMs (SLNT-1214): a throwaway copy of a box on this machine per check, in place of the one
// preview server every box check queued for. One master disk holds a stock Ubuntu cloud image with
// Docker, Mend installed the operator's way (`mend server setup`, through preview-deploy.sh) over
// VM 131's own install identity, the box run's data and its git service. Each copy is a qcow2
// overlay of that disk under QEMU/KVM with user-mode networking, on a loopback address of its own,
// and is deleted by `vm down`. To the box verbs a copy is a box: MEND_VERIFY_BOX_SSH and
// MEND_VERIFY_OUTER_URL name it, and nobody else holds it.
// `vm up --boat` adds Boat through a Boat slot's own tailnet name and Funnel (vm-boat.mjs).
//
// Everything private (the master, the copies, the box's identity and data, the VMs' ssh key) lives
// under one directory, mode 0700, outside any checkout: MEND_CHECK_VMS, default
// ~/.local/share/mend-check-vms.

const NODE_VERSION = "26.10.0";
const BASE_URL = "https://cloud-images.ubuntu.com/noble/current";
const BASE_FILE = "noble-server-cloudimg-amd64.img";
/** The most copies at once: each takes a loopback address 127.0.1.<n>. */
export const SLOTS = 8;
const MASTER_SLOT = 200;
const WEB_PORT = 3105;
const SSH_PORT = 2022;
/** In the VM, the socket proxy that carries QEMU's forward to Mend's loopback port (vm-provision.sh web). */
const GUEST_WEB_PORT = 13105;
const DISK_SIZE = "160G";
/** Projects of the box run whose sessions use the workspace images flows need (Ubuntu, Arch). */
const WARM_PROJECTS = ["boat-check-ubuntu", "boat-check-arch"];
/** Hours after which `vm list` calls a copy stale: no check runs that long. */
const STALE_HOURS = 8;

export const vmRoot = (env = process.env) =>
  env.MEND_CHECK_VMS ?? join(homedir(), ".local/share/mend-check-vms");

export const addressOf = (slot) => `127.0.1.${slot}`;
export const urlOf = (slot) => `http://${addressOf(slot)}:${WEB_PORT}`;
export const hostOf = (slot) => (slot === MASTER_SLOT ? "mend-check-master" : `mend-check-${slot}`);

const paths = (root) => ({
  root,
  base: join(root, "base", BASE_FILE),
  sums: join(root, "base", "SHA256SUMS"),
  key: join(root, "key/id_ed25519"),
  knownHosts: join(root, "known_hosts"),
  sshConfig: join(root, "ssh_config"),
  box: join(root, "box"),
  master: join(root, "master"),
  masterDisk: join(root, "master/disk.qcow2"),
  masterMeta: join(root, "master/master.json"),
  build: join(root, "master-build"),
  buildMarker: join(root, "master-build/building"),
  hostKey: join(root, "key/host_ed25519"),
  copies: join(root, "copies"),
});

// A build runs beside copies (SLNT-1249). It boots its own disk in master-build/ and, once that
// disk is sealed, renames it over master/disk.qcow2. A running copy's QEMU opened its backing file
// when it started and keeps that file open, so it reads the master it booted from until `vm down`
// stops it; the old disk's space is freed then. Nothing reopens a running copy's backing file by
// path: QEMU is started once per copy (vm up, vm slot) and never restarted, a reboot inside the
// guest keeps QEMU's open files, no snapshot is taken, and `vm save` works inside the copy over ssh.
// Every master boots with one host key (key/host_ed25519, written by cloud-init), so known_hosts
// holds the same entry before and after a build, and a copy of either master is reached as before.

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return {
    code: result.status ?? 255,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? result.error?.message ?? ""),
  };
};

const lastLine = (text) => text.trim().split("\n").at(-1) ?? "";
const seconds = (since) => Math.round((Date.now() - since) / 100) / 10;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const privateDir = (dir) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
};

/**
 * The ssh config every copy is reached through: one Host per copy (and the master while it builds),
 * the VMs' own key, and one known_hosts entry under one alias, since every copy boots with the
 * masters' one host key. It is written from what is on disk, so a copy that starts or stops during a
 * build keeps the build's block.
 */
const writeSshConfig = (p) => {
  const block = (slot) =>
    [
      `Host ${hostOf(slot)}`,
      `  HostName ${addressOf(slot)}`,
      `  Port ${SSH_PORT}`,
      "  User root",
      `  IdentityFile ${p.key}`,
      "  IdentitiesOnly yes",
      `  UserKnownHostsFile ${p.knownHosts}`,
      `  HostKeyAlias ${HOST_KEY_ALIAS}`,
      `  StrictHostKeyChecking ${slot === MASTER_SLOT ? "accept-new" : "yes"}`,
      "  ServerAliveInterval 15",
      "  LogLevel ERROR",
      "",
    ].join("\n");
  const slots = [...(existsSync(p.buildMarker) ? [MASTER_SLOT] : []), ...liveSlots(p)];
  // Copies start and stop at once: each writes the whole file aside and renames it into place.
  const temporary = `${p.sshConfig}.${process.pid}.${Date.now()}`;
  writeFileSync(temporary, slots.map(block).join("\n"), { mode: 0o600 });
  renameSync(temporary, p.sshConfig);
};

const HOST_KEY_ALIAS = "mend-check-vm";

/**
 * The masters' one host key, made once, and its known_hosts entry. Entries for the alias already
 * there stay: a master built before SLNT-1249 has a host key of its own, and its copies may still run.
 */
export const masterHostKey = (root) => {
  const p = paths(root);
  if (!existsSync(p.hostKey))
    run("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "mend-check-vm-host",
      "-f",
      p.hostKey,
    ]);
  const [type, key] = readFileSync(`${p.hostKey}.pub`, "utf8").trim().split(/\s+/);
  const entry = `${HOST_KEY_ALIAS} ${type} ${key}`;
  const known = existsSync(p.knownHosts) ? readFileSync(p.knownHosts, "utf8") : "";
  if (!known.split("\n").includes(entry))
    writeFileSync(
      p.knownHosts,
      `${known}${known === "" || known.endsWith("\n") ? "" : "\n"}${entry}\n`,
      {
        mode: 0o600,
      },
    );
  return { private: readFileSync(p.hostKey, "utf8"), public: `${type} ${key}` };
};

export const boxSshArgs = (root, slot) => ["-F", paths(root).sshConfig, hostOf(slot)];

const liveSlots = (p) =>
  existsSync(p.copies)
    ? readdirSync(p.copies)
        .filter((name) => /^\d+$/.test(name))
        .map(Number)
        .sort((a, b) => a - b)
    : [];

/** The QEMU process of a copy (or the master build), when it is alive and is that VM's. */
const qemuPid = (dir) => {
  let pid;
  try {
    pid = Number(readFileSync(join(dir, "qemu.pid"), "utf8").trim());
  } catch {
    return null;
  }
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.includes(join(dir, "disk.qcow2")) ? pid : null;
  } catch {
    return null;
  }
};

/** The copy's own disk: a qcow2 overlay of the master disk. */
const overlayOf = (p, dir) =>
  run("qemu-img", [
    "create",
    "-q",
    "-f",
    "qcow2",
    "-b",
    p.masterDisk,
    "-F",
    "qcow2",
    join(dir, "disk.qcow2"),
  ]);

const qemuArgs = ({ dir, slot, cpus, memory, cache, seedUrl, extraDrives = [] }) => [
  "-name",
  hostOf(slot),
  "-machine",
  "q35,accel=kvm",
  "-cpu",
  "host",
  "-smp",
  String(cpus),
  "-m",
  memory,
  "-drive",
  `file=${join(dir, "disk.qcow2")},if=none,id=root,format=qcow2,cache=${cache},discard=unmap`,
  // The firmware boots this disk first, before any extra one (a Boat slot's blank disk).
  "-device",
  "virtio-blk-pci,drive=root,bootindex=0",
  ...extraDrives,
  "-netdev",
  `user,id=n0,hostfwd=tcp:${addressOf(slot)}:${SSH_PORT}-:22,hostfwd=tcp:${addressOf(slot)}:${WEB_PORT}-:${GUEST_WEB_PORT}`,
  "-device",
  "virtio-net-pci,netdev=n0",
  "-device",
  "virtio-rng-pci",
  ...(seedUrl ? ["-smbios", `type=1,serial=ds=nocloud;s=${seedUrl}`] : []),
  "-display",
  "none",
  "-serial",
  `file:${join(dir, "serial.log")}`,
  "-pidfile",
  join(dir, "qemu.pid"),
  "-daemonize",
];

// A copy outlives the process that started it (SLNT-1326). QEMU daemonizes, but a daemon stays in
// its starter's cgroup, and stopping that cgroup's unit kills every process in it: on 24 Nov the
// daily run's three copies died when T3 stopped the scope of the thread that ran `vm up`, as it does
// when a thread ends a turn with no background command. So `vm up` asks the user's systemd manager
// to start QEMU as a transient service of its own. The manager forks it, so it works from an ssh
// session as well as from a scope under the manager, where a `--scope` would have to move a process
// out of a cgroup the user does not own. `--collect` removes the unit once QEMU exits, cleanly or not,
// so `vm down` (which stops QEMU by its pid) and a start that fails leave none behind. A host with no
// user manager reachable starts QEMU as before, in the starter's cgroup, and `vm up` says so.
//
// Only a copy gets a unit. `vm build` and `vm slot` drive their VM from start to end and the VM is
// no use without that driver: a build whose starter dies leaves the master as it was, and the next
// build deletes the VM's directory and starts over, whereas a build VM that outlived its starter
// would be one nobody stops.

/** The transient unit a copy's QEMU runs in, one per copies directory and slot. */
export const unitOf = (root, slot) =>
  `mend-check-vm-${createHash("sha256").update(root).digest("hex").slice(0, 8)}-${slot}.service`;

/** Whether the user's systemd manager answers, so a copy can run in a unit of its own. */
const userManager = () =>
  /^(running|degraded|starting|initializing)$/.test(
    run("systemctl", ["--user", "is-system-running"]).stdout.trim(),
  );

/** systemd-run's arguments for a copy's QEMU in `unit`: it returns once QEMU has daemonized. */
export const unitArgs = (unit, dir, slot, args) => [
  "--user",
  `--unit=${unit}`,
  `--description=Mend check VM ${hostOf(slot)} (${dir})`,
  "--collect",
  "--quiet",
  "--service-type=forking",
  `--property=PIDFile=${join(dir, "qemu.pid")}`,
  `--property=StandardError=file:${join(dir, "qemu.log")}`,
  "--",
  "qemu-system-x86_64",
  ...args,
];

/**
 * Starts QEMU, in `unit` when one is given. Returns null once it runs, or what went wrong.
 */
const startQemu = (options, unit = null) => {
  if (unit === null) {
    const started = run("qemu-system-x86_64", qemuArgs(options));
    return started.code === 0
      ? null
      : `qemu-system-x86_64 exited ${started.code}: ${lastLine(started.stderr)}`;
  }
  const started = run("systemd-run", unitArgs(unit, options.dir, options.slot, qemuArgs(options)));
  if (started.code === 0) return null;
  let said = "";
  try {
    said = lastLine(readFileSync(join(options.dir, "qemu.log"), "utf8"));
  } catch {
    // QEMU never ran: systemd-run's own message says why.
  }
  return `qemu-system-x86_64 in ${unit} failed: ${said || lastLine(started.stderr)}`;
};

/** Stops a copy's unit if it is still loaded; a no-op once QEMU has gone and the unit with it. */
const stopUnit = (unit) => {
  if (unit) run("systemctl", ["--user", "stop", unit]);
};

const waitForSsh = async (ssh, timeoutMs) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (ssh("true").code === 0) return true;
    await sleep(500);
  }
  return false;
};

const waitForHealth = async (url, timeoutMs) => {
  const until = Date.now() + timeoutMs;
  let seen = "no answer";
  while (Date.now() < until) {
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) });
      const body = await response.text();
      seen = `${response.status} ${body.slice(0, 200)}`;
      if (response.ok) return { ok: true, seen };
    } catch (error) {
      seen = String(error.cause?.code ?? error.message);
    }
    await sleep(1000);
  }
  return { ok: false, seen };
};

const stopQemu = async (dir) => {
  const pid = qemuPid(dir);
  if (pid === null) return "not running";
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (qemuPid(dir) === null) return "stopped";
  }
  process.kill(pid, "SIGKILL");
  await sleep(200);
  return "killed";
};

/** The cloud-init NoCloud seed, served once over HTTP to the build VM through QEMU's 10.0.2.2. */
const serveSeed = (publicKey, host) =>
  new Promise((resolve) => {
    const files = {
      "/meta-data": `instance-id: mend-check-master\nlocal-hostname: mend-check\n`,
      "/user-data": [
        "#cloud-config",
        "disable_root: false",
        "ssh_pwauth: false",
        "ssh_deletekeys: true",
        // The masters' one host key: with keys given, cloud-init writes these and generates none.
        "ssh_keys:",
        "  ed25519_private: |",
        ...host.private
          .trim()
          .split("\n")
          .map((line) => `    ${line}`),
        `  ed25519_public: ${host.public}`,
        "ssh_authorized_keys:",
        `  - ${publicKey.trim()}`,
        "growpart: {mode: auto, devices: ['/']}",
        "",
      ].join("\n"),
      "/vendor-data": "",
    };
    const server = createServer((request, response) => {
      const body = files[request.url ?? ""];
      response.writeHead(body === undefined ? 404 : 200, { "content-type": "text/plain" });
      response.end(body ?? "");
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

/**
 * Runs one phase of vm-provision.sh in a VM over ssh, keeping its output in `logDir`; resolves
 * { code, out, took }.
 */
const runPhase = (root, slot, name, args, logDir) => {
  const at = Date.now();
  const out = spawnSync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      ...boxSshArgs(root, slot),
      `bash -s -- ${[name, ...args].map((a) => `'${a}'`).join(" ")}`,
    ],
    {
      input: readFileSync(new URL("./vm-provision.sh", import.meta.url)),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const text = `${out.stdout ?? ""}${out.stderr ?? ""}`;
  writeFileSync(join(logDir, `provision-${name}.log`), text, { mode: 0o600 });
  return { code: out.status ?? 255, out: text, took: seconds(at) };
};

/** What the VM's containers said, kept beside it when a build or an up fails (no secrets: logs only). */
const keepFailure = (root, slot, dir) => {
  const out = spawnSync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      ...boxSshArgs(root, slot),
      "docker ps -a --format '{{.Names}} {{.Status}}'; docker logs --tail 150 mend-mend-1 2>&1",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (out.status === 0) writeFileSync(join(dir, "failure.log"), out.stdout, { mode: 0o600 });
};

const step = (id, title, status, detail) => ({ id, title, status, ...(detail ? { detail } : {}) });

/**
 * The mend CLI of the preview a master installs (SLNT-1343): `@sealant/mend` packed from `sha` in a
 * scratch worktree of `repoRoot`, its version stamped as `version`, as the preview's own image is. A
 * master's CLI then never depends on what npm's `next` tag points at, nor on the caller's checkout.
 * Returns the tarball's path in `out`, or what went wrong.
 */
export const packCli = ({ repoRoot, sha, version, out, run: exec = run }) => {
  const scratch = mkdtempSync(join(tmpdir(), "mend-vm-cli-"));
  const src = join(scratch, "src");
  const failed = (what, result) => ({
    ok: false,
    detail: `${what}: ${lastLine(result.stderr) || lastLine(result.stdout) || `exit ${result.code}`}`,
  });
  try {
    if (exec("git", ["-C", repoRoot, "cat-file", "-e", `${sha}^{commit}`]).code !== 0) {
      const fetched = exec("git", ["-C", repoRoot, "fetch", "--quiet", "origin", sha]);
      if (fetched.code !== 0) return failed(`git fetch origin ${sha.slice(0, 12)}`, fetched);
    }
    const added = exec("git", ["-C", repoRoot, "worktree", "add", "--quiet", "--detach", src, sha]);
    if (added.code !== 0) return failed("git worktree add", added);
    const installed = exec(
      "pnpm",
      ["install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts", "--silent"],
      { cwd: src, timeout: 600_000 },
    );
    if (installed.code !== 0) return failed("pnpm install", installed);
    const stamped = exec("npm", ["pkg", "set", `version=${version}`], {
      cwd: join(src, "apps/cli"),
    });
    if (stamped.code !== 0) return failed("npm pkg set version", stamped);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const packed = exec("pnpm", ["--filter", "@sealant/mend", "pack", "--pack-destination", out], {
      cwd: src,
      timeout: 600_000,
    });
    const tarball = existsSync(out) ? readdirSync(out).find((name) => name.endsWith(".tgz")) : null;
    if (packed.code !== 0 || !tarball) return failed("pnpm pack", packed);
    return { ok: true, tarball: join(out, tarball) };
  } finally {
    exec("git", ["-C", repoRoot, "worktree", "remove", "--force", src]);
    rmSync(scratch, { recursive: true, force: true });
  }
};

/**
 * Installs the packed CLI under `dir` (`<dir>/node_modules/.bin/mend`) and checks it reads
 * `version`. Returns null once it does, or what went wrong.
 */
const installCliKit = (dir, tarball, version, exec = run) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const installed = exec("npm", [
    "install",
    "--silent",
    "--no-audit",
    "--no-fund",
    "--prefix",
    dir,
    tarball,
  ]);
  if (installed.code !== 0) return `npm install: ${lastLine(installed.stderr)}`;
  const said = lastLine(
    exec(join(dir, "node_modules/.bin/mend"), ["--version"]).stdout.split("\n")[0] ?? "",
  );
  return said === `mend ${version}`
    ? null
    : `the installed CLI reads "${said}", not mend ${version}`;
};

/**
 * Puts the build's CLI kit in place of <root>/cli, the one `vm down` and the warm step run as the
 * checker, once the master it belongs to is sealed. A `vm down` running just then finds no CLI and
 * skips its stops; the rename leaves no half-installed kit.
 */
const swapCliKit = (root, kit) => {
  const target = join(root, "cli");
  const old = join(root, `cli.old.${process.pid}`);
  if (existsSync(target)) renameSync(target, old);
  renameSync(kit, target);
  rmSync(old, { recursive: true, force: true });
};

/**
 * vm build: the master disk. From VM 131 it copies (with --from-box) the install identity, the box
 * run's data and its git repositories into <root>/box; then it boots a stock cloud image, installs
 * Docker, Node and the mend CLI, installs Mend with preview-deploy.sh over that identity, loads the
 * data, checks Mend answers, and seals the disk with Mend stopped. Copies may run throughout: the
 * new disk is built aside and becomes the master only once sealed (SLNT-1249); a build that fails
 * leaves the master before as it was.
 */
export const vmBuild = async ({
  root = vmRoot(),
  repoRoot,
  version,
  sha,
  cli,
  fromBox,
  cpus = 8,
  memory = "12G",
}) => {
  const p = paths(root);
  const steps = [];
  if (!version || !sha)
    return {
      steps: [
        step(
          "args",
          "What to install",
          "failed",
          "--version <preview> and --sha <commit> are required",
        ),
      ],
      next: [],
    };
  if (cli !== undefined)
    return {
      steps: [
        step(
          "args",
          "What to install",
          "failed",
          "--cli is gone: vm build packs the mend CLI from --sha, so the master's CLI is the preview's own (SLNT-1343)",
        ),
      ],
      next: [`pnpm verify vm build --version ${version} --sha ${sha}`],
    };
  if (qemuPid(p.build) !== null)
    return {
      steps: [
        step(
          "build",
          "No other build running",
          "blocked_by_prerequisite",
          `a build's VM runs in ${p.build} (pid ${qemuPid(p.build)}): wait for it to end`,
        ),
      ],
      next: ["pnpm verify vm list"],
    };
  const fail = async (id, title, detail) => {
    steps.push(
      step(
        id,
        title,
        "failed",
        `${detail}; the master before is unchanged${existsSync(p.masterMeta) ? "" : " (there was none)"}`,
      ),
    );
    keepFailure(root, MASTER_SLOT, p.build);
    if (!process.env.MEND_CHECK_VMS_KEEP) {
      await stopQemu(p.build);
      rmSync(join(p.build, "disk.qcow2"), { force: true });
      rmSync(p.buildMarker, { force: true });
      writeSshConfig(p);
    }
    return { steps, next: [] };
  };
  privateDir(root);
  privateDir(join(root, "base"));
  privateDir(p.box);
  privateDir(join(root, "key"));
  privateDir(p.copies);

  // 1. The box's identity and data.
  const boxFiles = [
    "identity.env",
    "world.sql",
    "world.store.tgz",
    "mend-git.tgz",
    "mend-keys.tgz",
    "mend-ssh.tgz",
  ];
  if (fromBox) {
    const started = Date.now();
    for (const [file, script] of [
      ["identity.env", "cat /root/.config/mend/identity.env"],
      ["world.sql", "cat /root/main-run/world.sql"],
      ["world.store.tgz", "cat /root/main-run/world.store.tgz"],
      ["mend-git.tgz", "tar -C /srv -czf - mend-git"],
      // The machine keys the loaded data is sealed with (Executor's authority, project secrets, each
      // user's git key) and the workspace SSH gateway's host key: volumes, not identity.env.
      [
        "mend-keys.tgz",
        `tar -C "$(docker volume inspect -f '{{.Mountpoint}}' mend_mend-config)/mend" -czf - keys`,
      ],
      [
        "mend-ssh.tgz",
        `tar -C "$(docker volume inspect -f '{{.Mountpoint}}' mend_mend-ssh)" -czf - .`,
      ],
      // For `vm up --boat`: the server's own Boat key, and the build journals of the Boat images
      // the box built, which a copy reuses under the box's deployment name.
      ["boat.key", "sed -n 's/^SEALANT_BOAT_API_KEY=//p' /root/.config/mend/active/server.env"],
      [
        "mend-boat-state.tgz",
        `tar -C "$(docker volume inspect -f '{{.Mountpoint}}' mend_mend-boat-state)" -czf - --exclude='*.lock' .`,
      ],
    ]) {
      const out = spawnSync(
        "ssh",
        ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ...fromBox.trim().split(/\s+/), script],
        { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 2 * 1024 ** 3 },
      );
      if (out.status !== 0)
        return fail("box", "Copy the box's identity and data", `${file}: ssh exited ${out.status}`);
      writeFileSync(join(p.box, file), out.stdout, { mode: 0o600 });
    }
    steps.push(
      step(
        "box",
        "Copy the box's identity and data",
        "passed",
        `${boxFiles.join(", ")} in ${seconds(started)}s`,
      ),
    );
  }
  const missing = boxFiles.filter((file) => !existsSync(join(p.box, file)));
  if (missing.length > 0)
    return fail(
      "box",
      "The box's identity and data",
      `missing ${missing.join(", ")} in ${p.box}: pass --from-box '<ssh args of VM 131>'`,
    );
  if (!readFileSync(join(p.box, "world.sql")).subarray(-200).toString().includes("dump complete"))
    return fail("box", "The box's identity and data", "world.sql has no pg_dumpall trailer");

  // 2. The stock cloud image, checked against Ubuntu's SHA256SUMS.
  if (!existsSync(p.base)) {
    const fetched = run("bash", [
      "-c",
      `set -euo pipefail; cd "$1"; curl -fsSL -o SHA256SUMS "$2/SHA256SUMS"; curl -fsSL -o "$3.part" "$2/$3"; mv "$3.part" "$3"`,
      "fetch",
      join(root, "base"),
      BASE_URL,
      BASE_FILE,
    ]);
    if (fetched.code !== 0)
      return fail("base", "The Ubuntu 24.04 cloud image", lastLine(fetched.stderr));
  }
  const want = readFileSync(p.sums, "utf8")
    .split("\n")
    .find((line) => line.endsWith(`*${BASE_FILE}`))
    ?.split(" ")[0];
  const got = lastLine(run("sha256sum", [p.base]).stdout).split(" ")[0];
  if (!want || want !== got)
    return fail("base", "The Ubuntu 24.04 cloud image", `sha256 ${got} is not Ubuntu's ${want}`);
  steps.push(
    step(
      "base",
      "The Ubuntu 24.04 cloud image",
      "passed",
      `${BASE_FILE} sha256 ${got.slice(0, 12)}, as Ubuntu's SHA256SUMS`,
    ),
  );

  if (!existsSync(p.key))
    run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "mend-check-vm", "-f", p.key]);

  // 3. A fresh disk beside the master, booted with a cloud-init seed. The master every running copy
  // is backed by is not touched until this one is sealed.
  const started = Date.now();
  const buildDisk = join(p.build, "disk.qcow2");
  rmSync(p.build, { recursive: true, force: true });
  privateDir(p.build);
  privateDir(p.master);
  writeFileSync(p.buildMarker, `${process.pid}\n`, { mode: 0o600 });
  const host = masterHostKey(root);
  const converted = run("qemu-img", ["convert", "-O", "qcow2", p.base, buildDisk]);
  if (converted.code !== 0) return fail("disk", "The master disk", lastLine(converted.stderr));
  run("qemu-img", ["resize", buildDisk, DISK_SIZE]);
  writeSshConfig(p);
  const seed = await serveSeed(readFileSync(`${p.key}.pub`, "utf8"), host);
  const seedUrl = `http://10.0.2.2:${seed.address().port}/`;
  const qemu = startQemu({
    dir: p.build,
    slot: MASTER_SLOT,
    cpus,
    memory,
    cache: "writeback",
    seedUrl,
  });
  if (qemu) {
    seed.close();
    return fail("boot", "Boot the master", qemu);
  }
  const ssh = sshRunner(boxSshArgs(root, MASTER_SLOT));
  const up = await waitForSsh(ssh, 180_000);
  seed.close();
  if (!up)
    return fail(
      "boot",
      "Boot the master",
      `no ssh in 180s; serial log in ${join(p.build, "serial.log")}`,
    );
  steps.push(step("boot", "Boot the master", "passed", `ssh answered in ${seconds(started)}s`));

  // 4. Provision, phase by phase; each phase's output is kept in the master's directory.
  const phase = (name, args) => runPhase(root, MASTER_SLOT, name, args, p.build);
  const put = (file, target) => {
    const out = spawnSync(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        ...boxSshArgs(root, MASTER_SLOT),
        `umask 077; mkdir -p "$(dirname '${target}')"; cat > '${target}'`,
      ],
      { input: readFileSync(join(p.box, file)), maxBuffer: 1024 * 1024 },
    );
    return out.status === 0;
  };
  const system = phase("system", [NODE_VERSION]);
  if (system.code !== 0)
    return fail(
      "system",
      "Docker, git, jq and Node",
      `${lastLine(system.out)} (log: ${join(p.build, "provision-system.log")})`,
    );
  steps.push(
    step(
      "system",
      "Docker, git, jq and Node",
      "passed",
      `${lastLine(system.out).replace(/^vm-provision: /, "")} in ${system.took}s`,
    ),
  );

  // The CLI, packed from --sha: on the master as the box's global CLI, and in <root>/cli, the one
  // the warm step and `vm down` run as the checker.
  const cliTitle = `The mend CLI ${version}, packed from ${sha.slice(0, 12)}`;
  const cliAt = Date.now();
  const packed = packCli({ repoRoot, sha, version, out: join(p.build, "cli") });
  if (!packed.ok) return fail("cli", cliTitle, packed.detail);
  const tarballOnVm = "/root/mend-cli.tgz";
  const sent = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", ...boxSshArgs(root, MASTER_SLOT), `umask 077; cat > ${tarballOnVm}`],
    { input: readFileSync(packed.tarball), maxBuffer: 1024 * 1024 },
  );
  if (sent.status !== 0) return fail("cli", cliTitle, `the tarball could not be copied in`);
  const installed = phase("cli", [tarballOnVm, version]);
  if (installed.code !== 0)
    return fail(
      "cli",
      cliTitle,
      `${lastLine(installed.out)} (log: ${join(p.build, "provision-cli.log")})`,
    );
  const cliKit = join(p.build, "cli-kit");
  const local = installCliKit(cliKit, packed.tarball, version);
  if (local !== null) return fail("cli", cliTitle, local);
  steps.push(
    step(
      "cli",
      cliTitle,
      "passed",
      `${lastLine(installed.out).replace(/^vm-provision: /, "")} on the master and beside it, in ${seconds(cliAt)}s`,
    ),
  );
  for (const [file, target] of [
    ["identity.env", "/root/.config/mend/identity.env"],
    ["world.sql", "/root/main-run/world.sql"],
    ["world.store.tgz", "/root/main-run/world.store.tgz"],
    ["mend-git.tgz", "/root/main-run/mend-git.tgz"],
    ["mend-keys.tgz", "/root/main-run/mend-keys.tgz"],
    ["mend-ssh.tgz", "/root/main-run/mend-ssh.tgz"],
    // The blob store (session captures), once `vm save` has saved one: VM 131's holds the owner's
    // data beside the run's, so it was never copied from there (SLNT-1216).
    ...(existsSync(join(p.box, "mend-garage.tgz"))
      ? [["mend-garage.tgz", "/root/main-run/mend-garage.tgz"]]
      : []),
    // The build journals of the Boat images the data names: the master carries the ones saved with
    // its data, and `vm up --boat` puts them into the copy, so a later save cannot change what a
    // copy of this master gets (SLNT-1252).
    ...(existsSync(join(p.box, "mend-boat-state.tgz"))
      ? [["mend-boat-state.tgz", "/root/main-run/mend-boat-state.tgz"]]
      : []),
  ]) {
    if (!put(file, target))
      return fail("copy-in", "Copy the box's identity and data in", `${file} could not be written`);
  }
  ssh(
    "chmod 700 /root/.config/mend /root/main-run && tar -xzf /root/main-run/mend-git.tgz -C /srv",
  );
  steps.push(
    step(
      "copy-in",
      "Copy the box's identity and data in",
      "passed",
      `identity.env, world.sql, world.store.tgz, /srv/mend-git${existsSync(join(p.box, "mend-boat-state.tgz")) ? ", the Boat build journals" : ""}`,
    ),
  );

  // Setup checks health at its --url from inside the VM, so the forward comes first.
  const web = phase("web", [addressOf(MASTER_SLOT)]);
  if (web.code !== 0) return fail("web", "Mend's web port forwarded", lastLine(web.out));
  const server = phase("server", [version, sha, urlOf(MASTER_SLOT)]);
  if (server.code !== 0)
    return fail(
      "server",
      `mend server setup ${version}`,
      `${lastLine(server.out)} (log: ${join(p.build, "provision-server.log")})`,
    );
  steps.push(
    step(
      "server",
      `mend server setup ${version}`,
      "passed",
      `through preview-deploy.sh in ${server.took}s`,
    ),
  );

  const git = phase("git", []);
  if (git.code !== 0) return fail("git", "The box run's git service", lastLine(git.out));
  steps.push(
    step(
      "git",
      "The box run's git service",
      "passed",
      lastLine(git.out).replace(/^vm-provision: /, ""),
    ),
  );

  // 5. The box run's data, loaded as `box prepare --load` loads it, then Mend started on it.
  const loadAt = Date.now();
  const restored = ssh(restoreScript("/root/main-run/world.sql"));
  const errors = restored.stdout.split("\n").filter((line) => line.startsWith("error="));
  if (!restored.stdout.includes("restore=done") || errors.length > 0)
    return fail(
      "load",
      "Load the box run's data",
      [lastLine(restored.stdout), ...errors].join("; "),
    );
  const store = ssh(storeLoadScript("/root/main-run/world.sql"));
  if (!store.stdout.includes("store=done") || !/^missing=$/m.test(store.stdout))
    return fail("load", "Load the box run's data", lastLine(store.stdout));
  const keys = ssh(`set -e
c=$(docker volume inspect -f '{{.Mountpoint}}' mend_mend-config)
s=$(docker volume inspect -f '{{.Mountpoint}}' mend_mend-ssh)
rm -rf "$c/mend/keys" && mkdir -p "$c/mend"
tar -xzpf /root/main-run/mend-keys.tgz --numeric-owner -C "$c/mend"
tar -xzpf /root/main-run/mend-ssh.tgz --numeric-owner -C "$s"
if [ -s /root/main-run/mend-garage.tgz ]; then
  g=$(docker volume inspect -f '{{.Mountpoint}}' mend-garage)
  docker stop mend-garage-1 >/dev/null
  find "$g" -mindepth 1 -delete
  tar -xzpf /root/main-run/mend-garage.tgz --numeric-owner -C "$g"
  docker start mend-garage-1 >/dev/null
fi`);
  if (keys.code !== 0)
    return fail("load", "Load the box run's data", `the box's keys: ${lastLine(keys.stderr)}`);
  // The CLI's own exit and last line: a start it refuses fails here, not as a health wait.
  const startedMend = ssh("mend server start --offline 2>&1");
  if (startedMend.code !== 0)
    return fail(
      "load",
      "Load the box run's data",
      `mend server start exited ${startedMend.code}: ${lastLine(startedMend.stdout)}`,
    );
  const healthy = await waitForHealth(urlOf(MASTER_SLOT), 300_000);
  if (!healthy.ok)
    return fail("load", "Load the box run's data", `Mend did not answer health: ${healthy.seen}`);
  steps.push(
    step(
      "load",
      "Load the box run's data",
      "passed",
      `world.sql and its store in ${seconds(loadAt)}s; Mend answers health`,
    ),
  );

  // 6. Warm: one session per workspace image the flows use, as the checker account, so a copy's
  // first session does not build a 7 GB image (about 100 s each, measured 20 Nov). Then the data is
  // loaded again, so the master holds exactly the box run's data, with the images beside it.
  const kit = join(homedir(), ".local/share/mend-boat-check/cli");
  if (existsSync(kit)) {
    const warmAt = Date.now();
    const cliDir = cliKit;
    const env = { ...process.env, XDG_CONFIG_HOME: kit, MEND_URL: urlOf(MASTER_SLOT) };
    for (const project of WARM_PROJECTS) {
      const warmed = run(
        join(cliDir, "node_modules/.bin/mend"),
        ["run", "--project", project, "--name", `vm-warm-${project}`, "--", "true"],
        { env, timeout: 900_000 },
      );
      if (warmed.code !== 0)
        return fail(
          "warm",
          "Warm the workspace images",
          `mend run in ${project}: ${lastLine(warmed.stdout + warmed.stderr)}`,
        );
    }
    const again = ssh(restoreScript("/root/main-run/world.sql"));
    if (!again.stdout.includes("restore=done"))
      return fail("warm", "Warm the workspace images", `reload: ${lastLine(again.stdout)}`);
    const restarted = ssh("mend server start --offline 2>&1");
    const back =
      restarted.code === 0
        ? await waitForHealth(urlOf(MASTER_SLOT), 300_000)
        : {
            ok: false,
            seen: `mend server start exited ${restarted.code}: ${lastLine(restarted.stdout)}`,
          };
    if (!back.ok)
      return fail("warm", "Warm the workspace images", `Mend after the reload: ${back.seen}`);
    const images = ssh(
      "docker images --format '{{.Repository}}' | grep -c '^sealant-workspace-'",
    ).stdout.trim();
    steps.push(
      step(
        "warm",
        "Warm the workspace images",
        "passed",
        `${WARM_PROJECTS.join(", ")}: ${images} workspace image tags in ${seconds(warmAt)}s; data loaded again`,
      ),
    );
  } else {
    steps.push(
      step(
        "warm",
        "Warm the workspace images",
        "skipped",
        `no checker CLI kit at ${kit}: a copy's first session builds its image`,
      ),
    );
  }

  // 7. Seal: Mend stopped, so each copy starts it once with its own address.
  const seal = phase("seal", []);
  if (seal.code !== 0) return fail("seal", "Seal the master", lastLine(seal.out));
  ssh("poweroff");
  for (let i = 0; i < 120 && qemuPid(p.build) !== null; i++) await sleep(500);
  if (qemuPid(p.build) !== null) await stopQemu(p.build);
  // The sealed disk becomes the master in one rename; master.json, written aside, follows it.
  // Copies already running keep the disk they opened.
  const running = liveSlots(p).filter((copy) => qemuPid(join(p.copies, String(copy))) !== null);
  renameSync(buildDisk, p.masterDisk);
  const meta = join(p.master, `master.json.${process.pid}.tmp`);
  writeFileSync(
    meta,
    `${JSON.stringify({ version, sha, cliVersion: version, builtAt: new Date().toISOString(), seconds: seconds(started) }, null, 2)}\n`,
    { mode: 0o600 },
  );
  renameSync(meta, p.masterMeta);
  swapCliKit(root, cliKit);
  rmSync(p.buildMarker, { force: true });
  writeSshConfig(p);
  const size = statSync(p.masterDisk).size;
  steps.push(
    step(
      "seal",
      "Seal the master",
      "passed",
      `${(size / 1024 ** 3).toFixed(1)} GiB on disk; built in ${seconds(started)}s${running.length > 0 ? `; copies ${running.join(", ")} keep the master before until vm down` : ""}`,
    ),
  );
  return { steps, next: ["pnpm verify vm up"], master: { version, sha } };
};

/**
 * vm up: a fresh copy of the master. It takes the lowest free slot, boots an overlay of the master
 * disk, gives Mend the copy's own address with `mend server setup --url`, and waits for health.
 */
export const vmUp = async ({
  root = vmRoot(),
  cpus = 6,
  memory = "8G",
  boat = false,
  willSave = false,
}) => {
  const p = paths(root);
  const started = Date.now();
  if (!existsSync(p.masterMeta))
    return {
      steps: [
        step(
          "master",
          "The master disk",
          "blocked_by_prerequisite",
          "no master: pnpm verify vm build",
        ),
      ],
      next: ["pnpm verify vm build --version <preview> --sha <commit>"],
    };
  const master = readJson(p.masterMeta);
  if (boat && joinedSlots(root).length === 0)
    return {
      steps: [
        step(
          "boat",
          "A Boat slot",
          "blocked_by_prerequisite",
          "no Boat slot has joined the tailnet: pnpm verify vm slot add (needs an auth key from the owner)",
        ),
      ],
      next: ["pnpm verify vm slot add"],
    };
  privateDir(p.copies);
  let slot = null;
  for (let candidate = 1; candidate <= SLOTS; candidate++) {
    try {
      mkdirSync(join(p.copies, String(candidate)), { mode: 0o700 });
      slot = candidate;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  if (slot === null)
    return {
      steps: [
        step(
          "slot",
          "A free slot",
          "blocked_by_prerequisite",
          `all ${SLOTS} copies are in use: pnpm verify vm list`,
        ),
      ],
      next: ["pnpm verify vm list"],
    };
  const dir = join(p.copies, String(slot));
  const steps = [];
  const running = (copy) => qemuPid(join(p.copies, String(copy))) !== null;
  const boatSlot = boat ? claimSlot(root, slot, running) : null;
  if (boat && boatSlot === null) {
    rmSync(dir, { recursive: true, force: true });
    return {
      steps: [
        step(
          "boat",
          "A free Boat slot",
          "blocked_by_prerequisite",
          `all ${joinedSlots(root).length} Boat slots are held by running copies: pnpm verify vm list`,
        ),
      ],
      next: ["pnpm verify vm list"],
    };
  }
  const unit = userManager() ? unitOf(root, slot) : null;
  // Until the copy is healthy it is this `vm up`'s: a starter stopped on the way (its scope stopped,
  // Ctrl-C, a closed terminal) takes the half-started copy with it, unit and all, rather than leave
  // a VM nobody started a check on. Only SIGKILL gets past this, and leaves what `vm down` removes.
  const abandon = (signal) => {
    stopUnit(unit);
    const pid = qemuPid(dir);
    if (pid !== null) process.kill(pid, "SIGKILL");
    if (boatSlot !== null) releaseSlot(root, boatSlot, slot);
    rmSync(dir, { recursive: true, force: true });
    writeSshConfig(p);
    process.exit(128 + (osConstants.signals[signal] ?? 15));
  };
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
  const fail = async (id, title, detail) => {
    steps.push(step(id, title, "failed", detail));
    keepFailure(root, slot, dir);
    if (boatSlot !== null && qemuPid(dir) !== null) runPhase(root, slot, "tailnet-down", [], dir);
    await stopQemu(dir);
    stopUnit(unit);
    if (boatSlot !== null) releaseSlot(root, boatSlot, slot);
    return { steps, next: [`pnpm verify vm down ${slot}`], copy: { slot, dir } };
  };
  const boot = async () => {
    const overlay = overlayOf(p, dir);
    if (overlay.code !== 0) return fail("disk", "The copy's disk", lastLine(overlay.stderr));
    writeSshConfig(p);
    const qemu = startQemu(
      {
        dir,
        slot,
        cpus,
        memory,
        cache: "unsafe",
        extraDrives: boatSlot === null ? [] : slotDriveArgs(root, boatSlot),
      },
      unit,
    );
    if (qemu) return fail("boot", "Boot the copy", qemu);
    const ssh = sshRunner(boxSshArgs(root, slot));
    if (!(await waitForSsh(ssh, 120_000)))
      return fail("boot", "Boot the copy", `no ssh in 120s; serial log ${join(dir, "serial.log")}`);
    const booted = seconds(started);
    steps.push(
      step(
        "boot",
        "Boot the copy",
        "passed",
        `ssh answered ${booted}s after vm up; ${
          unit === null
            ? "no user systemd manager answers, so QEMU runs in this command's cgroup and stops with its scope or session"
            : `QEMU runs in ${unit}, so it outlives this command and its scope`
        }`,
      ),
    );
    const url = urlOf(slot);
    const web = runPhase(root, slot, "web", [addressOf(slot)], dir);
    if (web.code !== 0) return fail("web", "Mend's web port forwarded", lastLine(web.out));
    // Telemetry only when this machine names the projects (MEND_VERIFY_SENTRY_DSN and the rest).
    const telemetry = telemetryFlags(process.env, "check-vm")
      .map((part) => `'${part.replaceAll("'", "")}'`)
      .join(" ");
    const setup = ssh(`mend server setup --offline --url ${url} ${telemetry} 2>&1 | tail -5`);
    if (setup.code !== 0)
      return fail("url", `mend server setup --url ${url}`, lastLine(setup.stdout));
    const healthy = await waitForHealth(url, 300_000);
    if (!healthy.ok) return fail("health", "Mend answers health", healthy.seen);
    let boatOn_ = null;
    if (boatSlot !== null) {
      const boatAt = Date.now();
      boatOn_ = boatOn(
        root,
        boxSshArgs(root, slot),
        (name, args) => runPhase(root, slot, name, args, dir),
        boatSlot,
        dir,
        { removesImages: willSave },
      );
      if (boatOn_.error)
        return fail("boat", `Boat through slot ${boatSlot}'s own Funnel`, boatOn_.error);
      const back = await waitForHealth(url, 300_000);
      if (!back.ok)
        return fail(
          "boat",
          `Boat through slot ${boatSlot}'s own Funnel`,
          `Mend after setup: ${back.seen}`,
        );
      steps.push(
        step(
          "boat",
          `Boat through slot ${boatSlot}'s own Funnel`,
          "passed",
          `${boatOn_.sessionUrl} and ${boatOn_.blobUrl} in ${seconds(boatAt)}s; ${boatOn_.certSeen}; VM 131's deployment; ${boatOn_.journals}; ${boatOn_.answeredAfter}; ${boatOn_.retention}`,
        ),
      );
      // The check above asked from inside the copy, over the tailnet; a Boat VM comes through Funnel.
      const outside = await funnelFromOutside(boatOn_.dnsName);
      if (!outside.ok)
        return fail("funnel", "The copy's Funnel from outside the tailnet", outside.detail);
      steps.push(
        step("funnel", "The copy's Funnel from outside the tailnet", "passed", outside.detail),
      );
    }
    const total = seconds(started);
    steps.push(
      step(
        "health",
        "Mend answers health",
        "passed",
        `${url} healthy ${total}s after vm up (${master.version})`,
      ),
    );
    writeFileSync(
      join(dir, "copy.json"),
      `${JSON.stringify({ slot, url, ssh: boxSshArgs(root, slot).join(" "), startedAt: new Date(started).toISOString(), healthySeconds: total, master, unit, boat: boatOn_ ? { slot: boatSlot, session: boatOn_.sessionUrl, blob: boatOn_.blobUrl, removesImages: boatOn_.removesImages } : null }, null, 2)}\n`,
      { mode: 0o600 },
    );
    return {
      steps,
      next: [
        `export MEND_VERIFY_BOX_SSH='${boxSshArgs(root, slot).join(" ")}' MEND_VERIFY_OUTER_URL=${url}`,
        `pnpm verify vm down ${slot}   # when the check ends`,
      ],
      copy: {
        slot,
        url,
        ssh: boxSshArgs(root, slot).join(" "),
        healthySeconds: total,
        bootSeconds: booted,
        unit,
      },
    };
  };
  for (const signal of signals) process.on(signal, abandon);
  try {
    return await boot();
  } finally {
    for (const signal of signals) process.off(signal, abandon);
  }
};

/**
 * vm down <n> (or --all): stops the copy and deletes its disk. A Boat copy first stops, through its
 * own Mend, what it launched on Boat and waits until Boat confirms each VM gone (SLNT-1345). One
 * that is not confirmed keeps the copy: its Mend is the only thing that can still reach that VM.
 * `--leave-boat-vms` deletes it anyway, a person's choice: the VM then runs until Boat reaps it.
 * Then it removes from Boat, through sealant on the copy, each image the copy holds that the saved
 * data does not (SLNT-1256), and keeps the copy while one is not confirmed removed: its journal is
 * the only way to remove it. `--leave-boat-images` deletes it anyway, a person's choice.
 */
export const vmDown = async ({
  root = vmRoot(),
  slot,
  all,
  leaveBoatVms = false,
  leaveBoatImages = false,
  stopBoat = stopBoatSessions,
  removeImages = removeBoatImages,
}) => {
  const p = paths(root);
  const slots = all ? liveSlots(p) : [slot];
  const steps = [];
  const next = [];
  for (const each of slots) {
    const dir = join(p.copies, String(each));
    if (!existsSync(dir)) {
      steps.push(step(`down-${each}`, `Remove copy ${each}`, "passed", "no such copy"));
      continue;
    }
    let record = {};
    try {
      record = JSON.parse(readFileSync(join(dir, "copy.json"), "utf8"));
    } catch {
      // A copy whose start failed: nothing on Boat to stop.
    }
    const running = qemuPid(dir) !== null;
    let boatNote = "";
    if (record.boat && running) {
      const { left, stops } = await stopBoat(
        root,
        boxSshArgs(root, each),
        urlOf(each),
        record.startedAt,
      );
      const said = stops.length > 0 ? ` (stops: ${stops.join("; ")})` : "";
      const unconfirmed =
        left === null
          ? "its Mend could not say which Boat VMs it launched are still there"
          : left.length > 0
            ? `Boat VMs it launched still there: ${left.map(describeBoatVm).join(", ")}`
            : null;
      if (unconfirmed !== null && !leaveBoatVms) {
        steps.push(
          step(
            `down-${each}`,
            `Remove copy ${each}`,
            "failed",
            `kept: ${unconfirmed}${said}. The copy still runs, so its Mend can reach them`,
          ),
        );
        next.push(
          `MEND_URL=${urlOf(each)}: stop each one's session there (its page's Stop, or Discard unsaved and stop), then pnpm verify vm down ${each}`,
          `pnpm verify vm down ${each} --leave-boat-vms   # a person's choice: deletes the copy, and the VMs run until Boat reaps them`,
        );
        continue;
      }
      boatNote =
        unconfirmed === null
          ? `; Boat confirmed every VM it launched gone${said}`
          : `; left on Boat by --leave-boat-vms: ${unconfirmed}${said}`;
      const images = await removeImages(root, boxSshArgs(root, each));
      const removed =
        images.removed.length > 0
          ? `; removed from Boat the images it built that the saved data does not keep: ${images.removed.map(({ name, id }) => name ?? id).join(", ")}`
          : "";
      const refused =
        images.refused.length > 0
          ? `; left in Boat, refused by sealant (only the Boat account's owner can delete them): ${images.refused.map(describeBoatImage).join(", ")}`
          : "";
      const notRemoved =
        images.left === null
          ? `its images could not be read: ${images.why}`
          : images.left.length > 0
            ? `Boat images it built not confirmed removed: ${images.left.map(describeBoatImage).join(", ")}${images.why === undefined ? "" : ` (${images.why})`}`
            : null;
      if (notRemoved !== null && !leaveBoatImages) {
        steps.push(
          step(
            `down-${each}`,
            `Remove copy ${each}`,
            "failed",
            `kept: ${notRemoved}${removed}${refused}. The copy still runs, so its sealant can remove them`,
          ),
        );
        next.push(
          `pnpm verify vm down ${each}   # again: sealant on the copy goes on removing them`,
          `pnpm verify vm down ${each} --leave-boat-images   # a person's choice: deletes the copy, and the images stay in Boat with nothing to remove them`,
        );
        continue;
      }
      boatNote += `${removed}${refused}${notRemoved === null ? "" : `; left in Boat by --leave-boat-images: ${notRemoved}`}`;
    }
    if (record.boat && !running)
      boatNote = "; its VM was not running, so its Boat VMs were not checked";
    if (record.boat && running) runPhase(root, each, "tailnet-down", [], dir);
    const stopped = await stopQemu(dir);
    // QEMU gone, its unit goes with it (--collect); stopping it by name also covers a copy whose
    // qemu.pid is unreadable but whose unit still runs.
    stopUnit(record.unit ?? (userManager() ? unitOf(root, each) : null));
    // The slot is free once its VM is gone: QEMU's lock on the slot's disk went with it.
    const held = slotOfCopy(root, each);
    if (held !== null) releaseSlot(root, held, each);
    rmSync(dir, { recursive: true, force: true });
    steps.push(
      step(
        `down-${each}`,
        `Remove copy ${each}`,
        "passed",
        `VM ${stopped}; disk and directory removed${held !== null ? `; Boat slot ${held} free` : ""}${boatNote}`,
      ),
    );
  }
  writeSshConfig(p);
  if (steps.length === 0) steps.push(step("down", "Remove copies", "passed", "no copies"));
  return { steps, next };
};

/**
 * A refresh claim no worker ever reaches: sealant's keep-fresh sweepers take a login only when its
 * `refresh_claimed_until` is null or past (`claimRefresh`), and answer `skipped-claimed` otherwise.
 */
export const LOGIN_CLAIM = "2999-01-01 00:00:00+00";

/**
 * Holds every agent login of the copy's data against refresh, with Mend stopped: one refresh token
 * is shared by every copy of the saved data, so only the copy that lifts this claim (the daily
 * run's, `.agents/skills/box-main-run/refresher.sh`) may spend it. Prints `held=<n>`.
 */
export const holdLoginsScript = `# hold-logins
set -uo pipefail
docker stop --time 60 mend-mend-1 >/dev/null 2>&1
n=$(docker exec mend-postgres-1 psql -U postgres -d sealant_control_plane -At -v ON_ERROR_STOP=1 -c \\
  "with held as (update connected_accounts set refresh_claimed_until = '${LOGIN_CLAIM}' where archived_at is null and kind in ('auth-json', 'credentials-json') returning 1) select count(*) from held") ||
  { echo "held=failed"; exit 1; }
echo "held=$n"
`;

export const SAVED = [
  { name: "world.sql", read: "cat /root/main-run/world.sql", prev: "world.prev.sql" },
  {
    name: "world.store.tgz",
    read: "cat /root/main-run/world.store.tgz",
    prev: "world.prev.store.tgz",
  },
  { name: "mend-git.tgz", read: "tar -C /srv -czf - mend-git", prev: "mend-git.prev.tgz" },
  // The blob store, where sessions' captures live: a change page reads its capture from it.
  {
    name: "mend-garage.tgz",
    read: `docker stop mend-garage-1 >/dev/null && tar -C "$(docker volume inspect -f '{{.Mountpoint}}' mend-garage)" -czf - .`,
    prev: "mend-garage.prev.tgz",
  },
  // Boat's own state: the build journal of each Boat image. sealant reads an image's journal before
  // it launches on it, and quarantines an image whose journal is gone, so the journals go with the
  // rows that name them (SLNT-1252). A copy that never set Boat up has no such volume: its journals
  // are still the ones its master was built with.
  {
    name: "mend-boat-state.tgz",
    read: `if d=$(docker volume inspect -f '{{.Mountpoint}}' mend_mend-boat-state 2>/dev/null); then
  tar -C "$d" -czf - --exclude='*.lock' .
else
  cat /root/main-run/mend-boat-state.tgz
fi`,
    prev: "mend-boat-state.prev.tgz",
  },
];

/** Whether a saved `.tgz` reads to its end: an archive cut short fails here, not in the next build. */
const wholeArchive = (file) => spawnSync("tar", ["-tzf", file], { stdio: "ignore" }).status === 0;

/**
 * vm save <n>: makes a copy's data the data the next master is built from (SLNT-1216). With Mend
 * stopped in the copy, it holds the agent logins against refresh, dumps the databases and the store
 * directories they name (box.mjs saveScript, as `box release --save` does), and archives the git
 * service, the blob store and Boat's build journals. Then it copies the five into <root>/box beside
 * the old ones, checks each, and only once all five are whole moves the old ones to `*.prev.*` and
 * the new ones into place. A save that fails anywhere leaves <root>/box as it was. It refuses data
 * carrying a Mend migration origin/main lacks: a master built on it could not take a preview of main.
 * The copy is left with Mend stopped; `vm down` deletes it. The master is not touched: `vm build`
 * builds the next one from these files.
 */
export const vmSave = async ({ root = vmRoot(), repoRoot, slot }) => {
  const p = paths(root);
  const dir = join(p.copies, String(slot));
  const steps = [];
  const done = (id, title, status, detail) => {
    steps.push(step(id, title, status, detail));
    return { steps, next: status === "passed" ? [] : [`pnpm verify vm down ${slot}`] };
  };
  if (qemuPid(dir) === null)
    return done("copy", `Copy ${slot}`, "blocked_by_prerequisite", "no such copy running");
  const ssh = sshRunner(boxSshArgs(root, slot));

  const main = mainMigrations(repoRoot);
  const applied = ssh(
    `docker exec mend-postgres-1 psql -U postgres -d mend -At -F'|' -c 'select migration_id, name from mend_migrations order by migration_id'`,
  );
  const names = applied.stdout
    .split("\n")
    .map((line) => line.split("|"))
    .filter(([id]) => /^\d+$/.test(id ?? ""))
    .map(([id, name]) => `${id.padStart(4, "0")}_${name}`);
  const foreign = main === null ? null : names.filter((name) => !main.includes(name));
  if (applied.code !== 0 || names.length === 0 || foreign === null || foreign.length > 0)
    return done(
      "schema",
      "Data a run of main can load",
      "failed",
      applied.code !== 0 || names.length === 0
        ? "the copy's Mend migrations could not be read"
        : foreign === null
          ? "origin/main's migrations could not be read"
          : `the copy's data carries ${foreign.join(", ")}, which origin/main lacks; nothing saved`,
    );
  steps.push(
    step(
      "schema",
      "Data a run of main can load",
      "passed",
      `${names.length} migrations, all on main`,
    ),
  );

  const held = ssh(holdLoginsScript);
  const count = held.stdout.match(/^held=(\d+)$/m)?.[1];
  if (count === undefined)
    return done("hold", "Agent logins held against refresh", "failed", lastLine(held.stdout));
  steps.push(
    step(
      "hold",
      "Agent logins held against refresh",
      "passed",
      `${count} logins claimed until ${LOGIN_CLAIM.slice(0, 10)}; Mend stopped`,
    ),
  );

  const saved = ssh(saveScript("/root/main-run/world.sql"));
  if (!/^save=\d+$/m.test(saved.stdout))
    return done("dump", "The copy's data dumped", "failed", lastLine(saved.stdout));
  steps.push(step("dump", "The copy's data dumped", "passed", lastLine(saved.stdout)));

  const at = Date.now();
  const temporary = (name) => join(p.box, `${name}.${process.pid}.tmp`);
  const clean = () => SAVED.forEach(({ name }) => rmSync(temporary(name), { force: true }));
  for (const { name, read } of SAVED) {
    const out = spawnSync("ssh", ["-o", "BatchMode=yes", ...boxSshArgs(root, slot), read], {
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 ** 3,
    });
    const bytes = out.stdout?.length ?? 0;
    const got =
      out.status === 0 &&
      bytes > 0 &&
      (name !== "world.sql" || out.stdout.subarray(-200).toString().includes("dump complete"));
    if (got) writeFileSync(temporary(name), out.stdout, { mode: 0o600 });
    if (!got || (name.endsWith(".tgz") && !wholeArchive(temporary(name)))) {
      clean();
      return done(
        "copy-out",
        "The saved data copied out",
        "failed",
        `${name}: ssh exited ${out.status}, ${bytes} bytes${name === "world.sql" ? ", or no pg_dumpall trailer" : name.endsWith(".tgz") ? ", or an archive that does not read to its end" : ""}; ${p.box} is as it was`,
      );
    }
  }
  // Images with a saved snapshot only the replaced data records (SLNT-1256): no copy holds their
  // rows and journals once it is replaced, so they are named for the Boat account's owner.
  const replaced = dumpImages(join(p.box, "world.sql"));
  const kept = dumpImages(temporary("world.sql"));
  const orphans =
    replaced === null || kept === null
      ? null
      : liveImagesOf(replaced).filter(([id]) => !kept.has(id));
  for (const { name, prev } of SAVED) {
    if (existsSync(join(p.box, name))) renameSync(join(p.box, name), join(p.box, prev));
    renameSync(temporary(name), join(p.box, name));
  }
  const sizes = SAVED.map(
    ({ name }) => `${name} ${(statSync(join(p.box, name)).size / 1024 ** 2).toFixed(1)} MiB`,
  );
  steps.push(
    step(
      "save",
      "The next master's data",
      "passed",
      `${sizes.join(", ")} in ${p.box} after ${seconds(at)}s; the ones before kept as ${SAVED.map(({ prev }) => prev).join(", ")}`,
    ),
  );
  steps.push(
    step(
      "orphans",
      "Boat images only the replaced data knew",
      "passed",
      orphans === null
        ? "not compared: a dump's images could not be read"
        : orphans.length === 0
          ? "none: the new data records every image the replaced data did"
          : `${orphans.map(([, { name, state }]) => `${name} (${state})`).join(", ")}: no copy can remove these any more; the Boat account's owner deletes each by name`,
    ),
  );
  return {
    steps,
    next: [
      `pnpm verify vm down ${slot}`,
      "pnpm verify vm build --version <preview> --sha <commit>   # once no copy runs",
    ],
  };
};

/** vm list: the master and each copy, whether its VM runs, its address and age. */
export const vmList = ({ root = vmRoot() }) => {
  const p = paths(root);
  const master = readJson(p.masterMeta);
  const building = qemuPid(p.build) !== null;
  const copies = liveSlots(p).map((slot) => {
    const dir = join(p.copies, String(slot));
    let record = {};
    try {
      record = JSON.parse(readFileSync(join(dir, "copy.json"), "utf8"));
    } catch {
      // A copy still starting, or one whose start failed.
    }
    const ageHours = record.startedAt
      ? (Date.now() - Date.parse(record.startedAt)) / 3_600_000
      : null;
    return {
      slot,
      running: qemuPid(dir) !== null,
      // null for a copy started before SLNT-1326 or on a host with no user manager: it stops with
      // the scope or session that started it.
      unit: record.unit ?? null,
      url: urlOf(slot),
      ssh: boxSshArgs(root, slot).join(" "),
      ageHours,
      // A copy started before the last build runs on the master before it.
      onOlderMaster:
        record.master?.builtAt !== undefined && record.master.builtAt !== master?.builtAt
          ? record.master.version
          : null,
    };
  });
  const steps = [
    step(
      "master",
      "The master disk",
      master ? "passed" : "blocked_by_prerequisite",
      master
        ? `${master.version} (${master.sha.slice(0, 12)}), built ${master.builtAt}${building ? "; the next one is building beside it" : ""}`
        : `no master${building ? " yet: a build is running" : ": pnpm verify vm build"}`,
    ),
    ...copies.map((copy) =>
      step(
        `copy-${copy.slot}`,
        `Copy ${copy.slot}`,
        "passed",
        `${copy.running ? "running" : "not running"} · ${copy.url} ·${copy.running && copy.ageHours !== null ? (copy.unit ? ` ${copy.unit} ·` : " dies with the process that started it ·") : ""} ${copy.ageHours === null ? "starting" : `${copy.ageHours.toFixed(1)} h`}${copy.onOlderMaster ? ` · on the master before (${copy.onOlderMaster})` : ""}${copy.ageHours !== null && copy.ageHours > STALE_HOURS ? " · stale: pnpm verify vm down " + copy.slot : ""}`,
      ),
    ),
  ];
  const running = (copy) => qemuPid(join(p.copies, String(copy))) !== null;
  const slots = joinedSlots(root).map((record) => ({
    ...record,
    holder: slotHolder(root, record.slot, running)?.copy ?? null,
  }));
  for (const slot of slots)
    steps.push(
      step(
        `boat-slot-${slot.slot}`,
        `Boat slot ${slot.slot}`,
        slot.funnel === false ? "blocked_by_prerequisite" : "passed",
        `${slot.dnsName} · ${slot.holder === null ? "free" : `held by copy ${slot.holder}`} · node key expires ${slot.keyExpiry ?? "never (expiry off)"}${slot.funnel === false ? " · no funnel node attribute" : ""}`,
      ),
    );
  return { steps, next: [], master, copies, slots };
};

/**
 * Boots a bare copy (no Mend started) with extra drives, for `vm slot add|remove`. Returns its ssh
 * arguments, a phase runner and `remove()`, which powers it off and deletes it; or { error }.
 */
const bootBare = (root, cpus, memory) => async (extraDrives) => {
  const p = paths(root);
  privateDir(p.copies);
  let slot = null;
  for (let candidate = 1; candidate <= SLOTS && slot === null; candidate++) {
    try {
      mkdirSync(join(p.copies, String(candidate)), { mode: 0o700 });
      slot = candidate;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  if (slot === null) return { error: `all ${SLOTS} copies are in use` };
  const dir = join(p.copies, String(slot));
  const remove = async () => {
    await stopQemu(dir);
    rmSync(dir, { recursive: true, force: true });
    writeSshConfig(p);
  };
  const overlay = overlayOf(p, dir);
  if (overlay.code !== 0) {
    await remove();
    return { error: lastLine(overlay.stderr) };
  }
  writeSshConfig(p);
  const qemu = startQemu({ dir, slot, cpus, memory, cache: "unsafe", extraDrives });
  if (qemu || !(await waitForSsh(sshRunner(boxSshArgs(root, slot)), 120_000))) {
    await remove();
    return { error: qemu ?? "no ssh in 120s" };
  }
  return {
    sshArgs: boxSshArgs(root, slot),
    runPhase: (name, args) => runPhase(root, slot, name, args, dir),
    remove,
  };
};

/** vm slot add | vm slot remove <b>: the Boat slots' tailnet identities (vm-boat.mjs). */
export const vmSlot = async ({ root = vmRoot(), action, slot, cpus = 2, memory = "2G" }) => {
  const p = paths(root);
  if (!existsSync(p.masterMeta))
    return {
      steps: [
        step(
          "master",
          "The master disk",
          "blocked_by_prerequisite",
          "no master: pnpm verify vm build",
        ),
      ],
      next: [],
    };
  const running = (copy) => qemuPid(join(p.copies, String(copy))) !== null;
  const context = { bootBare: bootBare(root, cpus, memory), step, copyRunning: running };
  return action === "add" ? slotAdd(root, context) : slotRemove(root, slot, context);
};
