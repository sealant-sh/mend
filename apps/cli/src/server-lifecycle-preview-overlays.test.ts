import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hasOpenssl, makeCertificate } from "../test-fixtures/preview-certificate.ts";
import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand } from "./server-setup.ts";

const { cleanups, fixture, host } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
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
