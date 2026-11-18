import { once } from "node:events";
import { createServer, type Server } from "node:http";

import { createTRPCClient, unstable_localLink } from "@trpc/client";
import superjson from "superjson";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { appRouter, type AppRouter } from "../server/routers/index.ts";
import { type Account, expiryWords, groupCode, readAuthorize } from "./authorize.ts";

/**
 * The page's read, through the real routers called in process, against a stub API that answers the
 * request lookup with one status and body, as the API words them.
 */
let server: Server;
let apiUrl = "";
let answer: { readonly status: number; readonly body: unknown } = {
  status: 200,
  body: {},
};
let asked: string[] = [];

const REQUEST = {
  code: "K7QF-2MXD",
  name: "ada-laptop",
  client: "cli",
  createdAt: "2026-11-18T09:00:00.000Z",
  expiresAt: "2026-11-18T09:10:00.000Z",
  expiresIn: 600,
};

beforeAll(async () => {
  server = createServer((request, response) => {
    asked.push(request.url ?? "");
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(JSON.stringify(answer.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  apiUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  asked = [];
});

const client = () =>
  createTRPCClient<AppRouter>({
    links: [
      unstable_localLink({
        router: appRouter,
        transformer: superjson,
        createContext: async () => ({ headers: new Headers(), apiUrl }),
      }),
    ],
  });

const ADA: Account = { name: "Ada Lovelace", email: "ada@northwind.dev" };

const read = (code: string, account: () => Promise<Account | null> = async () => ADA) => {
  const trpc = client();
  return readAuthorize(code, {
    account,
    request: (wanted) => trpc.devices.cliAuthRequest.query({ code: wanted }),
    now: () => 1_000,
  });
};

describe("reading the authorize page", () => {
  it("shows the request and the account approving it", async () => {
    answer = { status: 200, body: REQUEST };
    const state = await read("K7QF-2MXD");
    expect(state).toEqual({
      kind: "request",
      account: ADA,
      request: expect.objectContaining({
        name: "ada-laptop",
        client: "cli",
        expiresIn: 600,
      }),
      answeredAt: 1_000,
    });
    expect(asked).toEqual(["/api/me/cli-auth/K7QF-2MXD"]);
  });

  it.each([
    ["a code the server never made", 404, { _tag: "CliAuthNotFound" }],
    ["a spent code (expired, decided or collected)", 410, { _tag: "CliAuthSpent" }],
  ])("says %s can't be used", async (_case, status, body) => {
    answer = { status, body };
    await expect(read("K7QF-2MXD")).resolves.toEqual({ kind: "unusable" });
  });

  it("says a link with no code can't be used, without asking the server", async () => {
    await expect(read("")).resolves.toEqual({ kind: "unusable" });
    expect(asked).toEqual([]);
  });

  it("asks a signed-out person to sign in first, without looking the request up", async () => {
    await expect(read("K7QF-2MXD", async () => null)).resolves.toEqual({
      kind: "sign-in",
    });
    expect(asked).toEqual([]);
  });

  it("asks to sign in again when the session ends between the two reads", async () => {
    answer = { status: 401, body: { _tag: "Unauthorized" } };
    await expect(read("K7QF-2MXD")).resolves.toEqual({ kind: "sign-in" });
  });

  it("says the server didn't answer, not that the code is bad, when the lookup fails", async () => {
    answer = { status: 503, body: {} };
    await expect(read("K7QF-2MXD")).resolves.toEqual({ kind: "unreachable" });
  });

  it("says the server didn't answer when the session can't be read", async () => {
    const state = await read("K7QF-2MXD", () => Promise.reject(new TypeError("Failed to fetch")));
    expect(state).toEqual({ kind: "unreachable" });
    expect(asked).toEqual([]);
  });
});

describe("the code", () => {
  it("is grouped in fours, whatever form it arrived in", () => {
    expect(groupCode("k7qf2mxd")).toBe("K7QF-2MXD");
    expect(groupCode("K7QF-2MXD")).toBe("K7QF-2MXD");
  });
});

describe("when the request runs out", () => {
  const answeredAt = Date.parse("2026-11-18T09:00:00.000Z");

  it("counts whole minutes down from the server's answer", () => {
    const request = { expiresAt: "2026-11-18T09:10:00.000Z", expiresIn: 600 };
    expect(expiryWords(request, answeredAt, answeredAt + 30_000)).toBe("It expires in 9 minutes.");
    expect(expiryWords(request, answeredAt, answeredAt + 480_000)).toBe("It expires in 2 minutes.");
    expect(expiryWords(request, answeredAt, answeredAt + 540_000)).toBe("It expires in 1 minute.");
    expect(expiryWords(request, answeredAt, answeredAt + 541_000)).toBe(
      "It expires in less than a minute.",
    );
    expect(expiryWords(request, answeredAt, answeredAt + 700_000)).toBe(
      "It expires in less than a minute.",
    );
  });

  it("trusts the server's seconds over a browser clock that disagrees with it", () => {
    // The browser's clock is an hour ahead: by `expiresAt` the request ran out long ago.
    const ahead = answeredAt + 3_600_000;
    const request = { expiresAt: "2026-11-18T09:10:00.000Z", expiresIn: 300 };
    expect(expiryWords(request, ahead, ahead)).toBe("It expires in 5 minutes.");
  });

  it("reads an older server's `expiresAt` against this clock", () => {
    const request = { expiresAt: "2026-11-18T09:10:00.000Z" };
    expect(expiryWords(request, 0, answeredAt + 180_000)).toBe("It expires in 7 minutes.");
  });
});
