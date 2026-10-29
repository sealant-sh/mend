import { PreviewId, PreviewLabel } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { servePreviewRequest } from "./preview-host.ts";
import { PreviewConfig, PreviewIdentity, PreviewNoIdentity } from "./preview-identity.ts";
import type { HeaderPair } from "./preview-requests.ts";
import { previewOriginOf, type PreviewRouting } from "./preview-routing.ts";

const ROUTING: PreviewRouting = { mode: "domain-https", domain: "preview.example", port: 443 };
const ORIGIN = previewOriginOf(ROUTING, {
  label: PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa"),
  tailnetPort: null,
});
if (ORIGIN === null) throw new Error("a domain routing addresses every preview");
const HOST = new URL(ORIGIN).host;

const unreached = Effect.die("admission refused nothing it should have");

const admit = (method: string, target: string, extra: ReadonlyArray<HeaderPair>) => {
  let reachedViewer = false;
  const identity = Layer.succeed(PreviewIdentity, {
    issueTicket: () => unreached,
    exchangeTicket: () => unreached,
    withViewer: () =>
      Effect.sync(() => {
        reachedViewer = true;
      }),
  });
  const config = Layer.succeed(PreviewConfig, { appUrl: "https://mend.example", routing: ROUTING });
  return Effect.runPromise(
    servePreviewRequest({ method, target, headers: [["Host", HOST], ...extra] }, () =>
      Effect.succeed(undefined),
    ).pipe(Effect.provide(Layer.merge(identity, config))),
  ).then((answer) => ({ status: answer?.status ?? null, reachedViewer }));
};

const SAME_ORIGIN: ReadonlyArray<HeaderPair> = [["Origin", ORIGIN]];

describe("preview admission before anything reaches the application", () => {
  it.each<readonly [string, string, string, ReadonlyArray<HeaderPair>, number]>([
    ["a service worker script", "GET", "/sw.js", [["Service-Worker", "script"]], 403],
    ["a service worker destination", "GET", "/sw.js", [["Sec-Fetch-Dest", "serviceworker"]], 403],
    ["an absolute-form target", "GET", `${ORIGIN}/`, [], 400],
    ["an asterisk-form target", "OPTIONS", "*", SAME_ORIGIN, 400],
    ["a network-path target", "GET", "//evil.example/", [], 400],
    ["a fragment", "GET", "/page#top", [], 400],
    [
      "Content-Length beside Transfer-Encoding",
      "POST",
      "/form",
      [...SAME_ORIGIN, ["Content-Length", "3"], ["Transfer-Encoding", "chunked"]],
      400,
    ],
    [
      "two Content-Length fields",
      "POST",
      "/form",
      [...SAME_ORIGIN, ["Content-Length", "3"], ["Content-Length", "3"]],
      400,
    ],
    ["a listed Content-Length", "POST", "/form", [...SAME_ORIGIN, ["Content-Length", "3, 3"]], 400],
    [
      "a Content-Length that is not a number",
      "POST",
      "/form",
      [...SAME_ORIGIN, ["Content-Length", "+3"]],
      400,
    ],
    [
      "a coding other than chunked",
      "POST",
      "/form",
      [...SAME_ORIGIN, ["Transfer-Encoding", "gzip, chunked"]],
      400,
    ],
    [
      "chunked twice",
      "POST",
      "/form",
      [...SAME_ORIGIN, ["Transfer-Encoding", "chunked"], ["Transfer-Encoding", "chunked"]],
      400,
    ],
    [
      "an expectation other than 100-continue",
      "POST",
      "/form",
      [...SAME_ORIGIN, ["Expect", "x"]],
      417,
    ],
    [
      "an upgrade to h2c",
      "GET",
      "/",
      [...SAME_ORIGIN, ["Connection", "Upgrade"], ["Upgrade", "h2c"]],
      400,
    ],
    [
      "an upgrade listing websocket beside another protocol",
      "GET",
      "/",
      [...SAME_ORIGIN, ["Upgrade", "websocket, h2c"]],
      400,
    ],
    [
      "a WebSocket upgrade with a sized body",
      "GET",
      "/hmr",
      [
        ...SAME_ORIGIN,
        ["Connection", "Upgrade"],
        ["Upgrade", "websocket"],
        ["Content-Length", "3"],
      ],
      400,
    ],
    [
      "a WebSocket upgrade with a chunked body",
      "GET",
      "/hmr",
      [
        ...SAME_ORIGIN,
        ["Connection", "Upgrade"],
        ["Upgrade", "websocket"],
        ["Transfer-Encoding", "chunked"],
      ],
      400,
    ],
    ["CONNECT", "CONNECT", "preview.example:443", [], 405],
  ])("refuses %s", async (_, method, target, headers, status) => {
    expect(await admit(method, target, headers)).toEqual({ status, reachedViewer: false });
  });

  it.each<readonly [string, string, string, ReadonlyArray<HeaderPair>]>([
    ["a plain page", "GET", "/page?q=1", []],
    ["a worker that is not a service worker", "GET", "/w.js", [["Sec-Fetch-Dest", "worker"]]],
    ["a sized body", "POST", "/form", [...SAME_ORIGIN, ["Content-Length", "3"]]],
    ["a chunked body", "POST", "/form", [...SAME_ORIGIN, ["Transfer-Encoding", "Chunked"]]],
    [
      "a body that waits for 100 Continue",
      "POST",
      "/form",
      [...SAME_ORIGIN, ["Content-Length", "3"], ["Expect", "100-Continue"]],
    ],
    [
      "a WebSocket upgrade",
      "GET",
      "/hmr",
      [...SAME_ORIGIN, ["Connection", "Upgrade"], ["Upgrade", "WebSocket"]],
    ],
    [
      "a WebSocket upgrade that declares an empty body",
      "GET",
      "/hmr",
      [
        ...SAME_ORIGIN,
        ["Connection", "Upgrade"],
        ["Upgrade", "websocket"],
        ["Content-Length", "0"],
      ],
    ],
  ])("admits %s", async (_, method, target, headers) => {
    expect(await admit(method, target, headers)).toEqual({ status: null, reachedViewer: true });
  });
});

