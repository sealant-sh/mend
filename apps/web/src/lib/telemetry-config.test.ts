import { describe, expect, it } from "vitest";

import { browserTelemetryOf, telemetryScript } from "./telemetry-config.ts";

const DSN = "https://6f570eb21e7adee8a5de60116db1b2a7@sentry.example/4";

describe("browserTelemetryOf", () => {
  it("is off unless the server names a DSN, so a Mend someone runs for themselves reports nothing", () => {
    expect(browserTelemetryOf({})).toBeNull();
    expect(browserTelemetryOf({ SENTRY_BROWSER_DSN: "  " })).toBeNull();
    // The server's own DSN is not the browser's: its project is the server's.
    expect(browserTelemetryOf({ SENTRY_DSN: DSN })).toBeNull();
  });

  it("is off for a value that is not a DSN", () => {
    expect(browserTelemetryOf({ SENTRY_BROWSER_DSN: "https://sentry.example/4" })).toBeNull();
    expect(browserTelemetryOf({ SENTRY_BROWSER_DSN: "ftp://key@sentry.example/4" })).toBeNull();
    expect(browserTelemetryOf({ SENTRY_BROWSER_DSN: "https://key@sentry.example/" })).toBeNull();
  });

  it("names the release the source maps are uploaded under, unless one is given", () => {
    expect(browserTelemetryOf({ SENTRY_BROWSER_DSN: DSN, MEND_VERSION: "0.40.1" })).toEqual({
      dsn: DSN,
      environment: "development",
      release: "mend-web@0.40.1",
      tracesSampleRate: 1,
    });
    expect(
      browserTelemetryOf({
        SENTRY_BROWSER_DSN: DSN,
        MEND_VERSION: "0.40.1",
        SENTRY_RELEASE: "mend-web@0.40.1+abc",
        SENTRY_ENVIRONMENT: "preview",
      }),
    ).toMatchObject({ release: "mend-web@0.40.1+abc", environment: "preview" });
    expect(browserTelemetryOf({ SENTRY_BROWSER_DSN: DSN })?.release).toBeNull();
  });

  it("samples at the rate given, from none to all, and every trace otherwise", () => {
    const rate = (text: string) =>
      browserTelemetryOf({ SENTRY_BROWSER_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: text })
        ?.tracesSampleRate;
    expect(rate("0")).toBe(0);
    expect(rate("0.25")).toBe(0.25);
    expect(rate("1")).toBe(1);
    expect(rate("1.5")).toBe(1);
    expect(rate("-0.1")).toBe(1);
    expect(rate("half")).toBe(1);
    expect(rate("")).toBe(1);
  });
});

describe("telemetryScript", () => {
  it("hands the browser exactly what the server read, and nothing can close the script", () => {
    const telemetry = {
      dsn: DSN,
      environment: "</script><script>alert(1)</script>",
      release: null,
      tracesSampleRate: 0.5,
    };
    const script = telemetryScript(telemetry) ?? "";
    expect(script.toLowerCase()).not.toContain("</script");
    const assigned = /^window\.__MEND_TELEMETRY__=(.*);$/s.exec(script)?.[1] ?? "";
    expect(JSON.parse(assigned)).toEqual(telemetry);
  });

  it("writes nothing into a page that reports nothing", () => {
    expect(telemetryScript(null)).toBeNull();
  });
});
