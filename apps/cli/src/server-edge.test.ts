import * as fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  composeOverlays,
  declaredPostureLines,
  EDGE_CADDYFILE,
  EDGE_COMPOSE_OVERLAY,
  EDGE_IMAGE,
  healthPosture,
  observedEdgeLine,
  observedPostureLines,
  parseEdgeHost,
  postureEnvironment,
  postureEnvLines,
  renderPostureOverlay,
} from "./server-edge.ts";

const repositoryFile = (name: string): string =>
  fs.readFileSync(new URL(`../../../deploy/docker/${name}`, import.meta.url), "utf8");

/** What a status line must never say: the report is facts beside a declaration, not a verdict. */
const VERDICTS = /\bsafe\b|gate passed|passed\b|ready to expose|fit to expose|✓/i;

describe("the edge the CLI carries", () => {
  it("is the repository's overlay and Caddyfile, byte for byte", () => {
    // Regenerate with: node apps/cli/scripts/edge-files.mjs
    expect(EDGE_COMPOSE_OVERLAY).toBe(repositoryFile("compose.edge.yaml"));
    expect(EDGE_CADDYFILE).toBe(repositoryFile("Caddyfile"));
  });

  it("pins the image the overlay runs", () => {
    expect(EDGE_COMPOSE_OVERLAY).toContain(`\n    image: ${EDGE_IMAGE}\n`);
    expect(EDGE_COMPOSE_OVERLAY).toContain("MEND_EDGE_HOST:?set MEND_EDGE_HOST in .env");
    expect(EDGE_CADDYFILE).toContain("{$MEND_EDGE_HOST} {");
  });

  it("takes a DNS name a certificate can be issued for, and nothing else", () => {
    expect(parseEdgeHost("Mend.Example.Com.")).toBe("mend.example.com");
    expect(parseEdgeHost(" alpha.mend.run ")).toBe("alpha.mend.run");
    expect(parseEdgeHost("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
    for (const value of [
      "",
      "localhost",
      "mend",
      "10.0.0.4",
      "::1",
      "-mend.example.com",
      "mend-.example.com",
      "mend.example.com/path",
      "mend example.com",
      "${MEND_EDGE_HOST}.example.com",
      `${"a".repeat(64)}.example.com`,
    ]) {
      expect(parseEdgeHost(value), value).toBeNull();
    }
  });
});

describe("the posture", () => {
  it("renders nothing when nothing is declared, so an older generation reads as it did", () => {
    expect(postureEnvironment({})).toEqual([]);
    expect(postureEnvLines({})).toEqual([]);
    expect(renderPostureOverlay({})).toBeUndefined();
    expect(composeOverlays({})).toEqual([]);
  });

  it("names the edge host alone when only the edge is set", () => {
    expect(postureEnvLines({ edgeHost: "mend.example.com" })).toEqual([
      "MEND_EDGE_HOST=mend.example.com",
    ]);
    expect(renderPostureOverlay({ edgeHost: "mend.example.com" })).toBeUndefined();
    expect(composeOverlays({ edgeHost: "mend.example.com" })).toEqual(["compose.edge.yaml"]);
  });

  it("declares exposure and tenancy as stated, and the gate's items with multi or public", () => {
    expect(postureEnvironment({ exposure: "private" })).toEqual([["MEND_EXPOSURE", "private"]]);
    expect(postureEnvironment({ tenancy: "single" })).toEqual([["MEND_TENANCY", "single"]]);
    expect(postureEnvironment({ tenancy: "multi" })).toEqual([
      ["MEND_TENANCY", "multi"],
      ["MEND_SOURCE_POLICY", "tenant"],
      ["MEND_CAPTURE_REQUIRE_SIZES", "true"],
    ]);
    expect(postureEnvironment({ edgeHost: "mend.example.com", exposure: "public" })).toEqual([
      ["MEND_EXPOSURE", "public"],
      ["MEND_SOURCE_POLICY", "tenant"],
      ["MEND_CAPTURE_REQUIRE_SIZES", "true"],
      ["MEND_URL_BEARERS", "refuse"],
    ]);
    expect(
      postureEnvironment({
        edgeHost: "mend.example.com",
        exposure: "public",
        tenancy: "multi",
      }).map(([key]) => key),
    ).toEqual([
      "MEND_EXPOSURE",
      "MEND_TENANCY",
      "MEND_SOURCE_POLICY",
      "MEND_CAPTURE_REQUIRE_SIZES",
      "MEND_URL_BEARERS",
    ]);
    // What the gate asks to be unset is never set.
    for (const posture of [{ tenancy: "multi" as const }, { exposure: "public" as const }]) {
      const keys = postureEnvironment(posture).map(([key]) => key);
      expect(keys).not.toContain("MEND_GIT_TRANSPORT_BIND_ORIGIN");
      expect(keys).not.toContain("MEND_SERVICE_HOSTS");
    }
  });

  it("writes an overlay that names each variable and reads its value from server.env", () => {
    const overlay = renderPostureOverlay({ exposure: "public", tenancy: "multi" });
    expect(overlay).toBe(
      [
        "# Written by mend server setup: the posture this install declares, read from server.env",
        "# (docs/adr/0003-organizations-and-tenancy.md, docs/adr/0004-access-without-a-private-network.md).",
        "# MEND_EXPOSURE and MEND_TENANCY are the operator's statements. With multi tenancy or a public",
        "# exposure, the multi mode gate's configuration items follow: Mend's own git keeps to the tenant",
        "# source policy and every capture upload is signed for its size. MEND_GIT_TRANSPORT_BIND_ORIGIN",
        "# and MEND_SERVICE_HOSTS are not set, which is what the gate asks of them.",
        "services:",
        "  mend:",
        "    environment:",
        "      MEND_EXPOSURE: ${MEND_EXPOSURE:?set MEND_EXPOSURE in server.env}",
        "      MEND_TENANCY: ${MEND_TENANCY:?set MEND_TENANCY in server.env}",
        "      MEND_SOURCE_POLICY: ${MEND_SOURCE_POLICY:?set MEND_SOURCE_POLICY in server.env}",
        "      MEND_CAPTURE_REQUIRE_SIZES: ${MEND_CAPTURE_REQUIRE_SIZES:?set MEND_CAPTURE_REQUIRE_SIZES in server.env}",
        "      MEND_URL_BEARERS: ${MEND_URL_BEARERS:?set MEND_URL_BEARERS in server.env}",
        "",
      ].join("\n"),
    );
    // The value stays in server.env: the overlay names the variable and nothing more.
    expect(overlay).not.toMatch(/MEND_EXPOSURE: public|MEND_TENANCY: multi/);
    expect(composeOverlays({ edgeHost: "mend.example.com", exposure: "public" })).toEqual([
      "compose.edge.yaml",
      "compose.posture.yaml",
    ]);
  });
});

describe("what status says", () => {
  it("reads the posture a health body carries, and null for what it does not", () => {
    expect(healthPosture({ status: "ok", version: "0.23.0" })).toEqual({
      tenancy: null,
      tenancyGate: null,
      exposure: null,
    });
    expect(
      healthPosture({
        tenancy: "multi",
        tenancyGate: { passed: false, failing: ["source-policy", 4] },
        exposure: { declared: "public", open: 3, unobservable: 3 },
      }),
    ).toEqual({
      tenancy: "multi",
      tenancyGate: { passed: false, failing: ["source-policy"] },
      exposure: { declared: "public", open: 3, unobservable: 3 },
    });
    expect(healthPosture({ tenancy: "plural", exposure: { declared: "public" } })).toEqual({
      tenancy: null,
      tenancyGate: null,
      exposure: null,
    });
    expect(healthPosture(null).exposure).toBeNull();
  });

  it("says what was declared, with a default named as one", () => {
    expect(declaredPostureLines({})).toEqual([
      "exposure · declared private · the default, not set on this install",
      "tenancy · declared single · the default, not set on this install",
    ]);
    expect(
      declaredPostureLines({ edgeHost: "alpha.mend.run", exposure: "public", tenancy: "multi" }),
    ).toEqual([
      "edge · alpha.mend.run · caddy:2.10-alpine on 80 and 443 · Mend's own port on loopback",
      "exposure · declared public",
      "tenancy · declared multi",
    ]);
  });

  it("says what the edge showed, and when nothing was looked at", () => {
    expect(
      observedEdgeLine("alpha.mend.run", { running: true, certificate: { kind: "none" } }),
    ).toBe(
      "edge · alpha.mend.run · container running · no certificate in Caddy's data yet · mend server logs shows what Caddy tried",
    );
    expect(
      observedEdgeLine("alpha.mend.run", {
        running: true,
        certificate: {
          kind: "observed",
          file: "/data/caddy/certificates/x/alpha.mend.run/alpha.mend.run.crt",
        },
      }),
    ).toBe(
      "edge · alpha.mend.run · container running · certificate observed in Caddy's data · /data/caddy/certificates/x/alpha.mend.run/alpha.mend.run.crt",
    );
    // A stopped edge or a refused look is not an absence: the line says no look was taken.
    expect(
      observedEdgeLine("alpha.mend.run", {
        running: false,
        certificate: {
          kind: "unavailable",
          reason: "the edge is not running, so its data was not read",
        },
      }),
    ).toBe(
      "edge · alpha.mend.run · container not running · certificate not observed · the edge is not running, so its data was not read",
    );
  });

  it("puts what was observed beside what was declared, and names a server started before the declaration changed", () => {
    const lines = observedPostureLines(
      { exposure: "public", tenancy: "multi" },
      {
        tenancy: "single",
        tenancyGate: { passed: false, failing: ["source-policy"] },
        exposure: { declared: "private", open: 1, unobservable: 1 },
      },
    );
    expect(lines).toEqual([
      "exposure · observed private · public exposure gate · 1 item open · 0 this build can observe · 1 no build can · mend operator exposure lists them",
      "exposure · the running server declares private, this install public: it was started before the last mend server setup",
      "tenancy · observed single · multi mode gate · open: source-policy · mend operator gate lists every item",
      "tenancy · the running server declares single, this install multi: it was started before the last mend server setup",
    ]);
    expect(
      observedPostureLines(
        {},
        {
          tenancy: "single",
          tenancyGate: { passed: true, failing: [] },
          exposure: { declared: "private", open: 0, unobservable: 0 },
        },
      ),
    ).toEqual([
      "exposure · observed private · public exposure gate · nothing open · mend operator exposure lists them",
      "tenancy · observed single · multi mode gate · nothing open · mend operator gate lists every item",
    ]);
    expect(observedPostureLines({}, { tenancy: null, tenancyGate: null, exposure: null })).toEqual([
      "exposure · observed · this server reports no exposure · it predates the gate",
      "tenancy · observed · this server reports no tenancy · it predates organizations",
    ]);
  });

  it("never words a report as a verdict", () => {
    const everything = [
      ...declaredPostureLines({ edgeHost: "a.example.com", exposure: "public", tenancy: "multi" }),
      observedEdgeLine("a.example.com", {
        running: true,
        certificate: { kind: "observed", file: "/data/x.crt" },
      }),
      observedEdgeLine("a.example.com", {
        running: false,
        certificate: { kind: "unavailable", reason: "the edge is not running" },
      }),
      ...observedPostureLines(
        { exposure: "public", tenancy: "multi" },
        {
          tenancy: "multi",
          tenancyGate: { passed: true, failing: [] },
          exposure: { declared: "public", open: 0, unobservable: 0 },
        },
      ),
    ];
    for (const line of everything) {
      expect(line).not.toMatch(VERDICTS);
      expect(line).not.toMatch(/[—–;()]/);
    }
  });
});
