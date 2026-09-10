import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { isIP } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const LEGACY_BLOCK_BEGIN = "# >>> mend workspace ssh (managed by `mend ssh setup`) >>>";
const LEGACY_BLOCK_END = "# <<< mend workspace ssh <<<";

/** A successful value or a caller-visible workspace SSH setup failure. */
export type WorkspaceSshResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: WorkspaceSshError };

/** A parsed or I/O failure while preparing this client's workspace SSH access. */
export class WorkspaceSshError extends Error {
  readonly _tag = "WorkspaceSshError" as const;

  /** Which setup operation failed. */
  readonly operation: "target" | "key" | "config";

  /** The underlying process or filesystem failure, when one exists. */
  override readonly cause: unknown;

  constructor(operation: "target" | "key" | "config", message: string, cause: unknown = undefined) {
    super(message, { cause });
    this.operation = operation;
    this.cause = cause;
  }
}

/** Stable client-side SSH coordinates for one configured Mend server. */
export interface WorkspaceSshTarget {
  /** Stable per-server OpenSSH alias. */
  readonly alias: string;
  /** Host reached by OpenSSH, without URL scheme or port. */
  readonly hostname: string;
  /** Published workspace SSH port reported by the server. */
  readonly port: number;
  /** Canonical configured Mend URL used to distinguish managed blocks. */
  readonly serverIdentity: string;
}

/** A public key available to register for workspace SSH. */
export interface WorkspaceSshKey {
  readonly publicKey: string;
  /** Absolute private-key path or public selector for an agent key; null for legacy unpinned config. */
  readonly identityFile: string | null;
  readonly source: "explicit" | "agent" | "existing" | "generated";
  readonly fingerprint: string;
}

/** Configuration and key-registration facts only; no connection or host-trust check is performed. */
export interface WorkspaceSshReadiness {
  readonly ready: boolean;
  readonly configReady: boolean;
  readonly keyRegistered: boolean;
}

const success = <T>(value: T): WorkspaceSshResult<T> => ({ ok: true, value });
const failure = <T>(error: WorkspaceSshError): WorkspaceSshResult<T> => ({ ok: false, error });

const stripIpv6Brackets = (hostname: string): string =>
  hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

const hashIdentity = (identity: string): string =>
  createHash("sha256").update(identity).digest("hex").slice(0, 24);

const aliasLabel = (hostname: string): string => {
  const label = hostname
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  return label === "" ? "server" : label;
};

const parseHostOverride = (raw: string): WorkspaceSshResult<string> => {
  const hostname = raw.trim();
  if (hostname === "") return failure(new WorkspaceSshError("target", "SSH hostname is empty."));
  if (hostname.includes("://") || /[\s/@]/.test(hostname)) {
    return failure(
      new WorkspaceSshError(
        "target",
        "SSH hostname must be a hostname or IP address without a scheme, path, or port.",
      ),
    );
  }
  if (/^[^:]+:\d+$/.test(hostname)) {
    return failure(
      new WorkspaceSshError(
        "target",
        "SSH hostname must not include a port; Mend uses the published gateway port.",
      ),
    );
  }
  if ((hostname.startsWith("[") || hostname.endsWith("]")) && !/^\[[^\]]+\]$/.test(hostname)) {
    return failure(new WorkspaceSshError("target", "SSH hostname contains invalid IPv6 brackets."));
  }
  const unbracketed = stripIpv6Brackets(hostname);
  if ((hostname.startsWith("[") || unbracketed.includes(":")) && isIP(unbracketed) !== 6) {
    return failure(
      new WorkspaceSshError("target", "SSH hostname contains an invalid IPv6 address."),
    );
  }
  return success(unbracketed);
};

/**
 * Parse the configured Mend URL and combine its hostname with the gateway's published SSH port.
 * An explicit hostname changes only routing; server identity and the port still come from Mend.
 */
