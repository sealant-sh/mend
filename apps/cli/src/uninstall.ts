import * as fs from "node:fs";
import * as path from "node:path";

import { stripManagedWorkspaceSshBlocks } from "@mend/workspace-ssh";

import { MEND_DOCKER_NAMESPACE, verifyServerDockerVolumes } from "./server-docker-volumes.ts";
import { serverComposeArgs, serverProcessDeadlines } from "./server-runtime.ts";
import { readServerInstallation, type ServerSetupRuntime } from "./server-setup.ts";
import { withServerStore } from "./server-store.ts";

/**
 * `mend uninstall`: the one command that deletes. Three scopes, chosen up front and
 * shown as a plan before anything is touched:
 *
 * - `server`: the Docker Compose installation on this machine (containers, every
 *   volume it owns, its release image) and the private configuration under the config
 *   directory (identity, generations, backups).
 * - `home`: what this CLI keeps for itself (the sign-in, the workspace SSH key, the
 *   managed block in ~/.ssh/config), with the device token revoked on the server first.
 * - `all`: both, server first.
 *
 * Nothing else under the config directory is touched: a host-run store or keys root,
 * or a file another tool left there, is listed and left in place. Workspace containers
 * carry no label Mend can filter on, so they are counted and named, never removed.
 */

export type UninstallScope = "all" | "server" | "home";

export interface UninstallArgs {
  readonly scope: UninstallScope | null;
  readonly yes: boolean;
}

export const UNINSTALL_USAGE = "usage: mend uninstall [--all | --server | --home] [--yes]";

/** Exactly one scope flag at most, `--yes` anywhere; anything else is a usage error. */
export const parseUninstallArgs = (
  args: ReadonlyArray<string>,
): UninstallArgs | { readonly error: string } => {
  let scope: UninstallScope | null = null;
  let yes = false;
  for (const arg of args) {
    if (arg === "--yes" || arg === "-y") {
      yes = true;
      continue;
    }
    const next: UninstallScope | null =
      arg === "--all" ? "all" : arg === "--server" ? "server" : arg === "--home" ? "home" : null;
    if (next === null) return { error: `${UNINSTALL_USAGE} · "${arg}" is not an option` };
    if (scope !== null && scope !== next) {
      return { error: `${UNINSTALL_USAGE} · pick one scope` };
    }
    scope = next;
  }
  return { scope, yes };
};

/** What the CLI knows about this machine, gathered once at the command boundary. */
export interface UninstallRuntime {
  readonly server: ServerSetupRuntime;
  /** `$XDG_CONFIG_HOME/mend` (or the legacy `~/.mend`): where cli.json and the ssh key live. */
  readonly cliHome: string;
  /** `~/.ssh/config`, where `mend ssh setup` keeps its managed block. */
  readonly sshConfigFile: string;
  /** The saved sign-in, when there is one. */
  readonly signedIn: { readonly url: string; readonly deviceId: string | null } | null;
  /** Revoke this terminal's device token; resolves to the failure's words, or null when done. */
  revokeDevice(): Promise<string | null>;
}

export interface ServerPlan {
  readonly version: string;
  readonly appUrl: string;
  readonly dockerContext: string;
  readonly generations: number;
  readonly backups: number;
}

export interface HomePlan {
  readonly cliConfig: string | null;
  readonly sshDirectory: string | null;
  readonly managedSshBlocks: number;
  readonly signedIn: UninstallRuntime["signedIn"];
}

export interface UninstallPlan {
  readonly scope: UninstallScope;
  /** `null` when the server is out of scope; `"none"` when nothing is installed here. */
  readonly server: ServerPlan | "none" | null;
  readonly home: HomePlan | null;
}

/** The server files uninstall owns; the lock directory is the store's and everything else stays. */
const SERVER_FILES = ["identity.env", "active", "generations", "backups"] as const;

const countEntries = (directory: string): number => {
  try {
    return fs.readdirSync(directory).length;
  } catch {
    return 0;
  }
};

