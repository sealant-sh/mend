import { describe, expect, it } from "vitest";

import { Launches } from "./launches.js";
import { MendApiError } from "./mend-http.js";
import type { LaunchRequest } from "./new-session.js";

const START: LaunchRequest = { mode: "pty", prompt: "add rate limiting", model: "opus" };

/** A client that records every call, refusing the first `refusals` launches. */
const fakeClient = (refusals: number) => {
  const calls: Array<{
    readonly route: string;
    readonly sessionId: string;
    readonly body: unknown;
  }> = [];
  let left = refusals;
  return {
    calls,
    launchSession: async (sessionId: string, start: LaunchRequest) => {
      calls.push({ route: "launch", sessionId, body: start });
      if (left > 0) {
        left -= 1;
        throw new MendApiError("Over the organization's budget.", 429);
      }
      return {};
    },
    createSession: async () => {
      calls.push({ route: "create", sessionId: "", body: null });
      return {};
    },
  };
};

const sink = () => {
  const said: Array<{ readonly sessionId: string; readonly line: string | null }> = [];
  return {
    said,
    refused: (sessionId: string, line: string | null) => said.push({ sessionId, line }),
  };
};

describe("Launches", () => {
  it("says a refused launch to the store in the server's words", async () => {
    const store = sink();
    await new Launches(fakeClient(1), store).launch("s1", START);
    expect(store.said).toEqual([
      { sessionId: "s1", line: "launch refused · Over the organization's budget." },
    ]);
  });

  it("relaunches the same session with the same start, clearing the refusal, and creates nothing", async () => {
    const client = fakeClient(1);
    const store = sink();
    const launches = new Launches(client, store);
    await launches.launch("s1", START);
    await launches.relaunch("s1");
    expect(client.calls).toEqual([
      { route: "launch", sessionId: "s1", body: START },
      { route: "launch", sessionId: "s1", body: START },
    ]);
    expect(store.said.at(-1)).toEqual({ sessionId: "s1", line: null });
    expect(launches.has("s1")).toBe(true);
  });

  it("offers nothing to retry for a session this window did not launch", async () => {
    const client = fakeClient(0);
    const launches = new Launches(client, sink());
    await launches.relaunch("s2");
    expect(launches.has("s2")).toBe(false);
    expect(client.calls).toEqual([]);
  });
});
