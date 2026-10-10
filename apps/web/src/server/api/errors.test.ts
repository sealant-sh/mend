import { once } from "node:events";
import { createServer, type Server } from "node:http";

import { NotFound, SealantUnavailable, StoreFailure } from "@mend/api-contracts";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiRefusal, toTRPCError } from "./errors.ts";
import { run } from "./run.ts";

/**
 * Drives run() + toTRPCError through the REAL derived client against a stub
 * API, so the HttpClientError tag names this layer branches on can never
 * silently drift with an effect upgrade again (they already did once: v3's
 * "ResponseError"/"RequestError" don't exist in v4).
 */

let server: Server;
let port = 0;
let mode: "unreachable" | "http-503" | "http-401" = "http-503";

beforeAll(async () => {
  server = createServer((_request, response) => {
    if (mode === "http-503") {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("busy");
      return;
    }
    response.writeHead(401, { "content-type": "application/json" });
    response.end("{}");
  });
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  port = address.port;
});

afterAll(() => {
  server.close();
});

const ctxFor = (apiUrl: string) => ({ headers: new Headers(), apiUrl });

const failure = async (apiUrl: string): Promise<TRPCError> => {
  try {
    await run(ctxFor(apiUrl), (api) => api.health.status());
  } catch (error) {
    if (error instanceof TRPCError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
};

describe("run + toTRPCError against a real client", () => {
  it("an unreachable API is a clean 'unreachable', never the internal URL", async () => {
    const error = await failure("http://127.0.0.1:1");
    expect(error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(error.message).toBe("The Mend server is not answering. Try again in a moment.");
    expect(error.message).not.toContain("127.0.0.1");
  });

  it("an undeclared 503 keeps its 5xx shape without leaking request details", async () => {
    mode = "http-503";
    const error = await failure(`http://127.0.0.1:${port}`);
    expect(error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(error.message).toBe("Mend could not do that. Try again; the server log has the detail.");
    expect(error.message).not.toContain("503");
  });

  it("an undeclared 401 maps to UNAUTHORIZED so the login walk still fires", async () => {
    mode = "http-401";
    const error = await failure(`http://127.0.0.1:${port}`);
    expect(error.code).toBe("UNAUTHORIZED");
  });
});

describe("a refusal the API declared", () => {
  it("crosses in the server's words, its tag beside them and never in them", () => {
    const error = toTRPCError(
      new SealantUnavailable({
        code: "connected-account-invalid",
        message: "GitHub rejected this token. Paste a new one.",
      }),
    );
    expect(error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(error.message).toBe("GitHub rejected this token. Paste a new one.");
    expect(error.cause).toBeInstanceOf(ApiRefusal);
    expect(error.cause instanceof ApiRefusal ? error.cause.tag : null).toBe("SealantUnavailable");
  });

  it("crosses in words when it carries no sentence of its own", () => {
    const error = toTRPCError(new NotFound({ id: "p1" }));
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("Not found. It may have been removed.");
    expect(toTRPCError(new StoreFailure({ message: "" })).message).toBe(
      "Mend could not do that. Try again; the server log has the detail.",
    );
  });
});
