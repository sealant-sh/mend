import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Option, Schema } from "effect";

import { type ServerProcessOptions, serverProcessDeadlines } from "./server-runtime.ts";

/**
 * Native Apple Silicon macOS `host-vm` support (`mac-vmd`, Apple `Virtualization.framework`).
 *
 * Each Mend installation on macOS gets its own per-install LaunchAgent (`sh.sealant.vmd.<installId>`),
 * bearer token (`<configDir>/vmd-token`), loopback port, and APFS disk directories
 * (`~/Library/Application Support/Mend/vm/<installId>/{images,data}`), so side-by-side Docker
 * Desktop and OrbStack installs never collide. `AbandonProcessGroup: true` plus direct TCP FD
 * handoff keeps live `sealant-vz-worker` VMs running across `sealant-vmd` upgrades and restarts.
 */

export const MAC_VMD_HOST = "host.docker.internal";
export const MAC_VMD_DEFAULT_PORT = 7422;
export const MAC_VMD_NETWORK = "mend-vmd-link";
export const MAC_VMD_TOKEN_NAME = "vmd-token";
export const MAC_VMD_TOKEN_TARGET = "/run/sealant-vmd/token";
export const MAC_VMD_DATA_SENTINEL = ".mend-vm-data";
/** macOS 14 Sonoma (Darwin 23.x) is the minimum supported macOS floor for Apple VZ. */
export const MAC_MIN_DARWIN_MAJOR = 23;

/**
 * Pinned macOS helper bundle built by `sealant-sh/sealantd`'s `macos-15` release workflow.
 * `MEND_MAC_VMD_BUNDLE` overrides this with a local `.tar.gz` path for offline / development runs.
 */
export const MAC_VMD_RELEASE_VERSION = "0.21.0-next.218";
export const MAC_VMD_ASSET_URL = `https://github.com/sealant-sh/sealantd/releases/download/v${MAC_VMD_RELEASE_VERSION}/sealant-vmd-darwin-arm64.tar.gz`;
/** Empty until the first signed GitHub release asset digest is pinned; required for remote downloads. */
export const MAC_VMD_SHA256: string = "";

/** Per-install macOS `host-vm` settings persisted in `server.json`. */
export interface ServerMacHostVm {
  readonly installId: string;
  readonly port: number;
  readonly imagesHostPath: string;
  readonly dataHostPath: string;
  readonly tokenHostPath: string;
  readonly network: string;
}

const ServerMacHostVmSchema = Schema.Struct({
  installId: Schema.String,
  port: Schema.Number,
  imagesHostPath: Schema.String,
  dataHostPath: Schema.String,
  tokenHostPath: Schema.String,
  network: Schema.String,
});

const decodeMacHostVm = Schema.decodeUnknownOption(ServerMacHostVmSchema);

/** Parse a saved `server.json` `macHostVm` object; null when invalid. */
export const parseMacHostVmField = (value: unknown): ServerMacHostVm | null => {
  const decoded = decodeMacHostVm(value);
  if (Option.isNone(decoded)) return null;
  const candidate = decoded.value;
  if (
    !/^[a-z0-9]{6,32}$/.test(candidate.installId) ||
    !Number.isInteger(candidate.port) ||
    candidate.port < 1 ||
    candidate.port > 65535 ||
    !candidate.imagesHostPath.startsWith("/") ||
    !candidate.dataHostPath.startsWith("/") ||
    !candidate.tokenHostPath.startsWith("/") ||
    !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(candidate.network)
  ) {
    return null;
  }
  return candidate;
};

/** Every macOS filesystem path owned by one Mend `host-vm` installation. */
export interface MacHostVmPaths {
  readonly installId: string;
  readonly vmdRoot: string;
  readonly vmdReleasesDir: string;
  readonly vmdCurrentLink: string;
  readonly vmRoot: string;
  readonly vmInstallDir: string;
  readonly imagesDir: string;
  readonly dataDir: string;
  readonly dataSentinelPath: string;
  readonly tokenPath: string;
  readonly launchAgentLabel: string;
  readonly launchAgentPlistPath: string;
  readonly logPath: string;
}