export const parseWorkspaceSshTarget = (input: {
  readonly serverUrl: string;
  readonly publishedPort: number;
  readonly hostnameOverride?: string | null;
}): WorkspaceSshResult<WorkspaceSshTarget> => {
  let server: URL;
  try {
    server = new URL(input.serverUrl);
  } catch (cause) {
    return failure(
      new WorkspaceSshError("target", `Mend server URL is invalid: ${input.serverUrl}`, cause),
    );
  }
  if (server.protocol !== "http:" && server.protocol !== "https:") {
    return failure(new WorkspaceSshError("target", "Mend server URL must use http or https."));
  }
  if (server.hostname === "") {
    return failure(new WorkspaceSshError("target", "Mend server URL has no hostname."));
  }
  if (
    !Number.isInteger(input.publishedPort) ||
    input.publishedPort < 1 ||
    input.publishedPort > 65_535
  ) {
    return failure(new WorkspaceSshError("target", "Published workspace SSH port is invalid."));
  }

  const serverIdentity = server.toString().replace(/\/$/, "");
  const defaultHostname = stripIpv6Brackets(server.hostname);
  const override = input.hostnameOverride?.trim() ?? "";
  const parsedHostname = override === "" ? success(defaultHostname) : parseHostOverride(override);
  if (parsedHostname.ok === false) return failure(parsedHostname.error);
  return success({
    alias: `mend-ws-${aliasLabel(defaultHostname)}-${hashIdentity(serverIdentity)}`,
    hostname: parsedHostname.value,
    port: input.publishedPort,
    serverIdentity,
  });
};

const blockBegin = (alias: string): string => `# >>> mend workspace ssh ${alias} (managed) >>>`;
const blockEnd = (alias: string): string => `# <<< mend workspace ssh ${alias} <<<`;

const hasControls = (value: string): boolean => /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);

const parseIdentityPath = (value: string): WorkspaceSshResult<string> => {
  const resolved = path.resolve(
    value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value,
  );
  if (
    value === "" ||
    hasControls(value) ||
    hasControls(resolved) ||
    value.includes("${") ||
    resolved.includes("${")
  ) {
    return failure(
      new WorkspaceSshError(
        "key",
        "SSH identity path must be nonempty and contain no controls or ${…} expansion.",
      ),
    );
  }
  if (value.startsWith("~") && !value.startsWith("~/")) {
    return failure(
      new WorkspaceSshError("key", "SSH identity path supports ~/ but not ~user paths."),
    );
  }
  return success(resolved);
};

// OpenSSH token expansion runs after quote removal, so a literal percent needs doubling.
const quoteIdentityPath = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;

/** Render a scoped block with an absolute, escaped identity; reject unsafe config values. */
export const managedWorkspaceSshBlock = (
  target: WorkspaceSshTarget,
  identityFile: string | null,
): WorkspaceSshResult<string> => {
  if (
    !/^[a-z0-9-]+$/.test(target.alias) ||
    !/^[a-zA-Z0-9.:-]+$/.test(target.hostname) ||
    !Number.isInteger(target.port) ||
    target.port < 1 ||
    target.port > 65_535
  ) {
    return failure(new WorkspaceSshError("config", "SSH target contains invalid config values."));
  }
  const identity = identityFile === null ? success(null) : parseIdentityPath(identityFile);
  if (!identity.ok) return identity;
  return success(
    [
      blockBegin(target.alias),
      `Host ${target.alias}`,
      `  HostName ${target.hostname}`,
      `  Port ${target.port}`,
      `  HostKeyAlias ${target.alias}`,
      ...(identity.value === null
        ? []
        : [`  IdentityFile ${quoteIdentityPath(identity.value)}`, "  IdentitiesOnly yes"]),
      "  StrictHostKeyChecking accept-new",
      // Restore the initial all-host scope before the user's global directives or other blocks.
      "Host *",
      blockEnd(target.alias),
      "",
    ].join("\n"),
  );
};

