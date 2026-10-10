import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  connectAccount,
  createSession,
  landSession,
  processLogPage,
  processOutput,
  refreshLanding,
  sessionLandings,
  stopService,
} from "#/lib/api";
import { bridgeFixture } from "#/lib/fixtures";

import type { ApiRequest } from "../../../shared/bridge";

const base64 = (bytes: Uint8Array): string =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));

describe("desktop process logs", () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, "mend");
  });

  it("pages the read-only logs endpoint and decodes UTF-8 across chunk boundaries", async () => {
    const encoded = new TextEncoder().encode("A🙂B");
    const requested: string[] = [];
    const pages = [
      {
        requestedFrom: "0",
        nextFrom: "2",
        chunks: [{ sequence: "1", dataBase64: base64(encoded.slice(0, 3)) }],
      },
      {
        requestedFrom: "2",
        nextFrom: "3",
        chunks: [{ sequence: "2", dataBase64: base64(encoded.slice(3)) }],
      },
      { requestedFrom: "3", nextFrom: "3", chunks: [] },
    ];
    let page = 0;
    Object.defineProperty(window, "mend", {
      configurable: true,
      value: bridgeFixture(async (input) => {
        requested.push(input.path);
        const body = pages[page];
        page += 1;
        return { status: 200, ok: true, body };
      }),
    });

    await expect(processOutput("process-1")).resolves.toEqual({ text: "A🙂B" });
    expect(requested).toEqual([
      "/api/processes/process-1/logs?from=0&limit=1000",
      "/api/processes/process-1/logs?from=2&limit=1000",
      "/api/processes/process-1/logs?from=3&limit=1000",
    ]);
  });

  it("preserves decimal log sequences above Number precision", async () => {
    const nextFrom = "900719925474099312345";
    Object.defineProperty(window, "mend", {
      configurable: true,
      value: bridgeFixture(async () => ({
        status: 200,
        ok: true,
        body: {
          processId: "process-1",
          sealantSessionId: "pty-1",
          sealantRunId: "run-1",
          requestedFrom: "900719925474099312344",
          firstSequence: "900719925474099312344",
          lastSequence: "900719925474099312344",
          nextFrom,
          status: "running",
          chunks: [],
          telemetryLoss: "unknown",
          telemetryNote: "range loss unknown",
        },
      })),
    });

    const page = await processLogPage("process-1", {
      from: "900719925474099312344",
      limit: "1000",
    });
    expect(page.nextFrom).toBe(nextFrom);
  });

  it("uses Service stop for an adopted Service's Remove forward action", async () => {
    const requests: ApiRequest[] = [];
    Object.defineProperty(window, "mend", {
      configurable: true,
      value: bridgeFixture(async (input) => {
        requests.push(input);
        return { status: 200, ok: true, body: {} };
      }),
    });

    await stopService("service-1");
    // The contract declares no payload for stop, so none is sent (as the derived client sends none).
    expect(requests).toEqual([{ method: "POST", path: "/api/services/service-1/stop" }]);
  });
});

describe("landing calls (docs/adr/0007-landing.md)", () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, "mend");
  });

  it("reach the routes and bodies the contract declares", async () => {
    const requests: Array<ApiRequest> = [];
    Object.defineProperty(window, "mend", {
      configurable: true,
      value: bridgeFixture(async (input) => {
        requests.push(input);
        return { status: 200, ok: true, body: {} };
      }),
    });
    await sessionLandings("session-1");
    await sessionLandings("session-1", true);
    await landSession("session-1", { branch: null, pullRequest: true, title: "Fix", body: null });
    await refreshLanding("landing-1");
    await createSession("project-1", "claude", null, null, null, "protocol", true);
    expect(requests).toEqual([
      { method: "GET", path: "/api/sessions/session-1/landings" },
      { method: "GET", path: "/api/sessions/session-1/landings?probe=true" },
      {
        method: "POST",
        path: "/api/sessions/session-1/land",
        body: { branch: null, pullRequest: true, title: "Fix", body: null },
      },
      { method: "POST", path: "/api/landings/landing-1/refresh" },
      {
        method: "POST",
        path: "/api/projects/project-1/sessions",
        body: {
          harness: "claude",
          mode: "protocol",
          label: null,
          name: null,
          base: null,
          autoLand: true,
        },
      },
    ]);
  });
});

const refuse = (status: number, body: unknown) =>
  Object.defineProperty(window, "mend", {
    configurable: true,
    value: bridgeFixture(async () => ({ status, ok: false, body })),
  });

describe("a refused call", () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, "mend");
  });

  it("reads as the server's sentence; the call and the status go to the log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    refuse(502, {
      _tag: "SealantUnavailable",
      code: "rejected",
      message: "GitHub rejected this token.",
    });
    const failure = await connectAccount({ provider: "github", secret: "ghp_x" }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      message: "GitHub rejected this token.",
      status: 502,
      detail: "GitHub rejected this token.",
      tag: "SealantUnavailable",
    });
    expect(warn).toHaveBeenCalledWith(
      "POST /api/me/sealant/accounts responded 502 · SealantUnavailable · GitHub rejected this token.",
    );
    warn.mockRestore();
  });

  it("never shows the status line or the tag when the body has no sentence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    refuse(409, { _tag: "SessionActive", id: "s-1" });
    const tagged = await sessionLandings("s-1").catch((error: unknown) => error);
    expect(tagged).toBeInstanceOf(ApiError);
    expect(tagged instanceof ApiError && tagged.message).not.toMatch(/SessionActive|409|GET|\/api/);
    refuse(500, null);
    const bare = await sessionLandings("s-1").catch((error: unknown) => error);
    expect(bare instanceof ApiError && bare.message).toBe(
      "Mend could not do that. Try again; the server log has the detail.",
    );
    warn.mockRestore();
  });
});
