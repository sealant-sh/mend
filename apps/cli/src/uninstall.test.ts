import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DockerProtocol } from "../test-fixtures/docker-protocol.ts";
import { SERVER_VOLUME_OWNER_LABEL } from "./server-docker-volumes.ts";
import type { ServerSetupRuntime } from "./server-setup.ts";
import type { ThisMachineKeyRemoval } from "./ssh-setup.ts";
import {
  describeUninstall,
  executeUninstall,
  formatBytes,
  parseUninstallArgs,
  planDeletesData,
  planLines,
  signedInTo,
  sysctlFileOf,
  sysctlRestoreCommand,
  type UninstallRuntime,
} from "./uninstall.ts";

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const MANAGED_BLOCK = [
  "# >>> mend workspace ssh mend-ws-mend-example-abcdef12 (managed) >>>",
  "Host mend-ws-mend-example-abcdef12",
  "  HostName mend.example",
  "  Port 2222",
  "  HostKeyAlias mend-ws-mend-example-abcdef12",
  "  StrictHostKeyChecking accept-new",
  "Host *",
  "# <<< mend workspace ssh mend-ws-mend-example-abcdef12 <<<",
  "",
].join("\n");

/** A machine with a sign-in and an ssh setup, but no server: the laptop scenario. */
const laptop = (
  options: {
    readonly signedIn?: boolean;
    readonly extra?: boolean;
    readonly keyRemoval?: ThisMachineKeyRemoval;
    /** A Docker daemon on this machine's current context; absent, Docker does not answer. */
    readonly daemon?: DockerProtocol;
  } = {},
) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend uninstall "));
  roots.push(root);
  const cliHome = path.join(root, "config", "mend");
  const sshDir = path.join(root, ".ssh");
  fs.mkdirSync(path.join(cliHome, "ssh"), { recursive: true });
  fs.mkdirSync(sshDir, { recursive: true });
  fs.writeFileSync(path.join(cliHome, "cli.json"), JSON.stringify({ url: "http://m:3105" }));
  fs.writeFileSync(path.join(cliHome, "ssh", "id_ed25519"), "private");
  if (options.extra === true)
    fs.mkdirSync(path.join(cliHome, "keys", "users"), { recursive: true });
  const sshConfigFile = path.join(sshDir, "config");
  fs.writeFileSync(sshConfigFile, `${MANAGED_BLOCK}Host mine\n  HostName mine.example\n`);
  const lines: Array<string> = [];
  const revoked: Array<string> = [];
  const order: Array<string> = [];
  const server: ServerSetupRuntime = {
    configDir: path.join(root, "config", "mend"),
    platform: "linux",
    cliVersion: "0.0.0-test",
    run: async (command, args, runOptions) => {
      const daemon = options.daemon;
      if (daemon === undefined)
        return { status: 1, stdout: "", stderr: "docker must not run here" };
      if (args[0] === "context" && args[1] === "show") {
        return { status: 0, stdout: "default\n", stderr: "" };
      }
      return (
        daemon.run(command, args, runOptions) ?? { status: 1, stdout: "", stderr: "unexpected" }
      );
    },
    fetchText: async () => ({ status: 0, body: "" }),
    randomBytes: (size) => Buffer.alloc(size),
    sleep: async () => undefined,
    writeLine: (line) => {
      lines.push(line);
    },
  };
  const runtime: UninstallRuntime = {
    server,
    cliHome,
    sshConfigFile,
    signedIn: options.signedIn === false ? null : { url: "http://m:3105", deviceId: "dev-1" },
    revokeDevice: async () => {
      revoked.push("dev-1");
      order.push("revokeDevice");
      return null;
    },
    removeWorkspaceSshKey: async () => {
      order.push("removeWorkspaceSshKey");
      // The key file is still on disk when the server is asked: it names the key to remove.
      if (!fs.existsSync(path.join(cliHome, "ssh", "id_ed25519"))) {
        return { removed: [], stillActive: [], problem: "the key was gone before it was named" };
      }
      return options.keyRemoval ?? { removed: ["SHA256:laptop"], stillActive: [], problem: null };
    },
  };
  return { root, cliHome, sshConfigFile, runtime, lines, revoked, order };
};

