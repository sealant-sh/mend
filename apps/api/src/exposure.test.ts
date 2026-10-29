import { SAME_SITE_PREVIEW_REASON } from "@mend/network";
import { describe, expect, it } from "vitest";

import {
  evaluateExposureGate,
  exposureGatePasses,
  exposureRefusal,
  type ExposurePosture,
  type PreviewPosture,
} from "./exposure.ts";

/** A posture in which every item this build can observe is closed. */
const closed: ExposurePosture = {
  exposure: "public",
  appUrl: "https://mend.example",
  allowedOrigins: ["https://mend.example"],
  trustedProxies: ["10.244.0.0/16"],
  tenancyGate: [{ id: "source-policy", ok: true, detail: "tenant", fix: null }],
  budgetsOff: [],
  urlBearers: "refuse",
  errorDetail: "redacted",
  sessionChannelUrl: "https://mend-session.example:3106",
  executorNetwork: undefined,
  sshPublished: undefined,
  declared: [],
  reassessedVersion: undefined,
  version: "0.29.0",
};

const open = (posture: ExposurePosture) =>
  evaluateExposureGate(posture)
    .filter((outcome) => outcome.established === "open")
    .map((outcome) => outcome.id);

const t3GatewayOf = (posture: ExposurePosture) =>
  evaluateExposureGate(posture).find((outcome) => outcome.id === "t3code-gateway");

const previewOf = (posture: ExposurePosture) =>
  evaluateExposureGate(posture).find((outcome) => outcome.id === "preview-gateway");

const workspaceSshOf = (posture: ExposurePosture) =>
  evaluateExposureGate(posture).find((outcome) => outcome.id === "workspace-ssh");

const LOOPBACK_PREVIEW: PreviewPosture = {
  routing: { mode: "loopback-http", port: 3130 },
  bind: "127.0.0.1",
  port: 3130,
};
const DOMAIN_PREVIEW: PreviewPosture = {
  routing: { mode: "domain-https", domain: "previews.example.net", port: 443 },
  bind: "0.0.0.0",
  port: 3130,
};
const TAILNET_PREVIEW: PreviewPosture = {
  routing: {
    mode: "tailnet-https",
    hostname: "mend-preview.tail1234.ts.net",
    ports: [20001],
  },
  bind: "127.0.0.1",
  port: 3130,
};

