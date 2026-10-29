import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hasOpenssl, makeCertificate } from "../test-fixtures/preview-certificate.ts";
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

  it("the t3code gateway's overlay runs with every start, and status says what this machine observed at its port", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    f.update({ gatewayImages: ["0.23.0"] });
    let answering = true;
    const gatewayProbes: Array<string> = [];
    const runtime = {
      ...f.runtime,
      fetchText: async (
        url: string,
        timeout: number,
        headers?: Readonly<Record<string, string>>,
      ) => {
        if (url.startsWith("http://127.0.0.1:3120/")) {
          gatewayProbes.push(url);
          return answering
            ? { status: 200, body: '{"environmentId":"e"}' }
            : { status: 0, body: "", error: "connect ECONNREFUSED" };
        }
        return f.runtime.fetchText(url, timeout, headers);
      },
    };
    expect(await serverCommand(["setup", "--offline", "--t3-gateway"], runtime)).toEqual({
      _tag: "ok",
    });
    // Setup looked at the port once Mend answered, and said what it saw.
    expect(gatewayProbes).toEqual(["http://127.0.0.1:3120/.well-known/t3/environment"]);
    expect(
      f.lines.some((line) => line.startsWith("The t3code gateway answered at 127.0.0.1:3120")),
    ).toBe(true);
    gatewayProbes.length = 0;
    expect(f.state().upFiles).toEqual(["compose.yaml", "compose.mirrors.yaml", "compose.t3.yaml"]);
    for (const command of [["restart"], ["stop"], ["start", "--offline"]]) {
      expect(await serverCommand(command, runtime)).toEqual({ _tag: "ok" });
      expect(f.state().upFiles).toEqual([
        "compose.yaml",
        "compose.mirrors.yaml",
        "compose.t3.yaml",
      ]);
    }
    f.lines.length = 0;
    expect(await serverCommand(["status"], runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(
      "t3code gateway · on · published on 127.0.0.1:3120 only · reached from this machine",
    );
    expect(f.lines).toContain(
      "t3code gateway · observed answering at 127.0.0.1:3120 from this machine · T3 Code's Remote link takes http://127.0.0.1:3120",
    );
    expect(gatewayProbes).toEqual(["http://127.0.0.1:3120/.well-known/t3/environment"]);
    answering = false;
    f.lines.length = 0;
    expect(await serverCommand(["status"], runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(
      "t3code gateway · not observed at 127.0.0.1:3120 from this machine · mend server logs shows what it said",
    );
    for (const line of f.lines) expect(line).not.toMatch(/\bsafe\b|gate passed/i);
  });

  it("refuses an upgrade that carries the gateway onto an image without it, and keeps the pin (644-1)", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    f.update({ gatewayImages: ["0.23.0"] });
    const runtime = {
      ...f.runtime,
      fetchText: async (url: string, timeout: number, headers?: Readonly<Record<string, string>>) =>
        url.startsWith("http://127.0.0.1:3120/")
          ? { status: 200, body: '{"environmentId":"e"}' }
          : f.runtime.fetchText(url, timeout, headers),
    };
    expect(await serverCommand(["setup", "--offline", "--t3-gateway"], runtime)).toMatchObject({
      _tag: "ok",
    });
    const old = f.active();
    // 0.24.0's image has no gateway: the carried setting is refused before anything stops.
    expect(await f.upgrade()).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("Mend 0.24.0 has no t3code gateway"),
    });
    expect(f.active()).toBe(old);
    expect(f.state().appRunning).toBe(true);
    expect(f.calls().some((call) => call.command[0] === "stop")).toBe(false);
    // An image that carries it upgrades as before.
    f.update({ gatewayImages: ["0.23.0", "0.24.0"] });
    expect(await f.upgrade()).toMatchObject({ _tag: "ok" });
  });
});

describe("previews behind the edge", { timeout: 120_000 }, () => {
  it.skipIf(!hasOpenssl)(
    "an upgrade carries setup's copies of the certificate and key, byte for byte and mode for mode",
    async () => {
      const f = await fixture();
      const files = makeCertificate(f.root, ["*.previews.example.net"]);
      expect(
        await f.setupEdge(
          host,
          "--preview-domain",
          "previews.example.net",
          "--preview-certificate",
          files.certificate,
          "--preview-key",
          files.key,
        ),
      ).toEqual({ _tag: "ok" });
      const before = f.files();
      expect(await f.upgrade()).toEqual({ _tag: "ok" });
      const after = f.files();
      for (const name of ["preview-certificate.pem", "preview-key.pem", "compose.preview.yaml"])
        expect(after[name], name).toBe(before[name]);
      expect(fs.statSync(path.join(f.active(), "preview-key.pem")).mode & 0o777).toBe(0o640);
      expect(after["preview-key.pem"]).toBe(fs.readFileSync(files.key, "utf8"));
    },
  );
});

describe("previews on the tailnet", { timeout: 120_000 }, () => {
  it("an upgrade carries the tailnet mode: its overlay, its server.env lines and its saved ports", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const origin = "https://mend-box.tailc79e49.ts.net";
    const local = `http://127.0.0.1:${f.port}`;
    // Tailscale here, faked: setup only reads its status. Tailscale Serve's https origin reaches the
    // fixture's Mend, as `tailscale serve --https=443` would.
    const runtime = {
      ...f.runtime,
      run: async (...call: Parameters<typeof f.runtime.run>) =>
        call[0] === "tailscale"
          ? call[1][0] === "status"
            ? {
                status: 0,
                stdout: JSON.stringify({
                  BackendState: "Running",
                  Self: { DNSName: "mend-box.tailc79e49.ts.net." },
                  CurrentTailnet: { MagicDNSSuffix: "tailc79e49.ts.net", MagicDNSEnabled: true },
                }),
                stderr: "",
              }
            : { status: 1, stdout: "", stderr: "" }
          : f.runtime.run(...call),
      fetchText: (request: string, timeout: number, headers?: Readonly<Record<string, string>>) =>
        f.runtime.fetchText(
          request.startsWith(origin) ? `${local}${request.slice(origin.length)}` : request,
          timeout,
          headers,
        ),
    };
    expect(
      await serverCommand(
        ["setup", "--offline", "--url", origin, "--preview-tailnet-ports", "20001-20004"],
        runtime,
      ),
    ).toEqual({ _tag: "ok" });
    const before = f.files();
    expect(
      await serverCommand(
        ["upgrade", "--version", "0.24.0", "--assets-dir", f.assets, "--offline"],
        runtime,
      ),
    ).toEqual({ _tag: "ok" });
    const after = f.files();
    expect(after["compose.preview.yaml"]).toBe(before["compose.preview.yaml"]);
    expect(after["compose.preview.yaml"]).toContain("MEND_PREVIEW_TAILNET_HOSTNAME");
    expect(after["server.env"]).toContain(
      "MEND_PREVIEW_TAILNET_HOSTNAME=mend-preview.tailc79e49.ts.net\n",
    );
    expect(after["server.env"]).toContain("MEND_PREVIEW_TAILNET_PORTS=20001-20004\n");
    expect(JSON.parse(after["server.json"] ?? "{}").preview).toEqual({
      mode: "tailnet",
      hostname: "mend-preview.tailc79e49.ts.net",
      ports: [20001, 20002, 20003, 20004],
    });
    expect(Object.keys(after)).not.toContain("Caddyfile.preview");
  });
});