describe("parseUninstallArgs", () => {
  it("accepts one scope and --yes in any order", () => {
    expect(parseUninstallArgs([])).toEqual({ scope: null, yes: false });
    expect(parseUninstallArgs(["--yes", "--home"])).toEqual({ scope: "home", yes: true });
    expect(parseUninstallArgs(["--server", "--server"])).toEqual({ scope: "server", yes: false });
  });

  it("refuses two scopes and unknown flags with the usage line", () => {
    expect(parseUninstallArgs(["--all", "--home"])).toMatchObject({
      error: expect.stringContaining("pick one scope"),
    });
    expect(parseUninstallArgs(["--force"])).toMatchObject({
      error: expect.stringContaining('"--force" is not an option'),
    });
  });
});

describe("the home scope", () => {
  it("plans exactly this CLI's files and the managed ssh block", async () => {
    const f = laptop();
    const plan = await describeUninstall(f.runtime, "home");
    expect(plan.server).toBeNull();
    expect(plan.home).toEqual({
      cliConfig: path.join(f.cliHome, "cli.json"),
      sshDirectory: path.join(f.cliHome, "ssh"),
      managedSshBlocks: 1,
      signedIn: { url: "http://m:3105", deviceId: "dev-1" },
      signedInToThisServer: false,
    });
    expect(planDeletesData(plan)).toBe(false);
    expect(planLines(plan, f.runtime.server.configDir)).toEqual([
      `home     ${path.join(f.cliHome, "cli.json")} (signed in to http://m:3105)`,
      `         ${path.join(f.cliHome, "ssh")}`,
      "         1 managed block in ~/.ssh/config",
      "         this machine's workspace ssh key on http://m:3105, if registered",
    ]);
  });

  it("revokes the device, removes the files, strips the block, and drops the empty directory", async () => {
    const f = laptop();
    const plan = await describeUninstall(f.runtime, "home");
    const outcome = await executeUninstall(f.runtime, plan);
    expect(outcome).toEqual({ failures: [], leftovers: [], remaining: [] });
    expect(f.revoked).toEqual(["dev-1"]);
    // The key goes first, while the device token can still ask for it.
    expect(f.order).toEqual(["removeWorkspaceSshKey", "revokeDevice"]);
    expect(f.lines[0]).toBe(
      "removed workspace ssh key SHA256:laptop on http://m:3105 · the gateway refuses it from the next connection",
    );
    expect(fs.existsSync(f.cliHome)).toBe(false);
    expect(fs.readFileSync(f.sshConfigFile, "utf8")).toBe("Host mine\n  HostName mine.example\n");
    expect(f.lines.at(-1)).toBe(`removed ${f.cliHome}`);
  });

  it("fails, naming the fingerprint still registered and what removes it, after removing this machine's files", async () => {
    const f = laptop({
      keyRemoval: {
        removed: [],
        stillActive: ["SHA256:laptop"],
        problem: "SHA256:laptop was not removed: DELETE → 502",
      },
    });
    const plan = await describeUninstall(f.runtime, "home");
    const outcome = await executeUninstall(f.runtime, plan);
    expect(outcome.failures).toEqual([
      "workspace ssh key SHA256:laptop is still registered on http://m:3105: SHA256:laptop was not removed: DELETE → 502. From another signed-in machine: mend ssh keys remove SHA256:laptop, or use Settings → Workspace SSH",
    ]);
    expect(f.revoked).toEqual(["dev-1"]);
    expect(fs.existsSync(f.cliHome)).toBe(false);
  });

  it("fails when this machine's key cannot be identified, never taking it for absent", async () => {
    const f = laptop({
      keyRemoval: {
        removed: [],
        stillActive: [],
        problem: "this machine's key could not be read (/x/id_ed25519.pub: EACCES)",
      },
    });
    const outcome = await executeUninstall(f.runtime, await describeUninstall(f.runtime, "home"));
    expect(outcome.failures).toEqual([
      "this machine's workspace ssh key on http://m:3105 may still be registered: this machine's key could not be read (/x/id_ed25519.pub: EACCES). From another signed-in machine, mend ssh keys lists your keys and mend ssh keys remove <fingerprint> removes one, or use Settings → Workspace SSH",
    ]);
  });

  it("says nothing of a key when the server holds none from this machine", async () => {
    const f = laptop({ keyRemoval: { removed: [], stillActive: [], problem: null } });
    const outcome = await executeUninstall(f.runtime, await describeUninstall(f.runtime, "home"));
    expect(outcome).toEqual({ failures: [], leftovers: [], remaining: [] });
    expect(f.lines.some((line) => line.includes("workspace ssh key"))).toBe(false);
  });

  it("keeps what is not the CLI's and names it", async () => {
    const f = laptop({ extra: true, signedIn: false });
    const plan = await describeUninstall(f.runtime, "home");
    const outcome = await executeUninstall(f.runtime, plan);
    expect(f.revoked).toEqual([]);
    // Signed out: no account to ask, so no key removal is attempted.
    expect(f.order).toEqual([]);
    expect(outcome.failures).toEqual([]);
    expect(outcome.leftovers).toEqual([
      `${f.cliHome}: keys is not Mend's CLI or server configuration (a host-run server's store or keys, or another tool's files), so it stays`,
    ]);
    expect(outcome.remaining).toEqual([f.cliHome]);
    expect(fs.existsSync(path.join(f.cliHome, "keys", "users"))).toBe(true);
    expect(fs.existsSync(path.join(f.cliHome, "cli.json"))).toBe(false);
  });

  it("reports an unconfigured server as nothing to remove under --all, without creating state", async () => {
    const f = laptop();
    const plan = await describeUninstall(f.runtime, "all");
    expect(plan.server).toBe("none");
    expect(planDeletesData(plan)).toBe(false);
    expect(planLines(plan, f.runtime.server.configDir)[0]).toBe(
      `server   none installed under ${f.runtime.server.configDir}`,
    );
    // The lock is the store's; a read must not leave it behind.
    expect(fs.existsSync(path.join(f.runtime.server.configDir, "server.lock"))).toBe(false);
    const outcome = await executeUninstall(f.runtime, plan);
    expect(outcome.failures).toEqual([]);
    expect(fs.existsSync(f.cliHome)).toBe(false);
  });
});

