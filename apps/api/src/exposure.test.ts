import { describe, expect, it } from "vitest";

import {
  evaluateExposureGate,
  exposureGatePasses,
  exposureRefusal,
  type ExposurePosture,
} from "./exposure.ts";

/** A posture in which every item this build can observe is closed. */
const closed: ExposurePosture = {
  appUrl: "https://mend.example",
  allowedOrigins: ["https://mend.example"],
  trustedProxies: ["10.244.0.0/16"],
  tenancyGate: [{ id: "source-policy", ok: true, detail: "tenant", fix: null }],
  budgetsOff: [],
  urlBearers: "refuse",
  errorDetail: "redacted",
  sessionChannelUrl: "https://mend-session.example:3106",
  executorNetwork: undefined,
  declared: [],
  reassessedVersion: undefined,
  version: "0.29.0",
};

const open = (posture: ExposurePosture) =>
  evaluateExposureGate(posture)
    .filter((outcome) => outcome.established === "open")
    .map((outcome) => outcome.id);

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
    ]);
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
    const words = evaluateExposureGate(closed)
      .flatMap((outcome) => [outcome.detail, outcome.fix ?? ""])
      .join(" ")
      .toLowerCase();
    for (const verdict of ["safe", "secure enough", "ready for", "approved", "passed"]) {
      expect(words).not.toContain(verdict);
    }
  });
});
