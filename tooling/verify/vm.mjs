import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import { restoreScript, storeLoadScript, sshRunner } from "./box.mjs";

// Check VMs (SLNT-1214): a throwaway copy of a box on this machine per check, in place of the one
// preview server every box check queued for. One master disk holds a stock Ubuntu cloud image with
// Docker, Mend installed the operator's way (`mend server setup`, through preview-deploy.sh) over
// VM 131's own install identity, the box run's data and its git service. Each copy is a qcow2
// overlay of that disk under QEMU/KVM with user-mode networking, on a loopback address of its own,
// and is deleted by `vm down`. To the box verbs a copy is a box: MEND_VERIFY_BOX_SSH and
// MEND_VERIFY_OUTER_URL name it, and nobody else holds it.
// `vm up --boat` adds Boat through this machine's Tailscale Funnel, one copy at a time (SLNT-1215).
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
/** Boat's two endpoints as setup publishes them in the VM, and as QEMU forwards them from the host. */
const SESSION_PORT = 13106;
const BLOB_PORT = 13900;
/** The Funnel ports a Boat copy takes on this machine's tailnet name: session traffic, saved work. */
export const FUNNEL_PORTS = { session: 8443, blob: 10000 };
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
  copies: join(root, "copies"),
});

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
 * the VMs' own key, and a known_hosts entry recorded at build under one alias, since every copy
 * boots with the master's host key.
 */
