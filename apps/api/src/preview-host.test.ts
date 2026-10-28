import { PreviewId, PreviewLabel } from "@mend/domain";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { servePreviewRequest } from "./preview-host.ts";
import { PreviewConfig, PreviewIdentity } from "./preview-identity.ts";
import type { HeaderPair } from "./preview-requests.ts";
import { previewOriginOf, type PreviewRouting } from "./preview-routing.ts";

const ROUTING: PreviewRouting = { mode: "domain-https", domain: "preview.example", port: 443 };
const ORIGIN = previewOriginOf(ROUTING, {
  id: PreviewId.make("pv-1"),
  label: PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa"),
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