describe("the public exposure gate", () => {
  it("with everything observable closed, only what no build can observe stays open", () => {
    expect(open(closed)).toEqual(["core-private", "edge-tls", "reassessment"]);
    expect(exposureRefusal("public", evaluateExposureGate(closed))).toBeNull();
    // Starting is not passing: three items are still open, and the report says so.
    expect(exposureGatePasses(evaluateExposureGate(closed))).toBe(false);
  });

  it.each<[string, Partial<ExposurePosture>]>([
    ["https-origin", { allowedOrigins: ["https://mend.example", "http://10.0.0.5:3105"] }],
    ["secure-cookies", { appUrl: "http://mend.example" }],
    ["trusted-proxies", { trustedProxies: [] }],
    ["trusted-proxies", { trustedProxies: ["0.0.0.0/0"] }],
    [
      "tenancy-gate",
      { tenancyGate: [{ id: "source-policy", ok: false, detail: "operator", fix: "x" }] },
    ],
    [
      "tenancy-gate",
      { tenancyGate: [{ id: "operator-present", ok: false, detail: "0", fix: "x" }] },
    ],
    ["budgets", { budgetsOff: ["bodyBytes"] }],
    ["no-bearers-in-urls", { urlBearers: "accept" }],
    ["error-redaction", { errorDetail: "verbose" }],
    ["executor-channel-transport", { sessionChannelUrl: "http://mend-api:3106" }],
    ["workspace-ssh", { sshPublished: "0.0.0.0:2222" }],
    ["workspace-ssh", { sshPublished: "[fd00::1]:2222" }],
  ])("refuses a public start while %s is open", (id, change) => {
    const gate = evaluateExposureGate({ ...closed, ...change });
    expect(gate.find((outcome) => outcome.id === id)?.established).toBe("open");
    const refusal = exposureRefusal("public", gate);
    expect(refusal).toContain("MEND_EXPOSURE=public is refused");
    expect(refusal).toContain(`${id}:`);
  });

  it("never refuses loopback or private, whatever is open; they get the same report", () => {
    const gate = evaluateExposureGate({
      ...closed,
      appUrl: "http://10.0.0.216:3105",
      allowedOrigins: ["http://10.0.0.216:3105"],
      trustedProxies: [],
      urlBearers: "accept",
    });
    expect(exposureRefusal("loopback", gate)).toBeNull();
    expect(exposureRefusal("private", gate)).toBeNull();
    expect(gate.filter((outcome) => outcome.established === "open").length).toBeGreaterThan(3);
  });

  it("reports a plain-http session channel as declared when the operator says the network is private", () => {
    const gate = evaluateExposureGate({
      ...closed,
      sessionChannelUrl: "http://mend-api:3106",
      executorNetwork: "private",
    });
    const item = gate.find((outcome) => outcome.id === "executor-channel-transport");
    expect(item?.established).toBe("declared");
    expect(item?.detail).toContain("MEND_EXECUTOR_NETWORK=private");
    expect(exposureRefusal("public", gate)).toBeNull();
  });

  it("a mounted session socket is no network to secure", () => {
    const gate = evaluateExposureGate({ ...closed, sessionChannelUrl: undefined });
    expect(gate.find((outcome) => outcome.id === "executor-channel-transport")?.established).toBe(
      "observed",
    );
  });

  it("a recorded reassessment counts only for the running version, as declared, never observed", () => {
    const recorded = evaluateExposureGate({ ...closed, reassessedVersion: "0.29.0" });
    const item = recorded.find((outcome) => outcome.id === "reassessment");
    expect(item?.established).toBe("declared");
    expect(item?.detail).toBe("the operator recorded an independent reassessment of 0.29.0");

    const upgraded = evaluateExposureGate({ ...closed, reassessedVersion: "0.28.0" });
    const stale = upgraded.find((outcome) => outcome.id === "reassessment");
    expect(stale?.established).toBe("open");
    expect(stale?.detail).toBe("a reassessment of 0.28.0 is recorded; this is 0.29.0");
    // It never blocks a start: a build cannot tell a reassessment from a typed string.
    expect(stale?.blocksStart).toBe(false);
  });

  it("says carried, not observed, for what this build contains and this process cannot see in effect", () => {
    const gate = evaluateExposureGate(closed);
    for (const id of ["enrollment-closed", "browser-headers"]) {
      const item = gate.find((outcome) => outcome.id === id);
      expect(item?.established).toBe("carried");
      expect(item?.fix).toContain("what would observe it");
      expect(item?.blocksStart).toBe(false);
    }
    // Everything marked observed was read from this instance's configuration.
    expect(
      gate.filter((outcome) => outcome.established === "observed").map((outcome) => outcome.id),
    ).toEqual([
      "https-origin",
      "secure-cookies",
      "trusted-proxies",
      "tenancy-gate",
      "budgets",
      "no-bearers-in-urls",
      "error-redaction",
      "executor-channel-transport",
      "workspace-ssh",
    ]);
  });

  it("names the package mirrors among what core-private covers, when sessions are pointed at them", () => {
    const without = evaluateExposureGate(closed).find((outcome) => outcome.id === "core-private");
    expect(without?.detail).toContain("Sealant, its registry and the database are reachable");
    const gate = evaluateExposureGate({
      ...closed,
      mirrors: ["npm-mirror:4873", "docker-mirror:5000"],
    });
    const item = gate.find((outcome) => outcome.id === "core-private");
    expect(item?.detail).toBe(
      "this process cannot observe whether Sealant, its registry, the database and the package mirrors (npm-mirror:4873, docker-mirror:5000) are reachable from the Internet",
    );
    expect(item?.established).toBe("open");
    expect(item?.blocksStart).toBe(false);
  });

  it("closes an unobservable item only on the operator's own statement, and says whose it is", () => {
    const gate = evaluateExposureGate({ ...closed, declared: ["core-private"] });
    const stated = gate.find((outcome) => outcome.id === "core-private");
    expect(stated?.established).toBe("declared");
    expect(stated?.detail).toContain("this process cannot check it");
    expect(gate.find((outcome) => outcome.id === "edge-tls")?.established).toBe("open");

    // Nothing open needs both statements and a reassessment of this exact version.
    const all = evaluateExposureGate({
      ...closed,
      declared: ["core-private", "edge-tls"],
      reassessedVersion: "0.29.0",
    });
    expect(exposureGatePasses(all)).toBe(true);
    expect(all.filter((outcome) => outcome.established === "declared")).toHaveLength(3);
  });

  it("reports workspace SSH published apart from the web port as declared, observed or open, never as a verdict", () => {
    // Not published apart (the edge keeps it with the web port, on loopback), or on loopback alone.
    expect(workspaceSshOf(closed)).toMatchObject({ established: "observed", fix: null });
    expect(workspaceSshOf({ ...closed, sshPublished: "127.0.0.1:2222" })).toMatchObject({
      established: "observed",
      detail: "workspace SSH is published on 127.0.0.1:2222 only",
    });
    // Beside a public edge on every interface: open, says what would verify it, refuses `public`.
    const published = { ...closed, sshPublished: "0.0.0.0:2222" };
    // It refuses a public start, and no build can observe it: the two are separate facts.
    expect(workspaceSshOf(published)).toMatchObject({
      established: "open",
      blocksStart: true,
      observable: false,
    });
    expect(workspaceSshOf(published)?.fix).toContain("a connection attempt to 0.0.0.0:2222");
    expect(workspaceSshOf(published)?.fix).toContain("MEND_EXPOSURE_DECLARED");
    const refusal = exposureRefusal("public", evaluateExposureGate(published));
    expect(refusal).toContain("workspace-ssh:");
    expect(refusal).toContain("open items that refuse a public start");
    expect(refusal).not.toContain("this build can observe");
    // A private declaration still reports it, and does not refuse.
    expect(exposureRefusal("private", evaluateExposureGate(published))).toBeNull();
    // The operator's statement, and only that, makes it declared; this process still cannot check it.
    const stated: ExposurePosture = { ...published, declared: ["workspace-ssh"] };
    expect(workspaceSshOf(stated)).toMatchObject({ established: "declared", fix: null });
    expect(workspaceSshOf(stated)?.detail).toContain("this process cannot check it");
    expect(exposureRefusal("public", evaluateExposureGate(stated))).toBeNull();
  });

  it("lists the t3code gateway only while it is enabled; unsaid where, open until the operator states who reaches it", () => {
    expect(evaluateExposureGate(closed).some((outcome) => outcome.id === "t3code-gateway")).toBe(
      false,
    );
    const on = evaluateExposureGate({ ...closed, t3Gateway: true });
    const item = on.find((outcome) => outcome.id === "t3code-gateway");
    expect(item?.established).toBe("open");
    // Unobservable and never blocking a start while nothing says where it is published.
    expect(item?.blocksStart).toBe(false);
    expect(item?.observable).toBe(false);
    expect(item?.detail).toContain("cannot observe who reaches it");
    // A configuration fact, read once: it says enabled, never that the gateway runs (645-2).
    expect(item?.detail).toContain("the t3code gateway is enabled (MEND_T3_GATEWAY_ENABLED)");
    expect(item?.detail).toContain("nor whether it is listening");
    expect(item?.detail).not.toMatch(/\bruns\b/);
    expect(item?.fix).toContain("then add t3code-gateway to MEND_EXPOSURE_DECLARED");
    expect(exposureRefusal("public", on)).toBe(
      exposureRefusal("public", evaluateExposureGate(closed)),
    );
    const stated = evaluateExposureGate({
      ...closed,
      t3Gateway: true,
      declared: ["t3code-gateway"],
    });
    expect(stated.find((outcome) => outcome.id === "t3code-gateway")?.established).toBe("declared");
  });

  it("reads the gateway published on loopback as observed: nothing to state", () => {
    const item = t3GatewayOf({
      ...closed,
      t3Gateway: true,
      t3GatewayPublished: "127.0.0.1:3120",
      t3GatewayUrl: "http://127.0.0.1:3120",
    });
    expect(item).toMatchObject({
      established: "observed",
      detail:
        "the t3code gateway's port is published on 127.0.0.1:3120 only (MEND_T3_GATEWAY_PUBLISHED)",
      fix: null,
      observable: true,
    });
  });

  it("holds the gateway published on a private address open until declared, and a public start with it", () => {
    const tailnet: ExposurePosture = {
      ...closed,
      t3Gateway: true,
      t3GatewayPublished: "100.94.101.28:3120",
      t3GatewayUrl: "http://mend-box.tailc79e49.ts.net:3120",
    };
    const item = t3GatewayOf(tailnet);
    expect(item).toMatchObject({ established: "open", blocksStart: true, observable: false });
    expect(item?.detail).toBe(
      "the t3code gateway's port is published on 100.94.101.28:3120 (MEND_T3_GATEWAY_PUBLISHED); every device pairs through Mend, and this process cannot observe who can reach the port",
    );
    expect(item?.fix).toContain("a connection attempt to 100.94.101.28:3120 from each network");
    // Private never refuses; public does, as for workspace SSH published beyond loopback.
    expect(exposureRefusal("private", evaluateExposureGate(tailnet))).toBeNull();
    expect(exposureRefusal("public", evaluateExposureGate(tailnet))).toContain("t3code-gateway");
    const stated = t3GatewayOf({ ...tailnet, declared: ["t3code-gateway"] });
    expect(stated).toMatchObject({ established: "declared", blocksStart: true });
    expect(stated?.detail).toContain("this process cannot check it");
    expect(
      exposureRefusal("public", evaluateExposureGate({ ...tailnet, declared: ["t3code-gateway"] })),
    ).toBeNull();
  });

  it("served by the edge on its own origin: open until the operator checked that origin from outside", () => {
    const served: ExposurePosture = {
      ...closed,
      t3Gateway: true,
      t3GatewayPublished: "127.0.0.1:3120",
      t3GatewayUrl: "https://t3.alpha.mend.run",
    };
    const item = t3GatewayOf(served);
    expect(item).toMatchObject({ established: "open", blocksStart: false, observable: false });
    expect(item?.detail).toBe(
      "the t3code gateway's port is published on 127.0.0.1:3120 only (MEND_T3_GATEWAY_PUBLISHED), and the edge serves it at https://t3.alpha.mend.run (MEND_T3_GATEWAY_URL); this process cannot observe that origin's certificate",
    );
    expect(item?.fix).toContain(
      "https://t3.alpha.mend.run/.well-known/t3/environment from another network",
    );
    expect(t3GatewayOf({ ...served, declared: ["t3code-gateway"] })?.established).toBe("declared");
  });

  it("an unversioned build has nothing a reassessment could name", () => {
    const gate = evaluateExposureGate({ ...closed, version: "dev", reassessedVersion: "dev" });
    const item = gate.find((outcome) => outcome.id === "reassessment");
    expect(item?.established).toBe("open");
    expect(item?.detail).toBe("this build has no version, so no reassessment can name it");
  });

  it("says what would verify the items no build can observe", () => {
    const gate = evaluateExposureGate(closed);
    for (const id of ["core-private", "edge-tls"]) {
      const item = gate.find((outcome) => outcome.id === id);
      expect(item?.blocksStart).toBe(false);
      expect(item?.fix).toContain("what would verify it");
    }
  });

  it("never words an outcome as a verdict", () => {
    const words = [
      closed,
      { ...closed, preview: { ...DOMAIN_PREVIEW, published: "127.0.0.1:3130" } },
      { ...closed, preview: TAILNET_PREVIEW, declared: ["preview-gateway" as const] },
      { ...closed, preview: LOOPBACK_PREVIEW },
    ]
      .flatMap(evaluateExposureGate)
      .flatMap((outcome) => [outcome.detail, outcome.fix ?? ""])
      .join(" ")
      .toLowerCase();
    for (const verdict of ["safe", "secure enough", "ready for", "approved", "passed"]) {
      expect(words).not.toContain(verdict);
    }
  });
});