const writeSshConfig = (p, slots) => {
  const block = (slot) =>
    [
      `Host ${hostOf(slot)}`,
      `  HostName ${addressOf(slot)}`,
      `  Port ${SSH_PORT}`,
      "  User root",
      `  IdentityFile ${p.key}`,
      "  IdentitiesOnly yes",
      `  UserKnownHostsFile ${p.knownHosts}`,
      "  HostKeyAlias mend-check-vm",
      `  StrictHostKeyChecking ${slot === MASTER_SLOT ? "accept-new" : "yes"}`,
      "  ServerAliveInterval 15",
      "  LogLevel ERROR",
      "",
    ].join("\n");
  // Copies start and stop at once: each writes the whole file aside and renames it into place.
  const temporary = `${p.sshConfig}.${process.pid}.${Date.now()}`;
  writeFileSync(temporary, slots.map(block).join("\n"), { mode: 0o600 });
  renameSync(temporary, p.sshConfig);
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

const qemuArgs = ({ dir, slot, cpus, memory, cache, seedUrl }) => [
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
  `file=${join(dir, "disk.qcow2")},if=virtio,format=qcow2,cache=${cache},discard=unmap`,
  "-netdev",
  `user,id=n0,hostfwd=tcp:${addressOf(slot)}:${SSH_PORT}-:22,hostfwd=tcp:${addressOf(slot)}:${WEB_PORT}-:${GUEST_WEB_PORT},hostfwd=tcp:${addressOf(slot)}:${SESSION_PORT}-:23106,hostfwd=tcp:${addressOf(slot)}:${BLOB_PORT}-:23900`,
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

const startQemu = (options) => {
  const started = run("qemu-system-x86_64", qemuArgs(options));
  return started.code === 0
    ? null
    : `qemu-system-x86_64 exited ${started.code}: ${lastLine(started.stderr)}`;
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
const serveSeed = (publicKey) =>
  new Promise((resolve) => {
    const files = {
      "/meta-data": `instance-id: mend-check-master\nlocal-hostname: mend-check\n`,
      "/user-data": [
        "#cloud-config",
        "disable_root: false",
        "ssh_pwauth: false",
        "ssh_deletekeys: true",
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

/** This machine's tailnet name, as Funnel serves it, or null without Tailscale. */
const tailnetName = () => {
  const status = run("tailscale", ["status", "--json"]);
  try {
    return JSON.parse(status.stdout).Self.DNSName.replace(/\.$/, "") || null;
  } catch {
    return null;
  }
};

/** Where each Funnel port forwards now: { "8443": "127.0.1.1:13106", … }. */
const funnelTargets = () => {
  const status = run("tailscale", ["funnel", "status", "--json"]);
  let config = {};
  try {
    config = JSON.parse(status.stdout || "{}");
  } catch {
    // No config reads as no forwards.
  }
  return Object.fromEntries(
    Object.entries(config.TCP ?? {}).map(([port, handler]) => [port, handler.TCPForward ?? ""]),
  );
};

/**
 * Takes the two Funnel ports for a copy: refuses when either forwards somewhere else (another copy
 * holds Boat), then forwards them to the copy's Boat endpoints. Returns an error string or null.
 */
const funnelUp = (slot) => {
  const targets = funnelTargets();
  const wants = {
    [FUNNEL_PORTS.session]: `${addressOf(slot)}:${SESSION_PORT}`,
    [FUNNEL_PORTS.blob]: `${addressOf(slot)}:${BLOB_PORT}`,
  };
  for (const [port, target] of Object.entries(wants)) {
    if (targets[port] && targets[port] !== target)
      return `Funnel port ${port} forwards to ${targets[port]}: another copy holds Boat (pnpm verify vm list)`;
  }
  for (const [port, target] of Object.entries(wants)) {
    const on = run("tailscale", [
      "funnel",
      "--bg",
      `--tls-terminated-tcp=${port}`,
      `tcp://${target}`,
    ]);
    if (on.code !== 0) return `tailscale funnel ${port}: ${lastLine(on.stderr || on.stdout)}`;
  }
  return null;
};

/**
 * Takes down the Funnel ports that forward to this copy, and only those. Turning a TCP forward off
 * leaves its port's "funnel on" flag behind with nothing served; when those flags are all that is
 * left of this machine's Serve config, the config is reset, so a later `tailscale funnel status`
 * reads clean. Anything else in it (another server's forwards) is left as it is. Returns the ports.
 */
const funnelDown = (slot) => {
  const ports = Object.entries(funnelTargets())
    .filter(([, target]) => target.startsWith(`${addressOf(slot)}:`))
    .flatMap(([port]) =>
      run("tailscale", ["funnel", `--tls-terminated-tcp=${port}`, "off"]).code === 0 ? [port] : [],
    );
  let config = {};
  try {
    config = JSON.parse(run("tailscale", ["funnel", "status", "--json"]).stdout || "{}");
  } catch {
    return ports;
  }
  const ours = new Set(Object.values(FUNNEL_PORTS).map(String));
  const leftovers = Object.keys(config.AllowFunnel ?? {});
  if (
    Object.keys(config).every((key) => key === "AllowFunnel") &&
    leftovers.length > 0 &&
    leftovers.every((hostPort) => ours.has(hostPort.split(":").at(-1)))
  )
    run("tailscale", ["funnel", "reset"]);
  return ports;
};

/**
 * Boat on a copy (SLNT-1215). The Funnel first, since setup checks both addresses answer. Then setup
 * with VM 131's own Boat key (<root>/box/boat.key, on stdin) and VM 131's deployment name, which the
 * loaded data's sealant keeps in `boat_install`; and no resource gateway, whose host id derives from
 * the identity the box shares, so a copy's gateway would take the box's place. Sharing the name is
 * what lets a copy reuse the Boat images the box built (their publications are in the loaded data,
 * their build journals in <root>/box/mend-boat-state.tgz, put into the copy's Boat state volume
 * here). It is safe because sealant acts only on runs in its own database: every run the loaded data
 * holds under that name is settled, the box never sees a copy's runs, and `vm down` stops the copy's
 * Boat sessions so their VMs go. Measured 20 Nov: with a name of its own, the copy's first image
 * build failed at once (`native-local-io-failed`) and quarantined the image.
 */
const boatOn = (root, slot, dir) => {
  const key = join(paths(root).box, "boat.key");
  const journals = join(paths(root).box, "mend-boat-state.tgz");
  for (const file of [key, journals])
    if (!existsSync(file))
      return { error: `no ${file}: pnpm verify vm build --from-box copies it from VM 131` };
  const host = tailnetName();
  if (host === null) return { error: "no tailnet name: tailscale status --json answered nothing" };
  const guest = (script, input) =>
    spawnSync("ssh", ["-o", "BatchMode=yes", ...boxSshArgs(root, slot), script], {
      ...(input === undefined ? {} : { input }),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  const deployment = (
    guest(
      `docker exec mend-postgres-1 psql -U postgres -d sealant_control_plane -At -c "select deployment_id from boat_install"`,
    ).stdout ?? ""
  ).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(deployment))
    return { error: "the loaded data names no Boat deployment (sealant's boat_install)" };
  const funnel = funnelUp(slot);
  if (funnel) return { error: funnel };
  const sessionUrl = `https://${host}:${FUNNEL_PORTS.session}`;
  const blobUrl = `https://${host}:${FUNNEL_PORTS.blob}`;
  const out = guest(
    [
      "mend server setup --offline --session-runtimes docker,boat --session-runtime boat",
      `--session-endpoint-url ${sessionUrl} --blob-store-public-url ${blobUrl}`,
      `--boat-deployment-id ${deployment} --no-boat-resources --boat-api-key-stdin 2>&1`,
    ].join(" "),
    readFileSync(key, "utf8").trim(),
  );
  writeFileSync(join(dir, "boat-setup.log"), `${out.stdout ?? ""}`, { mode: 0o600 });
  if (out.status !== 0)
    return { error: `mend server setup with Boat: ${lastLine(out.stdout ?? "")}` };
  const answered = (out.stdout ?? "")
    .split("\n")
    .filter((line) => /Boat VMs reach this server/.test(line));
  const put = spawnSync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      ...boxSshArgs(root, slot),
      `set -e
umask 077
cat > /root/main-run/mend-boat-state.tgz
d=$(docker volume inspect -f '{{.Mountpoint}}' mend_mend-boat-state)
docker stop mend-mend-1 >/dev/null
rm -f "$d"/native-builds/*.lock
tar -xzpf /root/main-run/mend-boat-state.tgz --numeric-owner -C "$d"
docker start mend-mend-1 >/dev/null`,
    ],
    { input: readFileSync(journals), maxBuffer: 16 * 1024 * 1024 },
  );
  if (put.status !== 0)
    return { error: `the box's Boat build journals: ${lastLine(String(put.stderr ?? ""))}` };
  return { sessionUrl, blobUrl, answered, deployment };
};

/**
 * Before a Boat copy goes: stops the Boat sessions started on it (by the checker accounts whose CLI
 * kits are here), then waits until sealant on the copy has every VM it launched deleted or seen gone.
 * Nothing else would ever remove them: the box knows none of the copy's runs. Returns the VMs left.
 */
const stopBoatSessions = async (root, slot, since) => {
  const cli = join(root, "cli/node_modules/.bin/mend");
  for (const kit of ["mend-boat-check", "mend-boat-check-2"]) {
    const config = join(homedir(), ".local/share", kit, "cli");
    if (!existsSync(config) || !existsSync(cli)) continue;
    const env = { ...process.env, XDG_CONFIG_HOME: config, MEND_URL: urlOf(slot) };
    let sessions = [];
    try {
      sessions = JSON.parse(run(cli, ["sessions", "--all", "--json"], { env }).stdout).data
        .sessions;
    } catch {
      continue;
    }
    for (const session of sessions)
      if (
        session.boatKey &&
        Date.parse(session.createdAt) >= Date.parse(since) &&
        !["stopped", "completed", "failed", "exited"].includes(session.status)
      )
        run(cli, ["stop", session.id], { env, timeout: 120_000 });
  }
  const live = () =>
    sshRunner(boxSshArgs(root, slot))(
      `docker exec mend-postgres-1 psql -U postgres -d sealant_control_plane -At -c "select coalesce(string_agg(sandbox_id, ' '), '') from boat_runs where sandbox_id is not null and deletion_completed_at is null and absent_at is null and create_issued_at >= '${since}'"`,
    ).stdout.trim();
  let left = live();
  for (let i = 0; i < 40 && left !== ""; i++) {
    await sleep(3000);
    left = live();
  }
  return left === "" ? [] : left.split(" ");
};

const step = (id, title, status, detail) => ({ id, title, status, ...(detail ? { detail } : {}) });

/**
 * vm build: the master disk. From VM 131 it copies (with --from-box) the install identity, the box
 * run's data and its git repositories into <root>/box; then it boots a stock cloud image, installs
 * Docker, Node and the mend CLI, installs Mend with preview-deploy.sh over that identity, loads the
 * data, checks Mend answers, and seals the disk with Mend stopped.
 */
export const vmBuild = async ({
  root = vmRoot(),
  version,
  sha,
  cliVersion,
  fromBox,
  cpus = 8,
  memory = "12G",
}) => {
  const p = paths(root);
  const steps = [];
  const fail = async (id, title, detail) => {
    steps.push(step(id, title, "failed", detail));
    keepFailure(root, MASTER_SLOT, p.master);
    if (!process.env.MEND_CHECK_VMS_KEEP) await stopQemu(p.master);
    return { steps, next: [] };
  };
  privateDir(root);
  privateDir(join(root, "base"));
  privateDir(p.box);
  privateDir(join(root, "key"));
  privateDir(p.copies);
  if (liveSlots(p).length > 0)
    return fail(
      "copies",
      "No copy runs on the master",
      `copies ${liveSlots(p).join(", ")} are backed by the master: pnpm verify vm down --all first`,
    );
  if (!version || !sha || !cliVersion)
    return fail(
      "args",
      "What to install",
      "--version <preview>, --sha <commit> and --cli <version> are required",
    );

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

  // 3. A fresh master disk, booted with a cloud-init seed.
  const started = Date.now();
  rmSync(p.master, { recursive: true, force: true });
  privateDir(p.master);
  rmSync(p.knownHosts, { force: true });
  const converted = run("qemu-img", ["convert", "-O", "qcow2", p.base, p.masterDisk]);
  if (converted.code !== 0) return fail("disk", "The master disk", lastLine(converted.stderr));
  run("qemu-img", ["resize", p.masterDisk, DISK_SIZE]);
  writeSshConfig(p, [MASTER_SLOT, ...liveSlots(p)]);
  const seed = await serveSeed(readFileSync(`${p.key}.pub`, "utf8"));
  const seedUrl = `http://10.0.2.2:${seed.address().port}/`;
  const qemu = startQemu({
    dir: p.master,
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
      `no ssh in 180s; serial log in ${join(p.master, "serial.log")}`,
    );
  steps.push(step("boot", "Boot the master", "passed", `ssh answered in ${seconds(started)}s`));

  // 4. Provision, phase by phase; each phase's output is kept in the master's directory.
  const phase = (name, args) => runPhase(root, MASTER_SLOT, name, args, p.master);
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
  const phases = [
    ["system", [NODE_VERSION], "Docker, git, jq and Node"],
    ["cli", [cliVersion], `The mend CLI ${cliVersion}`],
  ];
  for (const [name, args, title] of phases) {
    const done = phase(name, args);
    if (done.code !== 0)
      return fail(
        name,
        title,
        `${lastLine(done.out)} (log: ${join(p.master, `provision-${name}.log`)})`,
      );
    steps.push(
      step(
        name,
        title,
        "passed",
        `${lastLine(done.out).replace(/^vm-provision: /, "")} in ${done.took}s`,
      ),
    );
  }
  for (const [file, target] of [
    ["identity.env", "/root/.config/mend/identity.env"],
    ["world.sql", "/root/main-run/world.sql"],
    ["world.store.tgz", "/root/main-run/world.store.tgz"],
    ["mend-git.tgz", "/root/main-run/mend-git.tgz"],
    ["mend-keys.tgz", "/root/main-run/mend-keys.tgz"],
    ["mend-ssh.tgz", "/root/main-run/mend-ssh.tgz"],
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
      "identity.env, world.sql, world.store.tgz, /srv/mend-git",
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
      `${lastLine(server.out)} (log: ${join(p.master, "provision-server.log")})`,
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
tar -xzpf /root/main-run/mend-ssh.tgz --numeric-owner -C "$s"`);
  if (keys.code !== 0)
    return fail("load", "Load the box run's data", `the box's keys: ${lastLine(keys.stderr)}`);
  const startedMend = ssh("mend server start --offline 2>&1 | tail -3");
  if (startedMend.code !== 0)
    return fail("load", "Load the box run's data", lastLine(startedMend.stdout));
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
    const cliDir = join(root, "cli");
    if (!existsSync(join(cliDir, "node_modules/.bin/mend"))) {
      const installed = run("npm", [
        "install",
        "--silent",
        "--no-audit",
        "--no-fund",
        "--prefix",
        cliDir,
        `@sealant/mend@${cliVersion}`,
      ]);
      if (installed.code !== 0)
        return fail(
          "warm",
          "Warm the workspace images",
          `npm install: ${lastLine(installed.stderr)}`,
        );
    }
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
    const restarted = ssh("mend server start --offline 2>&1 | tail -3");
    const back =
      restarted.code === 0
        ? await waitForHealth(urlOf(MASTER_SLOT), 300_000)
        : { ok: false, seen: lastLine(restarted.stdout) };
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
  for (let i = 0; i < 120 && qemuPid(p.master) !== null; i++) await sleep(500);
  if (qemuPid(p.master) !== null) await stopQemu(p.master);
  writeFileSync(
    p.masterMeta,
    `${JSON.stringify({ version, sha, cliVersion, builtAt: new Date().toISOString(), seconds: seconds(started) }, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeSshConfig(p, liveSlots(p));
  const size = statSync(p.masterDisk).size;
  steps.push(
    step(
      "seal",
      "Seal the master",
      "passed",
      `${(size / 1024 ** 3).toFixed(1)} GiB on disk; built in ${seconds(started)}s`,
    ),
  );
  return { steps, next: ["pnpm verify vm up"], master: { version, sha } };
};

/**
 * vm up: a fresh copy of the master. It takes the lowest free slot, boots an overlay of the master
 * disk, gives Mend the copy's own address with `mend server setup --url`, and waits for health.
 */
export const vmUp = async ({ root = vmRoot(), cpus = 6, memory = "8G", boat = false }) => {
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
      next: ["pnpm verify vm build --version <preview> --sha <commit> --cli <version>"],
    };
  const master = JSON.parse(readFileSync(p.masterMeta, "utf8"));
  if (boat) {
    // One Boat copy per machine at a time: it takes this machine's two Funnel ports.
    const held = Object.entries(funnelTargets()).filter(
      ([port, target]) => Object.values(FUNNEL_PORTS).map(String).includes(port) && target !== "",
    );
    if (held.length > 0)
      return {
        steps: [
          step(
            "boat",
            "This machine's Funnel ports for Boat",
            "blocked_by_prerequisite",
            `Funnel port ${held[0][0]} forwards to ${held[0][1]}: another copy holds Boat, and a machine serves one (pnpm verify vm list)`,
          ),
        ],
        next: [
          "pnpm verify vm list",
          "pnpm verify vm up   # without Boat, or once that copy is down",
        ],
      };
  }
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
  const fail = async (id, title, detail) => {
    steps.push(step(id, title, "failed", detail));
    keepFailure(root, slot, dir);
    await stopQemu(dir);
    return { steps, next: [`pnpm verify vm down ${slot}`], copy: { slot, dir } };
  };
  const overlay = run("qemu-img", [
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
  if (overlay.code !== 0) return fail("disk", "The copy's disk", lastLine(overlay.stderr));
  writeSshConfig(p, liveSlots(p));
  const qemu = startQemu({ dir, slot, cpus, memory, cache: "unsafe" });
  if (qemu) return fail("boot", "Boot the copy", qemu);
  const ssh = sshRunner(boxSshArgs(root, slot));
  if (!(await waitForSsh(ssh, 120_000)))
    return fail("boot", "Boot the copy", `no ssh in 120s; serial log ${join(dir, "serial.log")}`);
  const booted = seconds(started);
  steps.push(step("boot", "Boot the copy", "passed", `ssh answered ${booted}s after vm up`));
  const url = urlOf(slot);
  const web = runPhase(root, slot, "web", [addressOf(slot)], dir);
  if (web.code !== 0) return fail("web", "Mend's web port forwarded", lastLine(web.out));
  const setup = ssh(`mend server setup --offline --url ${url} 2>&1 | tail -5`);
  if (setup.code !== 0)
    return fail("url", `mend server setup --url ${url}`, lastLine(setup.stdout));
  const healthy = await waitForHealth(url, 300_000);
  if (!healthy.ok) return fail("health", "Mend answers health", healthy.seen);
  let boatOn_ = null;
  if (boat) {
    const boatAt = Date.now();
    boatOn_ = boatOn(root, slot, dir);
    if (boatOn_.error) {
      funnelDown(slot);
      return fail("boat", "Boat through this machine's Funnel", boatOn_.error);
    }
    const back = await waitForHealth(url, 300_000);
    if (!back.ok) {
      funnelDown(slot);
      return fail("boat", "Boat through this machine's Funnel", `Mend after setup: ${back.seen}`);
    }
    steps.push(
      step(
        "boat",
        "Boat through this machine's Funnel",
        "passed",
        `${boatOn_.sessionUrl} and ${boatOn_.blobUrl} in ${seconds(boatAt)}s; VM 131's deployment and Boat images; ${boatOn_.answered.length} of 2 answered setup`,
      ),
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
    `${JSON.stringify({ slot, url, ssh: boxSshArgs(root, slot).join(" "), startedAt: new Date(started).toISOString(), healthySeconds: total, master, boat: boatOn_ ? { session: boatOn_.sessionUrl, blob: boatOn_.blobUrl } : null }, null, 2)}\n`,
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
    },
  };
};

/** vm down <n>|--all: stops a copy's VM and deletes its disk and directory. */
export const vmDown = async ({ root = vmRoot(), slot, all }) => {
  const p = paths(root);
  const slots = all ? liveSlots(p) : [slot];
  const steps = [];
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
    const leftOnBoat =
      record.boat && qemuPid(dir) !== null
        ? await stopBoatSessions(root, each, record.startedAt)
        : [];
    const funnel = funnelDown(each);
    const stopped = await stopQemu(dir);
    rmSync(dir, { recursive: true, force: true });
    steps.push(
      step(
        `down-${each}`,
        `Remove copy ${each}`,
        "passed",
        `VM ${stopped}; disk and directory removed${funnel.length > 0 ? `; Funnel ${funnel.join(" and ")} off` : ""}${leftOnBoat.length > 0 ? `; Boat VMs it launched still there: ${leftOnBoat.join(", ")}` : ""}`,
      ),
    );
  }
  writeSshConfig(p, liveSlots(p));
  if (steps.length === 0) steps.push(step("down", "Remove copies", "passed", "no copies"));
  return { steps, next: [] };
};

/** vm list: the master and each copy, whether its VM runs, its address and age. */
export const vmList = ({ root = vmRoot() }) => {
  const p = paths(root);
  const master = existsSync(p.masterMeta) ? JSON.parse(readFileSync(p.masterMeta, "utf8")) : null;
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
      url: urlOf(slot),
      ssh: boxSshArgs(root, slot).join(" "),
      ageHours,
    };
  });
  const steps = [
    step(
      "master",
      "The master disk",
      master ? "passed" : "blocked_by_prerequisite",
      master
        ? `${master.version} (${master.sha.slice(0, 12)}), built ${master.builtAt}`
        : "no master: pnpm verify vm build",
    ),
    ...copies.map((copy) =>
      step(
        `copy-${copy.slot}`,
        `Copy ${copy.slot}`,
        "passed",
        `${copy.running ? "running" : "not running"} · ${copy.url} · ${copy.ageHours === null ? "starting" : `${copy.ageHours.toFixed(1)} h`}${copy.ageHours !== null && copy.ageHours > STALE_HOURS ? " · stale: pnpm verify vm down " + copy.slot : ""}`,
      ),
    ),
  ];
  return { steps, next: [], master, copies };
};
