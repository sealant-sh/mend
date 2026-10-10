import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  configuredWorkspaceSshIdentityFile,
  inspectWorkspaceSshReadiness,
  parseWorkspaceSshTarget,
  pickWorkspaceSshKey,
  readWorkspaceSshConfig,
  workspaceSshPublicKeyFingerprint,
  writeWorkspaceSshConfig,
} from "@mend/workspace-ssh";

import type { ApiCall } from "./pair.ts";
import { redactCredentials } from "./shared.ts";

interface WorkspaceSshViewDto {
  readonly gateway: {
    readonly host: string;
    readonly port: number;
    readonly usernamePrefix: string;
  } | null;
  readonly keys: ReadonlyArray<{
    readonly sshKeyId: string;
    readonly name: string;
    readonly algorithm: string;
    readonly fingerprint: string;
    readonly createdAt: string;
  }>;
}

const ansi = (code: string) => (text: string) =>
  process.stdout.isTTY === true ? `[${code}m${text}[0m` : text;
const dim = ansi("2");
const green = ansi("32");
const warn = ansi("33");
const say = (line: string) => console.log(redactCredentials(line));
const sshConfigPath = (): string => path.join(os.homedir(), ".ssh", "config");

const flagValue = (args: ReadonlyArray<string>, flag: string): string | null => {
  const index = args.indexOf(flag);
  return index === -1 || args[index + 1] === undefined ? null : String(args[index + 1]);
};

const showFailure = (message: string): void => {
  say(`mend: ${message}`);
  process.exitCode = 1;
};

const showStatus = async (
  api: ApiCall,
  cliHome: string,
  serverUrl: string,
  args: ReadonlyArray<string>,
): Promise<void> => {
  const view = await api<WorkspaceSshViewDto>("GET", "/workspace-ssh");
  if (view.gateway === null) {
    say(`workspace ssh   ${warn("no gateway")} ${dim("· this deployment exposes none")}`);
    return;
  }
  const parsedTarget = parseWorkspaceSshTarget({
    serverUrl,
    publishedPort: view.gateway.port,
    hostnameOverride: flagValue(args, "--host"),
  });
  if (parsedTarget.ok === false) return showFailure(parsedTarget.error.message);
  const config = readWorkspaceSshConfig(sshConfigPath());
  if (config.ok === false) return showFailure(config.error.message);
  const picked = pickWorkspaceSshKey({
    configHome: cliHome,
    configuredIdentityFile: configuredWorkspaceSshIdentityFile(config.value, parsedTarget.value),
    create: false,
  });
  if (picked.ok === false) return showFailure(picked.error.message);
  const readiness = inspectWorkspaceSshReadiness({
    config: config.value,
    target: parsedTarget.value,
    key: picked.value,
    registeredFingerprints: view.keys.map((key) => key.fingerprint),
  });

  say(
    `gateway         ${parsedTarget.value.hostname}:${parsedTarget.value.port} ${dim(`· published for ${serverUrl}`)}`,
  );
  say(
    picked.value === null
      ? `client key      ${warn("none available")} ${dim("· run: mend ssh setup")}`
      : readiness.keyRegistered
        ? `client key      ${green("●")} ${picked.value.fingerprint} ${dim("· registered")}`
        : `client key      ${warn("not registered")} ${dim(`· ${picked.value.fingerprint}`)}`,
  );
  say(
    readiness.configReady
      ? `ssh config      ${green("●")} Host ${parsedTarget.value.alias} ${dim(`· ${sshConfigPath()}`)}`
      : `ssh config      ${warn("missing or stale")} ${dim("· run: mend ssh setup")}`,
  );
  say(
    "host trust      not checked · status checks config and client-key registration, not an SSH connection",
  );
};