/** What an earlier release's partial uninstall left: a live workspace holding the control volume. */
const leftoversDaemon = (options: { readonly anchor?: boolean } = {}) => {
  const daemon = new DockerProtocol();
  const label = { [SERVER_VOLUME_OWNER_LABEL]: "an-identity-long-deleted" };
  daemon.volumes.set("mend-control", label);
  if (options.anchor === true) daemon.volumes.set("mend-store", label);
  daemon.networks.set("mend_default", { "com.docker.compose.project": "mend" });
  daemon.networks.set("sealant-w1-network", null);
  daemon.containers.set("sealant-w1", {});
  daemon.facts.set("sealant-w1", {
    mounts: ["mend-control"],
    networks: ["mend_default", "sealant-w1-network"],
    state: "running",
    image: "sealant-workspace-arch:latest",
  });
  daemon.containers.set("sealant-w1-docker", { "sealant.workspace": "sealant-w1" });
  daemon.facts.set("sealant-w1-docker", { networks: ["sealant-w1-network"] });
  // Somebody else's: another Sealant's workspace, another Compose project, an unlabelled volume.
  daemon.containers.set("sealant-other", {});
  daemon.facts.set("sealant-other", { mounts: ["other-control"], networks: ["other_default"] });
  daemon.containers.set("other-db-1", { "com.docker.compose.project": "other" });
  daemon.networks.set("other_default", { "com.docker.compose.project": "other" });
  daemon.volumes.set("other-control", null);
  daemon.volumes.set("pgdata", null);
  return daemon;
};

