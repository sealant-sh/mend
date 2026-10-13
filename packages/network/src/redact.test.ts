import { describe, expect, it } from "vitest";

import { redactUrl } from "./redact.ts";

describe("redacting credentials from a URL", () => {
  it("replaces the value of every credential parameter and keeps the rest", () => {
    expect(redactUrl("/api/tty?session=s1&from=0&ticket=mut_abc")).toBe(
      "/api/tty?session=s1&from=0&ticket=redacted",
    );
    expect(
      redactUrl("wss://mend.example/api/keys/bridge/ws?host=my%20laptop&token=mdt_secret"),
    ).toBe("wss://mend.example/api/keys/bridge/ws?host=my%20laptop&token=redacted");
    expect(redactUrl("/pair?code=ABCD1234")).toBe("/pair?code=redacted");
  });

  it("is case-insensitive about the name, catches repeats, and drops the fragment", () => {
    expect(redactUrl("/api/tty?Token=a&token=b#ticket=c")).toBe(
      "/api/tty?Token=redacted&token=redacted",
    );
  });

  it("leaves a URL without a query alone", () => {
    expect(redactUrl("/api/health")).toBe("/api/health");
    expect(redactUrl("/api/tty?")).toBe("/api/tty");
  });

  it("characterizes fragment-only input outside the parsed request-log target shape", () => {
    const target = "/path#ticket=synthetic";
    expect(redactUrl(target)).toBe(target);
    const url = new URL(`https://mend.example${target}`);
    // The actual request logger calls the helper with these two parsed fields.
    expect(redactUrl(`${url.pathname}${url.search}`)).toBe("/path");
  });
});
