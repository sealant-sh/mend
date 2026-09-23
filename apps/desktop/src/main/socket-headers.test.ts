import { describe, expect, it } from "vitest";

import { isMendSocket, withoutBrowserCredentials } from "./socket-headers";

describe("isMendSocket", () => {
  it("matches the server's terminal socket over the matching scheme", () => {
    expect(
      isMendSocket("wss://alpha.mend.run/api/tty?session=s&ticket=t", "https://alpha.mend.run"),
    ).toBe(true);
    expect(isMendSocket("ws://localhost:3105/api/tty?process=p", "http://localhost:3105/")).toBe(
      true,
    );
  });

  it("keeps an instance that lives under a path", () => {
    expect(isMendSocket("wss://example.com/mend/api/tty", "https://example.com/mend")).toBe(true);
    expect(isMendSocket("wss://example.com/api/tty", "https://example.com/mend")).toBe(false);
  });

  it("leaves every other socket alone", () => {
    // Another host, another port, a downgraded scheme, a path outside the API.
    expect(isMendSocket("wss://evil.example/api/tty", "https://alpha.mend.run")).toBe(false);
    expect(isMendSocket("ws://localhost:5173/api/tty", "http://localhost:3105")).toBe(false);
    expect(isMendSocket("ws://alpha.mend.run/api/tty", "https://alpha.mend.run")).toBe(false);
    expect(isMendSocket("wss://alpha.mend.run/hmr", "https://alpha.mend.run")).toBe(false);
    expect(isMendSocket("https://alpha.mend.run/api/tty", "https://alpha.mend.run")).toBe(false);
  });

  it("answers false for anything unparseable", () => {
    expect(isMendSocket("not a url", "https://alpha.mend.run")).toBe(false);
    expect(isMendSocket("wss://alpha.mend.run/api/tty", "")).toBe(false);
  });
});

describe("withoutBrowserCredentials", () => {
  it("drops Origin and Cookie in any case and keeps the rest", () => {
    expect(
      withoutBrowserCredentials({
        Origin: "file://",
        cookie: "better-auth=1",
        "Sec-WebSocket-Key": "k",
        "User-Agent": "Electron",
      }),
    ).toEqual({ "Sec-WebSocket-Key": "k", "User-Agent": "Electron" });
  });
});
