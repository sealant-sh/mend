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
 * and the Boat build journals the master was built with (`vm build` copies in the saved ones) put into
 * the copy's Boat state volume. Why the shared name is safe, and why the resource gateway stays off:
 * docs/operations/preview-builds.md, "Check VMs".
 */
/**
 * The setup flag that keeps a Boat copy from removing Boat images (SLNT-1347). Every copy shares one
 * Boat deployment and starts from the same saved data, so an image one copy's hourly retention
 * removes is gone for all of them, and only that copy's database, thrown away with it, records it:
 * the saved data still reads it ready. Only the copy `vm save` saves (`vm up --will-save`, the daily
 * run's lane A) keeps sealant's retention, since its save then records each removal.
 */
export const NO_IMAGE_RETENTION = "--no-boat-image-retention";

/**
 * What a copy's setup said when its CLI predates NO_IMAGE_RETENTION: the CLI's own parser
 * (`mend: unknown flag --no-boat-image-retention · usage: …`, the 25 Nov master's), or setup's.
 */
const unknownRetentionFlag = (out) =>
  out.includes(`unknown flag ${NO_IMAGE_RETENTION}`) ||
  out.includes(`Unknown server setup option "${NO_IMAGE_RETENTION}"`);

/**
 * `mend server setup` with Boat on a copy, and what it decided about Boat image retention: off
 * unless `removesImages`, and on, said so, when the copy's CLI has no NO_IMAGE_RETENTION (a master
 * built before it): that CLI refuses the flag before it changes anything, so setup runs once more
 * without it.
 */
export const setupBoat = (setupWith, removesImages) => {
  if (removesImages)
    return {
      out: setupWith([]),
      removesImages: true,
      retention: "removes Boat images (--will-save: its save records each removal)",
    };
  const off = setupWith([NO_IMAGE_RETENTION]);
  if (!unknownRetentionFlag(off.stdout ?? ""))
    return { out: off, removesImages: false, retention: "removes no Boat image" };
  return {
    out: setupWith([]),
    removesImages: true,
    retention: `REMOVES Boat images: this master's CLI has no ${NO_IMAGE_RETENTION}, so a copy may delete what the saved data records (a master built after SLNT-1347 has it)`,
  };
};

