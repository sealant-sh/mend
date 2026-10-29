import { describe, expect, it } from "vitest";

import { cookieValues, sessionCookieName, sessionCookiePrefix } from "./session-cookie.ts";

describe("Mend's session cookie", () => {
  it("is __Host- on an https APP_URL, and plain over http", () => {
    expect(sessionCookiePrefix("https://mend.tail1234.ts.net")).toBe("__Host-");
    expect(sessionCookieName("https://mend.tail1234.ts.net")).toBe(
      "__Host-better-auth.session_token",
    );
    expect(sessionCookiePrefix("http://localhost:3105")).toBe("");
    expect(sessionCookieName("http://localhost:3105")).toBe("better-auth.session_token");
  });

  it("is read by its exact name only, never a look-alike a sibling plants", () => {
    const name = sessionCookieName("https://mend.example.com");
    expect(
      cookieValues(
        `better-auth.session_token=planted; x__Host-better-auth.session_token=near; ${name}=mine; ${name}=; other=1`,
        name,
      ),
    ).toEqual(["mine"]);
    expect(cookieValues(undefined, name)).toEqual([]);
  });
});