const exists = (file: string): boolean => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

const managedBlockCount = (sshConfigFile: string): number => {
  let config: string;
  try {
    config = fs.readFileSync(sshConfigFile, "utf8");
  } catch {
    return 0;
  }
  const stripped = stripManagedWorkspaceSshBlocks(config);
  return stripped.ok ? stripped.value.removed : 0;
};

/** Read what each scope would remove. The server is read under its lock; nothing changes. */
export const describeUninstall = async (
  runtime: UninstallRuntime,
  scope: UninstallScope,
): Promise<UninstallPlan> => {
  let server: UninstallPlan["server"] = null;
  if (scope !== "home") {
    const configDir = runtime.server.configDir;
    const read = await withServerStore(
      configDir,
      async (store) => {
        const installation = readServerInstallation(store);
        if (installation._tag === "error") throw installation.error;
        return installation.value;
      },
      { create: false },
    );
    if (read._tag === "error") {
      // An unconfigured directory is not an error for uninstall: there is nothing to remove.
      if (!read.error.message.startsWith("No Mend server is configured")) throw read.error;
      server = "none";
    } else if (read.value === null) {
      server = exists(path.join(configDir, "identity.env"))
        ? {
            version: "(no active generation)",
            appUrl: "",
            dockerContext: "",
            generations: countEntries(path.join(configDir, "generations")),
            backups: countEntries(path.join(configDir, "backups")),
          }
        : "none";
    } else {
      server = {
        version: read.value.config.serverVersion,
        appUrl: read.value.config.appUrl,
        dockerContext: read.value.config.dockerContext,
        generations: countEntries(path.join(configDir, "generations")),
        backups: countEntries(path.join(configDir, "backups")),
      };
    }
  }
  let home: HomePlan | null = null;
  if (scope !== "server") {
    const cliConfig = path.join(runtime.cliHome, "cli.json");
    const sshDirectory = path.join(runtime.cliHome, "ssh");
    home = {
      cliConfig: exists(cliConfig) ? cliConfig : null,
      sshDirectory: exists(sshDirectory) ? sshDirectory : null,
      managedSshBlocks: managedBlockCount(runtime.sshConfigFile),
      signedIn: runtime.signedIn,
    };
  }
  return { scope, server, home };
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The plan as the terminal shows it before asking: one line per thing that goes. */
export const planLines = (plan: UninstallPlan, configDir: string): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  if (plan.server === "none") {
    lines.push(`server   none installed under ${configDir}`);
  } else if (plan.server !== null) {
    const { version, appUrl, dockerContext, generations, backups } = plan.server;
    lines.push(
      `server   Mend ${version}${appUrl === "" ? "" : ` at ${appUrl}`}${dockerContext === "" ? "" : ` · docker context ${dockerContext}`}`,
    );
    if (dockerContext !== "") {
      lines.push(
        `         containers mend, postgres · volumes ${[MEND_DOCKER_NAMESPACE.store, MEND_DOCKER_NAMESPACE.control, "mend-config", "mend-ssh", "mend-postgres"].join(", ")} · image ghcr.io/sealant-sh/mend:${version}`,
      );
    }
    lines.push(
      `         ${configDir}: identity.env, active, ${plural(generations, "generation")}, ${plural(backups, "backup")}`,
    );
  }
  if (plan.home !== null) {
    const parts: Array<string> = [];
    if (plan.home.cliConfig !== null) {
      parts.push(
        plan.home.signedIn === null
          ? plan.home.cliConfig
          : `${plan.home.cliConfig} (signed in to ${plan.home.signedIn.url})`,
      );
    }
    if (plan.home.sshDirectory !== null) parts.push(plan.home.sshDirectory);
    if (plan.home.managedSshBlocks > 0) {
      parts.push(`${plural(plan.home.managedSshBlocks, "managed block")} in ~/.ssh/config`);
    }
    lines.push(parts.length === 0 ? "home     nothing of Mend's here" : `home     ${parts[0]}`);
    for (const part of parts.slice(1)) lines.push(`         ${part}`);
  }
  return lines;
};

