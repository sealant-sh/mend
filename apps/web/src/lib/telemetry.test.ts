import { describe, expect, it } from "vitest";

import { actionFetch, actionHeaders } from "./telemetry.ts";

describe("a call's action, between the tRPC link and the request", () => {
  it("names the first action any call of a batch was made in", () => {
    expect(actionHeaders([{}, { mendAction: "a1" }, { mendAction: "a2" }])).toEqual({
      "x-mend-action": "a1",
    });
    expect(actionHeaders([{}, { mendAction: 7 }])).toEqual({});
  });

  it("never lets the action's name leave the browser, and keeps every other header", async () => {
    const seen: Array<Headers> = [];
    const fetch = actionFetch((_url: string, init?: { readonly headers?: HeadersInit }) => {
      seen.push(new Headers(init?.headers));
      return Promise.resolve("answered");
    });
    await expect(
      fetch("/trpc/sessions.sendMessage", {
        headers: { "x-mend-action": "a1", "content-type": "application/json" },
      }),
    ).resolves.toBe("answered");
    expect(seen[0]?.has("x-mend-action")).toBe(false);
    expect(seen[0]?.get("content-type")).toBe("application/json");
  });
});