export const macHostVmPaths = (
  homeDir: string,
  configDir: string,
  installId: string,
): MacHostVmPaths => {
  const appSupport = path.join(homeDir, "Library", "Application Support", "Mend");
  const vmdRoot = path.join(appSupport, "vmd");
  const vmRoot = path.join(appSupport, "vm");
  const vmInstallDir = path.join(vmRoot, installId);
  const dataDir = path.join(vmInstallDir, "data");
  const launchAgentLabel = `sh.sealant.vmd.${installId}`;
  return {
    installId,
    vmdRoot,
    vmdReleasesDir: path.join(vmdRoot, "releases"),
    vmdCurrentLink: path.join(vmdRoot, "current"),
    vmRoot,
    vmInstallDir,
    imagesDir: path.join(vmInstallDir, "images"),
    dataDir,
    dataSentinelPath: path.join(dataDir, MAC_VMD_DATA_SENTINEL),
    tokenPath: path.join(configDir, MAC_VMD_TOKEN_NAME),
    launchAgentLabel,
    launchAgentPlistPath: path.join(
      homeDir,
      "Library",
      "LaunchAgents",
      `${launchAgentLabel}.plist`,
    ),
    logPath: path.join(homeDir, "Library", "Logs", "Mend", `sealant-vmd-${installId}.log`),
  };
};

/** Quote a string safely for YAML double-quoted scalar values. */
const yamlQuote = (value: string): string => JSON.stringify(value);

/**
 * `compose.host-vm.yaml` on Apple Silicon macOS: keeps `mend-store` and `mend-control` on Docker
 * named volumes, bind-mounts APFS VM disk directories + read-only `vmd-token`, wires
 * `SEALANT_HOST_VM_BACKEND=mac-vmd`, and creates `mend-vmd-link` with `enable_icc=false`.
 */
export const renderMacHostVmOverlay = (mac: ServerMacHostVm): string =>
  [
    "# Written by mend server setup (Apple Silicon macOS): runs host-vm workspaces on native Apple",
    "# Virtualization.framework via the per-install sealant-vmd LaunchAgent while keeping every",
    "# workspace behind its unchanged <name>-proxy.",
    "services:",
    "  mend:",
    "    environment:",
    '      SEALANT_HOST_VM_BACKEND: "mac-vmd"',
    "      SEALANT_HOST_VM_IMAGE_DIR: /var/lib/mend/vm-images",
    "      SEALANT_HOST_VM_DATA_DIR: /var/lib/mend/vm-data",
    `      SEALANT_HOST_VM_IMAGE_HOST_PATH: ${yamlQuote(mac.imagesHostPath)}`,
    `      SEALANT_HOST_VM_DATA_HOST_PATH: ${yamlQuote(mac.dataHostPath)}`,
    `      SEALANT_MAC_VMD_HOST: ${yamlQuote(MAC_VMD_HOST)}`,
    `      SEALANT_MAC_VMD_PORT: ${yamlQuote(String(mac.port))}`,
    `      SEALANT_MAC_VMD_TOKEN_FILE: ${yamlQuote(MAC_VMD_TOKEN_TARGET)}`,
    `      SEALANT_MAC_VMD_TOKEN_HOST_PATH: ${yamlQuote(mac.tokenHostPath)}`,
    `      SEALANT_MAC_VMD_NETWORK: ${yamlQuote(mac.network)}`,
    "    volumes:",
    `      - ${yamlQuote(`${mac.imagesHostPath}:/var/lib/mend/vm-images`)}`,
    `      - ${yamlQuote(`${mac.dataHostPath}:/var/lib/mend/vm-data`)}`,
    `      - ${yamlQuote(`${mac.tokenHostPath}:${MAC_VMD_TOKEN_TARGET}:ro`)}`,
    "    networks:",
    "      - default",
    "      - mend-vmd-link",
    "",
    "networks:",
    "  mend-vmd-link:",
    `    name: ${yamlQuote(mac.network)}`,
    "    driver: bridge",
    "    driver_opts:",
    '      com.docker.network.bridge.enable_icc: "false"',
    "",
  ].join("\n");

const xmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

/**
 * Render the user LaunchAgent plist for `sh.sealant.vmd.<installId>`.
 * `AbandonProcessGroup` is mandatory so restarting or upgrading `sealant-vmd` never kills live
 * `sealant-vz-worker` processes (which also call `setsid()` and hold direct TCP FDs to runners).
 */
export const renderMacVmdLaunchAgentPlist = (paths: MacHostVmPaths, port: number): string => {
  const args = [
    path.join(paths.vmdCurrentLink, "sealant-vmd"),
    "--listen",
    `127.0.0.1:${port}`,
    "--token-file",
    paths.tokenPath,
    "--images-dir",
    paths.imagesDir,
    "--data-dir",
    paths.dataDir,
    "--vz-worker",
    path.join(paths.vmdCurrentLink, "sealant-vz-worker"),
    "--kernel",
    path.join(paths.vmdCurrentLink, "Image"),
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(paths.launchAgentLabel)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...args.map((arg) => `    <string>${xmlEscape(arg)}</string>`),
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Interactive</string>",
    "  <key>AbandonProcessGroup</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(paths.logPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(paths.logPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
};

const MacVmdHealthSchema = Schema.Struct({
  protocolVersion: Schema.Number,
  version: Schema.String,
  instanceNonce: Schema.String,
  hostIps: Schema.Struct({
    ipv4: Schema.Array(Schema.String),
    ipv6: Schema.Array(Schema.String),
  }),
  memoryBytes: Schema.Number,
  availableMemoryBytes: Schema.Number,
  memoryPressure: Schema.Literals(["normal", "warning", "critical"]),
  diskAvailableImportantBytes: Schema.Number,
  workersRunning: Schema.Number,
});

export type MacVmdHealth = typeof MacVmdHealthSchema.Type;

const decodeMacVmdHealth = Schema.decodeUnknownOption(Schema.fromJsonString(MacVmdHealthSchema));

export const parseMacVmdHealth = (body: string): MacVmdHealth | null => {
  const decoded = decodeMacVmdHealth(body);
  return Option.isSome(decoded) ? decoded.value : null;
};

interface MacProbeOutput {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

interface MacFetchOutput {
  readonly status: number;
  readonly body: string;
  readonly error?: string;
}

export interface MacHostVmRuntime {
  readonly platform: NodeJS.Platform;
  readonly arch?: string;
  readonly osRelease?: string;
  readonly homeDir?: string;
  readonly configDir: string;
  readonly uid?: number;
  readonly macVmdBundlePath?: string;
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    options?: ServerProcessOptions,
  ) => Promise<MacProbeOutput>;
  fetchText(
    url: string,
    timeoutMs: number,
    headers?: Readonly<Record<string, string>>,
  ): Promise<MacFetchOutput>;
  randomBytes(size: number): Buffer;
  sleep(milliseconds: number): Promise<void>;
  readonly portTaken?: (port: number, address?: string) => Promise<boolean>;
  readonly writeLine: (line: string) => void;
}

const detailOf = (output: MacProbeOutput): string =>
  (output.stderr.trim() || output.error || `exit ${output.status ?? "unknown"}`).replace(
    /\s+/g,
    " ",
  );

/** Parse Darwin major release from `os.release()` (e.g. `23.6.0` -> `23`). */
export const darwinMajor = (release: string): number | null => {
  const match = /^(\d+)\./.exec(release.trim());
  return match?.[1] === undefined ? null : Number(match[1]);
};

const guiDomain = (runtime: MacHostVmRuntime): string => {
  const uid = runtime.uid ?? process.getuid?.() ?? 501;
  return `gui/${uid}`;
};

/**
 * Fast, read-only host eligibility check for Apple Silicon macOS `host-vm`:
 * arm64 CPU, macOS >= 14 (Darwin 23), local Docker context (`unix://`), and active `gui/<uid>`
 * launchd session. Returns null when eligible, else the exact observed refusal reason.
 */
export const macHostEligibilityFailure = async (
  runtime: MacHostVmRuntime,
  endpoint: string,
): Promise<string | null> => {
  if (runtime.platform !== "darwin") return "not macOS";
  const arch = runtime.arch ?? process.arch;
  if (arch !== "arm64") {
    return `Apple Silicon (arm64) is required for native macOS host-vm (this Mac is ${arch})`;
  }
  const release = runtime.osRelease ?? os.release();
  const major = darwinMajor(release);
  if (major === null || major < MAC_MIN_DARWIN_MAJOR) {
    return `macOS 14 (Darwin ${MAC_MIN_DARWIN_MAJOR}) or later is required for Virtualization.framework (observed Darwin ${release})`;
  }
  if (!endpoint.startsWith("unix://")) {
    return `macOS host-vm requires a local Docker context (OrbStack or Docker Desktop), not ${endpoint}`;
  }
  const domain = guiDomain(runtime);
  const printed = await runtime.run("launchctl", ["print", domain]);
  if (printed.status !== 0) {
    return `macOS user LaunchAgent domain ${domain} is not active (${detailOf(printed)}); run mend server setup from a logged-in macOS session`;
  }
  return null;
};

/** Verify that a `vmd/releases/<version>` directory holds all three required artifacts. */
const hasVmdArtifacts = (dir: string): boolean =>
  ["sealant-vmd", "sealant-vz-worker", "Image"].every((name) =>
    fs.existsSync(path.join(dir, name)),
  );

const sha256File = (filePath: string): string =>
  createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

/**
 * Install or verify the pinned `sealant-vmd` helper bundle under
 * `~/Library/Application Support/Mend/vmd/releases/<version>` and atomically flip `current`.
 */
export const ensureMacVmdBundle = async (
  runtime: MacHostVmRuntime,
  paths: MacHostVmPaths,
  options: { readonly offline: boolean; readonly version?: string },
): Promise<{ readonly changed: boolean; readonly releaseDir: string }> => {
  const version = options.version ?? MAC_VMD_RELEASE_VERSION;
  const releaseDir = path.join(paths.vmdReleasesDir, version);
  const localOverride = runtime.macVmdBundlePath;
  if (localOverride === undefined && hasVmdArtifacts(releaseDir)) {
    const currentTarget = (() => {
      try {
        return fs.readlinkSync(paths.vmdCurrentLink);
      } catch {
        return null;
      }
    })();
    if (currentTarget === releaseDir) return { changed: false, releaseDir };
  }

  fs.mkdirSync(paths.vmdReleasesDir, { recursive: true, mode: 0o700 });
  let tarballPath: string;
  let tempDownload: string | undefined;
  if (localOverride !== undefined) {
    if (!fs.existsSync(localOverride)) {
      throw new Error(`MEND_MAC_VMD_BUNDLE does not exist: ${localOverride}`);
    }
    tarballPath = localOverride;
  } else {
    if (options.offline) {
      throw new Error(
        `macOS host-vm helper (${version}) is not installed at ${releaseDir}, and --offline refuses downloads.`,
      );
    }
    if (MAC_VMD_SHA256 === "") {
      throw new Error(
        `No pinned SHA-256 is configured yet for ${MAC_VMD_ASSET_URL}. Set MEND_MAC_VMD_BUNDLE to a local sealant-vmd-darwin-arm64.tar.gz bundle built from sealantd.`,
      );
    }
    tempDownload = path.join(
      paths.vmdReleasesDir,
      `.download-${runtime.randomBytes(6).toString("hex")}.tar.gz`,
    );
    const fetched = await runtime.run(
      "curl",
      ["-fsSL", "--retry", "3", "-o", tempDownload, MAC_VMD_ASSET_URL],
      { timeoutMs: serverProcessDeadlines.pull },
    );
    if (fetched.status !== 0) {
      fs.rmSync(tempDownload, { force: true });
      throw new Error(`Failed to download ${MAC_VMD_ASSET_URL}: ${detailOf(fetched)}`);
    }
    const actualSha = sha256File(tempDownload);
    if (actualSha !== MAC_VMD_SHA256) {
      fs.rmSync(tempDownload, { force: true });
      throw new Error(
        `SHA-256 mismatch for ${MAC_VMD_ASSET_URL}: expected ${MAC_VMD_SHA256}, got ${actualSha}`,
      );
    }
    tarballPath = tempDownload;
  }

  const stageDir = path.join(
    paths.vmdReleasesDir,
    `.stage-${runtime.randomBytes(6).toString("hex")}`,
  );
  fs.mkdirSync(stageDir, { recursive: true, mode: 0o700 });
  try {
    const extracted = await runtime.run("tar", ["-xzf", tarballPath, "-C", stageDir]);
    if (extracted.status !== 0) {
      throw new Error(`Failed to unpack ${tarballPath}: ${detailOf(extracted)}`);
    }
    if (!hasVmdArtifacts(stageDir)) {
      throw new Error(
        `Unpacked macOS host-vm bundle is missing sealant-vmd, sealant-vz-worker, or Image.`,
      );
    }
    fs.rmSync(releaseDir, { recursive: true, force: true });
    fs.renameSync(stageDir, releaseDir);
    const nextLink = `${paths.vmdCurrentLink}.tmp-${runtime.randomBytes(4).toString("hex")}`;
    fs.symlinkSync(releaseDir, nextLink);
    fs.renameSync(nextLink, paths.vmdCurrentLink);
    return { changed: true, releaseDir };
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
    if (tempDownload !== undefined) fs.rmSync(tempDownload, { force: true });
  }
};

/** Ensure the per-install `vmd-token` (0600) exists at `<configDir>/vmd-token` and return it. */
export const ensureMacVmdToken = (runtime: MacHostVmRuntime, tokenPath: string): string => {
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
  }
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  const token = runtime.randomBytes(32).toString("hex");
  const tmp = `${tokenPath}.tmp-${runtime.randomBytes(6).toString("hex")}`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${token}\n`, "utf8");
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, tokenPath);
  return token;
};

/** Choose a free loopback port on `127.0.0.1`, preferring `preferred` when given. */
const chooseMacVmdPort = async (
  runtime: MacHostVmRuntime,
  preferred: number | undefined,
): Promise<number> => {
  if (preferred !== undefined) return preferred;
  if (runtime.portTaken === undefined) return MAC_VMD_DEFAULT_PORT;
  for (let port = MAC_VMD_DEFAULT_PORT; port < MAC_VMD_DEFAULT_PORT + 64; port += 1) {
    if (!(await runtime.portTaken(port, "127.0.0.1"))) return port;
  }
  throw new Error(
    `Could not find a free loopback port for sealant-vmd in ${MAC_VMD_DEFAULT_PORT}..${MAC_VMD_DEFAULT_PORT + 63}.`,
  );
};

const fetchMacVmdHealth = async (
  runtime: MacHostVmRuntime,
  port: number,
  token: string,
): Promise<MacVmdHealth | null> => {
  const res = await runtime.fetchText(`http://127.0.0.1:${port}/v1/health`, 2_000, {
    Authorization: `Bearer ${token}`,
  });
  if (res.error !== undefined || res.status !== 200) return null;
  return parseMacVmdHealth(res.body);
};