/** True when the plan deletes repositories, worktrees or a database: the typed confirmation gate. */
export const planDeletesData = (plan: UninstallPlan): boolean =>
  plan.server !== null && plan.server !== "none";

export interface UninstallOutcome {
  /** What could not be done, in the words a person can act on. Empty means clean. */
  readonly failures: ReadonlyArray<string>;
  /** Things left in place on purpose, each with why. */
  readonly leftovers: ReadonlyArray<string>;
}

const dockerArgs = (context: string, ...rest: ReadonlyArray<string>): ReadonlyArray<string> => [
  "--context",
  context,
  ...rest,
];

const removeServer = async (
  runtime: UninstallRuntime,
  failures: Array<string>,
  leftovers: Array<string>,
): Promise<void> => {
  const { server } = runtime;
  const configDir = server.configDir;
  const result = await withServerStore(
    configDir,
    async (store) => {
      const read = readServerInstallation(store);
      if (read._tag === "error") throw read.error;
      const installation = read.value;
      if (installation !== null) {
        const context = installation.config.dockerContext;
        // Containers, the project network and the Compose-owned volumes go together; a
        // failure here keeps the files, so the next attempt can still find the installation.
        const down = await server.run(
          "docker",
          serverComposeArgs({ directory: installation.directory, dockerContext: context }, [
            "down",
            "--volumes",
            "--remove-orphans",
            "--timeout",
            "30",
          ]),
          { timeoutMs: serverProcessDeadlines.stop },
        );
        if (down.status !== 0) {
          throw new Error(
            `docker compose down failed: ${(down.error ?? down.stderr.trim()) || "no output"}. Containers and files are retained; fix Docker and run mend uninstall again.`,
          );
        }
        server.writeLine("removed containers mend, postgres and the Compose-owned volumes");

        // The external volumes are the data. Only this installation's own label allows their
        // removal; anything else is somebody's data and stays, named.
        const identity = store.readIdentity();
        if (identity._tag === "error") throw identity.error;
        const owned =
          identity.value === null
            ? null
            : await verifyServerDockerVolumes(server, {
                dockerContext: context,
                identityBytes: Buffer.from(identity.value),
              });
        if (owned !== null && owned._tag === "ok") {
          const removed = await server.run(
            "docker",
            dockerArgs(
              context,
              "volume",
              "rm",
              MEND_DOCKER_NAMESPACE.store,
              MEND_DOCKER_NAMESPACE.control,
            ),
          );
          if (removed.status === 0) {
            server.writeLine(
              `removed volumes ${MEND_DOCKER_NAMESPACE.store}, ${MEND_DOCKER_NAMESPACE.control}`,
            );
          } else {
            failures.push(
              `could not remove volumes ${MEND_DOCKER_NAMESPACE.store}, ${MEND_DOCKER_NAMESPACE.control}: ${(removed.error ?? removed.stderr.trim()) || "no output"}`,
            );
          }
        } else if (owned !== null && owned.error.reason === "missing") {
          server.writeLine(
            `volumes ${MEND_DOCKER_NAMESPACE.store}, ${MEND_DOCKER_NAMESPACE.control} were already gone`,
          );
        } else {
          leftovers.push(
            `volumes ${MEND_DOCKER_NAMESPACE.store}, ${MEND_DOCKER_NAMESPACE.control}: ownership could not be confirmed for this installation, so they stay (docker --context ${context} volume ls)`,
          );
        }

        const image = `ghcr.io/sealant-sh/mend:${installation.config.serverVersion}`;
        const untagged = await server.run("docker", dockerArgs(context, "image", "rm", image));
        if (untagged.status === 0) server.writeLine(`removed image ${image}`);
        else leftovers.push(`image ${image}: not removed (${untagged.stderr.trim() || "absent"})`);

        // Workspaces are Sealant's containers on this daemon, named sealant-<run>; no label
        // ties them to this installation, so they are counted and named, never guessed at.
        const workspaces = await server.run(
          "docker",
          dockerArgs(
            context,
            "container",
            "ls",
            "--all",
            "--filter",
            "name=^sealant-",
            "--format",
            "{{.Names}}",
          ),
        );
        const names = workspaces.stdout.split(/\s+/).filter((name) => name !== "");
        if (workspaces.status === 0 && names.length > 0) {
          leftovers.push(
            `${plural(names.length, "workspace container")} left on docker context ${context} (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}): docker --context ${context} rm -f ${names.join(" ")}`,
          );
        }
      }
      // The lock directory is the store's own; its release removes it after this returns.
      for (const name of SERVER_FILES) {
        fs.rmSync(path.join(configDir, name), { recursive: true, force: true });
      }
      server.writeLine(`removed ${configDir}/{identity.env, active, generations, backups}`);
    },
    { create: false },
  );
  if (result._tag === "error") failures.push(result.error.message);
};