const setup = async (
  api: ApiCall,
  cliHome: string,
  serverUrl: string,
  args: ReadonlyArray<string>,
): Promise<void> => {
  const view = await api<WorkspaceSshViewDto>("GET", "/workspace-ssh");
  if (view.gateway === null)
    return showFailure("This deployment exposes no workspace SSH gateway.");

  const parsedTarget = parseWorkspaceSshTarget({
    serverUrl,
    publishedPort: view.gateway.port,
    hostnameOverride: flagValue(args, "--host"),
  });
  if (parsedTarget.ok === false) return showFailure(parsedTarget.error.message);
  const config = readWorkspaceSshConfig(sshConfigPath());
  if (config.ok === false) return showFailure(config.error.message);
  const picked = pickWorkspaceSshKey({
    configHome: cliHome,
    explicitKeyPath: flagValue(args, "--key"),
    configuredIdentityFile: configuredWorkspaceSshIdentityFile(config.value, parsedTarget.value),
    create: true,
  });
  if (picked.ok === false) return showFailure(picked.error.message);
  if (picked.value === null) return showFailure("No workspace SSH key is available.");

  const registered = await api<WorkspaceSshViewDto["keys"][number]>("POST", "/workspace-ssh/keys", {
    publicKey: picked.value.publicKey,
    name: os.hostname(),
  });
  const sourceLabel = {
    explicit: "from --key",
    agent: "from your ssh-agent (public identity saved locally)",
    existing: "existing selected key",
    generated: "generated dedicated key",
  }[picked.value.source];
  say(`key             ${green("●")} ${registered.fingerprint} ${dim(`· ${sourceLabel}`)}`);

  const written = writeWorkspaceSshConfig(
    sshConfigPath(),
    parsedTarget.value,
    picked.value.identityFile,
  );
  if (written.ok === false) return showFailure(written.error.message);
  say(
    `ssh config      ${green("●")} Host ${parsedTarget.value.alias} ${dim(`· ${sshConfigPath()}`)}`,
  );
  say(
    "host trust      not checked · SSH verifies the gateway when you connect; setup does not replace known_hosts entries",
  );
  say("");
  say(
    `connect with    ssh ${view.gateway.usernamePrefix}-<workspace-id>@${parsedTarget.value.alias} ${dim("· the VS Code extension uses this automatically")}`,
  );
};

type RegisteredKey = WorkspaceSshViewDto["keys"][number];

/** The public identities this machine holds for one Mend server, and what could not be read. */
interface ThisMachineKeys {
  readonly fingerprints: ReadonlySet<string>;
  /** Paths named as this machine's identity whose public half could not be read, with why. */
  readonly unreadable: ReadonlyArray<string>;
}

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * The keys this machine registered for the server, read from their PUBLIC halves: the identity
 * in this server's managed ~/.ssh/config block, and every public key `mend ssh setup` keeps under
 * the config directory (the dedicated key and pinned agent identities). Nothing here signs, so an
 * encrypted key, a stopped agent or a locked keychain still identifies. A key whose public half is
 * gone is tried through `pickWorkspaceSshKey`, which can derive it from an unencrypted private key;
 * what still cannot be read is reported, never taken for absence.
 */
