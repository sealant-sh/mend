import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { sshRunner } from "./box.mjs";

// Boat on a check VM (SLNT-1215, SLNT-1218). A Boat VM calls back to its server at two public
// addresses. Each Boat slot is a tailnet identity of its own: a small disk in the private directory
// holding tailscaled's state (node key, name `mend-check-boat-<b>`, HTTPS certificate). A copy started
// with `vm up --boat` claims a free slot, attaches its disk, brings Tailscale up inside the copy and
// serves the two addresses from its own Funnel. The identity outlives the copy, so a slot asks Let's
// Encrypt for its certificate once, not on every boot, and joins the tailnet with an auth key once.
//
// One copy per slot: a claim file names the copy holding the slot, and QEMU's own write lock on the
// slot's disk refuses a second VM outright; the lock goes with the process, so a crash frees it.

/** How many slots `vm slot add` makes by default: Boat copies that can run at once. */
export const BOAT_SLOTS = 4;

/** The Tailscale static build every Boat copy runs, checked against pkgs.tailscale.com's sha256. */
const TAILSCALE = {
  version: "1.104.1",
  sha256: "108d1d96ecf410d305571e173516f27038f870919a9b89c914a167c6d33a4528",
};

/** The two Funnel ports a Boat copy serves: session traffic, saved work. */
export const FUNNEL_PORTS = { session: 8443, blob: 10000 };

/** A claim younger than this is a copy still booting, even before its QEMU has a pid. */
const CLAIM_GRACE_MS = 5 * 60_000;

export const tailnetHostOf = (slot) => `mend-check-boat-${slot}`;

const slotsDir = (root) => join(root, "boat-slots");
const slotDir = (root, slot) => join(slotsDir(root), String(slot));
const slotDisk = (root, slot) => join(slotDir(root, slot), "tailnet.img");
const slotRecord = (root, slot) => join(slotDir(root, slot), "slot.json");
const claimPath = (root, slot) => join(slotDir(root, slot), "claim.json");
const keyPath = (root) => join(root, "tailscale-authkey");

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

const lastLine = (text) =>
  String(text ?? "")
    .trim()
    .split("\n")
    .at(-1) ?? "";

/** The QEMU drive arguments that attach a slot's disk, found in the VM by its serial. */
export const slotDriveArgs = (root, slot) => [
  "-drive",
  `file=${slotDisk(root, slot)},if=none,id=tailnet,format=raw,cache=writeback`,
  "-device",
  "virtio-blk-pci,drive=tailnet,serial=mendtailnet",
];

/** The slots that have joined the tailnet, in order: [{ slot, name, dnsName, joinedAt, … }]. */
export const joinedSlots = (root) =>
  existsSync(slotsDir(root))
    ? readdirSync(slotsDir(root))
        .filter((name) => /^\d+$/.test(name))
        .map(Number)
        .sort((a, b) => a - b)
        .map((slot) => ({ slot, ...readJson(slotRecord(root, slot)) }))
        .filter((record) => typeof record.dnsName === "string")
    : [];

/** Who holds a slot now: { copy, at } of a live claim, or null when it is free (or its claim stale). */
export const slotHolder = (root, slot, copyRunning) => {
  const claim = readJson(claimPath(root, slot));
  if (claim === null) return null;
  const young = Date.now() - Date.parse(claim.at) < CLAIM_GRACE_MS;
  return young || copyRunning(claim.copy) ? claim : null;
};

/**
 * Claims a joined slot for copy `copy`: the first with no live claim. A claim is written aside and
 * linked into place, which fails when one exists, so two copies racing for one slot cannot both
 * take it. A stale claim (its copy gone, and older than the grace) is first renamed aside, which only
 * one claimer can do, and checked to be the stale one read: a live claim is never removed. QEMU's
 * write lock on the slot's disk backs this up. Returns the slot, or null when none is free.
 */
