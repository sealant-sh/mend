import { once } from "node:events";
import { createServer, type Server } from "node:http";

import { QueryClient } from "@tanstack/react-query";
import { isRedirect } from "@tanstack/react-router";
import { createTRPCClient, unstable_localLink } from "@trpc/client";
import superjson from "superjson";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { appRouter, type AppRouter } from "../server/routers/index.ts";
import { requireSignedIn } from "./sign-in.ts";
import { makeTrpcProxy } from "./trpc.ts";

/**
 * The root route's check, run as a page render on the server runs it: the real routers, called in
 * process, against a stub API that answers every request with one status.
 */
let server: Server;
let apiUrl = "";
let status = 401;
let requests = 0;

beforeAll(async () => {
  server = createServer((_request, response) => {
    requests += 1;
    // A refusal as the API words it; anything else is a plain failure.
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(status === 401 ? { _tag: "Unauthorized" } : {}));
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
  requests = 0;
});

const check = (location: { readonly pathname: string; readonly href: string }) => {
  const queryClient = new QueryClient();
  const client = createTRPCClient<AppRouter>({
    links: [
      unstable_localLink({
        router: appRouter,
        transformer: superjson,
        createContext: async () => ({ headers: new Headers(), apiUrl }),
      }),
    ],
  });
  return requireSignedIn({
    context: { queryClient, trpc: makeTrpcProxy(queryClient, client) },
    location,
  });
};

const thrown = async (run: Promise<void>): Promise<unknown> =>
  run.then(
    () => {
      throw new Error("expected the check to stop the page");
    },
    (error: unknown) => error,
  );

describe("a page served to nobody", () => {
  it("redirects to sign-in, carrying the page to come back to", async () => {
    status = 401;
    const stopped = await thrown(
      check({ pathname: "/sessions/s1", href: "/sessions/s1?tab=change" }),
    );
    expect(isRedirect(stopped)).toBe(true);
    if (!isRedirect(stopped)) return;
    expect(stopped.options.href).toBe("/login#next=%2Fsessions%2Fs1%3Ftab%3Dchange");
  });

  it("lets sign-in itself through without asking, so the walk cannot loop", async () => {
    status = 401;
    await expect(check({ pathname: "/login", href: "/login" })).resolves.toBeUndefined();
    expect(requests).toBe(0);
  });

  it("shows any other failure as the page's error, not as a walk to sign-in", async () => {
    status = 503;
    const stopped = await thrown(check({ pathname: "/", href: "/" }));
    expect(isRedirect(stopped)).toBe(false);
  });
});