const thisMachineKeys = (
  view: WorkspaceSshViewDto | null,
  cliHome: string,
  serverUrl: string,
): ThisMachineKeys => {
  const fingerprints = new Set<string>();
  const unreadable: Array<string> = [];
  // The managed block's alias comes from the server URL alone, so the saved identity is found
  // whether or not the server reports a gateway now (or answers at all); the port only routes.
  const target = parseWorkspaceSshTarget({
    serverUrl,
    publishedPort: view?.gateway?.port ?? 22,
  });
  const config = readWorkspaceSshConfig(sshConfigPath());
  const configured =
    target.ok && config.ok ? configuredWorkspaceSshIdentityFile(config.value, target.value) : null;
  const publicPaths = new Set<string>();
  if (configured !== null) {
    publicPaths.add(configured.endsWith(".pub") ? configured : `${configured}.pub`);
  }
  const keyDirectory = path.join(cliHome, "ssh");
  try {
    for (const entry of fs.readdirSync(keyDirectory)) {
      if (entry.endsWith(".pub")) publicPaths.add(path.join(keyDirectory, entry));
    }
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
    if (code !== "ENOENT") unreadable.push(`${keyDirectory}: ${errorText(cause)}`);
  }
  let missingPublicHalf: string | null = null;
  for (const publicPath of publicPaths) {
    let line: string;
    try {
      line = fs.readFileSync(publicPath, "utf8");
    } catch (cause) {
      const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
      if (code === "ENOENT") missingPublicHalf = publicPath;
      else unreadable.push(`${publicPath}: ${errorText(cause)}`);
      continue;
    }
    const fingerprint = workspaceSshPublicKeyFingerprint(line);
    if (fingerprint.ok) fingerprints.add(fingerprint.value);
    else unreadable.push(`${publicPath}: ${fingerprint.error.message}`);
  }
  if (missingPublicHalf !== null) {
    const picked = pickWorkspaceSshKey({
      configHome: cliHome,
      configuredIdentityFile: configured,
      create: false,
    });
    if (picked.ok && picked.value !== null) fingerprints.add(picked.value.fingerprint);
    else {
      unreadable.push(
        `${missingPublicHalf}: missing${picked.ok ? "" : `, and ${picked.error.message}`}`,
      );
    }
  }
  return { fingerprints, unreadable };
};

/** `SHA256:abc…`, `abc…` (the prefix is optional) or the platform's key id. */
const findKey = (keys: ReadonlyArray<RegisteredKey>, wanted: string): RegisteredKey | undefined => {
  const fingerprint = wanted.startsWith("SHA256:") ? wanted : `SHA256:${wanted}`;
  return keys.find((key) => key.fingerprint === fingerprint || key.sshKeyId === wanted);
};

const REMOVED_KEY_EFFECT =
  "the gateway refuses it from the next connection; a connection already open stays open until it ends";

const listKeys = async (
  api: ApiCall,
  cliHome: string,
  serverUrl: string,
  args: ReadonlyArray<string>,
): Promise<void> => {
  const view = await api<WorkspaceSshViewDto>("GET", "/workspace-ssh");
  const local = thisMachineKeys(view, cliHome, serverUrl).fingerprints;
  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        view.keys.map((key) => ({ ...key, thisMachine: local.has(key.fingerprint) })),
        null,
        2,
      ),
    );
    return;
  }
  if (view.keys.length === 0) {
    say(`no workspace ssh keys registered ${dim("· run: mend ssh setup")}`);
    return;
  }
  const width = Math.max(...view.keys.map((key) => key.name.length));
  for (const key of view.keys) {
    say(
      `${key.fingerprint}  ${key.name.padEnd(width)}  ${dim(`${key.algorithm} · registered ${key.createdAt.slice(0, 10)}`)}${local.has(key.fingerprint) ? ` ${green("● this machine")}` : ""}`,
    );
  }
};

const removeKey = async (
  api: ApiCall,
  cliHome: string,
  serverUrl: string,
  args: ReadonlyArray<string>,
): Promise<void> => {
  const [wanted] = args;
  if (wanted === undefined || wanted.startsWith("-")) {
    return showFailure("usage: mend ssh keys remove <fingerprint> · mend ssh keys lists them");
  }
  const view = await api<WorkspaceSshViewDto>("GET", "/workspace-ssh");
  const key = findKey(view.keys, wanted);
  if (key === undefined) {
    return showFailure(
      `none of your registered keys has fingerprint ${wanted} · mend ssh keys lists them`,
    );
  }
  const removed = await api<RegisteredKey>(
    "DELETE",
    `/workspace-ssh/keys/${encodeURIComponent(key.sshKeyId)}`,
  );
  say(`removed         ${removed.fingerprint} ${dim(`· ${removed.name}`)}`);
  say(dim(REMOVED_KEY_EFFECT));
  if (thisMachineKeys(view, cliHome, serverUrl).fingerprints.has(removed.fingerprint)) {
    say(
      dim(
        "this machine's key: the file and the ~/.ssh/config block stay; mend ssh setup registers it again",
      ),
    );
  }
};

