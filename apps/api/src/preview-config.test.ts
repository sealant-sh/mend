import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { NetworkConfig } from "@mend/network";
import { ConfigProvider, Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  loadPreviewSetup,
  PREVIEW_ENV,
  type PreviewEnvironment,
  previewSetupOf,
  type PreviewVariable,
} from "./preview-config.ts";

const origin = Schema.decodeUnknownSync(PublicOrigin);
const MEND = makePublicNetwork(origin("https://mend.example.com"), [
  origin("http://192.168.1.20:3105"),
]);
const LOCAL = makePublicNetwork(origin("http://localhost:3105"), []);

const setupOf = (env: PreviewEnvironment, mend = MEND) =>
  Effect.runSync(Effect.exit(previewSetupOf(env, mend)));

const refusalOf = (env: PreviewEnvironment, mend = MEND) => {
  const exit = setupOf(env, mend);
  if (Exit.isSuccess(exit)) return null;
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error;
  return error === undefined ? null : { variable: error.variable, message: error.message };
};

const defaults = { startHoldMs: 180_000, bodyCap: { _tag: "Unlimited" } } as const;

describe("MEND_PREVIEW_* (docs/adr/0017)", () => {
  it.each<[string, PreviewEnvironment]>([
    ["nothing set", {}],
    ["only empty values", { port: "", domain: " " }],
  ])("is off with %s, and the instance runs as before", (_, env) => {
    expect(setupOf(env)).toEqual(Exit.succeed({ _tag: "Off" }));
  });

  it.each<[string, PreviewEnvironment, unknown, unknown]>([
    [
      "a port alone: loopback, the browser on the listen port",
      { port: "3117" },
      { mode: "loopback-http", port: 3117 },
      { bind: "127.0.0.1", port: 3117, ...defaults },
    ],
    [
      "a bind and a port: loopback on that address",
      { bind: "0.0.0.0", port: "3117" },
      { mode: "loopback-http", port: 3117 },
      { bind: "0.0.0.0", port: 3117, ...defaults },
    ],
    [
      "a domain: behind an edge on 443",
      { port: "3117", domain: "previews.example.net" },
      { mode: "domain-https", domain: "previews.example.net", port: 443 },
      { bind: "127.0.0.1", port: 3117, ...defaults },
    ],
    [
      "a domain and the edge's port, a hold and a body cap",
      {
        port: "3117",
        domain: "previews.example.net",
        publicPort: "8443",
        startHold: "90 seconds",
        bodyBytes: "1048576",
      },
      { mode: "domain-https", domain: "previews.example.net", port: 8443 },
      {
        bind: "127.0.0.1",
        port: 3117,
        startHoldMs: 90_000,
        bodyCap: { _tag: "Capped", bytes: 1_048_576 },
      },
    ],
    [
      "a tailnet name and its ports",
      {
        port: "3117",
        tailnetHostname: "mend-preview.tail1234.ts.net",
        tailnetPorts: "20001-20003, 20010",
      },
      {
        mode: "tailnet-https",
        hostname: "mend-preview.tail1234.ts.net",
        ports: [20001, 20002, 20003, 20010],
      },
      { bind: "127.0.0.1", port: 3117, ...defaults },
    ],
    [
      "a tailnet name alone, on the default sixteen ports",
      { port: "3117", tailnetHostname: "mend-preview.tail1234.ts.net" },
      {
        mode: "tailnet-https",
        hostname: "mend-preview.tail1234.ts.net",
        ports: Array.from({ length: 16 }, (_, index) => 20001 + index),
      },
      { bind: "127.0.0.1", port: 3117, ...defaults },
    ],
    [
      "a domain and a tailnet name: the domain takes over",
      {
        port: "3117",
        domain: "previews.example.net",
        tailnetHostname: "mend-preview.tail1234.ts.net",
        tailnetPorts: "20001",
      },
      { mode: "domain-https", domain: "previews.example.net", port: 443 },
      { bind: "127.0.0.1", port: 3117, ...defaults },
    ],
  ])("routes %s", (_, env, routing, gateway) => {
    const exit = setupOf(env);
    expect(Exit.isSuccess(exit) ? exit.value : exit).toMatchObject({
      _tag: "On",
      routing,
      gateway,
    });
  });

  it.each<[string, PreviewEnvironment, PreviewVariable, string]>([
    ["a variable without a port", { domain: "previews.example.net" }, "port", "listen port"],
    ["a port that is not a number", { port: "31x7" }, "port", '"31x7" is not a TCP port'],
    ["a port out of range", { port: "70000" }, "port", '"70000" is not a TCP port'],
    ["port zero", { port: "0" }, "port", '"0" is not a TCP port'],
    ["a bind that is no address", { port: "3117", bind: "my host" }, "bind", "not an IP address"],
    [
      "an uppercase domain",
      { port: "3117", domain: "Previews.Example.net" },
      "domain",
      "not a lowercase DNS name",
    ],
    ["an IP as the domain", { port: "3117", domain: "10.0.0.1" }, "domain", "not a lowercase"],
    ["a domain with a scheme", { port: "3117", domain: "https://p.example" }, "domain", "DNS name"],
    [
      "a public port without a domain",
      { port: "3117", publicPort: "443" },
      "publicPort",
      "applies only with MEND_PREVIEW_DOMAIN",
    ],
    [
      "a malformed public port",
      { port: "3117", domain: "previews.example.net", publicPort: "https" },
      "publicPort",
      "not a TCP port",
    ],
    ["a hold that is no duration", { port: "3117", startHold: "3m" }, "startHold", "duration"],
    ["a hold under a second", { port: "3117", startHold: "500 millis" }, "startHold", "1 second"],
    ["a zero body cap", { port: "3117", bodyBytes: "0" }, "bodyBytes", "positive number"],
    ["a body cap with a unit", { port: "3117", bodyBytes: "1MiB" }, "bodyBytes", "positive"],
    [
      "tailnet ports without a hostname",
      { port: "3117", tailnetPorts: "20001" },
      "tailnetHostname",
      "is required",
    ],
    [
      "the port=previewId form from before Mend assigned ports",
      { port: "3117", tailnetHostname: "mend-preview.t.ts.net", tailnetPorts: "20001=pv_web" },
      "tailnetPorts",
      "pairs a port with a preview, the form before Mend assigned ports itself",
    ],
    [
      "a tailnet port listed twice",
      { port: "3117", tailnetHostname: "mend-preview.t.ts.net", tailnetPorts: "20001,20001" },
      "tailnetPorts",
      "port 20001 is listed twice",
    ],
    [
      "a tailnet port out of range",
      { port: "3117", tailnetHostname: "mend-preview.t.ts.net", tailnetPorts: "99999" },
      "tailnetPorts",
      "not a TCP port",
    ],
  ])("refuses %s, naming the variable", (_, env, variable, says) => {
    const refused = refusalOf(env);
    expect(refused?.variable, "the variable that is wrong").toBe(PREVIEW_ENV[variable]);
    expect(refused?.message, "the message names the variable first").toMatch(
      new RegExp(`^${PREVIEW_ENV[variable]}: `),
    );
    expect(refused?.message, "and says what is wrong").toContain(says);
  });

  it.each<[string, string, typeof MEND]>([
    ["equal to Mend's host", "mend.example.com", MEND],
    ["a parent of Mend's host", "example.com", MEND],
    ["under Mend's host", "previews.mend.example.com", MEND],
    ["under the default APP_URL's localhost", "preview.localhost", LOCAL],
    [
      "a parent of an alternate origin",
      "lan",
      makePublicNetwork(origin("https://mend.example.com"), [origin("http://mac-mini.lan:3105")]),
    ],
  ])("refuses a preview domain %s", (_, domain, mend) => {
    const refused = refusalOf({ port: "3117", domain }, mend);
    expect(refused?.variable, "the preview domain is what must move").toBe("MEND_PREVIEW_DOMAIN");
    expect(refused?.message, "it says previews need a domain of their own").toContain(
      "previews need a domain apart from Mend's",
    );
  });

  it("takes a preview domain beside Mend's host on its registrable domain", () => {
    expect(refusalOf({ port: "3117", domain: "previews.example.com" })).toBeNull();
    expect(refusalOf({ port: "3117", domain: "previews.example.net" })).toBeNull();
  });

  it("refuses a tailnet hostname that is Mend's own host", () => {
    const mend = makePublicNetwork(origin("https://box.tail1234.ts.net"), []);
    const refused = refusalOf(
      { port: "3117", tailnetHostname: "box.tail1234.ts.net", tailnetPorts: "20001" },
      mend,
    );
    expect(refused?.variable).toBe("MEND_PREVIEW_TAILNET_HOSTNAME");
    expect(refused?.message).toContain("is Mend's own host (https://box.tail1234.ts.net)");
    expect(
      setupOf(
        {
          port: "3117",
          tailnetHostname: "mend-preview.tail1234.ts.net",
          tailnetPorts: "20001",
        },
        mend,
      )._tag,
      "a Service name of its own on the same tailnet is fine",
    ).toBe("Success");
  });

  it("reads the variables from the environment once, with Mend's origins", async () => {
    const read = (values: Record<string, string>) =>
      Effect.runPromise(
        Effect.exit(
          loadPreviewSetup.pipe(
            Effect.provideService(NetworkConfig, MEND),
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values))),
          ),
        ),
      );
    expect(await read({})).toEqual(Exit.succeed({ _tag: "Off" }));
    const on = await read({
      MEND_PREVIEW_PORT: "3117",
      MEND_PREVIEW_DOMAIN: "previews.example.net",
    });
    expect(Exit.isSuccess(on) ? on.value : on).toMatchObject({
      _tag: "On",
      routing: { mode: "domain-https", domain: "previews.example.net", port: 443 },
    });
    const refused = await read({
      MEND_PREVIEW_PORT: "3117",
      MEND_PREVIEW_DOMAIN: "mend.example.com",
    });
    expect(Exit.isFailure(refused), "a refused setup fails the layer that reads it").toBe(true);
  });
});
