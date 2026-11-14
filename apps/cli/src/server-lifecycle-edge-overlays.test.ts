import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand } from "./server-setup.ts";

const { cleanups, fixture, repositoryFile, host } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("the edge and the posture", { timeout: 120_000 }, () => {
  it("an edge host and the posture travel with every generation: setup, upgrade, start and restart run the overlays", async () => {
    const f = await fixture();
    expect(await f.setupEdge(host, "--exposure", "private", "--tenancy", "single")).toEqual({
      _tag: "ok",
    });
    const before = f.files();
    // The generation holds the repository's edge files byte for byte, and names the posture.
    expect(before["compose.edge.yaml"]).toBe(repositoryFile("compose.edge.yaml"));
    expect(before["Caddyfile"]).toBe(repositoryFile("Caddyfile"));
    expect(fs.statSync(path.join(f.active(), "Caddyfile")).mode & 0o777).toBe(0o644);
    expect(before["compose.posture.yaml"]).toContain(
      "      MEND_EXPOSURE: ${MEND_EXPOSURE:?set MEND_EXPOSURE in server.env}",
    );
    expect(before["compose.posture.yaml"]).toContain("      MEND_TENANCY: ${MEND_TENANCY:?");
    expect(before["compose.posture.yaml"]).not.toContain("MEND_SOURCE_POLICY");
    expect(JSON.parse(before["server.json"] ?? "{}")).toMatchObject({
      edgeHost: host,
      exposure: "private",
      tenancy: "single",
      bind: "127.0.0.1",
      appUrl: `https://${host}`,
    });
    const env = before["server.env"] ?? "";
    expect(env).toContain(`MEND_EDGE_HOST=${host}\n`);
    expect(env).toContain("MEND_EXPOSURE=private\n");
    expect(env).toContain("MEND_TENANCY=single\n");
    expect(env).toContain(`APP_URL=https://${host}\n`);
    expect(env).toContain("MEND_BIND_HOST=127.0.0.1\n");
    expect(env).toContain(`SEALANT_SSH_HOST=${host}\n`);
    expect(env).not.toContain("MEND_SOURCE_POLICY");
    // Compose ran the base file and both overlays, in that order, and the edge came up.
    expect(f.state().upFiles).toEqual([
      "compose.yaml",
      "compose.edge.yaml",
      "compose.posture.yaml",
      "compose.mirrors.yaml",
    ]);
    expect(f.state().edgeRunning).toBe(true);
    // Health and the accounts question were read on Mend's own loopback port, never through the
    // edge's public name; beside them only where this machine's CLI points by default.
    expect(
      f.fetched.every(
        (request) =>
          request === `http://127.0.0.1:${f.port}/api/health` ||
          request === `http://127.0.0.1:${f.port}/api/instance` ||
          request === "http://localhost:3105/api/health",
      ),
    ).toBe(true);
    expect(f.fetched.some((request) => request.includes(host))).toBe(false);
    expect(f.lines).toContain(
      `Mend 0.23.0 answers at http://127.0.0.1:${f.port} on this machine · the edge is set up for https://${host}`,
    );
    expect(
      f.lines.some((line) => line.startsWith(`The edge for ${host} is up on 80 and 443.`)),
    ).toBe(true);
    // The edge image is checked beside the bundle's, from the generation's own overlay.
    expect(f.runCalls.some((call) => call.args.includes("caddy:2.10-alpine"))).toBe(true);

    // An upgrade carries all of it: same overlays, same values, the new version.
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    const after = f.files();
    expect(after["compose.edge.yaml"]).toBe(before["compose.edge.yaml"]);
    expect(after["Caddyfile"]).toBe(before["Caddyfile"]);
    expect(after["compose.posture.yaml"]).toBe(before["compose.posture.yaml"]);
    expect(after["server.env"]).toBe(env.replace("MEND_VERSION=0.23.0", "MEND_VERSION=0.24.0"));
    expect(JSON.parse(after["server.json"] ?? "{}")).toMatchObject({
      serverVersion: "0.24.0",
      edgeHost: host,
      exposure: "private",
      tenancy: "single",
    });
    expect(f.state().upFiles).toEqual([
      "compose.yaml",
      "compose.edge.yaml",
      "compose.posture.yaml",
      "compose.mirrors.yaml",
    ]);
    for (const command of [["restart"], ["stop"], ["start", "--offline"]]) {
      expect(await serverCommand(command, f.runtime)).toEqual({ _tag: "ok" });
      expect(f.state().upFiles).toEqual([
        "compose.yaml",
        "compose.edge.yaml",
        "compose.posture.yaml",
        "compose.mirrors.yaml",
      ]);
    }
    expect(f.lines).toContain(
      "Mend, Postgres, Garage, the edge, the npm mirror and the Docker mirror stopped. Volumes, configuration and workspace containers are retained.",
    );
    expect(f.state().edgeRunning).toBe(true);
  });

  it("an upgrade from a generation with 0.36.0's Caddyfile writes the current one, and runs the edge from it", async () => {
    const f = await fixture();
    expect(await f.setupEdge(host, "--exposure", "private", "--tenancy", "single")).toEqual({
      _tag: "ok",
    });
    const released = fs.readFileSync(
      new URL("../test-fixtures/Caddyfile-0.36.0", import.meta.url),
      "utf8",
    );
    expect(released).not.toBe(repositoryFile("Caddyfile"));
    fs.writeFileSync(path.join(f.active(), "Caddyfile"), released);
    const before = f.active();
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    expect(f.active()).not.toBe(before);
    expect(f.files()["Caddyfile"]).toBe(repositoryFile("Caddyfile"));
    expect(f.state()).toMatchObject({ edgeRunning: true, edgeDirectory: f.active() });
  });
});