// A leading sequence of our scoped blocks leaves unrelated hosts in the initial all-host scope.
// Allow only the directives we emit, not a nested Host/Match/Include hidden under managed markers.
const isManagedPreamble = (config: string): boolean => {
  const unmanaged = config.replace(
    /^# >>> mend workspace ssh (mend-ws-[a-z0-9-]+) \(managed\) >>>\nHost \1\n(?:  (?:HostName|Port|HostKeyAlias|IdentityFile|IdentitiesOnly|StrictHostKeyChecking) [^\n]*\n)*Host \*\n# <<< mend workspace ssh \1 <<<\n/gm,
    "",
  );
  return unmanaged.split(/\r?\n/).every((line) => /^\s*(#.*)?$/.test(line));
};

const removeManagedBlock = (
  config: string,
  beginMarker: string,
  endMarker: string,
): WorkspaceSshResult<string> => {
  const begin = config.indexOf(beginMarker);
  if (begin === -1) return success(config);
  const end = config.indexOf(endMarker, begin + beginMarker.length);
  if (end === -1) {
    return failure(
      new WorkspaceSshError(
        "config",
        `Managed SSH config block beginning with "${beginMarker}" has no closing marker.`,
      ),
    );
  }
  const after = config.slice(end + endMarker.length).replace(/^\r?\n/, "");
  const firstDirective = after.split(/\r?\n/).find((line) => !/^\s*(#.*)?$/.test(line));
  const restoresScope = /\nHost \*\r?\n$/.test(config.slice(begin, end));
  if (
    !(restoresScope && isManagedPreamble(config.slice(0, begin))) &&
    firstDirective !== undefined &&
    !/^\s*(Host|Match)\s/i.test(firstDirective)
  ) {
    return failure(
      new WorkspaceSshError(
        "config",
        "Managed SSH block has trailing scoped directives. Move them into an explicit Host or Match block before rerunning setup; Mend left the config unchanged.",
      ),
    );
  }
  if (config.indexOf(beginMarker, end + endMarker.length) !== -1) {
    return failure(
      new WorkspaceSshError(
        "config",
        "Duplicate managed SSH blocks; Mend left the config unchanged.",
      ),
    );
  }
  return success(`${config.slice(0, begin)}${after}`);
};

/**
 * Remove every block `mend ssh setup` ever wrote, current form and legacy, keeping every other
 * byte. Duplicate or unterminated blocks are refused the same way reconciliation refuses them.
 */
export const stripManagedWorkspaceSshBlocks = (
  existing: string,
): WorkspaceSshResult<{ readonly config: string; readonly removed: number }> => {
  let config = existing;
  let removed = 0;
  const aliases = [
    ...config.matchAll(/^# >>> mend workspace ssh (mend-ws-[a-z0-9-]+) \(managed\) >>>$/gm),
  ]
    .map((match) => match[1])
    .filter((alias): alias is string => alias !== undefined);
  for (const alias of new Set(aliases)) {
    const stripped = removeManagedBlock(config, blockBegin(alias), blockEnd(alias));
    if (!stripped.ok) return stripped;
    config = stripped.value;
    removed += 1;
  }
  if (config.includes(LEGACY_BLOCK_BEGIN)) {
    const stripped = removeManagedBlock(config, LEGACY_BLOCK_BEGIN, LEGACY_BLOCK_END);
    if (!stripped.ok) return stripped;
    config = stripped.value;
    removed += 1;
  }
  return success({ config, removed });
};

const containsExactHost = (config: string, alias: string): boolean =>
  config.split("\n").some((line) => {
    const match = /^\s*Host\s+(.+?)\s*$/i.exec(line);
    return match?.[1]?.split(/\s+/).includes(alias) === true;
  });

/**
 * Replace this server's managed block and migrate Mend's old global block. Retain other servers and
 * every hand-written byte. Prepending wins OpenSSH's first-match policy; Host * restores the
 * original global scope. Ambiguous legacy scopes and hand-written alias collisions are refused.
 */
export const reconcileWorkspaceSshConfig = (
  existing: string,
  target: WorkspaceSshTarget,
  identityFile: string | null,
): WorkspaceSshResult<string> => {
  const withoutCurrent = removeManagedBlock(
    existing,
    blockBegin(target.alias),
    blockEnd(target.alias),
  );
  if (!withoutCurrent.ok) return withoutCurrent;
  const withoutLegacy = removeManagedBlock(
    withoutCurrent.value,
    LEGACY_BLOCK_BEGIN,
    LEGACY_BLOCK_END,
  );
  if (!withoutLegacy.ok) return withoutLegacy;
  if (containsExactHost(withoutLegacy.value, target.alias)) {
    return failure(
      new WorkspaceSshError(
        "config",
        `SSH config already has a hand-written Host ${target.alias} block; Mend left it unchanged.`,
      ),
    );
  }
  const block = managedWorkspaceSshBlock(target, identityFile);
  if (!block.ok) return block;
  return success(`${block.value}${withoutLegacy.value}`);
};

/** SHA-256 fingerprint in the same `SHA256:…` form OpenSSH and the server report. */
export const workspaceSshPublicKeyFingerprint = (publicKey: string): WorkspaceSshResult<string> => {
  const encoded = publicKey.trim().split(/\s+/)[1];
  if (encoded === undefined || encoded === "") {
    return failure(new WorkspaceSshError("key", "SSH public key has no encoded key data."));
  }
  try {
    const digest = createHash("sha256").update(Buffer.from(encoded, "base64")).digest("base64");
    return success(`SHA256:${digest.replace(/=+$/, "")}`);
  } catch (cause) {
    return failure(
      new WorkspaceSshError("key", "SSH public key could not be fingerprinted.", cause),
    );
  }
};

const publicKeyIdentity = (publicKey: string): string =>
  publicKey.trim().split(/\s+/).slice(0, 2).join(" ");

const agentKeys = (): ReadonlyArray<string> => {
  if (!process.env["SSH_AUTH_SOCK"]) return [];
  const listed = spawnSync("ssh-add", ["-L"], {
    encoding: "utf8",
    timeout: 3_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SSH_ASKPASS_REQUIRE: "never" },
  });
  return listed.status === 0
    ? listed.stdout.split("\n").filter((line) => /^(ssh-|ecdsa-|sk-)/.test(line))
    : [];
};

const readText = (file: string): WorkspaceSshResult<string> => {
  try {
    return success(fs.readFileSync(file, "utf8"));
  } catch (cause) {
    const error = cause instanceof Error && "code" in cause ? cause.code : undefined;
    return error === "ENOENT"
      ? success("")
      : failure(new WorkspaceSshError("key", `Could not read ${file}.`, cause));
  }
};

/**
 * Read the identity file from this server's managed block. Null means the block is absent,
 * incomplete, or relies on ssh-agent.
 */
export const configuredWorkspaceSshIdentityFile = (
  config: string,
  target: WorkspaceSshTarget,
): string | null => {
  const begin = config.indexOf(blockBegin(target.alias));
  if (begin === -1) return null;
  const end = config.indexOf(blockEnd(target.alias), begin);
  if (end === -1) return null;
  const block = config.slice(begin, end);
  const match = /^\s*IdentityFile\s+(.+?)\s*$/m.exec(block);
  const value = match?.[1];
  if (value === undefined) return null;
  // Decode our quoted representation. Old unquoted blocks contained literal paths.
  if (!value.startsWith('"')) return value;
  if (!/^"(?:[^"\\]|\\["\\])*"$/.test(value)) return null;
  return value
    .slice(1, -1)
    .replace(/\\(["\\])/g, "$1")
    .replaceAll("%%", "%");
};

type WorkspaceSshKeyMaterial = Omit<WorkspaceSshKey, "fingerprint">;

const publicKeyPath = (keyPath: string): string =>
  keyPath.endsWith(".pub") ? keyPath : `${keyPath}.pub`;

const readRequiredKey = (
  keyPath: string,
  source: WorkspaceSshKey["source"],
): WorkspaceSshResult<WorkspaceSshKeyMaterial> => {
  const parsed = parseIdentityPath(keyPath);
  if (!parsed.ok) return parsed;
  const publicPath = publicKeyPath(parsed.value);
  const privatePath = publicPath.slice(0, -".pub".length);
  const read = readText(publicPath);
  if (!read.ok) return read;
  // An empty passphrase is explicit: ssh-keygen cannot open a tty or askpass dialog.
  // Deriving the public half checks private-key readability, format, permissions and encryption.
  const derived = spawnSync("ssh-keygen", ["-y", "-P", "", "-f", privatePath], {
    encoding: "utf8",
    timeout: 3_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SSH_ASKPASS_REQUIRE: "never" },
  });
  const publicKey = read.value.trim() || (derived.status === 0 ? derived.stdout.trim() : "");
  if (publicKey === "") {
    return failure(
      new WorkspaceSshError(
        "key",
        `No usable SSH key exists at ${privatePath}. Restore the key or choose --key explicitly.`,
      ),
    );
  }
  if (derived.status === 0 && publicKeyIdentity(derived.stdout) === publicKeyIdentity(publicKey)) {
    return success({ publicKey, identityFile: privatePath, source });
  }
  if (agentKeys().some((key) => publicKeyIdentity(key) === publicKeyIdentity(publicKey))) {
    // A public IdentityFile pins precisely the matching agent key, even without a private file.
    return success({ publicKey, identityFile: publicPath, source });
  }
  return failure(
    new WorkspaceSshError(
      "key",
      `SSH key at ${privatePath} has no usable matching private material or unlocked agent identity. Restore the private key, or unlock this exact key with ssh-add and rerun setup.`,
    ),
  );
};

const readOptionalKey = (keyPath: string): WorkspaceSshResult<WorkspaceSshKeyMaterial | null> => {
  const parsed = parseIdentityPath(keyPath);
  if (!parsed.ok) return parsed;
  if (!fs.existsSync(parsed.value) && !fs.existsSync(publicKeyPath(parsed.value)))
    return success(null);
  return readRequiredKey(parsed.value, "existing");
};

const pinAgentKey = (
  configHome: string,
  publicKey: string,
): WorkspaceSshResult<WorkspaceSshKeyMaterial> => {
  const identityFile = path.resolve(
    configHome,
    "ssh",
    `agent-${hashIdentity(publicKeyIdentity(publicKey))}.pub`,
  );
  try {
    fs.mkdirSync(path.dirname(identityFile), { recursive: true, mode: 0o700 });
    // Only a public selector is persisted. Never copy private material out of the agent.
    fs.writeFileSync(identityFile, `${publicKey}\n`, { mode: 0o600 });
    return success({ publicKey, identityFile, source: "agent" });
  } catch (cause) {
    return failure(
      new WorkspaceSshError("key", "Could not save the selected agent public key.", cause),
    );
  }
};

const generateDedicatedKey = (privatePath: string): WorkspaceSshResult<WorkspaceSshKeyMaterial> => {
  try {
    fs.mkdirSync(path.dirname(privatePath), { recursive: true, mode: 0o700 });
  } catch (cause) {
    return failure(
      new WorkspaceSshError("key", `Could not create ${path.dirname(privatePath)}.`, cause),
    );
  }
  const generated = spawnSync(
    "ssh-keygen",
    ["-t", "ed25519", "-f", privatePath, "-N", "", "-C", `mend-${os.hostname()}`],
    { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (generated.status !== 0) {
    return failure(
      new WorkspaceSshError(
        "key",
        `ssh-keygen failed: ${generated.stderr.trim() || "unknown error"}`,
      ),
    );
  }
  const fresh = readRequiredKey(privatePath, "generated");
  if (fresh.ok === false) {
    return failure(
      new WorkspaceSshError(
        "key",
        `ssh-keygen succeeded but ${publicKeyPath(privatePath)} is missing.`,
        fresh.error,
      ),
    );
  }
  return fresh;
};

const dedicatedKey = (
  configHome: string,
  create: boolean,
): WorkspaceSshResult<WorkspaceSshKeyMaterial | null> => {
  const privatePath = path.join(configHome, "ssh", "id_ed25519");
  const existing = readOptionalKey(privatePath);
  if (existing.ok === false) return failure(existing.error);
  if (existing.value !== null || !create) return existing;
  const agent = agentKeys()[0];
  return agent === undefined ? generateDedicatedKey(privatePath) : pinAgentKey(configHome, agent);
};

/**
 * Pick the key this client can use. The explicit key or this server's configured identity wins,
 * then the persistent dedicated key. First setup may pin an agent public key or generate a key.
 * A missing/unusable selected key is an error, never permission to silently select another key.
 */
export const pickWorkspaceSshKey = (input: {
  readonly configHome: string;
  readonly explicitKeyPath?: string | null;
  readonly configuredIdentityFile?: string | null;
  readonly create: boolean;
}): WorkspaceSshResult<WorkspaceSshKey | null> => {
  const explicit = input.explicitKeyPath ?? "";
  const configured = input.configuredIdentityFile ?? "";
  let material: WorkspaceSshKeyMaterial | null;

  if (explicit === "") {
    const fromConfig = configured === "" ? success(null) : readRequiredKey(configured, "existing");
    if (fromConfig.ok === false) return failure(fromConfig.error);
    material = fromConfig.value;
    if (material === null) {
      const dedicated = dedicatedKey(input.configHome, input.create);
      if (dedicated.ok === false) return failure(dedicated.error);
      material = dedicated.value;
    }
  } else {
    const read = readRequiredKey(explicit, "explicit");
    if (read.ok === false) return failure(read.error);
    material = read.value;
  }

  if (material === null) return success(null);
  const fingerprint = workspaceSshPublicKeyFingerprint(material.publicKey);
  if (fingerprint.ok === false) return failure(fingerprint.error);
  return success({ ...material, fingerprint: fingerprint.value });
};

/** Compare the exact managed block and this client's key with the server's registered keys. */
export const inspectWorkspaceSshReadiness = (input: {
  readonly config: string;
  readonly target: WorkspaceSshTarget;
  readonly key: WorkspaceSshKey | null;
  readonly registeredFingerprints: ReadonlyArray<string>;
}): WorkspaceSshReadiness => {
  const block =
    input.key === null ? null : managedWorkspaceSshBlock(input.target, input.key.identityFile);
  // Only intact managed blocks and comments may precede ours. An arbitrary earlier directive
  // could win first-match evaluation. Do not execute a user's Match exec while inspecting status.
  const prefix = input.config.slice(0, input.config.indexOf(blockBegin(input.target.alias)));
  const configReady =
    block !== null && block.ok && input.config.includes(block.value) && isManagedPreamble(prefix);
  const keyRegistered =
    input.key !== null && input.registeredFingerprints.includes(input.key.fingerprint);
  return { ready: configReady && keyRegistered, configReady, keyRegistered };
};

/** Read a UTF-8 OpenSSH config, treating an absent file as empty. */
export const readWorkspaceSshConfig = (configFile: string): WorkspaceSshResult<string> => {
  const read = readText(configFile);
  if (read.ok === true) return read;
  return failure(new WorkspaceSshError("config", `Could not read ${configFile}.`, read.error));
};

/** Reconcile one server block on disk and enforce normal OpenSSH directory and file modes. */
export const writeWorkspaceSshConfig = (
  configFile: string,
  target: WorkspaceSshTarget,
  identityFile: string | null,
): WorkspaceSshResult<void> => {
  const before = readWorkspaceSshConfig(configFile);
  if (before.ok === false) return failure(before.error);
  const reconciled = reconcileWorkspaceSshConfig(before.value, target, identityFile);
  if (reconciled.ok === false) return failure(reconciled.error);
  try {
    fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(configFile), 0o700);
    fs.writeFileSync(configFile, reconciled.value, { mode: 0o600 });
    fs.chmodSync(configFile, 0o600);
    return success(undefined);
  } catch (cause) {
    return failure(new WorkspaceSshError("config", `Could not write ${configFile}.`, cause));
  }
};
