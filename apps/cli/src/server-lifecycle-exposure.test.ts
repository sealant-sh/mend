import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand } from "./server-setup.ts";

const { cleanups, fixture, host } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("the edge and the posture", { timeout: 120_000 }, () => {
  it("status says what was declared beside what was observed, and never a verdict", async () => {
    const f = await fixture();
    expect(await f.setupEdge(host, "--exposure", "private")).toEqual({ _tag: "ok" });
    // Stopped, the edge's data is not read: the line says so instead of claiming an absence.
    expect(await serverCommand(["stop"], f.runtime)).toEqual({ _tag: "ok" });
    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(
      `edge · ${host} · container not running · certificate not observed · the edge is not running, so its data was not read`,
    );
    expect(f.lines).toContain("Mend is stopped. No health claim was made.");
    expect(await serverCommand(["start", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(
      `edge · ${host} · caddy:2.10-alpine on 80 and 443 · Mend's own port on loopback`,
    );
    expect(f.lines).toContain("exposure · declared private");
    expect(f.lines).toContain("tenancy · declared single · the default, not set on this install");
    expect(f.lines).toContain(
      `edge · ${host} · container running · no certificate in Caddy's data yet · mend server logs shows what Caddy tried`,
    );
    // A health body from before the gates reports neither; status says so instead of guessing.
    expect(f.lines).toContain(
      "exposure · observed · this server reports no exposure · it predates the gate",
    );
    expect(
      f.lines.some((line) =>
        line.startsWith("gate items · every item with its detail needs the operator's sign-in"),
      ),
    ).toBe(true);

    const certificate = `/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${host}/${host}.crt`;
    f.update({
      certificate,
      health: {
        tenancy: "single",
        tenancyGate: { passed: false, failing: ["source-policy", "upload-length-binding"] },
        exposure: { declared: "private", open: 5, unobservable: 3 },
      },
    });
    fs.writeFileSync(
      path.join(f.configDir, "cli.json"),
      JSON.stringify({ url: `https://${host}`, token: "operator-token" }),
    );
    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(
      `edge · ${host} · container running · certificate observed in Caddy's data · ${certificate}`,
    );
    for (const line of f.lines) expect(line).not.toMatch(/[—–]/);
    expect(f.lines).toContain(
      "exposure · observed private · public exposure gate · 5 items open · 2 this build can observe · 3 no build can · mend operator exposure lists them",
    );
    expect(f.lines).toContain(
      "tenancy · observed single · multi mode gate · open: source-policy, upload-length-binding · mend operator gate lists every item",
    );
    // The operator's reports came through the saved sign-in, as a bearer, on the loopback port.
    expect(f.lines).toContain("multi mode gate, as the server reports each item:");
    expect(f.lines).toContain("public exposure gate, as the server reports each item:");
    expect(
      f.lines.some((line) => line.includes("source-policy") && line.includes("operator policy")),
    ).toBe(true);
    expect(f.lines.some((line) => line.includes("edge-tls") && line.includes("open"))).toBe(true);
    expect(
      f.requests
        .filter((request) => request.url.startsWith("/api/operator/"))
        .map((r) => r.authorization),
    ).toEqual(["Bearer operator-token", "Bearer operator-token"]);
    for (const line of f.lines) {
      expect(line).not.toMatch(/\bsafe\b|gate passed|ready to expose|fit to expose/i);
    }

    // Signed in elsewhere: the reports are not read, and status says where the sign-in points.
    fs.writeFileSync(
      path.join(f.configDir, "cli.json"),
      JSON.stringify({ url: "https://other.example.test", token: "operator-token" }),
    );
    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(
      `gate items · this machine is signed in to https://other.example.test, not https://${host} · not read`,
    );
  });

  it("a public, multi install renders the gate's environment, after the first account exists", async () => {
    const f = await fixture();
    // A fresh box takes neither the edge nor public: registration would be open on the origin.
    for (const flags of [["--exposure", "public"], [], ["--exposure", "private"]]) {
      expect(await f.freshEdge(host, ...flags)).toMatchObject({
        _tag: "error",
        message: expect.stringContaining("A fresh install cannot start with the edge or as public"),
      });
    }
    expect(fs.existsSync(path.join(f.configDir, "active"))).toBe(false);
    expect(await f.setupEdge(host)).toEqual({ _tag: "ok" });
    const plain = f.files();
    expect(plain["compose.posture.yaml"]).toBeUndefined();
    expect(f.state().upFiles).toEqual([
      "compose.yaml",
      "compose.edge.yaml",
      "compose.mirrors.yaml",
    ]);
    expect(
      await serverCommand(["setup", "--exposure", "public", "--tenancy", "multi"], f.runtime),
    ).toEqual({ _tag: "ok" });
    const env = f.files()["server.env"] ?? "";
    for (const line of [
      `MEND_EDGE_HOST=${host}`,
      "MEND_EXPOSURE=public",
      "MEND_TENANCY=multi",
      "MEND_SOURCE_POLICY=tenant",
      "MEND_CAPTURE_REQUIRE_SIZES=true",
      "MEND_URL_BEARERS=refuse",
    ]) {
      expect(env).toContain(`${line}\n`);
    }
    expect(env).not.toContain("MEND_GIT_TRANSPORT_BIND_ORIGIN");
    expect(env).not.toContain("MEND_SERVICE_HOSTS");
    const posture = f.files()["compose.posture.yaml"] ?? "";
    for (const key of [
      "MEND_EXPOSURE",
      "MEND_TENANCY",
      "MEND_SOURCE_POLICY",
      "MEND_CAPTURE_REQUIRE_SIZES",
      "MEND_URL_BEARERS",
    ]) {
      expect(posture).toContain(`      ${key}: \${${key}:?set ${key} in server.env}`);
    }
    expect(posture).not.toContain("=public");
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    expect(f.files()["server.env"]).toBe(env.replace("MEND_VERSION=0.23.0", "MEND_VERSION=0.24.0"));
    expect(f.files()["compose.posture.yaml"]).toBe(posture);
    expect(JSON.parse(f.files()["server.json"] ?? "{}")).toMatchObject({
      exposure: "public",
      tenancy: "multi",
      edgeHost: host,
    });
  });
});