const SelfTestReport = Schema.Struct({
  version: Schema.Literal(1),
  ok: Schema.Boolean,
  checks: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      ok: Schema.Boolean,
      observed: Schema.String,
    }),
  ),
});

const decodeSelfTest = Schema.decodeUnknownOption(Schema.fromJsonString(SelfTestReport));

/**
 * Full single-command macOS host-vm host preparation (called once `host-vm` is selected on macOS):
 * 1. Creates per-install APFS directories + Time Machine exclusion + `.mend-vm-data` sentinel.
 * 2. Ensures `<configDir>/vmd-token` (0600) and pinned `sealant-vmd` helper bundle.
 * 3. Installs/reconciles LaunchAgent `sh.sealant.vmd.<installId>` idempotently (`AbandonProcessGroup`).
 * 4. Verifies `GET /v1/self-test`, `host.docker.internal` + `instanceNonce` from Docker, and
 *    shared APFS read/write visibility from Docker.
 */
export const ensureMacHostVmInstalled = async (
  runtime: MacHostVmRuntime,
  options: {
    readonly installId: string;
    readonly dockerContext: string;
    readonly helperImage: string;
    readonly offline: boolean;
    readonly existing?: ServerMacHostVm | undefined;
  },
): Promise<ServerMacHostVm> => {
  const homeDir = runtime.homeDir ?? os.homedir();
  const paths = macHostVmPaths(homeDir, runtime.configDir, options.installId);

  fs.mkdirSync(paths.imagesDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(paths.launchAgentPlistPath), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.dirname(paths.logPath), { recursive: true, mode: 0o755 });

  // Exclude VM disk root from Time Machine so local snapshots never pin deleted multi-GiB blocks.
  await runtime.run("tmutil", ["addexclusion", paths.vmRoot]);

  if (!fs.existsSync(paths.dataSentinelPath)) {
    fs.writeFileSync(paths.dataSentinelPath, `${options.installId}\n`, { mode: 0o600 });
  }

  const token = ensureMacVmdToken(runtime, paths.tokenPath);
  const bundle = await ensureMacVmdBundle(runtime, paths, { offline: options.offline });
  const port = await chooseMacVmdPort(runtime, options.existing?.port);
  const desiredPlist = renderMacVmdLaunchAgentPlist(paths, port);

  const existingPlist = (() => {
    try {
      return fs.readFileSync(paths.launchAgentPlistPath, "utf8");
    } catch {
      return null;
    }
  })();

  const alreadyHealthy =
    !bundle.changed &&
    existingPlist === desiredPlist &&
    (await fetchMacVmdHealth(runtime, port, token)) !== null;

  if (!alreadyHealthy) {
    fs.writeFileSync(paths.launchAgentPlistPath, desiredPlist, { mode: 0o644 });
    const domain = guiDomain(runtime);
    const service = `${domain}/${paths.launchAgentLabel}`;
    if (existingPlist === desiredPlist) {
      const kicked = await runtime.run("launchctl", ["kickstart", "-k", service]);
      if (kicked.status !== 0) {
        await runtime.run("launchctl", ["bootout", service]);
        const booted = await runtime.run("launchctl", [
          "bootstrap",
          domain,
          paths.launchAgentPlistPath,
        ]);
        if (booted.status !== 0) {
          throw new Error(
            `Failed to start LaunchAgent ${paths.launchAgentLabel}: ${detailOf(booted)}`,
          );
        }
      }
    } else {
      await runtime.run("launchctl", ["bootout", service]);
      const booted = await runtime.run("launchctl", [
        "bootstrap",
        domain,
        paths.launchAgentPlistPath,
      ]);
      if (booted.status !== 0) {
        throw new Error(
          `Failed to load LaunchAgent ${paths.launchAgentLabel}: ${detailOf(booted)}`,
        );
      }
      runtime.writeLine(
        `Loaded LaunchAgent ${paths.launchAgentLabel} (macOS may show a one-time "Background Items Added" notification in System Settings -> General -> Login Items).`,
      );
    }
  }

  // Wait up to 5 s for sealant-vmd to answer /v1/health.
  let health: MacVmdHealth | null = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    health = await fetchMacVmdHealth(runtime, port, token);
    if (health !== null) break;
    await runtime.sleep(200);
  }
  if (health === null) {
    throw new Error(
      `sealant-vmd did not answer on 127.0.0.1:${port}/v1/health. Inspect ${paths.logPath}.`,
    );
  }

  // 1. Host self-test on macOS.
  const selfTestRes = await runtime.fetchText(`http://127.0.0.1:${port}/v1/self-test`, 5_000, {
    Authorization: `Bearer ${token}`,
  });
  const selfTest =
    selfTestRes.error === undefined ? decodeSelfTest(selfTestRes.body) : Option.none();
  if (Option.isNone(selfTest) || !selfTest.value.ok) {
    const failed = Option.isSome(selfTest)
      ? selfTest.value.checks
          .filter((check) => !check.ok)
          .map((check) => `${check.name}: ${check.observed}`)
          .join("; ")
      : (selfTestRes.error ?? `HTTP ${selfTestRes.status}`);
    throw new Error(`sealant-vmd host self-test failed: ${failed}`);
  }

  // 2. Docker -> macOS host.docker.internal reachability + instanceNonce verification.
  const reach = await runtime.run("docker", [
    "--context",
    options.dockerContext,
    "run",
    "--rm",
    "-e",
    `VMD_TOKEN=${token}`,
    "--entrypoint",
    "sh",
    options.helperImage,
    "-c",
    `wget -q -O - --header="Authorization: Bearer $VMD_TOKEN" http://${MAC_VMD_HOST}:${port}/v1/health`,
  ]);
  const dockerHealth = reach.status === 0 ? parseMacVmdHealth(reach.stdout) : null;
  if (dockerHealth === null || dockerHealth.instanceNonce !== health.instanceNonce) {
    throw new Error(
      `Docker context "${options.dockerContext}" could not reach this install's sealant-vmd at ${MAC_VMD_HOST}:${port} (${reach.status === 0 ? "instanceNonce mismatch" : detailOf(reach)}).`,
    );
  }

  // 3. Shared APFS storage sentinel probe (catches Docker Desktop File Sharing misconfiguration).
  const probeName = `.mend-apfs-probe-${runtime.randomBytes(6).toString("hex")}`;
  const probePayload = runtime.randomBytes(16).toString("hex");
  const probeHostPath = path.join(paths.dataDir, probeName);
  try {
    const writeProbe = await runtime.run("docker", [
      "--context",
      options.dockerContext,
      "run",
      "--rm",
      "--network",
      "none",
      "--mount",
      `type=bind,source=${paths.dataDir},target=/probe`,
      "--entrypoint",
      "sh",
      options.helperImage,
      "-c",
      `printf '%s' "$1" > "/probe/$2.tmp" && mv "/probe/$2.tmp" "/probe/$2"`,
      "--",
      probePayload,
      probeName,
    ]);
    if (writeProbe.status !== 0) {
      throw new Error(
        `Docker context "${options.dockerContext}" could not write to ${paths.dataDir}: ${detailOf(writeProbe)}. Add "${paths.vmRoot}" to Docker File Sharing and re-run mend server setup.`,
      );
    }
    const readBack = fs.existsSync(probeHostPath) ? fs.readFileSync(probeHostPath, "utf8") : null;
    if (readBack !== probePayload) {
      throw new Error(
        `Docker wrote ${probeName} inside ${paths.dataDir}, but macOS APFS did not observe the same bytes. Check Docker File Sharing for "${paths.vmRoot}".`,
      );
    }
  } finally {
    fs.rmSync(probeHostPath, { force: true });
    fs.rmSync(`${probeHostPath}.tmp`, { force: true });
  }

  return {
    installId: options.installId,
    port,
    imagesHostPath: paths.imagesDir,
    dataHostPath: paths.dataDir,
    tokenHostPath: paths.tokenPath,
    network: options.existing?.network ?? MAC_VMD_NETWORK,
  };
};

