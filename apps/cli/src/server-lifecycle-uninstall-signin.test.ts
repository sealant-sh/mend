import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { describeUninstall, executeUninstall, planLines, planRefusal } from "./uninstall.ts";

const { cleanups, fixture, sshBlock, uninstallRuntime } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("server uninstall with live sessions", { timeout: 60_000 }, () => {
  it("with Docker stopped, refuses everything up front and leaves this machine's files and sign-in alone", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    f.update({ fail: "docker-down" });
    const calls: Array<string> = [];
    const runtime = uninstallRuntime(f, { signedIn: "https://elsewhere.example", calls });
    const plan = await describeUninstall(runtime, "all");
    const refusal =
      "Docker is not answering on context saved-local (Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?), so nothing was removed. Start Docker and run mend uninstall again, or run mend uninstall --home to remove only this machine's files.";
    expect(planRefusal(plan)).toBe(refusal);
    expect(await executeUninstall(runtime, plan)).toEqual({
      failures: [refusal],
      leftovers: [],
      remaining: [],
    });
    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(runtime.cliHome, "cli.json"))).toBe(true);
    expect(fs.existsSync(path.join(f.configDir, "identity.env"))).toBe(true);
  });

  it("does not revoke a sign-in to the server it deletes, and clears it under --server", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const appUrl = `http://127.0.0.1:${f.port}`;
    const calls: Array<string> = [];
    const all = uninstallRuntime(f, { signedIn: appUrl, calls });
    const plan = await describeUninstall(all, "all");
    expect(plan.home).toMatchObject({ signedInToThisServer: true });
    expect(planLines(plan, f.configDir).join("\n")).not.toContain("workspace ssh key on");
    const outcome = await executeUninstall(all, plan);
    expect(outcome.failures).toEqual([]);
    expect(calls).toEqual([]);
    expect(f.lines).toContain(
      `this terminal's device token and workspace ssh key on ${appUrl} went with the server's database`,
    );

    const g = await fixture();
    expect(await g.setup()).toEqual({ _tag: "ok" });
    const serverCalls: Array<string> = [];
    const server = uninstallRuntime(g, {
      signedIn: `http://localhost:${g.port}`,
      calls: serverCalls,
    });
    expect(
      (await executeUninstall(server, await describeUninstall(server, "server"))).failures,
    ).toEqual([]);
    expect(serverCalls).toEqual(["forgetSignIn"]);
    expect(g.lines).toContain(
      `signed out of http://localhost:${g.port}: its device token went with the server`,
    );
  });

  it("with a sign-in to another server, removes the server first, then revokes, then the files", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const calls: Array<string> = [];
    const runtime = uninstallRuntime(f, { signedIn: "https://elsewhere.example", calls });
    const outcome = await executeUninstall(runtime, await describeUninstall(runtime, "all"));
    expect(outcome.failures).toEqual([]);
    expect(calls).toEqual(["removeWorkspaceSshKey", "revokeDevice"]);
    const removedServer = f.lines.findIndex((line) => line.startsWith("removed containers"));
    const revoked = f.lines.indexOf("revoked this terminal's device on https://elsewhere.example");
    const removedFiles = f.lines.indexOf(`removed ${path.join(runtime.cliHome, "cli.json")}`);
    expect(removedServer).toBeGreaterThanOrEqual(0);
    expect(revoked).toBeGreaterThan(removedServer);
    expect(removedFiles).toBeGreaterThan(revoked);
  });

  it("everything removes this installation's ~/.ssh/config block, found by its gateway after a URL change, and nothing else", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    // Set up while the server answered at another URL, on the port it publishes SSH on.
    const ours = sshBlock("http://localhost:3999", 2222);
    const other = sshBlock("http://10.0.0.214:3105", 2222);
    const legacy =
      "# >>> mend workspace ssh (managed by `mend ssh setup`) >>>\nHost mend-ws\n  HostName 10.0.0.214\n  Port 2222\nHost *\n# <<< mend workspace ssh <<<\n";
    const mine = "Host mine\n  HostName mine.example\n";
    const runtime = uninstallRuntime(f, { signedIn: "https://elsewhere.example" });
    fs.writeFileSync(runtime.sshConfigFile, `${ours.text}${other.text}${legacy}${mine}`);
    const plan = await describeUninstall(runtime, "all");
    expect(plan.home?.sshBlocks.map((entry) => entry.alias)).toEqual([ours.alias]);
    const outcome = await executeUninstall(runtime, plan);
    expect(outcome.failures).toEqual([]);
    expect(fs.readFileSync(runtime.sshConfigFile, "utf8")).toBe(`${other.text}${legacy}${mine}`);
    expect(outcome.leftovers).toEqual([
      expect.stringContaining("Host mend-ws → 10.0.0.214:2222 stays"),
    ]);
  });
});
