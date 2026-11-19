import { describe, expect, it } from "vitest";

import {
  addressKindsLine,
  addressLine,
  changeHow,
  creationWord,
  deploymentLine,
  exposureResult,
  exposureSummary,
  gateSummary,
  imageExtras,
  imageLine,
  organizationCounts,
  refusesPublicStart,
  runtimeOffer,
  sealantReading,
  sessionChannelLine,
} from "./server-settings.ts";

const now = new Date(2026, 10, 19, 10, 50);
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

describe("exposure", () => {
  it("names each way an item was established, and only an open one is amber", () => {
    expect(exposureResult({ established: "observed", blocksStart: true })).toEqual({
      word: "Checked",
      tone: "idle",
    });
    expect(exposureResult({ established: "carried", blocksStart: false }).word).toBe(
      "In this build",
    );
    expect(exposureResult({ established: "declared", blocksStart: false }).word).toBe("Declared");
    expect(exposureResult({ established: "open", blocksStart: false })).toEqual({
      word: "Open",
      tone: "wait",
    });
  });

  it("an open item refuses a public start only when it blocks one", () => {
    expect(refusesPublicStart({ established: "open", blocksStart: true })).toBe(true);
    expect(refusesPublicStart({ established: "open", blocksStart: false })).toBe(false);
    expect(refusesPublicStart({ established: "observed", blocksStart: true })).toBe(false);
  });

  it("says when Mend checked and what the open items mean for a public start", () => {
    const checked = new Date(2026, 10, 13, 10, 46);
    const time = checked.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const day = checked.toLocaleDateString(undefined, { day: "numeric", month: "short" });
    const observed = { established: "observed", blocksStart: true } as const;
    const blocking = { established: "open", blocksStart: true } as const;
    const harmless = { established: "open", blocksStart: false } as const;

    expect(exposureSummary([observed, blocking], checked, now)).toBe(
      `Mend checked this server on ${day} at ${time}. One item is open, so Mend would refuse to start in public.`,
    );
    expect(exposureSummary([harmless, harmless], checked, now)).toBe(
      `Mend checked this server on ${day} at ${time}. 2 items are open, and none of them stops a public start.`,
    );
    expect(exposureSummary([observed], minutesAgo(1), now)).toMatch(
      /^Mend checked this server today at .+\. Nothing is open\.$/,
    );
  });

  it("reports the address as the server observed it, never the addresses themselves", () => {
    expect(
      addressLine({
        originScheme: "https",
        originOnMachine: false,
        arrivedVia: "trusted-proxy",
        addressKinds: ["private"],
      }),
    ).toBe("https, not on this machine's loopback, reached through a trusted proxy");
    expect(
      addressLine({
        originScheme: "http",
        originOnMachine: true,
        arrivedVia: "direct",
        addressKinds: [],
      }),
    ).toBe("http, on this machine's loopback, reached directly");
    expect(addressKindsLine(["loopback", "tailnet"])).toBe(
      "Addresses on the host: loopback, tailnet.",
    );
    expect(addressKindsLine([])).toBe("Mend found no network address on the host.");
  });
});

describe("the Sealant connection check", () => {
  const at = "http://sealant:7400";

  it("connected: where Mend reached Sealant, and when", () => {
    expect(
      sealantReading(
        { status: "connected", baseUrl: at, detail: null, checkedAt: minutesAgo(5) },
        now,
      ),
    ).toEqual({
      word: "Connected",
      tone: "ok",
      line: "Mend reached Sealant at http://sealant:7400, checked 5 minutes ago.",
      saw: null,
    });
  });

  it("a refused key says so and what to do, and never names the key", () => {
    const reading = sealantReading(
      {
        status: "unauthorized",
        baseUrl: at,
        detail: "401 Unauthorized",
        checkedAt: minutesAgo(0),
      },
      now,
    );
    expect(reading.word).toBe("Key refused");
    expect(reading.tone).toBe("bad");
    expect(reading.line).toBe(
      "Sealant at http://sealant:7400 refused this server's service key, checked just now. Give the server a new key with mend server setup.",
    );
    expect(reading.saw).toBe("401 Unauthorized");
  });

  it("an answer that isn't Sealant's API, and no answer at all, each with what Mend saw", () => {
    expect(
      sealantReading(
        { status: "mismatched", baseUrl: at, detail: "404 at /v1/health", checkedAt: now },
        now,
      ),
    ).toMatchObject({ word: "Not Sealant", tone: "wait", saw: "404 at /v1/health" });
    expect(
      sealantReading(
        {
          status: "unreachable",
          baseUrl: at,
          detail: "connect ECONNREFUSED 10.0.0.4:7400",
          checkedAt: now,
        },
        now,
      ),
    ).toEqual({
      word: "Unreachable",
      tone: "bad",
      line: "Mend couldn't reach Sealant at http://sealant:7400, checked just now.",
      saw: "connect ECONNREFUSED 10.0.0.4:7400",
    });
  });
});

