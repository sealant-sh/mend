import { beforeEach, describe, expect, it } from "vitest";

import { processLogPage, processOutput, stopService } from "#/lib/api";

import type { ApiRequest, MendBridge } from "../../../shared/bridge";

const base64 = (bytes: Uint8Array): string =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));

const bridgeWith = (
  request: (
    input: ApiRequest,
  ) => Promise<{ readonly status: number; readonly ok: boolean; readonly body: unknown }>,
): MendBridge => ({
  platform: "linux",
  connection: {
    get: async () => ({
      url: "http://localhost:3105",
      signedIn: true,
      configPath: "/tmp/cli.json",
    }),
    authorize: async () => ({ ok: false, reason: "not in test" }),
    awaitAuthorize: async () => ({ ok: false, reason: "not in test" }),
    cancelAuthorize: async () => undefined,
    setToken: async () => undefined,
    signOut: async () => ({ revoke: "no-device" }),
    onChange: () => () => {},
  },
  api: { request },
  tty: { url: async () => "ws://localhost/tty" },
  events: {
    onEvent: () => () => {},
    onState: () => () => {},
  },
  shell: { openExternal: async () => undefined },
  window: {
    minimize: () => {},
    toggleMaximize: () => {},
    close: () => {},
  },
});

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
      value: bridgeWith(async (input) => {
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
      value: bridgeWith(async () => ({
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
      value: bridgeWith(async (input) => {
        requests.push(input);
        return { status: 200, ok: true, body: {} };
      }),
    });

    await stopService("service-1");
    expect(requests).toEqual([{ method: "POST", path: "/api/services/service-1/stop", body: {} }]);
  });
});
