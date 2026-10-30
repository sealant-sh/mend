import { type Auth, type AuthSession } from "@mend/auth";
import { makeUpgradeTicketsMemory, OrganizationsRepo, type UpgradeTicketsRepo } from "@mend/db";
import { Context, Effect, Logger, Option } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import {
  CAROL_SHELL_IN_SHARED_A,
  createTenancyWorld,
  PROTOCOL_PROCESS,
} from "../../test/support/tenancy-harness.ts";
import { isUpgradeCaller, resolveUpgradeCaller } from "./upgrade-tickets.ts";

const failureKinds = ["invalid", "expired", "spent", "foreign-scope"] satisfies ReadonlyArray<
  "invalid" | "expired" | "spent" | "foreign-scope"
>;
const processUrl = `/api/tty?process=${PROTOCOL_PROCESS}`;
const ticketOf = (body: unknown) => {
  if (
    body === null ||
    typeof body !== "object" ||
    !("ticket" in body) ||
    typeof body.ticket !== "string"
  )
    throw new Error("Missing minted ticket");
  return body.ticket;
};
const mintProcessTicket = async (api: TenancyApi, user: "alice" | "bob", process: string) => {
  const response = await api.request(user, "POST", "/api/upgrade-tickets", {
    target: "tty",
    process,
  });
  expect(response.status).toBe(200);
  return ticketOf(await response.json());
};

describe("query upgrade ticket precedence through the actual terminal route", () => {
  for (const kind of failureKinds)
    it(`refuses an ${kind} query ticket even with an admitted header`, async () => {
      let now = 1_000_000;
      const api = await createTenancyApi({}, { clock: () => now });
      try {
        // This exact response establishes authentication/authorization before a physical socket.
        const headerOnly = await api.rawRequest("alice", processUrl);
        expect(headerOnly.status).toBe(409);
        expect(await headerOnly.text()).toBe("protocol agents use the structured conversation API");
        const token =
          kind === "invalid"
            ? "mut_unknown_fixture"
            : await mintProcessTicket(
                api,
                "alice",
                kind === "foreign-scope" ? CAROL_SHELL_IN_SHARED_A : PROTOCOL_PROCESS,
              );
        if (kind === "expired") now += 30_000;
        if (kind === "spent") {
          const first = await api.rawRequest(
            null,
            `${processUrl}&ticket=${encodeURIComponent(token)}`,
          );
          expect(first.status).toBe(409);
          expect(await first.text()).toBe("protocol agents use the structured conversation API");
        }
        api.world.calls.length = 0;
        const refused = await api.rawRequest(
          "alice",
          `${processUrl}&ticket=${encodeURIComponent(token)}`,
        );
        expect(refused.status).toBe(401);
        expect(await refused.text()).toBe("");
        expect(api.world.calls).toEqual([]);
        // A scope refusal leaves the ticket usable at its address, where Alice cannot steer Carol.
        if (kind === "foreign-scope") {
          const rightful = await api.rawRequest(
            null,
            `/api/tty?process=${CAROL_SHELL_IN_SHARED_A}&ticket=${encodeURIComponent(token)}`,
          );
          expect(rightful.status).toBe(403);
          expect(await rightful.text()).toBe("forbidden");
          expect(api.world.calls).toEqual([]);
        }
      } finally {
        await api.dispose();
      }
    });

  it("authorizes a valid Bob ticket as Bob despite Alice's admitted header", async () => {
    const api = await createTenancyApi();
    try {
      const headerOnly = await api.rawRequest("alice", processUrl);
      expect(headerOnly.status).toBe(409);
      expect(await headerOnly.text()).toBe("protocol agents use the structured conversation API");
      const token = await mintProcessTicket(api, "bob", PROTOCOL_PROCESS);
      api.world.calls.length = 0;
      const foreign = await api.rawRequest(
        "alice",
        `${processUrl}&ticket=${encodeURIComponent(token)}`,
      );
      expect(foreign.status).toBe(404);
      expect(await foreign.text()).toBe("unknown process");
      expect(api.world.calls).toEqual([]);
    } finally {
      await api.dispose();
    }
  });
});

