import { afterEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

/**
 * Upgrade tickets through the real routes (docs/adr/0004, "Upgrade tickets"; MEND-08). The raw
 * routes here are the production terminal and tunnel routes over the two-organization world; the
 * platform behind them is a recording mock, so a request that gets past authentication and
 * authorization answers something other than 400/401/404, and one that does not leaves no effect.
 */
let api: TenancyApi | null = null;
afterEach(async () => {
  await api?.dispose();
  api = null;
});

const sharedA = ids("shared-a");
const privateAlice = ids("private-alice");

const mint = async (
  on: TenancyApi,
  user: "alice" | "carol" | "bob",
  body: Record<string, string>,
) => {
  const response = await on.request(user, "POST", "/api/upgrade-tickets", body);
  const text = await response.text();
  const minted: unknown = text === "" ? null : JSON.parse(text);
  return { status: response.status, minted };
};

const ticketOf = (minted: unknown): string => {
  if (typeof minted === "object" && minted !== null && "ticket" in minted) {
    const { ticket } = minted;
    if (typeof ticket === "string") return ticket;
  }
  throw new Error("no ticket in the response");
};

const tty = (on: TenancyApi, session: string, ticket: string) =>
  on.rawRequest(null, `/api/tty?session=${session}&ticket=${encodeURIComponent(ticket)}`);

const PAST_AUTH = [400, 401, 404];

describe("an upgrade ticket", () => {
  it("opens exactly what it was minted for, once, with no other credential on the request", async () => {
    api = await createTenancyApi();
    const { status, minted } = await mint(api, "carol", {
      target: "tty",
      session: sharedA.session,
    });
    expect(status).toBe(200);
    expect(minted).toMatchObject({ expiresInSeconds: 30 });
    const ticket = ticketOf(minted);
    expect(ticket.startsWith("mut_")).toBe(true);

    const first = await tty(api, sharedA.session, ticket);
    expect(PAST_AUTH).not.toContain(first.status);

    api.world.calls.splice(0, api.world.calls.length);
    const replay = await tty(api, sharedA.session, ticket);
    expect(replay.status).toBe(401);
    expect(api.world.calls).toEqual([]);
  });

  it("is refused for another session, and that guess does not spend it", async () => {
    api = await createTenancyApi();
    const ticket = ticketOf(
      (await mint(api, "alice", { target: "tty", session: sharedA.session })).minted,
    );
    api.world.calls.splice(0, api.world.calls.length);
    expect((await tty(api, privateAlice.session, ticket)).status).toBe(401);
    expect(api.world.calls).toEqual([]);
    expect(PAST_AUTH).not.toContain((await tty(api, sharedA.session, ticket)).status);
  });

  it("is refused at another target", async () => {
    api = await createTenancyApi();
    const tunnelTicket = ticketOf(
      (await mint(api, "carol", { target: "service-tunnel", service: sharedA.service })).minted,
    );
    const atTerminal = await api.rawRequest(
      null,
      `/api/tty?session=${sharedA.session}&ticket=${encodeURIComponent(tunnelTicket)}`,
    );
    expect(atTerminal.status).toBe(401);
  });

  it("is refused after thirty seconds", async () => {
    let now = 1_000_000;
    api = await createTenancyApi({}, { clock: () => now });
    const ticket = ticketOf(
      (await mint(api, "carol", { target: "tty", session: sharedA.session })).minted,
    );
    now += 30_000;
    expect((await tty(api, sharedA.session, ticket)).status).toBe(401);
  });

  it("authorizes as the account that minted it: another organization's session stays missing", async () => {
    api = await createTenancyApi();
    // Minting authorizes nothing, so bob may mint for a session he cannot see...
    const ticket = ticketOf(
      (await mint(api, "bob", { target: "tty", session: sharedA.session })).minted,
    );
    api.world.calls.splice(0, api.world.calls.length);
    // ...and spending it answers exactly like a missing session, with no effect.
    const response = await tty(api, sharedA.session, ticket);
    expect(response.status).toBe(404);
    expect(api.world.calls).toEqual([]);
  });

  it("needs parameters that address its target", async () => {
    api = await createTenancyApi();
    expect((await mint(api, "carol", { target: "tty" })).status).toBe(400);
    expect((await mint(api, "carol", { target: "tty", session: "s", process: "p" })).status).toBe(
      400,
    );
    expect((await mint(api, "carol", { target: "service-tunnel" })).status).toBe(400);
    expect((await mint(api, "carol", { target: "keys-bridge" })).status).toBe(200);
    const unauthenticated = await api.request(null, "POST", "/api/upgrade-tickets", {
      target: "keys-bridge",
    });
    expect(unauthenticated.status).toBe(401);
  });
});

const exchange = (on: TenancyApi, ticket: string, session: string) =>
  on.request(null, "POST", "/api/upgrade-tickets/exchange", { ticket, session });
const renewOf = (body: unknown): string => {
  if (typeof body === "object" && body !== null && "renew" in body) {
    const { renew } = body;
    if (typeof renew === "string") return renew;
  }
  throw new Error("no renewal ticket in the response");
};

describe("the embed exchange", () => {
  it("trades an embed ticket for a terminal ticket with the same parameters, once", async () => {
    api = await createTenancyApi();
    const embed = ticketOf(
      (await mint(api, "carol", { target: "tty-embed", session: sharedA.session })).minted,
    );
    // An embed ticket is not a terminal ticket.
    expect((await tty(api, sharedA.session, embed)).status).toBe(401);
    // Another session's parameters do not spend it.
    expect((await exchange(api, embed, privateAlice.session)).status).toBe(401);
    const traded = await exchange(api, embed, sharedA.session);
    expect(traded.status).toBe(200);
    const terminal = ticketOf(await traded.json());
    expect((await exchange(api, embed, sharedA.session)).status).toBe(401);
    expect(PAST_AUTH).not.toContain((await tty(api, sharedA.session, terminal)).status);
  });

  it("lets the page reconnect with its renewal ticket, again after a lost reply", async () => {
    let now = 1_000_000;
    api = await createTenancyApi({}, { clock: () => now });
    const embed = ticketOf(
      (await mint(api, "carol", { target: "tty-embed", session: sharedA.session })).minted,
    );
    const first: unknown = await (await exchange(api, embed, sharedA.session)).json();
    // Long after the URL's ticket would have expired, the page reconnects.
    now += 60 * 60 * 1000;
    const second = await exchange(api, renewOf(first), sharedA.session);
    expect(second.status).toBe(200);
    const secondBody: unknown = await second.json();
    expect(PAST_AUTH).not.toContain((await tty(api, sharedA.session, ticketOf(secondBody))).status);
    // The renewal is kept, not replaced: a reply lost on the way back strands nobody.
    expect(renewOf(secondBody)).toBe(renewOf(first));
    expect((await exchange(api, renewOf(first), sharedA.session)).status).toBe(200);
    // It opens no terminal itself and no other session's.
    expect((await tty(api, sharedA.session, renewOf(first))).status).toBe(401);
    expect((await exchange(api, renewOf(first), privateAlice.session)).status).toBe(401);
  });

  it("ends with the sign-in that minted it: tickets, renewals and the terminal's own", async () => {
    const revoked = new Set<string>();
    api = await createTenancyApi({}, { revokedCredentials: revoked });
    const embed = ticketOf(
      (await mint(api, "carol", { target: "tty-embed", session: sharedA.session })).minted,
    );
    const first: unknown = await (await exchange(api, embed, sharedA.session)).json();
    const direct = ticketOf(
      (await mint(api, "carol", { target: "tty", session: sharedA.session })).minted,
    );
    // Carol signs out (or her password changes, or an operator revokes her sessions).
    revoked.add("session:carol");
    api.world.calls.splice(0, api.world.calls.length);
    expect((await exchange(api, renewOf(first), sharedA.session)).status).toBe(401);
    expect((await tty(api, sharedA.session, ticketOf(first))).status).toBe(401);
    expect((await tty(api, sharedA.session, direct)).status).toBe(401);
    expect(api.world.calls).toEqual([]);
  });

  it("refuses a repeated parameter, so a ticket never opens a session it was not minted for", async () => {
    api = await createTenancyApi();
    const ticket = ticketOf(
      (await mint(api, "carol", { target: "tty", session: sharedA.session })).minted,
    );
    api.world.calls.splice(0, api.world.calls.length);
    const smuggled = await api.rawRequest(
      null,
      `/api/tty?session=${privateAlice.session}&session=${sharedA.session}&ticket=${encodeURIComponent(ticket)}`,
    );
    expect(smuggled.status).toBe(400);
    expect(api.world.calls).toEqual([]);
    // Refused, not spent.
    expect(PAST_AUTH).not.toContain((await tty(api, sharedA.session, ticket)).status);
  });

  it("stops renewing after twelve hours, and a renewal ticket cannot be minted directly", async () => {
    let now = 1_000_000;
    api = await createTenancyApi({}, { clock: () => now });
    const embed = ticketOf(
      (await mint(api, "carol", { target: "tty-embed", session: sharedA.session })).minted,
    );
    const first: unknown = await (await exchange(api, embed, sharedA.session)).json();
    now += 12 * 60 * 60 * 1000;
    expect((await exchange(api, renewOf(first), sharedA.session)).status).toBe(401);
    expect(
      (await mint(api, "carol", { target: "tty-renew", session: sharedA.session })).status,
    ).toBe(400);
  });
});

describe("a bearer in the URL", () => {
  it("is accepted while MEND_URL_BEARERS=accept, for clients older than tickets", async () => {
    api = await createTenancyApi({}, { urlBearers: "accept" });
    const response = await api.rawRequest(null, `/api/tty?session=${sharedA.session}&token=carol`);
    expect(PAST_AUTH).not.toContain(response.status);
  });

  it("is refused with 400 under MEND_URL_BEARERS=refuse, with no effect", async () => {
    api = await createTenancyApi({}, { urlBearers: "refuse" });
    api.world.calls.splice(0, api.world.calls.length);
    const response = await api.rawRequest(null, `/api/tty?session=${sharedA.session}&token=carol`);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("carol");
    expect(api.world.calls).toEqual([]);
    // A header is unaffected.
    const withHeader = await api.rawRequest("carol", `/api/tty?session=${sharedA.session}`);
    expect(PAST_AUTH).not.toContain(withHeader.status);
  });
});
