import { boatKeyReportFixture, refusedKeyReportFixture, serverBoatFactsFixture } from "@mend/domain/boat-key-fixtures";
import { ServerBoatFacts } from "@mend/domain/workbench";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand, type ServerSetupRuntime } from "./server-setup.ts";

const { cleanups, fixture } = lifecycleTestFixtures();
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const GATEWAY =
  "ghcr.io/sealant-sh/sealant-boat-gateway-next@sha256:1111111111111111111111111111111111111111111111111111111111111111";
const ENDPOINTS = [
  "--session-endpoint-url",
  "https://mend.example.com:8443",
  "--blob-store-public-url",
  "https://mend.example.com:10000",
];
const DAY_MS = 86_400_000;
const encodeFacts = Schema.encodeSync(Schema.toCodecJson(ServerBoatFacts));

type Fixture = Awaited<ReturnType<ReturnType<typeof lifecycleTestFixtures>["fixture"]>>;

/** Boat set up and offered beside Docker, the default for new organizations. */
const boatServer = async (): Promise<Fixture> => {
  const f = await fixture();
  f.update({ boatGatewayImage: GATEWAY });
  expect(await f.setup()).toEqual({ _tag: "ok" });
  expect(
    await serverCommand(
      ["setup", "--offline", "--session-runtimes", "docker,boat", "--session-runtime", "boat", ...ENDPOINTS],
      f.runtime,
    ),
  ).toEqual({ _tag: "ok" });
  return f;
};

/**
 * `mend server status` as the operator signed in on this machine, with the running server's
 * machine view carrying `boat`, and the public addresses answering as `addresses` says.
 */
const statusOf = async (
  f: Fixture,
  options: {
    readonly boat?: ServerBoatFacts;
    readonly signedIn?: boolean;
    readonly addressesAnswer?: boolean;
  } = {},
): Promise<ReadonlyArray<string>> => {
  const appUrl: string = JSON.parse(f.files()["server.json"] ?? "{}").appUrl;
  const runtime: ServerSetupRuntime = {
    ...f.runtime,
    ...(options.signedIn === false ? {} : { readLogin: () => ({ url: appUrl, token: "t" }) }),
    fetchText: async (url, timeout, headers) => {
      if (url.endsWith("/api/machine"))
        return {
          status: 200,
          body: JSON.stringify(options.boat === undefined ? {} : { boat: encodeFacts(options.boat) }),
        };
      if (url.includes("/api/operator/")) return { status: 404, body: "" };
      if (url.startsWith("https://mend.example.com:") && options.addressesAnswer === false)
        return { status: 0, body: "", error: "getaddrinfo ENOTFOUND mend.example.com" };
      return f.runtime.fetchText(url, timeout, headers);
    },
  };
  f.lines.length = 0;
  expect(await serverCommand(["status"], runtime)).toEqual({ _tag: "ok" });
  return [...f.lines];
};

const lineOf = (lines: ReadonlyArray<string>, start: string): string => {
  const line = lines.find((entry) => entry.startsWith(start));
  if (line === undefined) throw new Error(`no line starting "${start}" in:\n${lines.join("\n")}`);
  return line;
};

describe("mend server status on where sessions run and Boat (SLNT-799)", { timeout: 120_000 }, () => {
  it("says only what a Docker-only server offers", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const lines = await statusOf(f);
    expect(lineOf(lines, "sessions · ")).toBe(
      "sessions · offered on this server's Docker · new organizations run on this server's Docker until an owner chooses · declared",
    );
    expect(lines.filter((line) => line.startsWith("boat"))).toEqual([]);
  });

  it("reports a Boat server with a working key: what was declared, and what was observed when", async () => {
    const f = await boatServer();
    const lines = await statusOf(f, { boat: serverBoatFactsFixture() });
    expect(lineOf(lines, "sessions · ")).toBe(
      "sessions · offered on this server's Docker and Boat · new organizations run on Boat until an owner chooses · declared",
    );
    const boat = lines.filter((line) => line.startsWith("boat"));
    expect(boat.map((line) => line.split(" · ")[0])).toEqual([
      "boat address",
      "boat address",
      "boat key",
      "boat launch",
      "boat gateway",
    ]);
    expect(boat[0]).toMatch(
      /^boat address · session traffic at https:\/\/mend\.example\.com:8443 · answered HTTP 404 from this machine · observed \d{4}-\d\d-\d\d \d\d:\d\d UTC$/,
    );
    expect(lineOf(lines, "boat key · ")).toMatch(
      /^boat key · key of Acme CI @acme-ci .* starts a VM: yes .* · observed \d{4}-\d\d-\d\d \d\d:\d\d UTC$/,
    );
    expect(lineOf(lines, "boat launch · ")).toMatch(/a worker reported that it launches Boat VMs/);
    expect(lineOf(lines, "boat gateway · ")).toMatch(/^boat gateway · declared on · present/);
    expect(boat.some((line) => line.includes(" → "))).toBe(false);
  });

  it("warns of a key that expires within fourteen days", async () => {
    const f = await boatServer();
    const report = boatKeyReportFixture({
      expiry: {
        observed: true,
        expiresAt: new Date(Date.now() + 10 * DAY_MS),
        expired: false,
        expiringSoon: true,
      },
    });
    const key = lineOf(
      await statusOf(f, { boat: serverBoatFactsFixture({ serverKey: { state: "held", report } }) }),
      "boat key · ",
    );
    expect(key).toMatch(/→ This Boat key expires on .*, in 10 days\./);
    expect(key).toContain("mend server setup --boat-api-key-stdin");
  });

  it("says a refused key needs a new one, in the Boat failure table's words", async () => {
    const f = await boatServer();
    const key = lineOf(
      await statusOf(f, {
        boat: serverBoatFactsFixture({
          serverKey: { state: "held", report: refusedKeyReportFixture() },
        }),
      }),
      "boat key · ",
    );
    expect(key).toContain(
      "→ This server's Boat key has expired, so Boat refused it and new Boat sessions cannot start with it.",
    );
    expect(key).not.toMatch(/api_key_expired|req_fixture/);
  });

  it("says an address that does not answer from this machine, and how to forward it", async () => {
    const f = await boatServer();
    const address = lineOf(
      await statusOf(f, { boat: serverBoatFactsFixture(), addressesAnswer: false }),
      "boat address · saved work",
    );
    expect(address).toMatch(
      /^boat address · saved work at https:\/\/mend\.example\.com:10000 · no answer from this machine \(getaddrinfo ENOTFOUND mend\.example\.com\) · observed .* → Forward https:\/\/mend\.example\.com:10000 to this server/,
    );
  });

  it("says Boat sessions are refused while no worker reported it launches Boat", async () => {
    const f = await boatServer();
    const launch = lineOf(
      await statusOf(f, {
        boat: serverBoatFactsFixture({ launch: { state: "not-listed", observedAt: new Date() } }),
      }),
      "boat launch · ",
    );
    expect(launch).toMatch(/no worker has reported that it launches Boat VMs, so Boat sessions are refused/);
    expect(launch).toContain("→ On the server's machine, mend server logs --tail 200");
  });

  it("says what is declared, and which sign-in reads the rest, without the operator's sign-in", async () => {
    const f = await boatServer();
    const lines = await statusOf(f, { signedIn: false });
    expect(lineOf(lines, "boat key · ")).toMatch(
      /^boat key · this server has no Boat key of its own · declared · what Sealant last observed of it, and whether a worker launches Boat, needs the operator's sign-in on this machine: mend login --url /,
    );
    expect(lineOf(lines, "boat gateway · ")).toBe("boat gateway · declared on · not observed");
  });
});