describe("gate item 15, preview-gateway (ADR 0017, Exposure)", () => {
  it("is listed only while the gateway is on, after the t3code gateway and before reassessment", () => {
    expect(previewOf(closed)).toBeUndefined();
    const ids = evaluateExposureGate({
      ...closed,
      t3Gateway: true,
      preview: DOMAIN_PREVIEW,
    }).map((outcome) => outcome.id);
    expect(ids.slice(-3)).toEqual(["t3code-gateway", "preview-gateway", "reassessment"]);
  });

  it("on loopback under a loopback exposure, every fact is observed or carried: nothing to state", () => {
    const item = previewOf({ ...closed, exposure: "loopback", preview: LOOPBACK_PREVIEW });
    expect(item).toMatchObject({
      established: "observed",
      fix: null,
      blocksStart: true,
      observable: true,
    });
    expect(item?.detail).toBe(
      [
        "observed: previews are plain http at http://<label>.localhost:3130, on loopback under MEND_EXPOSURE=loopback",
        "carried: the SDK this build pins has the bounded forward the gateway starts on",
        "observed: it listens on 127.0.0.1:3130, published nowhere else that was said (MEND_PREVIEW_PUBLISHED unset)",
      ].join("; "),
    );
  });

  it.each<[string, Partial<ExposurePosture>]>([
    ["a private exposure", { exposure: "private" }],
    ["a public exposure", { exposure: "public" }],
    [
      "a listener beyond loopback",
      { exposure: "loopback", preview: { ...LOOPBACK_PREVIEW, bind: "0.0.0.0" } },
    ],
    [
      "a port published beyond loopback",
      { exposure: "loopback", preview: { ...LOOPBACK_PREVIEW, published: "10.0.0.5:3130" } },
    ],
  ])("plain http previews are open under %s, and no statement closes them", (_, change) => {
    const posture: ExposurePosture = {
      ...closed,
      preview: LOOPBACK_PREVIEW,
      declared: ["preview-gateway"],
      ...change,
    };
    const item = previewOf(posture);
    expect(item?.established).toBe("open");
    expect(item?.detail).toContain("open: previews are plain http");
    expect(item?.fix).toContain("set MEND_PREVIEW_DOMAIN");
  });

  it("with a domain, open until the operator states DNS, the certificate and the reach, and a public start waits", () => {
    const posture: ExposurePosture = {
      ...closed,
      preview: { ...DOMAIN_PREVIEW, published: "127.0.0.1:3130" },
    };
    const item = previewOf(posture);
    expect(item).toMatchObject({ established: "open", blocksStart: true, observable: false });
    expect(item?.detail).toBe(
      [
        "observed: APP_URL's host mend.example is not previews.example.net, above or under it, or on its registrable domain",
        "observed: previews are https at https://<label>.previews.example.net",
        "carried: the SDK this build pins has the bounded forward the gateway starts on",
        "observed: it listens on 0.0.0.0:3130, its port published on 127.0.0.1:3130 (MEND_PREVIEW_PUBLISHED)",
        "open: the wildcard DNS and certificate for *.previews.example.net, and who reaches the published listener; only a look from another network sees it",
      ].join("; "),
    );
    expect(item?.fix).toBe(
      "what would verify it: https://<label>.previews.example.net from another network, over a certificate that chains to a public root, and 127.0.0.1:3130 answering nothing from another machine; then add preview-gateway to MEND_EXPOSURE_DECLARED",
    );
    expect(exposureRefusal("private", evaluateExposureGate(posture))).toBeNull();
    expect(exposureRefusal("public", evaluateExposureGate(posture))).toContain("preview-gateway:");

    const stated: ExposurePosture = { ...posture, declared: ["preview-gateway"] };
    expect(previewOf(stated)).toMatchObject({ established: "declared", fix: null });
    expect(previewOf(stated)?.detail).toContain(
      "declared: the wildcard DNS and certificate for *.previews.example.net, and who reaches the published listener (MEND_EXPOSURE_DECLARED); this process cannot check it",
    );
    expect(exposureRefusal("public", evaluateExposureGate(stated))).toBeNull();
  });

  it("never reads clean for a preview domain on Mend's own site, whatever was declared", () => {
    const item = previewOf({
      ...closed,
      appUrl: "https://mend.example.com",
      allowedOrigins: ["https://mend.example.com"],
      declared: ["preview-gateway"],
      preview: {
        ...DOMAIN_PREVIEW,
        routing: { mode: "domain-https", domain: "previews.example.com", port: 443 },
      },
    });
    expect(item?.established).toBe("open");
    expect(item?.detail).toContain(
      "open: APP_URL's host mend.example.com shares the registrable domain example.com with previews.example.com, so a page on a preview can set cookies Mend's host receives",
    );
    expect(item?.fix).toContain(SAME_SITE_PREVIEW_REASON);
  });

  it("names a non-default public port, and reads a statement that cannot describe the listener as open", () => {
    expect(
      previewOf({
        ...closed,
        preview: {
          ...DOMAIN_PREVIEW,
          routing: { mode: "domain-https", domain: "previews.example.net", port: 8443 },
        },
      })?.detail,
    ).toContain("observed: previews are https at https://<label>.previews.example.net:8443");
    const stale = previewOf({
      ...closed,
      declared: ["preview-gateway"],
      preview: { ...DOMAIN_PREVIEW, bind: "127.0.0.1", published: "203.0.113.7:3130" },
    });
    expect(stale?.established).toBe("open");
    expect(stale?.detail).toContain(
      "open: it listens on 127.0.0.1:3130, and MEND_PREVIEW_PUBLISHED says 203.0.113.7:3130: that statement is not this listener's",
    );
  });

  it("on the tailnet default, observes the __Host- session cookie Auth sets over https", () => {
    const posture: ExposurePosture = {
      ...closed,
      exposure: "private",
      preview: TAILNET_PREVIEW,
      declared: ["preview-gateway"],
    };
    const item = previewOf(posture);
    expect(item?.established).toBe("declared");
    expect(item?.detail).toContain(
      "observed: APP_URL's host mend.example is not the gateway's name mend-preview.tail1234.ts.net",
    );
    expect(item?.detail).toContain(
      "observed: Mend's cookies are named __Host- (__Host-better-auth.session_token)",
    );
    expect(item?.detail).toContain(
      "declared: the Tailscale steps for mend-preview.tail1234.ts.net",
    );
  });

  it("on the tailnet default, open while APP_URL is http, so Mend's cookies cannot be __Host-", () => {
    const posture: ExposurePosture = {
      ...closed,
      exposure: "private",
      appUrl: "http://mend.tail1234.ts.net:3105",
      allowedOrigins: ["http://mend.tail1234.ts.net:3105"],
      preview: TAILNET_PREVIEW,
      declared: ["preview-gateway"],
    };
    const item = previewOf(posture);
    expect(item?.established).toBe("open");
    expect(item?.detail).toContain(
      "open: Mend's cookies are named better-auth.session_token, not __Host-, and every preview is Mend's own site: APP_URL is http",
    );
    expect(item?.fix).toContain("set APP_URL to https");
    expect(exposureRefusal("private", evaluateExposureGate(posture))).toBeNull();
    expect(exposureRefusal("public", evaluateExposureGate(posture))).toContain("preview-gateway:");
  });
});