/**
 * Upgrade the macOS helper bundle atomically and kickstart `sh.sealant.vmd.<installId>`.
 * Running `sealant-vz-worker` VMs survive uninterrupted via `AbandonProcessGroup: true`.
 */
export const upgradeMacHostVm = async (
  runtime: MacHostVmRuntime,
  mac: ServerMacHostVm,
  offline: boolean,
): Promise<void> => {
  if (runtime.platform !== "darwin") return;
  const homeDir = runtime.homeDir ?? os.homedir();
  const paths = macHostVmPaths(homeDir, runtime.configDir, mac.installId);
  const bundle = await ensureMacVmdBundle(runtime, paths, { offline });
  if (!bundle.changed) return;
  const service = `${guiDomain(runtime)}/${paths.launchAgentLabel}`;
  const kicked = await runtime.run("launchctl", ["kickstart", "-k", service]);
  if (kicked.status !== 0) {
    runtime.writeLine(
      `Warning: updated sealant-vmd bundle, but launchctl kickstart failed (${detailOf(kicked)}).`,
    );
    return;
  }
  runtime.writeLine(
    `Updated macOS host-vm helper (${MAC_VMD_RELEASE_VERSION}) and reloaded ${paths.launchAgentLabel}; running VMs stay alive.`,
  );
};