export const boatOn = (root, sshArgs, runPhase, slot, dir, { removesImages = false } = {}) => {
  const box = join(root, "box");
  const key = join(box, "boat.key");
  if (!existsSync(key))
    return { error: `no ${key}: pnpm verify vm build --from-box copies it from VM 131` };
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
  const setup = setupBoat(
    (extra) =>
      guest(
        [
          "mend server setup --offline --session-runtimes docker,boat --session-runtime boat",
          `--session-endpoint-url ${sessionUrl} --blob-store-public-url ${blobUrl}`,
          `--boat-deployment-id ${deployment} --no-boat-resources`,
          ...extra,
          "--boat-api-key-stdin 2>&1",
        ].join(" "),
        readFileSync(key, "utf8").trim(),
      ),
    removesImages,
  );
  const out = setup.out;
  writeFileSync(join(dir, "boat-setup.log"), `${out.stdout ?? ""}`, { mode: 0o600 });
  if (out.status !== 0)
    return { error: `mend server setup with Boat: ${lastLine(out.stdout ?? "")}` };
  const answered = (out.stdout ?? "")
    .split("\n")
    .filter((line) => /Boat VMs reach this server/.test(line) && /answered/.test(line));
  // A master built before SLNT-1252 carries no journals: the copy gets the saved ones, which are
  // the journals of the data that master was built from only until the next `vm save`.
  const journals = join(box, "mend-boat-state.tgz");
  const carried = guest("test -s /root/main-run/mend-boat-state.tgz").status === 0;
  if (!carried) {
    if (!existsSync(journals))
      return { error: `the master carries no Boat build journals, and there is no ${journals}` };
    const put = spawnSync(
      "ssh",
      ["-o", "BatchMode=yes", ...sshArgs, "umask 077; cat > /root/main-run/mend-boat-state.tgz"],
      { input: readFileSync(journals), maxBuffer: 16 * 1024 * 1024 },
    );
    if (put.status !== 0)
      return { error: `the saved Boat build journals: ${lastLine(String(put.stderr ?? ""))}` };
  }
  const restored = runPhase("boat-journals", []);
  if (restored.code !== 0) return { error: `the Boat build journals: ${lastLine(restored.out)}` };
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
    journals: `${lastLine(restored.out).replace(/^vm-provision: /, "")}${carried ? "" : " (the saved ones: the master carries none)"}`,
    removesImages: setup.removesImages,
    retention: setup.retention,
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

/** The checker accounts whose CLI kits `vm down` stops a copy's sessions as. */
export const CHECKER_KITS = ["mend-boat-check", "mend-boat-check-2"];

/**
 * Prints one `vm=<sandbox> workspace=<id> sessions=<id>:<status>,…` line per Boat VM the copy
 * launched (`create_issued_at` from `since` on) that sealant has not seen deleted or gone, with the
 * Mend sessions on that workspace; then `checked=yes`. A copy whose databases do not answer prints
 * no `checked=yes`, so nothing is taken as gone that was not seen gone.
 */
export const liveBoatVmsScript = (since) => `# live-boat-vms
set -uo pipefail
q() { docker exec mend-postgres-1 psql -U postgres -d "$1" -At -F' ' -v ON_ERROR_STOP=1 -c "$2"; }
runs=$(q sealant_control_plane "select sandbox_id, workspace_id from boat_runs where sandbox_id is not null and deletion_completed_at is null and absent_at is null and create_issued_at >= '${since}' order by create_issued_at") || exit 1
while read -r vm ws; do
  [ -n "$vm" ] || continue
  sessions=$(q mend "select coalesce(string_agg(id || ':' || status, ',' order by created_at), '') from agent_sessions where sealant_workspace_id = '$ws'") || exit 1
  echo "vm=$vm workspace=$ws sessions=$sessions"
done <<<"$runs"
echo "checked=yes"
`;

/** Reads liveBoatVmsScript's output: the VMs left, or null when the copy could not say. */
export const parseLiveBoatVms = (stdout) => {
  const lines = stdout.split("\n");
  if (!lines.includes("checked=yes")) return null;
  return lines.flatMap((line) => {
    const match = /^vm=(\S+) workspace=(\S+) sessions=(\S*)$/.exec(line);
    if (!match) return [];
    const sessions = match[3]
      .split(",")
      .filter(Boolean)
      .map((pair) => {
        const at = pair.lastIndexOf(":");
        return { id: pair.slice(0, at), status: pair.slice(at + 1) };
      });
    return [{ vm: match[1], workspace: match[2], sessions }];
  });
};

/** `bx_1 (session 1a2b3c4d failed)`: a VM left, with what holds it in Mend. */
export const describeBoatVm = ({ vm, sessions }) =>
  sessions.length === 0
    ? `${vm} (no Mend session on its workspace)`
    : `${vm} (${sessions.map(({ id, status }) => `session ${id.slice(0, 8)} ${status}`).join(", ")})`;

/**
 * Before a Boat copy goes (SLNT-1345): stops, through the copy's own Mend, every session the
 * checker accounts have live there, then waits until sealant on the copy has seen each Boat VM the
 * copy launched deleted or gone, which it records only on Boat's answer. Nothing else would ever
 * remove them: the copy's Mend holds the only record of them, and the Boat key stays private.
 *
 * Every live session, not only the ones that read a Boat key and were made on this copy: a
 * session from the saved data resumed here, and one whose launch has not stamped its key yet, hold
 * VMs this copy launched too. A VM whose session has already ended (a failed `mend run` whose
 * workspace is kept, say) has nothing a stop reaches, so it is waited for and then named.
 *
 * Returns `{ left, stops }`: `left` the VMs still there (null when the copy could not be read, which
 * counts as not confirmed), `stops` what each stop said.
 */
export const stopBoatSessions = async (
  root,
  sshArgs,
  url,
  since,
  {
    waitMs = 300_000,
    pollMs = 5_000,
    run = spawnSync,
    ssh = sshRunner(sshArgs),
    home = homedir(),
  } = {},
) => {
  const cli = join(root, "cli/node_modules/.bin/mend");
  const stops = [];
  for (const kit of CHECKER_KITS) {
    const config = join(home, ".local/share", kit, "cli");
    if (!existsSync(config)) continue;
    if (!existsSync(cli)) {
      stops.push(`${kit}: no CLI at ${cli}, so nothing was stopped`);
      continue;
    }
    const env = { ...process.env, XDG_CONFIG_HOME: config, MEND_URL: url };
    const stopped = run(cli, ["stop", "--all"], { env, encoding: "utf8", timeout: 300_000 });
    const said = `${stopped.stdout ?? ""}${stopped.stderr ?? ""}`.trim().split("\n").at(-1) ?? "";
    stops.push(
      `${kit}: ${stopped.status === 0 ? said || "stopped" : `exit ${stopped.status}: ${said}`}`,
    );
  }
  const read = () => parseLiveBoatVms(ssh(liveBoatVmsScript(since)).stdout ?? "");
  const until = Date.now() + waitMs;
  let left = read();
  while ((left === null || left.length > 0) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    left = read();
  }
  return { left, stops };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SNAPSHOT_NAME = /"identity":\s*\{\s*"name":\s*"([a-z0-9-]{1,63})"/;

/**
 * The Boat images a pg_dumpall names (SLNT-1256): each row of sealant's `native_publications`, as
 * `id → { state, name }`, `name` its saved snapshot's or null when it has none. Read with awk, so a
 * dump of hundreds of MiB is never held in memory, and nothing of it is printed. Null when the file
 * or its table cannot be read: nothing is then taken as unsaved that was not read.
 */
export const dumpImages = (file, run = spawnSync) => {
  if (!existsSync(file)) return null;
  const out = run(
    "awk",
    [
      '/^COPY public\\.native_publications /{f=1; print; next} f && /^\\\\\\.$/{print "end=yes"; exit} f{print}',
      file,
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 ** 2 },
  );
  const lines = (out.stdout ?? "").split("\n");
  if (out.status !== 0 || !lines.includes("end=yes")) return null;
  const columns = /^COPY public\.native_publications \((.*)\) FROM stdin;$/
    .exec(lines[0] ?? "")?.[1]
    ?.split(", ");
  const at = (name) => columns?.indexOf(name) ?? -1;
  const [id, state, publication] = [at("id"), at("state"), at("publication")];
  if (id < 0 || state < 0 || publication < 0) return null;
  const images = new Map();
  for (const line of lines.slice(1)) {
    if (line === "end=yes") break;
    const fields = line.split("\t");
    if (!UUID.test(fields[id] ?? "")) return null;
    images.set(fields[id], {
      state: fields[state],
      name: SNAPSHOT_NAME.exec(fields[publication] ?? "")?.[1] ?? null,
    });
  }
  return images;
};

/** The images a dump names that hold a saved snapshot in Boat still, by sealant's own record. */
export const liveImagesOf = (images) =>
  [...images].filter(([, { state, name }]) => name !== null && state !== "removed");

/**
 * Prints one `image=<id> state=<state> reason=<reason> name=<snapshot>` line per Boat image the
 * copy's sealant records that may hold something in Boat (every state but removed and superseded,
 * and not a failed build, which saved nothing), then `mend=<true|false>` and `checked=yes`. A copy
 * whose database does not answer prints no `checked=yes`.
 */
export const boatImagesScript = `# boat-images
set -uo pipefail
docker exec mend-postgres-1 psql -U postgres -d sealant_control_plane -At -F' ' -v ON_ERROR_STOP=1 -c \\
  "select 'image=' || id, 'state=' || state, 'reason=' || coalesce(reason, '-'), 'name=' || coalesce(publication->'snapshot'->'identity'->>'name', '-') from native_publications where state not in ('removed', 'superseded') and not (state = 'quarantined' and publication is null) order by created_at" || exit 1
echo "mend=$(docker inspect -f '{{.State.Running}}' mend-mend-1 2>/dev/null || echo false)"
echo "checked=yes"
`;

/** Reads boatImagesScript's output: `{ images, mend }`, or null when the copy could not say. */
export const parseBoatImages = (stdout) => {
  const lines = stdout.split("\n");
  if (!lines.includes("checked=yes")) return null;
  const images = lines.flatMap((line) => {
    const match = /^image=(\S+) state=(\S+) reason=(\S+) name=(\S+)$/.exec(line);
    if (!match || !UUID.test(match[1])) return [];
    return [
      {
        id: match[1],
        state: match[2],
        reason: match[3] === "-" ? null : match[3],
        name: match[4] === "-" ? null : match[4],
      },
    ];
  });
  return { images, mend: lines.includes("mend=true") };
};

/**
 * Asks sealant on the copy to remove each image: the transition sealant's own withdrawal makes
 * (`NativePublicationRepo.withdraw`), with its guards: a ready image, no claim held, and no run
 * still holding it. sealant's catalog sweep (every 30 s) then deletes the saved snapshot through
 * the image's build journal and records it `removed` once Boat no longer has it.
 */
export const retireImagesScript = (ids) => `# retire-images
set -uo pipefail
docker exec mend-postgres-1 psql -U postgres -d sealant_control_plane -At -v ON_ERROR_STOP=1 -c \\
  "update native_publications p set state = 'retiring', generation = p.generation + 1, claim_token = null, claim_purpose = null, claim_until = null where p.id in (${ids.map((id) => `'${id}'`).join(", ")}) and p.state = 'ready' and (p.claim_until is null or p.claim_until <= now()) and not exists (select 1 from native_publication_consumers c where c.publication_id = p.id and c.state <> 'released') returning p.id"
`;

/** States sealant on the copy can still bring to removed: a build ending, or a removal under way. */
const REMOVABLE = new Set(["reserved", "building", "ready", "retiring"]);
const removable = ({ state, reason }) =>
  REMOVABLE.has(state) || (state === "quarantined" && reason === "native-removal-pending");

/** `sealant-dev-boat-stream-… (ready)`: an image, by its snapshot name or its id. */
export const describeBoatImage = ({ id, state, reason, name }) =>
  `${name ?? `publication ${id.slice(0, 8)}`} (${state}${reason === null ? "" : ` ${reason}`})`;

/**
 * Before a Boat copy goes (SLNT-1256): removes from Boat, through sealant on the copy, every image
 * the copy holds that the saved data (`<root>/box/world.sql`) does not. Each saved snapshot is in the
 * owner's Boat account, every copy's in the same one, and once the copy goes its journal goes with
 * it: nothing could remove it after. An image the saved data names, in any state, is left alone: a
 * saved copy (the daily run's lane A) keeps every image its save recorded, and a removal never
 * reaches an image another copy of the same data may use.
 *
 * Waits until sealant records each one removed. Returns `{ removed, left, refused }`: `removed` the
 * images it saw removed, `left` the ones sealant may still remove but has not (null when the copy
 * or the saved data could not be read, which counts as not confirmed), `refused` the ones sealant
 * will not remove (quarantined with a saved snapshot, such as one whose identity Boat changed:
 * only the Boat account's owner can delete those).
 */
export const removeBoatImages = async (
  root,
  sshArgs,
  {
    waitMs = 300_000,
    pollMs = 10_000,
    ssh = sshRunner(sshArgs),
    saved = () => dumpImages(join(root, "box", "world.sql")),
  } = {},
) => {
  const keep = saved();
  if (keep === null)
    return {
      removed: [],
      left: null,
      refused: [],
      why: "the saved data's images could not be read",
    };
  const read = () => {
    const answer = parseBoatImages(ssh(boatImagesScript).stdout ?? "");
    if (answer === null) return null;
    return { ...answer, images: answer.images.filter(({ id }) => !keep.has(id)) };
  };
  let now = read();
  if (now === null)
    return { removed: [], left: null, refused: [], why: "its database did not answer" };
  const first = now.images;
  const settle = () => ({
    removed: first.filter(({ id }) => !now.images.some((image) => image.id === id)),
    left: now.images.filter(removable),
    refused: now.images.filter((image) => !removable(image)),
  });
  if (!first.some(removable)) return settle();
  if (!now.mend) return { ...settle(), why: "Mend is stopped on it, so sealant removes nothing" };
  const until = Date.now() + waitMs;
  for (;;) {
    const ready = now.images.filter(({ state }) => state === "ready").map(({ id }) => id);
    if (ready.length > 0) ssh(retireImagesScript(ready));
    if (Date.now() >= until) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const next = read();
    if (next === null) return { ...settle(), left: null, why: "its database stopped answering" };
    now = next;
    if (!now.images.some(removable)) break;
  }
  return settle();
};
