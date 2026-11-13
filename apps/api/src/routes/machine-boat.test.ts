import { SessionRuntimeOffer } from "@mend/domain";
import { refusedKeyReportFixture, serverBoatFactsFixture } from "@mend/domain/boat-key-fixtures";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { askAddress, boatLaunchOf } from "../machine-boat.ts";
import { createTenancyApi } from "../../test/support/tenancy-api.ts";

const NOW = new Date("2026-11-13T14:02:00.000Z");

const machineOf = async (
  offer: SessionRuntimeOffer,
  user: "alice" | "carol" | "bob",
): Promise<Record<string, unknown>> => {
  const api = await createTenancyApi(
    {},
    {
      sessionRuntimes: offer,
      machineBoat: serverBoatFactsFixture(
        { serverKey: { state: "held", report: refusedKeyReportFixture(NOW) } },
        NOW,
      ),
    },
  );
  try {
    const response = await api.request(user, "GET", "/api/machine");
    const body: unknown = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    if (typeof body !== "object" || body === null) throw new Error("not an object");
    return { ...body };
  } finally {
    await api.dispose();
  }
};

const BOTH = new SessionRuntimeOffer({ offered: ["docker", "boat"], default: "boat" });

describe("the machine view's sessions and Boat facts (SLNT-799)", () => {
  it("tells everyone where sessions may run, as declared", async () => {
    const machine = await machineOf(BOTH, "carol");
    expect(machine["sessionRuntimes"]).toEqual({ offered: ["docker", "boat"], default: "boat" });
  });

  it("gives the server's own Boat facts to its operator, with when each was observed", async () => {
    const machine = await machineOf(BOTH, "alice");
    expect(machine["boat"]).toMatchObject({
      addresses: [
        {
          purpose: "sessions",
          url: "https://mend.example.ts.net:8443",
          answer: { answered: true, status: 404 },
          observedAt: NOW.toISOString(),
        },
        { purpose: "saved-work", observedAt: NOW.toISOString() },
      ],
      serverKey: {
        state: "held",
        report: {
          observedAt: NOW.toISOString(),
          identity: { observed: false, reason: "refused", boat: { kind: "key-expired" } },
        },
      },
      storedKeys: 1,
      launch: { state: "listed", observedAt: NOW.toISOString(), resourceGateway: true },
    });
  });

  it("keeps them from an owner and a member who do not operate the server", async () => {
    for (const user of ["carol", "bob"] as const) {
      expect(await machineOf(BOTH, user)).not.toHaveProperty("boat");
    }
  });

  it("says nothing of Boat on a server that offers Docker alone", async () => {
    const machine = await machineOf(
      new SessionRuntimeOffer({ offered: ["docker"], default: "docker" }),
      "alice",
    );
    expect(machine).not.toHaveProperty("boat");
    expect(machine["sessionRuntimes"]).toEqual({ offered: ["docker"], default: "docker" });
  });
});

describe("whether Sealant lists Boat", () => {
  it("reads Boat and its gateway from the runtime report, or says Sealant left it out", () => {
    const notListed = boatLaunchOf({
      state: "observed",
      observedAt: NOW,
      runtimes: {
        default: "docker",
        runtimes: [],
      },
    });
    expect(notListed).toEqual({ state: "not-listed", observedAt: NOW });
    expect(boatLaunchOf({ state: "unread", reason: "Sealant could not be reached" })).toEqual({
      state: "unread",
      reason: "Sealant could not be reached",
    });
  });
});

describe("asking a public address from the server", () => {
  it("takes any HTTP answer as an answer, and says why there was none", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address: AddressInfo | string | null = server.address();
    if (address === null || typeof address === "string") throw new Error("no loopback port");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const answered = await Effect.runPromise(askAddress("sessions", url));
      expect(answered).toMatchObject({ purpose: "sessions", url, answer: { answered: true, status: 404 } });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const refused = await Effect.runPromise(askAddress("saved-work", url));
    expect(refused.answer).toEqual({ answered: false, detail: "ECONNREFUSED" });
  });
});