const removeHome = async (
  runtime: UninstallRuntime,
  plan: HomePlan,
  failures: Array<string>,
  leftovers: Array<string>,
): Promise<void> => {
  const { server } = runtime;
  if (plan.cliConfig !== null) {
    fs.rmSync(plan.cliConfig, { force: true });
    server.writeLine(`removed ${plan.cliConfig}`);
  }
  if (plan.sshDirectory !== null) {
    fs.rmSync(plan.sshDirectory, { recursive: true, force: true });
    server.writeLine(`removed ${plan.sshDirectory}`);
  }
  if (plan.managedSshBlocks > 0) {
    try {
      const before = fs.readFileSync(runtime.sshConfigFile, "utf8");
      const stripped = stripManagedWorkspaceSshBlocks(before);
      if (!stripped.ok) throw stripped.error;
      if (stripped.value.removed > 0) {
        fs.writeFileSync(runtime.sshConfigFile, stripped.value.config, { mode: 0o600 });
        server.writeLine(
          `removed ${plural(stripped.value.removed, "managed block")} from ${runtime.sshConfigFile}`,
        );
      }
    } catch (cause) {
      failures.push(
        `${runtime.sshConfigFile}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  // The directory itself goes only when nothing else lives there.
  let remaining: ReadonlyArray<string> = [];
  try {
    remaining = fs.readdirSync(runtime.cliHome);
  } catch {
    return;
  }
  if (remaining.length === 0) {
    fs.rmdirSync(runtime.cliHome);
    server.writeLine(`removed ${runtime.cliHome}`);
  } else {
    leftovers.push(
      `${runtime.cliHome} kept: ${remaining.join(", ")} ${remaining.length === 1 ? "is" : "are"} not this CLI's (a host-run server's store or keys, or another tool's files)`,
    );
  }
};

/** Carry the plan out, server first. Each scope reports what it did; failures never hide. */
export const executeUninstall = async (
  runtime: UninstallRuntime,
  plan: UninstallPlan,
): Promise<UninstallOutcome> => {
  const failures: Array<string> = [];
  const leftovers: Array<string> = [];
  // The token is revoked while the server can still answer; with `all` it is about to go.
  if (plan.home?.signedIn !== null && plan.home?.signedIn?.deviceId != null) {
    const failure = await runtime.revokeDevice();
    if (failure === null) {
      runtime.server.writeLine(`revoked this terminal's device on ${plan.home.signedIn.url}`);
    } else {
      leftovers.push(
        `device token on ${plan.home.signedIn.url}: ${failure} (end it under Settings → Devices)`,
      );
    }
  }
  if (plan.server !== null && plan.server !== "none") {
    await removeServer(runtime, failures, leftovers);
  }
  if (plan.home !== null) await removeHome(runtime, plan.home, failures, leftovers);
  return { failures, leftovers };
};
