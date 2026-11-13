import { describe, expect, it } from "vitest";

import {
  boatKeyReportFixture,
  refusedKeyReportFixture,
  serverBoatFactsFixture,
} from "./boat-key-fixtures.ts";
import {
  boatGatewayLine,
  serverBoatLines,
  sessionRuntimesLine,
  type StatusLine,
} from "./server-boat-words.ts";

const NOW = new Date("2026-11-13T14:02:00Z");
const DAY_MS = 86_400_000;

const lines = (overrides: Parameters<typeof serverBoatFactsFixture>[0] = {}) =>
  serverBoatLines({ facts: serverBoatFactsFixture(overrides, NOW), now: NOW, from: "the server" });

const byLabel = (all: ReadonlyArray<StatusLine>, label: string): StatusLine => {
  const line = all.find((entry) => entry.label === label);
  if (line === undefined) throw new Error(`no ${label} line`);
  return line;
};

describe("where sessions run", () => {
  it("says what the server offers and what a new organization gets, as declared", () => {
    expect(sessionRuntimesLine({ offered: ["docker", "boat"], default: "boat" }).detail).toBe(
      "offered on this server's Docker and Boat · new organizations run on Boat until an owner chooses · declared",
    );
  });
});

describe("the Boat lines of a server's machine view", () => {
  it("says what was observed and when, with nothing to do, for a server whose Boat works", () => {
    const all = lines();
    expect(all.map((line) => [line.label, line.state])).toEqual([
      ["boat address", "ok"],
      ["boat address", "ok"],
      ["boat key", "ok"],
      ["boat launch", "ok"],
      ["boat gateway", "ok"],
    ]);
    expect(all[0]?.detail).toBe(
      "session traffic at https://mend.example.ts.net:8443 · answered HTTP 404 from the server · observed 2026-11-13 14:02 UTC",
    );
    expect(byLabel(all, "boat key").detail).toMatch(
      /^key of Acme CI @acme-ci service account · a personal key · bills the Boat organization acme-boat · the key's role there: admin · fixed: sealant names it on every request · starts a VM: yes · 2 of 5 VMs running · expires .* · in 200 days · observed 2026-11-13 14:02 UTC$/,
    );
    expect(all.every((line) => line.fix === null)).toBe(true);
  });

  it("warns of a key that expires within fourteen days, and says how to replace it", () => {
    const report = boatKeyReportFixture(
      {
        expiry: {
          observed: true,
          expiresAt: new Date(NOW.getTime() + 9 * DAY_MS),
          expired: false,
          expiringSoon: true,
        },
      },
      NOW,
    );
    const key = byLabel(
      lines({ serverKey: { state: "held", unreachable: null, report } }),
      "boat key",
    );
    expect(key.state).toBe("todo");
    expect(key.fix).toMatch(
      /^This Boat key expires on .*, in 9 days\. After that, new Boat sessions cannot start with it\. Give this server a new key with mend server setup --boat-api-key-stdin\.$/,
    );
  });

  it("reports a key Boat refuses in the Boat failure table's words", () => {
    const key = byLabel(
      lines({
        serverKey: { state: "held", unreachable: null, report: refusedKeyReportFixture(NOW) },
      }),
      "boat key",
    );
    expect(key.state).toBe("failed");
    expect(key.fix).toBe(
      "This server's Boat key has expired, so Boat refused it and new Boat sessions cannot start with it. The person who runs this Mend server gives it a new key with mend server setup --boat-api-key-stdin, or drops its key with --no-boat-api-key so each organization connects its own. Boat keys last 90 days unless made to last longer; the command on the Boat page makes one that lasts a year.",
    );
    expect(key.fix).not.toMatch(/api_key_expired|req_/);
  });

  it("says an address that does not answer is a problem, with how to forward it", () => {
    const address = lines({
      addresses: [
        {
          purpose: "saved-work",
          url: "https://mend.example.ts.net:10000",
          answer: { answered: false, detail: "connect ECONNREFUSED" },
          observedAt: NOW,
        },
      ],
    })[0];
    expect(address).toEqual({
      label: "boat address",
      state: "failed",
      detail:
        "saved work at https://mend.example.ts.net:10000 · no answer from the server (connect ECONNREFUSED) · observed 2026-11-13 14:02 UTC",
      fix: "Forward https://mend.example.ts.net:10000 to this server with a Tailscale Funnel or your own TLS proxy. Boat VMs dial it, and a Boat session cannot start or keep its work without it.",
    });
  });

  it("says Boat sessions are refused when no worker reported it launches Boat", () => {
    const launch = byLabel(
      lines({ launch: { state: "not-listed", observedAt: NOW } }),
      "boat launch",
    );
    expect(launch.state).toBe("failed");
    expect(launch.detail).toContain("no worker has reported that it launches Boat VMs");
  });

  it("asks for a key first when there is none to launch with", () => {
    const launch = byLabel(
      lines({
        serverKey: { state: "none" },
        storedKeys: 0,
        launch: { state: "not-listed", observedAt: NOW },
      }),
      "boat launch",
    );
    expect(launch.state).toBe("todo");
    expect(launch.fix).toContain("mend boat connect");
  });

  it("states a gateway the server turned off as declared, and a missing one as a problem", () => {
    const listed = { state: "listed" as const, observedAt: NOW, resourceGateway: false };
    expect(boatGatewayLine(listed, false)?.state).toBe("info");
    expect(boatGatewayLine(listed, true)?.state).toBe("failed");
    expect(boatGatewayLine({ state: "unread", reason: "x" }, undefined)).toBeNull();
  });
});