export const claimSlot = (root, copy, copyRunning) => {
  for (const { slot } of joinedSlots(root)) {
    const path = claimPath(root, slot);
    const found = readJson(path);
    if (found !== null) {
      if (slotHolder(root, slot, copyRunning) !== null) continue;
      const aside = `${path}.stale-${process.pid}-${Date.now()}`;
      try {
        renameSync(path, aside);
      } catch {
        continue; // another claimer moved it first
      }
      const moved = readJson(aside);
      rmSync(aside, { force: true });
      if (moved?.copy !== found.copy || moved?.at !== found.at) {
        // A fresh claim landed between the read and the rename: put it back, and leave this slot.
        try {
          writeFileSync(path, JSON.stringify(moved), { mode: 0o600, flag: "wx" });
        } catch {
          // A newer claim is there already.
        }
        continue;
      }
    }
    const temporary = `${path}.${process.pid}`;
    writeFileSync(temporary, JSON.stringify({ copy, at: new Date().toISOString() }), {
      mode: 0o600,
    });
    try {
      // link() fails when the name exists: exactly one claimer wins.
      linkSync(temporary, path);
      return slot;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return null;
};

/** Frees a slot, but only if `copy` holds it. */
export const releaseSlot = (root, slot, copy) => {
  if (readJson(claimPath(root, slot))?.copy === copy) unlinkSync(claimPath(root, slot));
};

/** The slot a copy holds, or null. */
export const slotOfCopy = (root, copy) =>
  joinedSlots(root).find(({ slot }) => readJson(claimPath(root, slot))?.copy === copy)?.slot ??
  null;

/**
 * The pinned Tailscale build, fetched once into <root>/tailscale and checked. Returns its path, or
 * { error }.
 */
export const tailscaleTarball = (root) => {
  const dir = join(root, "tailscale");
  const file = join(dir, `tailscale_${TAILSCALE.version}_amd64.tgz`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fetched = spawnSync(
      "curl",
      [
        "-fsSL",
        "--retry",
        "3",
        "-o",
        `${file}.part`,
        `https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE.version}_amd64.tgz`,
      ],
      { encoding: "utf8" },
    );
    if (fetched.status !== 0) return { error: `fetching Tailscale: ${lastLine(fetched.stderr)}` };
    renameSync(`${file}.part`, file);
  }
  const sum = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (sum !== TAILSCALE.sha256) {
    rmSync(file, { force: true });
    return { error: `Tailscale ${TAILSCALE.version} has sha256 ${sum}, not ${TAILSCALE.sha256}` };
  }
  return { path: file };
};

/** Copies a local file into the VM through ssh's stdin: nothing of it on a command line. */
const putFile = (sshArgs, source, target) =>
  spawnSync("ssh", ["-o", "BatchMode=yes", ...sshArgs, `umask 077; cat > '${target}'`], {
    input: readFileSync(source),
    maxBuffer: 1024 * 1024,
  }).status === 0;

/** Reads `key=value` lines from a phase's output. */
const values = (text) =>
  Object.fromEntries(
    String(text ?? "")
      .split("\n")
      .filter((line) => /^[a-z-]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

/**
 * Brings Tailscale up inside a copy on slot `slot`'s disk: mounts the disk (formatting a blank one),
 * installs the pinned build, starts tailscaled in userspace networking (the VM's own routes and
 * Docker stay as they are), and, with `join`, logs in with the auth key, which goes into the VM as a
 * file and is removed once read. Returns { dnsName, funnel, https, certs } or { error }.
 */
export const tailnetUp = (root, sshArgs, runPhase, slot, { join: joining = false } = {}) => {
  const tarball = tailscaleTarball(root);
  if (tarball.error) return tarball;
  if (!putFile(sshArgs, tarball.path, "/root/tailscale.tgz"))
    return { error: "the Tailscale build could not be copied into the VM" };
  if (joining) {
    if (!existsSync(keyPath(root)))
      return {
        error: `no auth key at ${keyPath(root)}: a new slot joins once with a key from the owner`,
      };
    if (!putFile(sshArgs, keyPath(root), "/run/mend-tailnet-authkey"))
      return { error: "the auth key could not be copied into the VM" };
  }
  const up = runPhase("tailnet", [tailnetHostOf(slot)]);
  const seen = values(up.out);
  if (up.code !== 0) return { error: lastLine(up.out) };
  return {
    dnsName: seen.dns,
    funnel: seen.funnel === "yes",
    https: seen.https === "yes",
    certs: Number(seen.certs ?? 0),
    certSha: seen["cert-sha"] || null,
    backend: seen.state,
    keyExpiry: seen["key-expiry"] || null,
  };
};

/**
 * `vm slot add`: makes the next slot and joins it to the tailnet. It boots a bare copy with the new
 * disk (Mend is never started), joins with the auth key, checks the node may use Funnel and HTTPS,
 * gets the slot's certificate, and powers the copy off. Each step says what it saw.
 */
export const slotAdd = async (root, { bootBare, step }) => {
  const steps = [];
  mkdirSync(slotsDir(root), { recursive: true, mode: 0o700 });
  const taken = readdirSync(slotsDir(root))
    .filter((name) => /^\d+$/.test(name))
    .map(Number);
  let slot = 1;
  while (taken.includes(slot)) slot += 1;
  mkdirSync(slotDir(root, slot), { mode: 0o700 });
  writeFileSync(slotDisk(root, slot), "", { mode: 0o600 });
  spawnSync("truncate", ["-s", "256M", slotDisk(root, slot)]);
  const at = Date.now();
  const bare = await bootBare(slotDriveArgs(root, slot));
  if (bare.error) {
    rmSync(slotDir(root, slot), { recursive: true, force: true });
    return { steps: [step("boot", "Boot a bare copy", "failed", bare.error)], next: [] };
  }
  try {
    const up = tailnetUp(root, bare.sshArgs, bare.runPhase, slot, { join: true });
    if (up.error) {
      steps.push(step("join", `Join ${tailnetHostOf(slot)} to the tailnet`, "failed", up.error));
      return { steps, next: [`pnpm verify vm slot remove ${slot}`] };
    }
    steps.push(
      step(
        "join",
        `Join ${tailnetHostOf(slot)} to the tailnet`,
        "passed",
        `${up.dnsName} · ${up.backend} · node key expires ${up.keyExpiry ?? "never (expiry off)"}`,
      ),
    );
    if (!up.funnel || !up.https) {
      steps.push(
        step(
          "funnel",
          "The node may use Funnel and HTTPS",
          "blocked_by_prerequisite",
          `${up.dnsName} has ${up.funnel ? "" : "no `funnel` node attribute"}${!up.funnel && !up.https ? " and " : ""}${up.https ? "" : "no `https` capability (HTTPS certificates off for the tailnet)"}: the tailnet policy's nodeAttrs must give it "funnel" (and HTTPS certificates must be on) before a Boat copy can serve its addresses`,
        ),
      );
      writeSlot(root, slot, up, null);
      return { steps, next: [] };
    }
    const cert = bare.runPhase("tailnet-cert", [up.dnsName]);
    const sha = values(cert.out)["cert-sha"];
    if (cert.code !== 0 || !sha) {
      steps.push(step("cert", "The slot's HTTPS certificate", "failed", lastLine(cert.out)));
      writeSlot(root, slot, up, null);
      return { steps, next: [] };
    }
    writeSlot(root, slot, up, sha);
    steps.push(
      step(
        "cert",
        "The slot's HTTPS certificate",
        "passed",
        `${values(cert.out).subject ?? up.dnsName}, valid to ${values(cert.out)["not-after"] ?? "?"}, sha256 ${sha.slice(0, 16)}…; joined in ${Math.round((Date.now() - at) / 1000)}s`,
      ),
    );
    return { steps, next: [], slot: { slot, dnsName: up.dnsName } };
  } finally {
    bare.runPhase("tailnet-down", []);
    await bare.remove();
  }
};

const writeSlot = (root, slot, up, certSha) =>
  writeFileSync(
    slotRecord(root, slot),
    `${JSON.stringify({ name: tailnetHostOf(slot), dnsName: up.dnsName, joinedAt: new Date().toISOString(), keyExpiry: up.keyExpiry, certSha, funnel: up.funnel, https: up.https }, null, 2)}\n`,
    { mode: 0o600 },
  );

/**
 * `vm slot remove <b>`: logs the slot's node out of the tailnet from a bare copy, so it leaves the
 * tailnet, then deletes the slot. Refuses a slot a running copy holds.
 */
export const slotRemove = async (root, slot, { bootBare, step, copyRunning }) => {
  if (!existsSync(slotDir(root, slot)))
    return { steps: [step("slot", `Slot ${slot}`, "passed", "no such slot")], next: [] };
  const holder = slotHolder(root, slot, copyRunning);
  if (holder !== null)
    return {
      steps: [
        step(
          "slot",
          `Slot ${slot}`,
          "blocked_by_prerequisite",
          `copy ${holder.copy} holds it: pnpm verify vm down ${holder.copy} first`,
        ),
      ],
      next: [`pnpm verify vm down ${holder.copy}`],
    };
  const steps = [];
  if (existsSync(slotRecord(root, slot))) {
    const bare = await bootBare(slotDriveArgs(root, slot));
    if (bare.error)
      return { steps: [step("boot", "Boot a bare copy", "failed", bare.error)], next: [] };
    try {
      const up = tailnetUp(root, bare.sshArgs, bare.runPhase, slot);
      const out = up.error ? { code: 1, out: up.error } : bare.runPhase("tailnet-logout", []);
      steps.push(
        step(
          "logout",
          `Log ${tailnetHostOf(slot)} out of the tailnet`,
          out.code === 0 ? "passed" : "failed",
          lastLine(out.out),
        ),
      );
      if (out.code !== 0) return { steps, next: [] };
    } finally {
      await bare.remove();
    }
  }
  rmSync(slotDir(root, slot), { recursive: true, force: true });
  steps.push(step("remove", `Remove slot ${slot}`, "passed", "its disk and records deleted"));
  return { steps, next: [] };
};

/**
 * Boat on a copy holding slot `slot`: Tailscale up from the slot's state (no key), the copy's own
 * Funnel on 8443 and 10000 to the endpoints setup publishes on the VM's loopback, then setup with
 * VM 131's own Boat key on stdin and VM 131's deployment name (which the loaded data's sealant keeps),
 * and the box's Boat build journals put into the copy's Boat state volume. Why the shared name is
 * safe, and why the resource gateway stays off: docs/operations/preview-builds.md, "Check VMs".
 */
export const boatOn = (root, sshArgs, runPhase, slot, dir) => {
  const box = join(root, "box");
  const key = join(box, "boat.key");
  const journals = join(box, "mend-boat-state.tgz");
  for (const file of [key, journals])
    if (!existsSync(file))
      return { error: `no ${file}: pnpm verify vm build --from-box copies it from VM 131` };
  const up = tailnetUp(root, sshArgs, runPhase, slot);
  if (up.error) return { error: `Tailscale on slot ${slot}: ${up.error}` };
  // The slot's certificate should be the one it had last time: Let's Encrypt is asked again only
  // when it is missing from the slot's state (or near expiry, which tailscaled renews by itself).
  const record = readJson(slotRecord(root, slot)) ?? {};
  const certSeen =
    up.certSha === null
      ? "no certificate in the slot yet: Funnel asks for one"
      : record.certSha === up.certSha
        ? `the same certificate as last time (sha256 ${up.certSha.slice(0, 16)}…)`
        : `certificate sha256 ${up.certSha.slice(0, 16)}…, not the ${record.certSha ? `${record.certSha.slice(0, 16)}… recorded before` : "one recorded"}`;
  if (up.certSha !== null && record.certSha !== up.certSha)
    writeFileSync(
      slotRecord(root, slot),
      `${JSON.stringify({ ...record, certSha: up.certSha }, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
  if (!up.funnel)
    return {
      error: `${up.dnsName} has no \`funnel\` node attribute: the tailnet policy's nodeAttrs must give it "funnel"`,
    };
  const guest = (script, input) =>
    spawnSync("ssh", ["-o", "BatchMode=yes", ...sshArgs, script], {
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
  const funnel = runPhase("tailnet-funnel", []);
  if (funnel.code !== 0) return { error: `the copy's Funnel: ${lastLine(funnel.out)}` };
  const sessionUrl = `https://${up.dnsName}:${FUNNEL_PORTS.session}`;
  const blobUrl = `https://${up.dnsName}:${FUNNEL_PORTS.blob}`;
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
    .filter((line) => /Boat VMs reach this server/.test(line) && /answered/.test(line));
  const put = spawnSync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      ...sshArgs,
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
  // Setup probes the two addresses once, often before Funnel answers on a name just brought up (and
  // Mend publishes the session endpoint only once setup turns Boat on): the copy is ready when it does.
  const answering = runPhase("tailnet-wait", [up.dnsName]);
  if (answering.code !== 0) return { error: lastLine(answering.out) };
  return {
    sessionUrl,
    blobUrl,
    answered,
    answeredAfter: lastLine(answering.out).replace(/^vm-provision: /, ""),
    deployment,
    dnsName: up.dnsName,
    certSeen,
  };
};

/** Public resolvers: this machine's own resolver answers a tailnet name with its tailnet address. */
const PUBLIC_DNS = ["1.1.1.1", "8.8.8.8"];

/**
 * Whether the copy's Funnel answers from outside the tailnet (SLNT-1228), as a Boat VM reaches it:
 * the name's public A records (Tailscale's Funnel relays), and each Funnel port asked through a relay
 * address with the name as SNI. The check inside the copy (tailnet-wait) resolves the name to its
 * tailnet address and never goes through Funnel, so it passed on 20 Nov while every relay took the
 * TCP connection and then hung the TLS handshake. Any HTTP status counts as an answer. Asks again
 * every 3 s until `timeoutMs`; resolves { ok, detail }.
 */
export const funnelFromOutside = async (
  dnsName,
  { timeoutMs = 90_000, probe = curlThrough, resolve = publicA } = {},
) => {
  const started = Date.now();
  const answered = {};
  const last = {};
  let addresses = [];
  while (true) {
    try {
      addresses = await resolve(dnsName);
    } catch (error) {
      last.dns = `no public A record (${error.code ?? error.message})`;
    }
    for (const port of Object.values(FUNNEL_PORTS)) {
      if (answered[port]) continue;
      for (const address of addresses) {
        const code = probe(dnsName, port, address);
        last[port] = `${address}: ${code === "000" ? "no HTTP answer in 5 s" : code}`;
        if (/^[1-5]\d\d$/.test(code)) {
          answered[port] = `${port} answered ${code} through ${address}`;
          break;
        }
      }
    }
    const after = Math.round((Date.now() - started) / 1000);
    if (Object.values(FUNNEL_PORTS).every((port) => answered[port]))
      return {
        ok: true,
        detail: `from outside the tailnet: ${Object.values(answered).join(", ")} after ${after}s`,
      };
    if (Date.now() - started >= timeoutMs) {
      const ports = Object.values(FUNNEL_PORTS).map(
        (port) => answered[port] ?? `${port} last ${last[port] ?? last.dns ?? "not asked"}`,
      );
      const records = addresses.length > 0 ? ` (public A records ${addresses.join(", ")})` : "";
      return {
        ok: false,
        detail: `the copy's Funnel did not answer from outside the tailnet in ${after}s: ${ports.join(", ")}${records}. The tailnet sees it, Boat VMs would not: take another copy (vm down, then vm up --boat)`,
      };
    }
    await new Promise((done) => setTimeout(done, 3000));
  }
};

const publicA = (name) => {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  resolver.setServers(PUBLIC_DNS);
  return resolver.resolve4(name);
};

/** One HTTPS request to `name:port` through `address`, with the name as SNI: its status, or 000. */
const curlThrough = (name, port, address) =>
  (
    spawnSync(
      "curl",
      [
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "-m",
        "5",
        "--resolve",
        `${name}:${port}:${address}`,
        `https://${name}:${port}/`,
      ],
      { encoding: "utf8" },
    ).stdout ?? ""
  ).trim() || "000";

/**
 * Before a Boat copy goes: stops the Boat sessions started on it (by the checker accounts whose CLI
 * kits are here), then waits until sealant on the copy has every VM it launched deleted or seen gone.
 * Nothing else would ever remove them: the box knows none of the copy's runs. Returns the VMs left.
 */
export const stopBoatSessions = async (root, sshArgs, url, since) => {
  const cli = join(root, "cli/node_modules/.bin/mend");
  for (const kit of ["mend-boat-check", "mend-boat-check-2"]) {
    const config = join(homedir(), ".local/share", kit, "cli");
    if (!existsSync(config) || !existsSync(cli)) continue;
    const env = { ...process.env, XDG_CONFIG_HOME: config, MEND_URL: url };
    let sessions = [];
    try {
      sessions = JSON.parse(
        spawnSync(cli, ["sessions", "--all", "--json"], { env, encoding: "utf8" }).stdout,
      ).data.sessions;
    } catch {
      continue;
    }
    for (const session of sessions)
      if (
        session.boatKey &&
        Date.parse(session.createdAt) >= Date.parse(since) &&
        !["stopped", "completed", "failed", "exited"].includes(session.status)
      )
        spawnSync(cli, ["stop", session.id], { env, timeout: 120_000, stdio: "ignore" });
  }
  const live = () =>
    sshRunner(sshArgs)(
      `docker exec mend-postgres-1 psql -U postgres -d sealant_control_plane -At -c "select coalesce(string_agg(sandbox_id, ' '), '') from boat_runs where sandbox_id is not null and deletion_completed_at is null and absent_at is null and create_issued_at >= '${since}'"`,
    ).stdout.trim();
  let left = live();
  for (let i = 0; i < 40 && left !== ""; i++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    left = live();
  }
  return left === "" ? [] : left.split(" ");
};
