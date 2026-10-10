import * as os from "node:os";
import * as path from "node:path";

import {
  configuredWorkspaceSshIdentityFile,
  inspectWorkspaceSshReadiness,
  parseWorkspaceSshTarget,
  pickWorkspaceSshKey,
  readWorkspaceSshConfig,
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

/**
 * The fingerprint of the key this machine would offer the gateway: the identity in this server's
 * managed ~/.ssh/config block, else the dedicated key `mend ssh setup` keeps. Nothing is created;
 * an unreadable key or config reads as no key, since a listing must not fail on it.
 */
const thisMachineFingerprint = (
  view: WorkspaceSshViewDto,
  cliHome: string,
  serverUrl: string,
): string | null => {
  const target =
    view.gateway === null
      ? null
      : parseWorkspaceSshTarget({ serverUrl, publishedPort: view.gateway.port });
  const config = readWorkspaceSshConfig(sshConfigPath());
  const configured =
    target !== null && target.ok && config.ok
      ? configuredWorkspaceSshIdentityFile(config.value, target.value)
      : null;
  const picked = pickWorkspaceSshKey({
    configHome: cliHome,
    configuredIdentityFile: configured,
    create: false,
  });
  return picked.ok && picked.value !== null ? picked.value.fingerprint : null;
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
  const local = thisMachineFingerprint(view, cliHome, serverUrl);
  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        view.keys.map((key) => ({ ...key, thisMachine: key.fingerprint === local })),
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
      `${key.fingerprint}  ${key.name.padEnd(width)}  ${dim(`${key.algorithm} · registered ${key.createdAt.slice(0, 10)}`)}${key.fingerprint === local ? ` ${green("● this machine")}` : ""}`,
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
  if (removed.fingerprint === thisMachineFingerprint(view, cliHome, serverUrl)) {
    say(
      dim(
        "this machine's key: the file and the ~/.ssh/config block stay; mend ssh setup registers it again",
      ),
    );
  }
};

/**
 * `mend uninstall --home`: remove the key this machine registered, while the sign-in still works.
 * Resolves to the removed key, or null when this machine holds none the server knows; a failed
 * call throws for the caller to report.
 */
export const removeThisMachineKey = async (
  api: ApiCall,
  cliHome: string,
  serverUrl: string,
): Promise<RegisteredKey | null> => {
  const view = await api<WorkspaceSshViewDto>("GET", "/workspace-ssh");
  const local = thisMachineFingerprint(view, cliHome, serverUrl);
  const key = view.keys.find((candidate) => candidate.fingerprint === local);
  if (key === undefined) return null;
  return api<RegisteredKey>("DELETE", `/workspace-ssh/keys/${encodeURIComponent(key.sshKeyId)}`);
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
