import { once } from "node:events";
import { createServer } from "node:http";

import { BoatKeyStatus } from "@mend/api-contracts";
import {
  boatKeyReportFixture,
  boatUnreachableFixture,
  refusedKeyReportFixture,
  serverBoatFactsFixture,
} from "@mend/domain/boat-key-fixtures";
import { BoatKeyReport, ServerBoatFacts } from "@mend/domain/workbench";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { type Check, formatCheck, runChecks } from "./doctor.ts";

const DAY_MS = 86_400_000;
const now = new Date();

const encodeFacts = Schema.encodeSync(Schema.toCodecJson(ServerBoatFacts));
const encodeReport = Schema.encodeSync(Schema.toCodecJson(BoatKeyReport));
const encodeStatus = Schema.encodeSync(Schema.toCodecJson(BoatKeyStatus));

const BOTH = { offered: ["docker", "boat"], default: "boat" } as const;

/** A signed-in Mend whose machine view says `machine`, and whose Boat key routes say the rest. */
const doctorAgainst = async (routes: {
  readonly sessionRuntimes: unknown;
  readonly boat?: ServerBoatFacts;
  readonly organizationKey?: BoatKeyStatus;
  readonly personKey?: unknown;
  /** What `/organization/runtime` answers a member (SLNT-822). */
  readonly organizationRuntime?: unknown;
  /** `--check-boat-key`, and what the check answers; undefined: a 404, as to a non-operator. */
  readonly checkBoatKey?: { readonly answer?: unknown };
}): Promise<ReadonlyArray<Check>> => {
  const answers: Record<string, unknown> = {
    "/api/health": { status: "ok", version: "0.5.0" },
    "/api/projects": [],
    "/api/machine": {
      hostname: "fixture",
      platform: "linux",
      tailnet: { status: "not-detected", address: null },
      sessionRuntimes: routes.sessionRuntimes,
      ...(routes.boat === undefined ? {} : { boat: encodeFacts(routes.boat) }),
    },
    ...(routes.organizationKey === undefined
      ? {}
      : { "/api/organization/boat-key": encodeStatus(routes.organizationKey) }),
    ...(routes.personKey === undefined ? {} : { "/api/me/boat-key": routes.personKey }),
    ...(routes.organizationRuntime === undefined
      ? {}
      : { "/api/organization/runtime": routes.organizationRuntime }),
    ...(routes.checkBoatKey?.answer === undefined
      ? {}
      : { "/api/machine/boat-key/check": routes.checkBoatKey.answer }),
  };
  const asked: Array<string> = [];
  const server = createServer((request, response) => {
    asked.push(`${request.method ?? "GET"} ${request.url ?? ""}`);
    const body = answers[request.url ?? ""];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  try {
    const checks = await runChecks(
      { url: `http://127.0.0.1:${address.port}`, token: "token" },
      {
        localCredential: () => null,
        claudeGrant: () => null,
        onPath: () => false,
        ...(routes.checkBoatKey === undefined ? {} : { checkBoatKey: true }),
      },
    );
    // The check is asked before the machine view, so the Boat lines show what it observed.
    if (routes.checkBoatKey !== undefined)
      expect(asked.indexOf("POST /api/machine/boat-key/check")).toBeLessThan(
        asked.indexOf("GET /api/machine"),
      );
    return checks.filter((check) => check.label === "sessions" || check.label.includes("boat"));
  } finally {
    server.close();
    await once(server, "close");
  }
};

const labelled = (checks: ReadonlyArray<Check>, label: string): Check => {
  const check = checks.find((entry) => entry.label === label);
  if (check === undefined) throw new Error(`no ${label} line in ${JSON.stringify(checks)}`);
  return check;
};

describe("mend doctor on where sessions run and Boat (SLNT-799)", { timeout: 30_000 }, () => {
  it("says only what a Docker-only server offers", async () => {
    const checks = await doctorAgainst({
      sessionRuntimes: { offered: ["docker"], default: "docker" },
    });
    expect(checks.map((check) => formatCheck(check))).toEqual([
      "· sessions    offered on this server's Docker · new organizations run on this server's Docker until an owner chooses · declared",
    ]);
  });

  it("reports a Boat server with a working key line by line, with nothing to do", async () => {
    const checks = await doctorAgainst({
      sessionRuntimes: BOTH,
      boat: serverBoatFactsFixture({}, now),
      organizationKey: new BoatKeyStatus({
        connected: false,
        sessionRuntime: "boat",
        details: null,
        peopleWithOwnKeys: null,
      }),
    });
    expect(checks.map((check) => [check.label, check.state])).toEqual([
      ["sessions", "info"],
      ["boat address", "ok"],
      ["boat address", "ok"],
      ["boat key", "ok"],
      ["boat launch", "ok"],
      ["boat gateway", "ok"],
      ["org boat key", "todo"],
    ]);
    expect(labelled(checks, "boat key").detail).toMatch(
      /· observed \d{4}-\d\d-\d\d \d\d:\d\d UTC$/,
    );
  });

  it("warns of a server key that expires within fourteen days", async () => {
    const report = boatKeyReportFixture(
      {
        expiry: {
          observed: true,
          expiresAt: new Date(now.getTime() + 5 * DAY_MS),
          expired: false,
          expiringSoon: true,
        },
      },
      now,
    );
    const key = labelled(
      await doctorAgainst({
        sessionRuntimes: BOTH,
        boat: serverBoatFactsFixture(
          { serverKey: { state: "held", unreachable: null, report } },
          now,
        ),
      }),
      "boat key",
    );
    expect(key.state).toBe("todo");
    expect(key.fix).toContain("in 5 days");
    expect(key.fix).toContain("mend server setup --boat-api-key-stdin");
  });

  it("fails a server key Boat refuses, in the Boat failure table's words", async () => {
    const key = labelled(
      await doctorAgainst({
        sessionRuntimes: BOTH,
        boat: serverBoatFactsFixture(
          { serverKey: { state: "held", unreachable: null, report: refusedKeyReportFixture(now) } },
          now,
        ),
      }),
      "boat key",
    );
    expect(key.state).toBe("failed");
    expect(key.fix).toMatch(/^This server's Boat key has expired, so Boat refused it/);
  });

  it("fails an address that does not answer", async () => {
    const checks = await doctorAgainst({
      sessionRuntimes: BOTH,
      boat: serverBoatFactsFixture(
        {
          addresses: [
            {
              purpose: "sessions",
              url: "https://mend.example.ts.net:8443",
              answer: { answered: false, detail: "ENOTFOUND" },
              observedAt: now,
            },
          ],
        },
        now,
      ),
    });
    const address = labelled(checks, "boat address");
    expect(address.state).toBe("failed");
    expect(address.fix).toContain("Forward https://mend.example.ts.net:8443 to this server");
  });

  it("fails a server that offers Boat with no worker able to launch it", async () => {
    const launch = labelled(
      await doctorAgainst({
        sessionRuntimes: BOTH,
        boat: serverBoatFactsFixture({ launch: { state: "not-listed", observedAt: now } }, now),
      }),
      "boat launch",
    );
    expect(launch.state).toBe("failed");
    expect(launch.fix).toContain("mend server logs");
  });

  it("says nothing of the server's own facts to someone who does not operate it", async () => {
    const checks = await doctorAgainst({
      sessionRuntimes: BOTH,
      organizationKey: new BoatKeyStatus({
        connected: true,
        sessionRuntime: "boat",
        details: null,
        peopleWithOwnKeys: null,
      }),
    });
    expect(checks.map((check) => check.label)).toEqual(["sessions", "org boat key"]);
    expect(labelled(checks, "org boat key").detail).toBe(
      "this organization has its own Boat key · only an owner reads its details",
    );
  });

  it("tells a member whether sealant lists Boat for their organization, from its runtime (SLNT-822)", async () => {
    const runtimeOf = (support: unknown) => ({
      sessionRuntime: {
        chosen: null,
        effective: "boat",
        offered: ["docker", "boat"],
        serverDefault: "boat",
      },
      support,
    });
    const refused = labelled(
      await doctorAgainst({
        sessionRuntimes: BOTH,
        organizationRuntime: runtimeOf({
          state: "not-launched",
          observedAt: now.toISOString(),
          runtime: "boat",
        }),
      }),
      "boat launch",
    );
    expect(refused.state).toBe("failed");
    expect(refused.detail).toMatch(
      /^sealant does not list Boat, so this organization's Boat sessions are refused · observed /,
    );
    const unread = labelled(
      await doctorAgainst({
        sessionRuntimes: BOTH,
        organizationRuntime: runtimeOf({ state: "unread", reason: "sealant did not answer" }),
      }),
      "boat launch",
    );
    expect(unread).toMatchObject({ state: "info", detail: "not read · sealant did not answer" });
  });

  it("names what sealant cannot reach for an owner of the organization's key", async () => {
    const checks = await doctorAgainst({
      sessionRuntimes: BOTH,
      organizationKey: new BoatKeyStatus({
        connected: true,
        sessionRuntime: "boat",
        details: {
          sealantBoatAccountId: "0b0a7c1e-4f3d-4a51-9d2e-1c8f6b7a9e30",
          connectedByUserId: "alice",
          connectedByName: "Alice",
          connectedAt: now,
          keyReplacedAt: null,
          report: boatKeyReportFixture({}, now),
          fullCheck: { last: null, runningSince: null },
          unreachable: boatUnreachableFixture,
        },
        peopleWithOwnKeys: [],
      }),
    });
    const unreachable = labelled(checks, "org boat unreachable");
    expect(unreachable.state).toBe("todo");
    expect(unreachable.fix).toContain("sealant-img-a1b2");
  });

  it("checks the server's own key now with --check-boat-key, for its operator only", async () => {
    const checked = await doctorAgainst({
      sessionRuntimes: BOTH,
      boat: serverBoatFactsFixture({}, now),
      checkBoatKey: { answer: { state: "none" } },
    });
    expect(labelled(checked, "boat key check")).toMatchObject({
      state: "ok",
      detail: expect.stringMatching(
        /^sealant asked Boat about the server's own key now · observed /,
      ),
    });
    const refused = await doctorAgainst({ sessionRuntimes: BOTH, checkBoatKey: {} });
    expect(labelled(refused, "boat key check")).toMatchObject({
      state: "failed",
      detail: "not checked: only this server's operator checks its own Boat key",
    });
  });

  it("covers a person's own key in the same words as the organization's", async () => {
    const report = refusedKeyReportFixture(now);
    const details = {
      sealantBoatAccountId: "0b0a7c1e-4f3d-4a51-9d2e-1c8f6b7a9e30",
      connectedByUserId: "carol",
      connectedByName: "Carol",
      connectedAt: now.toISOString(),
      keyReplacedAt: null,
    };
    const checks = await doctorAgainst({
      sessionRuntimes: BOTH,
      personKey: {
        organizationName: "Acme",
        connected: true,
        sessionRuntime: "boat",
        organizationKey: false,
        details: {
          ...details,
          report: encodeReport(report),
        },
      },
    });
    const own = labelled(checks, "own boat key");
    expect(own.state).toBe("failed");
    expect(own.fix).toBe(
      "This Boat key has expired, so Boat refused it and new Boat sessions cannot start with it. Create a new key using the command in Settings, Account and connect that one there, or with mend boat connect --mine. Boat keys last 90 days unless made to last longer; the command on the Boat page makes one that lasts a year.",
    );
    expect(own.fix).not.toContain("Settings, Organization");
  });
});
