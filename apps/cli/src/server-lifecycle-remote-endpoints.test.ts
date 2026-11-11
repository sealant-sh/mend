import { afterEach, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand } from "./server-setup.ts";

const { cleanups, fixture } = lifecycleTestFixtures();
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it(
  "keeps remote addresses and the last overlay across upgrade, restart and start",
  { timeout: 120_000 },
  async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(
      await serverCommand(
        [
          "setup",
          "--offline",
          "--session-endpoint-url",
          "https://mend.example.com:8443",
          "--blob-store-public-url",
          "https://mend.example.com:10000",
        ],
        f.runtime,
      ),
    ).toEqual({ _tag: "ok" });
    const before = f.files();
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    expect(f.files()["compose.remote-endpoints.yaml"]).toBe(
      before["compose.remote-endpoints.yaml"],
    );
    expect(f.files()["server.env"]).toBe(
      before["server.env"]?.replace("MEND_VERSION=0.23.0", "MEND_VERSION=0.24.0"),
    );
    for (const command of [["restart"], ["stop"], ["start", "--offline"]]) {
      expect(await serverCommand(command, f.runtime)).toEqual({ _tag: "ok" });
      expect(f.state().upFiles?.at(-1)).toBe("compose.remote-endpoints.yaml");
    }
  },
);

it(
  "has the edge serve both endpoints on names of their own, with only 80 and 443 open",
  { timeout: 120_000 },
  async () => {
    const f = await fixture();
    expect(
      await f.setupEdge(
        "mend.example.com",
        "--session-endpoint-url",
        "https://session.mend.example.com",
        "--blob-store-public-url",
        "https://files.mend.example.com",
      ),
    ).toEqual({ _tag: "ok" });
    const files = f.files();
    expect(files["Caddyfile.remote-endpoints"]).toContain("reverse_proxy mend:3106");
    expect(files["Caddyfile.remote-endpoints"]).toContain("reverse_proxy garage:3900");
    expect(files["server.env"]).toContain(
      "MEND_SESSION_ENDPOINT_EDGE_HOST=session.mend.example.com\n",
    );
    expect(files["server.env"]).toContain("MEND_BLOB_STORE_EDGE_HOST=files.mend.example.com\n");
    const overlay = files["compose.remote-endpoints.yaml"] ?? "";
    expect(overlay).toContain("networks: [default, edge]");
    expect(overlay).toContain(
      "./Caddyfile.remote-endpoints:/etc/caddy/sites/remote-endpoints.caddy:ro",
    );
    // Survives an upgrade; and an endpoint with a port of its own is the operator's proxy again.
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    expect(f.files()["Caddyfile.remote-endpoints"]).toBe(files["Caddyfile.remote-endpoints"]);
    expect(
      await serverCommand(
        [
          "setup",
          "--offline",
          "--session-endpoint-url",
          "https://mend.example.com:8443",
          "--blob-store-public-url",
          "https://mend.example.com:10000",
        ],
        f.runtime,
      ),
    ).toEqual({ _tag: "ok" });
    expect(f.files()["Caddyfile.remote-endpoints"]).toBeUndefined();
    expect(f.files()["compose.remote-endpoints.yaml"]).not.toContain("edge:");
  },
);