describe("a request with no grant", () => {
  const PREVIEW = PreviewId.make("pv-1");
  const answerWithoutGrant = (method: string, extra: ReadonlyArray<HeaderPair>) => {
    const identity = Layer.succeed(PreviewIdentity, {
      issueTicket: () => unreached,
      exchangeTicket: () => unreached,
      withViewer: () =>
        Effect.fail(new PreviewNoIdentity({ reason: "missing-grant", previewId: PREVIEW })),
    });
    const config = Layer.succeed(PreviewConfig, {
      appUrl: "https://mend.example",
      routing: ROUTING,
    });
    return Effect.runPromise(
      servePreviewRequest({ method, target: "/pricing", headers: [["Host", HOST], ...extra] }, () =>
        Effect.succeed(undefined),
      ).pipe(Effect.provide(Layer.merge(identity, config))),
    );
  };
  const signIn = `https://mend.example/preview-auth?preview=${PREVIEW}&path=%2Fpricing`;
  const HTML: HeaderPair = ["Accept", "text/html,application/xhtml+xml,*/*;q=0.8"];

  it.each<readonly [string, string, ReadonlyArray<HeaderPair>, number, string | undefined]>([
    [
      "a navigation with Fetch Metadata",
      "GET",
      [
        ["Sec-Fetch-Site", "none"],
        ["Sec-Fetch-Mode", "navigate"],
        ["Sec-Fetch-Dest", "document"],
        HTML,
      ],
      302,
      signIn,
    ],
    ["a navigation from a browser that sends no Fetch Metadata", "GET", [HTML], 302, signIn],
    [
      "a fetch for JSON with no Fetch Metadata",
      "GET",
      [["Accept", "application/json"]],
      401,
      undefined,
    ],
    [
      "a fetch for HTML that is not a navigation",
      "GET",
      [["Sec-Fetch-Mode", "cors"], ["Sec-Fetch-Dest", "empty"], HTML],
      401,
      undefined,
    ],
    ["a form post asking for HTML", "POST", [["Origin", ORIGIN], HTML], 401, undefined],
  ])("%s", async (_, method, headers, status, location) => {
    const answer = await answerWithoutGrant(method, headers);
    expect([answer?.status, answer?.headers["location"]]).toEqual([status, location]);
  });
});

describe("the exchange on a tailnet port", () => {
  const TAILNET: PreviewRouting = {
    mode: "tailnet-https",
    hostname: "mend-preview.tail1234.ts.net",
    ports: [20001],
  };
  const PORT_ORIGIN = previewOriginOf(TAILNET, {
    label: PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa"),
    tailnetPort: 20001,
  });
  if (PORT_ORIGIN === null) throw new Error("a tailnet routing addresses a held port");
  const TICKET = `mut_${"a".repeat(43)}`;
  const HELD = `mpg_${"b".repeat(43)}`;
  const exchangeWith = (clearSiteData: boolean, cookie: ReadonlyArray<HeaderPair>) => {
    const presented: Array<string | null> = [];
    const identity = Layer.succeed(PreviewIdentity, {
      issueTicket: () => unreached,
      exchangeTicket: (request) =>
        Effect.sync(() => {
          presented.push(request.presented === null ? null : Redacted.value(request.presented));
          return {
            origin: request.origin,
            grant: Redacted.make(`mpg_${"c".repeat(43)}`),
            clearSiteData,
          };
        }),
      withViewer: () => unreached,
    });
    const config = Layer.succeed(PreviewConfig, {
      appUrl: "https://mend.tail1234.ts.net",
      routing: TAILNET,
    });
    return Effect.runPromise(
      servePreviewRequest(
        {
          method: "GET",
          target: `/__mend/auth?ticket=${TICKET}&path=%2F`,
          headers: [["Host", new URL(PORT_ORIGIN).host], ...cookie],
        },
        () => Effect.succeed(undefined),
      ).pipe(Effect.provide(Layer.merge(identity, config))),
    ).then((answer) => ({ answer, presented }));
  };

  it("asks the browser to clear the port's cache and storage on a first open after the port held another preview", async () => {
    const { answer, presented } = await exchangeWith(true, [
      ["Cookie", `__Host-mend-preview-20001=${HELD}`],
    ]);
    expect(answer?.status).toBe(303);
    expect(answer?.headers["clear-site-data"]).toBe('"cache", "storage"');
    expect(presented, "the grant the browser held for the port").toEqual([HELD]);
  });

  it("leaves the browser's data alone otherwise", async () => {
    const { answer, presented } = await exchangeWith(false, []);
    expect(answer?.status).toBe(303);
    expect(answer?.headers["clear-site-data"]).toBeUndefined();
    expect(presented).toEqual([null]);
  });
});
