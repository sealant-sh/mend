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
  renderT3GatewayOverlay,
  T3_GATEWAY_CADDYFILE,
  t3GatewayEnvLines,
  t3GatewayPlacement,
} from "./server-edge.ts";

const repositoryFile = (name: string): string =>
  fs.readFileSync(new URL(`../../../deploy/docker/${name}`, import.meta.url), "utf8");

/** The access log's uri filter, applied the way Caddy's regexp filter does (Go's ReplaceAll). */
const loggedUri = (caddyfile: string, uri: string) => {
  const [, pattern = "", replacement = ""] =
    /\buri regexp "([^"]+)" "([^"]*)"/.exec(caddyfile) ?? [];
  return uri.replace(new RegExp(pattern, "g"), replacement.replace(/\$\{(\d+)\}/g, "$$$1"));
};

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

  it("hands the gate where workspace SSH is published apart from the web port, and what was declared", () => {
    expect(postureEnvironment({ sshBind: "0.0.0.0", sshPort: 2222 })).toEqual([
      ["MEND_SSH_PUBLISHED", "0.0.0.0:2222"],
    ]);
    expect(
      postureEnvironment({ sshBind: "fd00::1", sshPort: 2222, declared: ["workspace-ssh"] }),
    ).toEqual([
      ["MEND_SSH_PUBLISHED", "[fd00::1]:2222"],
      ["MEND_EXPOSURE_DECLARED", "workspace-ssh"],
    ]);
    // Neither set: nothing new, and no overlay where there was none.
    expect(postureEnvironment({ sshPort: 2222, declared: [] })).toEqual([]);
    expect(renderPostureOverlay({ sshPort: 2222 })).toBeUndefined();
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

describe("where the t3code gateway is published (ADR 0012, ADR 0004)", () => {
  it("off, it is nowhere and adds nothing", () => {
    expect(t3GatewayPlacement({ bind: "100.94.101.28" })).toBeUndefined();
    expect(t3GatewayEnvLines({ bind: "100.94.101.28" })).toEqual([]);
    expect(renderT3GatewayOverlay({ bind: "100.94.101.28" })).toBeUndefined();
  });

  it("loopback: it stays on loopback, reached from this machine", () => {
    const posture = {
      bind: "127.0.0.1",
      appUrl: "http://localhost:3105",
      exposure: "loopback" as const,
      t3GatewayPort: 3120,
    };
    expect(t3GatewayPlacement(posture)).toEqual({
      bind: "127.0.0.1",
      port: 3120,
      url: "http://127.0.0.1:3120",
      probeUrl: "http://127.0.0.1:3120",
    });
    expect(t3GatewayEnvLines(posture)).toEqual([
      "MEND_T3_GATEWAY_PORT=3120",
      "MEND_T3_GATEWAY_BIND_HOST=127.0.0.1",
      "MEND_T3_GATEWAY_PUBLISHED=127.0.0.1:3120",
      "MEND_T3_GATEWAY_URL=http://127.0.0.1:3120",
    ]);
    expect(declaredPostureLines(posture)[0]).toBe(
      "t3code gateway · on · published on 127.0.0.1:3120 only · reached from this machine",
    );
  });

  it("private, on the tailnet: published on the web port's address, at the name Mend is reached by", () => {
    const posture = {
      bind: "100.94.101.28",
      appUrl: "http://mend-box.tailc79e49.ts.net:3105",
      exposure: "private" as const,
      t3GatewayPort: 3120,
    };
    expect(t3GatewayPlacement(posture)).toMatchObject({
      bind: "100.94.101.28",
      url: "http://mend-box.tailc79e49.ts.net:3120",
      probeUrl: "http://100.94.101.28:3120",
    });
    expect(t3GatewayEnvLines(posture)).toContain("MEND_T3_GATEWAY_PUBLISHED=100.94.101.28:3120");
    expect(declaredPostureLines(posture)[0]).toBe(
      "t3code gateway · on · published on 100.94.101.28:3120, where Mend's web port is · T3 Code's Remote link takes http://mend-box.tailc79e49.ts.net:3120",
    );
    // An IPv6 tailnet address, bracketed where Compose and a URL need it.
    const v6 = {
      bind: "fd7a:115c:a1e0::1",
      appUrl: "http://[fd7a:115c:a1e0::1]:3105",
      t3GatewayPort: 3120,
    };
    expect(t3GatewayEnvLines(v6)).toEqual([
      "MEND_T3_GATEWAY_PORT=3120",
      "MEND_T3_GATEWAY_BIND_HOST=[fd7a:115c:a1e0::1]",
      "MEND_T3_GATEWAY_PUBLISHED=[fd7a:115c:a1e0::1]:3120",
      "MEND_T3_GATEWAY_URL=http://[fd7a:115c:a1e0::1]:3120",
    ]);
    // Every address is looked for on this machine's loopback.
    expect(
      t3GatewayPlacement({ bind: "0.0.0.0", appUrl: "http://mend.lan:3105", t3GatewayPort: 3120 }),
    ).toMatchObject({ url: "http://mend.lan:3120", probeUrl: "http://127.0.0.1:3120" });
  });

  it("public: never published beyond loopback; the edge serves it on its own origin only when named", () => {
    const edge = {
      bind: "127.0.0.1",
      appUrl: "https://alpha.mend.run",
      edgeHost: "alpha.mend.run",
      exposure: "public" as const,
      t3GatewayPort: 3120,
    };
    expect(t3GatewayPlacement(edge)).toMatchObject({
      bind: "127.0.0.1",
      url: "http://127.0.0.1:3120",
    });
    expect(renderT3GatewayOverlay(edge)).not.toContain("edge:");
    expect(declaredPostureLines(edge)[1]).toBe(
      "t3code gateway · on · published on 127.0.0.1:3120 only · reached from this machine; mend server setup --t3-gateway-origin <host> serves it through the edge",
    );
    // Even a config that names a wider bind with a public exposure keeps the raw port on loopback.
    expect(t3GatewayPlacement({ ...edge, bind: "0.0.0.0" })?.bind).toBe("127.0.0.1");
    expect(
      t3GatewayPlacement({ bind: "0.0.0.0", exposure: "public", t3GatewayPort: 3120 })?.bind,
    ).toBe("127.0.0.1");

    const served = { ...edge, t3GatewayOrigin: "t3.alpha.mend.run" };
    expect(t3GatewayPlacement(served)).toEqual({
      bind: "127.0.0.1",
      port: 3120,
      url: "https://t3.alpha.mend.run",
      probeUrl: "http://127.0.0.1:3120",
      edgeHost: "t3.alpha.mend.run",
    });
    expect(t3GatewayEnvLines(served)).toEqual([
      "MEND_T3_GATEWAY_PORT=3120",
      "MEND_T3_GATEWAY_BIND_HOST=127.0.0.1",
      "MEND_T3_GATEWAY_PUBLISHED=127.0.0.1:3120",
      "MEND_T3_GATEWAY_URL=https://t3.alpha.mend.run",
      "MEND_T3_GATEWAY_EDGE_HOST=t3.alpha.mend.run",
    ]);
    // The gateway's lines are read by its own overlay, never by the posture's.
    expect(renderPostureOverlay(served)).not.toContain("MEND_T3_GATEWAY");
    const overlay = renderT3GatewayOverlay(served) ?? "";
    expect(overlay).toContain("\n  edge:\n");
    expect(overlay).toContain("      - ./Caddyfile.t3:/etc/caddy/sites/t3code-gateway.caddy:ro");
    expect(declaredPostureLines(served)[1]).toBe(
      "t3code gateway · on · served by the edge at https://t3.alpha.mend.run · its port published on 127.0.0.1:3120 only",
    );
    // Without the edge an origin is nothing: the gateway follows the web port.
    expect(
      t3GatewayPlacement({
        bind: "127.0.0.1",
        t3GatewayPort: 3120,
        t3GatewayOrigin: "t3.alpha.mend.run",
      })?.edgeHost,
    ).toBeUndefined();
  });

  it("the edge's site proxies to the gateway on its own origin, unbuffered, with its ticket out of the log", () => {
    expect(EDGE_CADDYFILE).toContain("import /etc/caddy/sites/*.caddy");
    expect(T3_GATEWAY_CADDYFILE).toContain("{$MEND_T3_GATEWAY_EDGE_HOST} {");
    expect(T3_GATEWAY_CADDYFILE).toContain("\treverse_proxy mend:3120 {\n");
    expect(T3_GATEWAY_CADDYFILE).toContain("\t\tflush_interval -1\n");
    expect(T3_GATEWAY_CADDYFILE).toContain("replace wsTicket REDACTED");
    for (const line of declaredPostureLines({ bind: "100.94.101.28", t3GatewayPort: 3120 }))
      expect(line).not.toMatch(VERDICTS);
  });

  it("keeps asset tokens, file names and raw read paths out of both edges' access logs", () => {
    const token = `ast_${"a1_-".repeat(10)}xyz`;
    for (const caddyfile of [EDGE_CADDYFILE, T3_GATEWAY_CADDYFILE]) {
      for (const uri of [
        `/api/assets/${token}/private-name.png`,
        `/api/assets/${token}/nested/private-name.css`,
        `/API//assets/${token}/private-name.png`,
        "/api/worktrees/w/raw?path=private-name.png&within=private-dir",
        "/api/worktrees/w/raw/?path=private-name.png",
        "/API/worktrees/w/RAW?path=private-name.png",
        "/api/worktrees/w/r%61w?within=private-dir&path=x",
        "/api/worktrees/w/raw;v=1?path=private-name.png",
        "https://user:secret@host/api/worktrees/w/raw?path=private-name.png",
      ]) {
        const logged = loggedUri(caddyfile, uri);
        for (const secret of [token, "private-name", "private-dir", "secret"])
          expect(logged, uri).not.toContain(secret);
      }
      // Every other route logs as before.
      for (const uri of [
        "/api/worktrees/w/contents?path=README.md",
        "/api/projects?raw=1",
        "/api/forecast_x/y",
        "/drawing/raw-notes",
      ])
        expect(loggedUri(caddyfile, uri)).toBe(uri);
      expect(loggedUri(caddyfile, "https://user:secret@host/api/projects")).toBe(
        "https://REDACTED@host/api/projects",
      );
    }
  });

  it("filters Caddy's own lines (a failed dial, a response cut short) like the access logs", () => {
    const filters = [...EDGE_CADDYFILE.matchAll(/\buri regexp .*$/gm)].map(([line]) => line);
    expect(filters).toHaveLength(2);
    expect(
      new Set([...filters, ...T3_GATEWAY_CADDYFILE.matchAll(/\buri regexp .*$/gm)].map(String))
        .size,
    ).toBe(1);
    const global = /^\{\n([\s\S]*?)\n\}\n/m.exec(EDGE_CADDYFILE)?.[1] ?? "";
    expect(global).toContain("\tlog default {");
    for (const key of ["ticket", "token", "code", "wsTicket"])
      expect(global).toContain(`replace ${key} REDACTED`);
  });
});