interface CookieFixture {
  readonly tickets: UpgradeTicketsRepo["Service"];
  readonly auth: Auth["Service"];
  readonly organizations: OrganizationsRepo["Service"];
  readonly reads: Array<string | null>;
  readonly advance: () => void;
}
const COOKIE = "fixture-session=alice";
const withCookieFixture = async (work: (fixture: CookieFixture) => Promise<void>) => {
  const world = await createTenancyWorld();
  try {
    const context = await Effect.runPromise(
      Effect.context<OrganizationsRepo>().pipe(Effect.provide(world.accessLayers)),
    );
    const organizations = Context.get(context, OrganizationsRepo);
    let now = 1_000_000;
    const reads: Array<string | null> = [];
    const session: AuthSession = {
      user: { id: "alice", name: "Alice", email: "alice@example.invalid" },
      expiresAt: new Date("2100-01-01T00:00:00Z"),
      credential: "session:alice",
    };
    // The auth service owns opaque cookies. This proves precedence, not Better Auth cookie parsing.
    const auth: Auth["Service"] = {
      handler: () => Effect.succeed(new Response(null, { status: 404 })),
      issuePasswordReset: () => Effect.die("unused"),
      getSession: (headers) =>
        Effect.sync(() => {
          const cookie = headers.get("cookie");
          reads.push(cookie);
          return cookie === COOKIE ? Option.some(session) : Option.none();
        }),
    };
    await work({
      tickets: makeUpgradeTicketsMemory(() => now),
      auth,
      organizations,
      reads,
      advance: () => {
        now += 30_000;
      },
    });
  } finally {
    await world.dispose();
  }
};
const cookieCaller = (fixture: CookieFixture, token?: string) =>
  Effect.runPromise(
    resolveUpgradeCaller({
      auth: fixture.auth,
      tickets: fixture.tickets,
      organizations: fixture.organizations,
      urlBearers: { mode: "refuse" },
      headers: new Headers({ cookie: COOKIE }),
      url: new URL(
        `http://fixture/api/tty?session=s1${token === undefined ? "" : `&ticket=${encodeURIComponent(token)}`}`,
      ),
      target: "tty",
    }),
  );

describe("query ticket precedence at the cookie authentication service boundary", () => {
  for (const kind of failureKinds)
    it(`refuses an ${kind} query ticket without consulting a valid cookie`, async () =>
      withCookieFixture(async (fixture) => {
        const cookieOnly = await cookieCaller(fixture);
        expect(isUpgradeCaller(cookieOnly)).toBe(true);
        if (!isUpgradeCaller(cookieOnly)) throw new Error("Cookie positive control refused");
        expect(cookieOnly.userId).toBe("alice");
        expect(fixture.reads).toEqual([COOKIE]);
        fixture.reads.length = 0;
        const minted = await Effect.runPromise(
          fixture.tickets.mint({
            userId: "bob",
            target: "tty",
            scope: kind === "foreign-scope" ? "session=s2" : "session=s1",
            credential: null,
          }),
        );
        if (kind === "expired") fixture.advance();
        if (kind === "spent")
          expect(
            await Effect.runPromise(
              fixture.tickets.consume({
                ticket: minted.ticket,
                target: "tty",
                scope: "session=s1",
              }),
            ),
          ).not.toBeNull();
        const refused = await cookieCaller(
          fixture,
          kind === "invalid" ? "mut_unknown_fixture" : minted.ticket,
        );
        expect(isUpgradeCaller(refused)).toBe(false);
        if (isUpgradeCaller(refused)) throw new Error("Query ticket fell back to cookie");
        expect(refused.status).toBe(401);
        expect(fixture.reads).toEqual([]);
        if (kind === "foreign-scope")
          expect(
            await Effect.runPromise(
              fixture.tickets.consume({
                ticket: minted.ticket,
                target: "tty",
                scope: "session=s2",
              }),
            ),
          ).not.toBeNull();
      }));

  it("keeps a valid query ticket's issuer instead of the cookie account", async () =>
    withCookieFixture(async (fixture) => {
      const minted = await Effect.runPromise(
        fixture.tickets.mint({
          userId: "bob",
          target: "tty",
          scope: "session=s1",
          credential: null,
        }),
      );
      const caller = await cookieCaller(fixture, minted.ticket);
      expect(isUpgradeCaller(caller)).toBe(true);
      if (!isUpgradeCaller(caller)) throw new Error("Valid query ticket refused");
      expect(caller.userId).toBe("bob");
      expect(await Effect.runPromise(caller.stillAdmitted)).toBe(true);
      expect(fixture.reads).toEqual([]);
    }));
});

describe("a bearer in a URL from a client that predates upgrade tickets", () => {
  it("is logged by its target, with no part of the URL it came in", async () =>
    withCookieFixture(async (fixture) => {
      const lines: Array<string> = [];
      const answer = await Effect.runPromise(
        resolveUpgradeCaller({
          auth: fixture.auth,
          tickets: fixture.tickets,
          organizations: fixture.organizations,
          urlBearers: { mode: "accept" },
          headers: new Headers(),
          url: new URL(
            "http://fixture/api/tty?session=SYN_SESSION&token=SYN_BEARER&wsTicket=SYN_WS_TICKET&view=SYN_VIEW",
          ),
          target: "tty",
        }).pipe(
          Effect.provide(
            Logger.layer([
              Logger.make((entry) => lines.push(String(Logger.formatJson.log(entry)))),
            ]),
          ),
        ),
      );
      expect(isUpgradeCaller(answer)).toBe(false);
      expect(lines.map((line): Record<string, unknown> => JSON.parse(line).annotations)).toEqual([
        { target: "tty" },
      ]);
      expect(lines.filter((line) => line.includes("SYN_"))).toEqual([]);
    }));
});
