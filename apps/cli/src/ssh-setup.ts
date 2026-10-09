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
    default:
      showFailure(
        `Unknown ssh subcommand "${subcommand}". Try: mend ssh · mend ssh setup [--key <path>] [--host <hostname>]`,
      );
  }
};
