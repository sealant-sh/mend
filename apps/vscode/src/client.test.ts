import { afterEach, describe, expect, it, vi } from "vitest";

import { MendClient } from "./client.js";

vi.mock("vscode", () => import("./test-vscode.js"));

afterEach(() => {
  vi.unstubAllGlobals();
});

const client = () =>
  new MendClient({
    get: async () => ({ url: "http://mend-mini:3105", token: "secret" }),
    refused: async () => {},
  });

const row = (id: string, status: string) => ({
  id,
  sessionId: "s",
  processId: "p",
  turnId: "t",
  kind: "tool-permission",
  providerRequestId: `provider-${id}`,
  providerItemId: null,
  title: "Bash",
  detail: null,
  questions: null,
  status,
  decision: status === "resolved" ? "accept" : null,
  decidedBy: null,
  answers: null,
  createdAt: "2026-10-20T08:00:00.000Z",
  decidedAt: null,
});

describe("a conversation's pending requests", () => {
  it("asks the server to filter with pending=1, and drops any row that is not pending", async () => {
    const fetch = vi.fn(
      async (_url: string) =>
        new Response(
          JSON.stringify([row("r1", "resolved"), row("r2", "pending"), row("r3", "cancelled")]),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const requests = await client().pendingRequests("s");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "http://mend-mini:3105/api/sessions/s/requests?pending=1",
    ]);
    expect(requests.map((request) => request.id)).toEqual(["r2"]);
  });
});
