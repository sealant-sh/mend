import { once } from "node:events";
import { createServer, type Server } from "node:http";

import {
  LaunchRequest,
  NotFound,
  ResumeRequest,
  SealantUnavailable,
  StoreFailure,
} from "@mend/api-contracts";
import { ServiceId, SessionId } from "@mend/domain";
import { REMOVAL_START_REFUSED, REMOVED_PROJECT_WORK_REFUSED } from "@mend/domain/workbench";
import { TRPCError } from "@trpc/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { API_DRIFT, ApiRefusal, toTRPCError } from "./errors.ts";
import { run } from "./run.ts";

/**
 * Drives run() + toTRPCError through the REAL derived client against a stub
 * API, so the HttpClientError tag names this layer branches on can never
 * silently drift with an effect upgrade again (they already did once: v3's
 * "ResponseError"/"RequestError" don't exist in v4).
 */

let server: Server;
let port = 0;
let mode:
  | "unreachable"
  | "http-503"
  | "http-401"
  | "removal-in-progress"
  | "removed-project"
  | "drift-404" = "http-503";

beforeAll(async () => {
  server = createServer((_request, response) => {
    if (mode === "removal-in-progress") {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ _tag: "RemovalInProgress", message: REMOVAL_START_REFUSED }));
      return;
    }
    if (mode === "removed-project") {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ _tag: "RemovalInProgress", message: REMOVED_PROJECT_WORK_REFUSED }),
      );
      return;
    }
    if (mode === "drift-404") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ _tag: "NotWhatTheContractDeclares" }));
      return;
    }
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

const failure = async (
  apiUrl: string,
  call: Parameters<typeof run>[1] = (api) => api.health.status(),
): Promise<TRPCError> => {
  try {
    await run(ctxFor(apiUrl), call);
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

describe("what the web tier logs about a failed API call", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the operation, the failure and the status of contract drift, never the URL it called", async () => {
    mode = "drift-404";
    const logged: Array<string> = [];
    for (const level of ["error", "warn", "log", "info"] as const)
      vi.spyOn(console, level).mockImplementation((...parts: Array<unknown>) => {
        logged.push(parts.map(String).join(" "));
      });
    const error = await failure(`http://127.0.0.1:${port}`, (api) =>
      api.userDevices.cliAuthRequest({ params: { code: "CODE-7SEC" } }),
    );
    expect(error.message).toBe(API_DRIFT);
    expect(logged.filter((line) => /7sec|127\.0\.0\.1|cli-auth/i.test(line))).toEqual([]);
    expect(logged).toEqual([
      "[trpc] contract drift decoding API response: userDevices.cliAuthRequest StatusCodeError 404",
    ]);
  });

  it("names the operation when the API is served under a path", async () => {
    mode = "drift-404";
    const logged: Array<string> = [];
    vi.spyOn(console, "error").mockImplementation((...parts: Array<unknown>) => {
      logged.push(parts.map(String).join(" "));
    });
    await failure(`http://127.0.0.1:${port}/mend/`, (api) =>
      api.userDevices.cliAuthRequest({ params: { code: "CODE-7SEC" } }),
    );
    expect(logged).toEqual([
      "[trpc] contract drift decoding API response: userDevices.cliAuthRequest StatusCodeError 404",
    ]);
  });
});

describe("a start a removal's mark refused, through the real client", () => {
  const session = SessionId.make("s-1");
  const starts: ReadonlyArray<readonly [string, Parameters<typeof run>[1]]> = [
    [
      "launch",
      (api) => api.sessions.launch({ params: { id: session }, payload: new LaunchRequest({}) }),
    ],
    [
      "resume",
      (api) =>
        api.sessions.resume({
          params: { id: session },
          payload: new ResumeRequest({ harness: null }),
        }),
    ],
    ["openShell", (api) => api.sessions.openShell({ params: { id: session } })],
    [
      "restartService",
      (api) => api.sessions.restartService({ params: { id: ServiceId.make("svc-1") } }),
    ],
  ];

  for (const [name, call] of starts) {
    it(`reads ${name}'s refusal as the conflict it is, in the server's words`, async () => {
      mode = "removal-in-progress";
      const error = await failure(`http://127.0.0.1:${port}`, call);
      expect(error.code).toBe("CONFLICT");
      expect(error.message).toBe(REMOVAL_START_REFUSED);
      expect(error.cause instanceof ApiRefusal ? error.cause.tag : null).toBe("RemovalInProgress");
    });
  }
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

describe("a change asked of a removed project, through the real client", () => {
  const session = SessionId.make("s-1");
  const changes: ReadonlyArray<readonly [string, Parameters<typeof run>[1]]> = [
    ["remove", (api) => api.sessions.remove({ params: { id: session } })],
    ["label", (api) => api.sessions.label({ params: { id: session }, payload: { label: "x" } })],
  ];

  for (const [name, call] of changes) {
    it(`reads ${name}'s refusal in the server's words, which say to restore the project`, async () => {
      mode = "removed-project";
      const error = await failure(`http://127.0.0.1:${port}`, call);
      expect({ code: error.code, message: error.message }).toEqual({
        code: "CONFLICT",
        message: REMOVED_PROJECT_WORK_REFUSED,
      });
    });
  }
});
