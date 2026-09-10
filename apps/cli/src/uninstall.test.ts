import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ServerSetupRuntime } from "./server-setup.ts";
import {
  describeUninstall,
  executeUninstall,
  parseUninstallArgs,
  planDeletesData,
  planLines,
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
const laptop = (options: { readonly signedIn?: boolean; readonly extra?: boolean } = {}) => {
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
  const server: ServerSetupRuntime = {
    configDir: path.join(root, "config", "mend"),
    platform: "linux",
    cliVersion: "0.0.0-test",
    run: async () => ({ status: 1, stdout: "", stderr: "docker must not run here" }),
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
      return null;
    },
  };
  return { root, cliHome, sshConfigFile, runtime, lines, revoked };
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
    });
    expect(planDeletesData(plan)).toBe(false);
    expect(planLines(plan, f.runtime.server.configDir)).toEqual([
      `home     ${path.join(f.cliHome, "cli.json")} (signed in to http://m:3105)`,
      `         ${path.join(f.cliHome, "ssh")}`,
      "         1 managed block in ~/.ssh/config",
    ]);
  });

  it("revokes the device, removes the files, strips the block, and drops the empty directory", async () => {
    const f = laptop();
    const plan = await describeUninstall(f.runtime, "home");
    const outcome = await executeUninstall(f.runtime, plan);
    expect(outcome).toEqual({ failures: [], leftovers: [] });
    expect(f.revoked).toEqual(["dev-1"]);
    expect(fs.existsSync(f.cliHome)).toBe(false);
    expect(fs.readFileSync(f.sshConfigFile, "utf8")).toBe("Host mine\n  HostName mine.example\n");
    expect(f.lines.at(-1)).toBe(`removed ${f.cliHome}`);
  });

  it("keeps what is not the CLI's and names it", async () => {
    const f = laptop({ extra: true, signedIn: false });
    const plan = await describeUninstall(f.runtime, "home");
    const outcome = await executeUninstall(f.runtime, plan);
    expect(f.revoked).toEqual([]);
    expect(outcome.failures).toEqual([]);
    expect(outcome.leftovers).toEqual([
      `${f.cliHome} kept: keys is not this CLI's (a host-run server's store or keys, or another tool's files)`,
    ]);
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