describe("runtimes and the server", () => {
  it("says which runtimes are offered and where new organizations start", () => {
    const offer = { offered: ["docker", "boat"] as const, default: "boat" as const };
    expect(runtimeOffer("boat", offer)).toEqual({ word: "Offered", startsHere: true });
    expect(runtimeOffer("docker", offer)).toEqual({ word: "Offered", startsHere: false });
    expect(runtimeOffer("boat", { offered: ["docker"], default: "docker" })).toEqual({
      word: "Not offered",
      startsHere: false,
    });
  });

  it("says where the server runs, how workspaces reach it and how to change it", () => {
    const local = {
      version: "0.37.0",
      deploymentMode: "local",
      sessionChannel: { mode: "unix-socket", endpoint: null },
    } as const;
    expect(deploymentLine(local, "mendbox")).toBe("One machine, mendbox, with Docker");
    expect(deploymentLine({ ...local, deploymentMode: "kubernetes" }, "mendbox")).toBe(
      "Kubernetes",
    );
    expect(sessionChannelLine(local.sessionChannel)).toBe("A socket per session, on this machine");
    expect(sessionChannelLine({ mode: "network", endpoint: "mend-api:7443" })).toBe(
      "Over the network, at mend-api:7443",
    );
    expect(changeHow("local")).toBe("run mend server setup on the server");
    expect(changeHow("kubernetes")).toBe("edit your Helm values and upgrade the release");
    expect(changeHow(null)).toBe(
      "run mend server setup on the server, or edit your Helm values and upgrade the release",
    );
  });
});

describe("organizations", () => {
  it("counts members and owners, and says when an organization has no owner", () => {
    expect(organizationCounts({ memberCount: 4, ownerCount: 2 })).toBe("4 members, 2 owners");
    expect(organizationCounts({ memberCount: 1, ownerCount: 1 })).toBe("1 member, 1 owner");
    expect(organizationCounts({ memberCount: 3, ownerCount: 0 })).toBe("3 members, no owner");
  });

  it("reads the multi mode gate for the tenancy the server runs", () => {
    expect(gateSummary([{ ok: true }, { ok: true }], "single")).toBe(
      "Every item is in place, so the server could run several organizations.",
    );
    expect(gateSummary([{ ok: true }, { ok: false }], "single")).toBe(
      "1 item isn't in place, so Mend would refuse to start with several organizations.",
    );
    expect(gateSummary([{ ok: false }, { ok: false }], "multi")).toBe(
      "2 items aren't in place. The server checks them when it starts.",
    );
    expect(gateSummary([], "multi")).toBe("Every item is in place.");
  });

  it("says who may create an organization", () => {
    expect(creationWord(true)).toBe("Anyone signed in");
    expect(creationWord(false)).toBe("Only operators");
  });
});

describe("the starting image", () => {
  it("sums up a family image and a custom one", () => {
    const family = {
      mode: "family",
      os: "arch",
      shell: "zsh",
      packages: ["pnpm", "jq"],
      services: { docker: true },
      screen: false,
    } as const;
    expect(imageLine(family)).toBe("Arch · zsh · 2 packages");
    expect(imageExtras(family)).toBe("Docker inside workspaces · no screen");
    const custom = {
      mode: "custom",
      baseImage: "ghcr.io/northwind/dev:2026.11",
      packages: ["jq"],
      setupCommands: [],
      services: { docker: false },
    } as const;
    expect(imageLine(custom)).toBe("ghcr.io/northwind/dev:2026.11 · 1 package · 0 setup commands");
    expect(imageExtras(custom)).toBe("No Docker inside workspaces");
  });
});