describe("leftovers of an install with no configuration here", () => {
  it("lists the labelled volumes, the network and the live workspace, then removes only those", async () => {
    const daemon = leftoversDaemon();
    const f = laptop({ daemon, signedIn: false });
    const plan = await describeUninstall(f.runtime, "server");
    expect(plan.server).toEqual({
      kind: "leftovers",
      dockerContext: "default",
      volumes: ["mend-control"],
      networks: ["mend_default"],
      containers: [],
      holdings: {
        workspaces: [{ name: "sealant-w1", running: true }],
        sidecars: ["sealant-w1-docker"],
        networks: ["sealant-w1-network"],
        images: ["sealant-workspace-arch:latest"],
      },
    });
    expect(planDeletesData(plan)).toBe(true);
    expect(planLines(plan, f.runtime.server.configDir)).toEqual([
      `server   none configured under ${f.runtime.server.configDir}, but docker context default holds what an earlier Mend install left:`,
      "         volumes mend-control",
      "         networks mend_default",
      "sessions 1 live session · 1 workspace container on docker context default (sealant-w1)",
      "         uninstall stops them, then removes them with their Docker services, volumes and networks; unsaved work in them is lost",
    ]);
    const outcome = await executeUninstall(f.runtime, plan);
    expect(outcome).toEqual({ failures: [], leftovers: [], remaining: [] });
    expect([...daemon.volumes.keys()]).toEqual(["other-control", "pgdata"]);
    expect([...daemon.networks.keys()]).toEqual(["other_default"]);
    expect([...daemon.containers.keys()]).toEqual(["sealant-other", "other-db-1"]);
    // The workspace's anonymous volumes went with it.
    expect(
      daemon.calls.some(({ args }) => args.join(" ").includes("container rm -f -v sealant-w1")),
    ).toBe(true);
    expect(f.lines).toEqual([
      "removed 2 workspace containers, 1 of them live, with their volumes (sealant-w1, sealant-w1-docker)",
      "removed workspace networks sealant-w1-network",
      "removed network mend_default",
      "removed volume mend-control",
    ]);
    // A second run finds nothing left.
    expect((await describeUninstall(f.runtime, "server")).server).toBe("none");
  });

  it("leaves an installation that still has its anchor alone, whoever's it is", async () => {
    const f = laptop({ daemon: leftoversDaemon({ anchor: true }) });
    expect((await describeUninstall(f.runtime, "server")).server).toBe("none");
  });
});

describe("words", () => {
  it("tells a sign-in to the server being removed from one to another server", () => {
    expect(signedInTo("http://10.0.0.52:3105", "http://10.0.0.52:3105", null)).toBe(true);
    expect(signedInTo("http://localhost:3105/", "http://10.0.0.52:3105", null)).toBe(true);
    expect(signedInTo("http://127.0.0.1:3105", "http://localhost:3105", null)).toBe(true);
    expect(signedInTo("https://mend.example", "http://localhost:3105", "mend.example")).toBe(true);
    expect(signedInTo("http://localhost:3106", "http://localhost:3105", null)).toBe(false);
    expect(signedInTo("https://mend.example", "http://localhost:3105", null)).toBe(false);
    expect(signedInTo("not a url", "http://localhost:3105", null)).toBe(false);
  });

  it("reads setup's sysctl file by its marker, and puts back the setting it says it replaced", () => {
    expect(
      sysctlFileOf(
        [
          "# written by mend server setup; mend uninstall removes it",
          "# previous: kernel.unprivileged_userns_clone = 0",
          "kernel.unprivileged_userns_clone = 1",
          "",
        ].join("\n"),
      ),
    ).toEqual({ state: "mend", restore: { key: "kernel.unprivileged_userns_clone", value: "0" } });
    // Written by hand, as the docs once said: the distribution's default comes back.
    expect(sysctlFileOf("kernel.apparmor_restrict_unprivileged_userns = 0\n")).toEqual({
      state: "by-hand",
      restore: { key: "kernel.apparmor_restrict_unprivileged_userns", value: "1" },
    });
    expect(sysctlFileOf("vm.swappiness = 10\n")).toEqual({ state: "by-hand", restore: null });
  });

  it("names the command that restores a host's own user-namespace setting", () => {
    expect(
      sysctlRestoreCommand({ key: "kernel.apparmor_restrict_unprivileged_userns", value: "1" }),
    ).toBe(
      "sudo rm /etc/sysctl.d/60-mend-rootless-docker.conf && sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=1",
    );
    expect(sysctlRestoreCommand(null)).toBe(
      "sudo rm /etc/sysctl.d/60-mend-rootless-docker.conf && sudo sysctl --system",
    );
  });

  it("prints sizes the way Docker does", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(5_781_000_000)).toBe("5.8 GB");
    expect(formatBytes(424_000_000)).toBe("424 MB");
  });
});