/** What removing this machine's workspace SSH keys came to (`mend uninstall --home`). */
export interface ThisMachineKeyRemoval {
  /** Fingerprints archived on the server. */
  readonly removed: ReadonlyArray<string>;
  /** This machine's fingerprints the server still holds active after the attempt. */
  readonly stillActive: ReadonlyArray<string>;
  /** Why a key may still be registered: a refused call, or a key this machine could not read. */
  readonly problem: string | null;
}

/**
 * `mend uninstall --home`: remove the keys this machine registered, while the sign-in still works.
 * Each is identified by its public half, removed on its own, and anything left (a refused call,
 * an unreadable identity) is named in `problem`, never reported as absent. Never throws.
 */
export const removeThisMachineKey = async (
  api: ApiCall,
  cliHome: string,
  serverUrl: string,
): Promise<ThisMachineKeyRemoval> => {
  let view: WorkspaceSshViewDto;
  try {
    view = await api<WorkspaceSshViewDto>("GET", "/workspace-ssh");
  } catch (cause) {
    const local = thisMachineKeys(null, cliHome, serverUrl);
    return {
      removed: [],
      stillActive: [...local.fingerprints],
      problem: `the server's key list could not be read: ${errorText(cause)}`,
    };
  }
  const local = thisMachineKeys(view, cliHome, serverUrl);
  const removed: Array<string> = [];
  const stillActive: Array<string> = [];
  const problems: Array<string> = [];
  for (const key of view.keys.filter((candidate) =>
    local.fingerprints.has(candidate.fingerprint),
  )) {
    try {
      await api<RegisteredKey>("DELETE", `/workspace-ssh/keys/${encodeURIComponent(key.sshKeyId)}`);
      removed.push(key.fingerprint);
    } catch (cause) {
      stillActive.push(key.fingerprint);
      problems.push(`${key.fingerprint} was not removed: ${errorText(cause)}`);
    }
  }
  if (local.unreadable.length > 0) {
    problems.push(
      `this machine's key could not be read (${local.unreadable.join("; ")}), so Mend cannot tell which registered key is this machine's`,
    );
  }
  return { removed, stillActive, problem: problems.length === 0 ? null : problems.join("; ") };
};

const keysCommand = async (
  api: ApiCall,
  cliHome: string,
  serverUrl: string,
  args: ReadonlyArray<string>,
): Promise<void> => {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case undefined:
    case "list":
    case "--json":
      return listKeys(api, cliHome, serverUrl, args);
    case "remove":
    case "rm":
      return removeKey(api, cliHome, serverUrl, rest);
    default:
      showFailure(
        `Unknown ssh keys subcommand "${subcommand}". Try: mend ssh keys [--json] · mend ssh keys remove <fingerprint>`,
      );
  }
};

/** Show or reconcile workspace SSH for the configured Mend server on this client machine. */
export const sshCommand = async (
  args: ReadonlyArray<string>,
  api: ApiCall,
  cliHome: string,
  serverUrl: string,
): Promise<void> => {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case undefined:
    case "status":
      return showStatus(api, cliHome, serverUrl, rest);
    case "setup":
      return setup(api, cliHome, serverUrl, rest);
    case "keys":
      return keysCommand(api, cliHome, serverUrl, rest);
    default:
      showFailure(
        `Unknown ssh subcommand "${subcommand}". Try: mend ssh · mend ssh setup [--key <path>] [--host <hostname>] · mend ssh keys [remove <fingerprint>]`,
      );
  }
};