const formatGiB = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/** Status lines for `mend server status` and `mend doctor` on a macOS `host-vm` install. */
export const observeMacVmdStatusLines = async (
  runtime: MacHostVmRuntime,
  mac: ServerMacHostVm,
): Promise<ReadonlyArray<string>> => {
  if (runtime.platform !== "darwin") return [];
  const homeDir = runtime.homeDir ?? os.homedir();
  const paths = macHostVmPaths(homeDir, runtime.configDir, mac.installId);
  const service = `${guiDomain(runtime)}/${paths.launchAgentLabel}`;
  const printed = await runtime.run("launchctl", ["print", service]);
  const disabledHint =
    printed.status !== 0 || /disabled\s*=\s*(true|1)/i.test(printed.stdout)
      ? " (check System Settings -> General -> Login Items if disabled)"
      : "";
  const token = (() => {
    try {
      return fs.readFileSync(mac.tokenHostPath, "utf8").trim();
    } catch {
      return null;
    }
  })();
  if (token === null || token === "") {
    return [
      `macOS host-vm · LaunchAgent ${paths.launchAgentLabel} · token missing at ${mac.tokenHostPath}${disabledHint}`,
    ];
  }
  const health = await fetchMacVmdHealth(runtime, mac.port, token);
  if (health === null) {
    return [
      `macOS host-vm · sealant-vmd not answering on 127.0.0.1:${mac.port} (${paths.launchAgentLabel})${disabledHint}`,
    ];
  }
  return [
    `macOS host-vm · sealant-vmd ${health.version} on 127.0.0.1:${mac.port} · ${health.workersRunning} VM${health.workersRunning === 1 ? "" : "s"} running · memory pressure ${health.memoryPressure} · APFS headroom ${formatGiB(health.diskAvailableImportantBytes)}`,
  ];
};

/**
 * Clean up per-install macOS host-vm resources during `mend uninstall --server`:
 * boots out LaunchAgent (tolerating dead/absent agent), deletes plist, `vmd-token`, log,
 * and `vm/<installId>` without touching any other installation's directory.
 */
export const removeMacHostVm = async (
  runtime: MacHostVmRuntime,
  mac: ServerMacHostVm,
): Promise<ReadonlyArray<string>> => {
  if (runtime.platform !== "darwin") return [];
  const homeDir = runtime.homeDir ?? os.homedir();
  const paths = macHostVmPaths(homeDir, runtime.configDir, mac.installId);
  const service = `${guiDomain(runtime)}/${paths.launchAgentLabel}`;
  await runtime.run("launchctl", ["bootout", service]);
  const removed: Array<string> = [];
  for (const target of [
    paths.launchAgentPlistPath,
    mac.tokenHostPath,
    paths.logPath,
    paths.vmInstallDir,
  ]) {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(target);
    }
  }
  return removed;
};
