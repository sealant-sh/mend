import { PreviewLabel } from "@mend/domain";
import type { PreviewNotDelivered } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import {
  type ForwardRequest,
  forwardRequestHead,
  forwardResponseHead,
  undeliveredAnswer,
} from "./preview-headers.ts";
import type { HeaderPair } from "./preview-requests.ts";
import { type CookiePolicy, namespacedCookieName, previewOriginOf } from "./preview-routing.ts";

const LABEL = PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa");
const OTHER = PreviewLabel.make("baaaaaaaaaaaaaaaaaaaaaaaaa");
const HOSTED: CookiePolicy = { mode: "host-per-preview" };
const OWN_PORT: CookiePolicy = { mode: "tailnet-ports", label: LABEL };

const tailnetOrigin = previewOriginOf(
  { mode: "tailnet-https", hostname: "mend-preview.tail1234.ts.net", ports: [20001] },
  { label: LABEL, tailnetPort: 20001 },
);
if (tailnetOrigin === null) throw new Error("the tailnet routing serves port 20001");

const TO: ForwardRequest = {
  origin: tailnetOrigin,
  port: 5173,
  host: "rewrite",
  cookies: OWN_PORT,
  upgrade: false,
};

const named = (headers: ReadonlyArray<HeaderPair>, name: string) =>
  headers.flatMap(([field, value]) => (field.toLowerCase() === name ? [value] : []));

const names = (headers: ReadonlyArray<HeaderPair>) =>
  new Set(headers.map(([field]) => field.toLowerCase()));

describe("the request head an application receives", () => {
  it("names the Service as its host and the preview origin only in generated forwarding fields", () => {
    const sent = forwardRequestHead(
      [
        ["Host", "mend-preview.tail1234.ts.net:20001"],
        ["X-Forwarded-Host", "evil.example"],
        ["x-forwarded-for", "10.0.0.1"],
        ["X-Forwarded-Proto", "http"],
        ["Forwarded", "for=1.2.3.4;host=evil.example"],
        ["X-Real-IP", "1.2.3.4"],
        ["Origin", "https://mend-preview.tail1234.ts.net:20001"],
        ["Accept", "text/html"],
      ],
      TO,
    );
    expect(sent).toEqual([
      ["host", "localhost:5173"],
      ["Origin", "https://mend-preview.tail1234.ts.net:20001"],
      ["Accept", "text/html"],
      ["x-forwarded-host", "mend-preview.tail1234.ts.net:20001"],
      ["x-forwarded-proto", "https"],
    ]);
  });

  it("drops every Tailscale-* field, whoever set it, in every routing mode", () => {
    const spoofed: ReadonlyArray<HeaderPair> = [
      ["Host", "x"],
      ["Tailscale-User-Login", "alice@example.com"],
      ["tailscale-user-name", "Alice"],
      ["TAILSCALE-USER-PROFILE-PIC", "https://example.com/a.png"],
      ["Tailscale-Headers-Info", "https://tailscale.com/s/serve-headers"],
      ["Tailscale-App-Capabilities", '{"example.com/cap":[{}]}'],
      ["Tailscale-Funnel-Request", "?1"],
      ["Accept", "*/*"],
    ];
    for (const cookies of [OWN_PORT, HOSTED]) {
      const sent = forwardRequestHead(spoofed, { ...TO, cookies });
      expect([...names(sent)].filter((name) => name.startsWith("tailscale"))).toEqual([]);
      expect(named(sent, "accept")).toEqual(["*/*"]);
    }
  });

  it("drops hop-by-hop fields and every field Connection names, and keeps Authorization", () => {
    const sent = forwardRequestHead(
      [
        ["Host", "x"],
        ["Connection", "keep-alive, X-Secret, Content-Length"],
        ["X-Secret", "s"],
        ["Proxy-Connection", "keep-alive"],
        ["Keep-Alive", "timeout=5"],
        ["TE", "trailers"],
        ["Trailer", "X-Checksum"],
        ["Upgrade", "websocket"],
        ["Expect", "100-continue"],
        ["Proxy-Authorization", "Basic abc"],
        ["Authorization", "Bearer app-or-mend"],
        ["X-Mend-Invitation", "inv"],
        ["Content-Length", "12"],
        ["Accept", "*/*"],
      ],
      TO,
    );
    expect(sent).toEqual([
      ["host", "localhost:5173"],
      ["Authorization", "Bearer app-or-mend"],
      ["X-Mend-Invitation", "inv"],
      ["Content-Length", "12"],
      ["Accept", "*/*"],
      ["x-forwarded-host", "mend-preview.tail1234.ts.net:20001"],
      ["x-forwarded-proto", "https"],
    ]);
  });

  it("marks a chunked body chunked so the upstream request is framed for every method", () => {
    const sent = forwardRequestHead(
      [
        ["Host", "x"],
        ["Transfer-Encoding", "chunked"],
      ],
      TO,
    );
    expect(named(sent, "transfer-encoding")).toEqual(["chunked"]);
    expect(named(sent, "content-length")).toEqual([]);
  });

  it("sends one Cookie header with grants and other previews' cookies removed", () => {
    const sent = forwardRequestHead(
      [
        ["Host", "x"],
        ["Cookie", `theme=dark; ${namespacedCookieName(LABEL, "sid")}=1`],
        ["Cookie", `__Host-mend-preview-20001=g; ${namespacedCookieName(OTHER, "sid")}=2`],
        ["Cookie", "__Secure-better-auth.session_token=s"],
      ],
      TO,
    );
    expect(named(sent, "cookie")).toEqual([
      "theme=dark; sid=1; __Secure-better-auth.session_token=s",
    ]);
  });

  it("sends no Cookie header when nothing is left", () => {
    const sent = forwardRequestHead(
      [
        ["Host", "x"],
        ["Cookie", "__Host-mend-preview-20001=g; mend-preview=g"],
      ],
      { ...TO, cookies: HOSTED },
    );
    expect(names(sent).has("cookie")).toBe(false);
  });

  it("asks for exactly a WebSocket upgrade and keeps the handshake fields", () => {
    const sent = forwardRequestHead(
      [
        ["Host", "x"],
        ["Connection", "keep-alive, Upgrade"],
        ["Upgrade", "websocket"],
        ["Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="],
        ["Sec-WebSocket-Version", "13"],
        ["Sec-WebSocket-Protocol", "vite-hmr"],
      ],
      { ...TO, upgrade: true },
    );
    expect(sent).toEqual([
      ["host", "localhost:5173"],
      ["Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="],
      ["Sec-WebSocket-Version", "13"],
      ["Sec-WebSocket-Protocol", "vite-hmr"],
      ["x-forwarded-host", "mend-preview.tail1234.ts.net:20001"],
      ["x-forwarded-proto", "https"],
      ["connection", "Upgrade"],
      ["upgrade", "websocket"],
    ]);
  });

  it("states the scheme and host of a loopback preview", () => {
    const origin = previewOriginOf(
      { mode: "loopback-http", port: 3110 },
      { label: LABEL, tailnetPort: null },
    );
    if (origin === null) throw new Error("loopback addresses every preview");
    const sent = forwardRequestHead([["Host", "x"]], { ...TO, origin, cookies: HOSTED });
    expect(named(sent, "x-forwarded-host")).toEqual([`${LABEL}.localhost:3110`]);
    expect(named(sent, "x-forwarded-proto")).toEqual(["http"]);
  });
});

const answered = (headers: ReadonlyArray<HeaderPair>, status = 200) =>
  forwardResponseHead({ status, headers }, OWN_PORT);

describe("the response head a viewer receives", () => {
  it("drops hop-by-hop fields, nominated fields, Clear-Site-Data and Alt-Svc", () => {
    const sent = answered([
      ["Connection", "keep-alive, X-Hop"],
      ["X-Hop", "1"],
      ["Keep-Alive", "timeout=5"],
      ["Transfer-Encoding", "chunked"],
      ["Trailer", "X-Checksum"],
      ["Upgrade", "h2c"],
      ["Proxy-Authenticate", "Basic"],
      ["Clear-Site-Data", '"cookies"'],
      ["Alt-Svc", 'h3=":20002"'],
      ["Content-Type", "text/html"],
      ["Content-Length", "5"],
    ]);
    expect(sent).toEqual([
      ["Content-Type", "text/html"],
      ["Content-Length", "5"],
      ["cache-control", "private"],
      ["x-robots-tag", "noindex"],
      ["x-accel-buffering", "no"],
    ]);
  });

  it("rewrites every Set-Cookie on its own, Expires commas included", () => {
    const sent = answered([
      ["Set-Cookie", "sid=1; Path=/; HttpOnly; Expires=Wed, 21 Oct 2026 07:28:00 GMT"],
      ["Set-Cookie", "theme=dark; Domain=ts.net; Path=/"],
      ["Set-Cookie", "__Host-mend-preview-20001=forged; Path=/; HttpOnly; Secure"],
      ["Set-Cookie", "better-auth.session_token=forged; Path=/; HttpOnly"],
    ]);
    expect(named(sent, "set-cookie")).toEqual([
      `${namespacedCookieName(LABEL, "sid")}=1; Path=/; HttpOnly; Expires=Wed, 21 Oct 2026 07:28:00 GMT`,
      "theme=dark; Path=/",
      `${namespacedCookieName(LABEL, "better-auth.session_token")}=forged; Path=/; HttpOnly`,
    ]);
  });

  it.each([
    [[], "private"],
    [["public, max-age=60"], "private, max-age=60"],
    [["max-age=60, s-maxage=600"], "private, max-age=60"],
    [["no-store"], "private, no-store"],
    [['private="Set-Cookie", no-cache="Set-Cookie, X-A"'], 'private, no-cache="Set-Cookie, X-A"'],
    [["public", "must-revalidate"], "private, must-revalidate"],
  ])("Cache-Control %j becomes %j", (values, expected) => {
    const sent = answered(values.map((value): HeaderPair => ["Cache-Control", value]));
    expect(named(sent, "cache-control")).toEqual([expected]);
  });

  it("adds noindex beside the application's own robots rules unless it said so", () => {
    expect(named(answered([["X-Robots-Tag", "nofollow"]]), "x-robots-tag")).toEqual([
      "nofollow",
      "noindex",
    ]);
    expect(named(answered([["X-Robots-Tag", "noindex, nofollow"]]), "x-robots-tag")).toEqual([
      "noindex, nofollow",
    ]);
  });

  it("replaces the application's buffering choice with no buffering", () => {
    expect(named(answered([["X-Accel-Buffering", "yes"]]), "x-accel-buffering")).toEqual(["no"]);
  });

  it("answers a 101 with exactly the WebSocket upgrade, and applies cookie policy to it", () => {
    const sent = answered(
      [
        ["Connection", "Upgrade, X-Hop"],
        ["Upgrade", "websocket, h2c"],
        ["X-Hop", "1"],
        ["Sec-WebSocket-Accept", "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="],
        ["Set-Cookie", "sid=1; HttpOnly; Domain=ts.net"],
      ],
      101,
    );
    expect(named(sent, "connection")).toEqual(["Upgrade"]);
    expect(named(sent, "upgrade")).toEqual(["websocket"]);
    expect(names(sent).has("x-hop")).toBe(false);
    expect(named(sent, "sec-websocket-accept")).toEqual(["s3pPLMBiTxaQ9kYGzzhZRbK+xOo="]);
    expect(named(sent, "set-cookie")).toEqual([
      `${namespacedCookieName(LABEL, "sid")}=1; HttpOnly`,
    ]);
  });

  it("answers anything but a 101 without an upgrade", () => {
    const sent = answered(
      [
        ["Connection", "Upgrade"],
        ["Upgrade", "websocket"],
      ],
      426,
    );
    expect(names(sent).has("connection")).toBe(false);
    expect(names(sent).has("upgrade")).toBe(false);
  });
});

describe("the page for a request the gateway did not deliver", () => {
  const facts: ReadonlyArray<{ readonly service: string; readonly why: PreviewNotDelivered }> = [
    {
      service: 'web <dev> & "docs"',
      why: { _tag: "DidNotStart", holdMs: 180_000, reason: "start timed out" },
    },
    { service: "api's", why: { _tag: "Stopped", by: "<Maria>" } },
  ];

  it.each(facts)("says $why._tag in one escaped line, uncached and unindexed", (fact) => {
    const page = undeliveredAnswer(fact.service, fact.why);
    expect(page.status).toBe(503);
    expect(page.headers).toMatchObject({
      "cache-control": "no-store, private",
      "x-robots-tag": "noindex",
      "referrer-policy": "no-referrer",
      "content-type": "text/html; charset=utf-8",
    });
    expect(page.body).not.toMatch(/<script|http-equiv|refresh/i);
    const visible = page.body
      .match(/<p>(.*)<\/p>/)?.[1]
      ?.replace(/<[^>]+>/g, "")
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
    expect(visible).toBe(
      fact.why._tag === "DidNotStart"
        ? 'preview · web <dev> & "docs" · did not start in 3 min · start timed out · your request was not delivered'
        : "preview · api's · <Maria> stopped the preview · your request was not delivered",
    );
    expect(page.body).not.toContain("<dev>");
  });

  it("is a page in Mend's look that fetches nothing, light and dark", () => {
    const page = undeliveredAnswer("web", { _tag: "Stopped", by: "Maria" });
    expect(page.body).not.toMatch(/<script|<link|<img|src=|href=|url\(|@import|https?:\/\//i);
    expect(page.body).toContain("<style>");
    expect(page.body).toMatch(/:root\{color-scheme:light;[^}]*--background:/);
    expect(page.body).toMatch(
      /@media \(prefers-color-scheme: dark\)\{:root\{color-scheme:dark;[^}]*--background:/,
    );
    expect(page.body).toContain("<h1>Mend preview · 503</h1>");
  });

  it("links back to the preview's project in Mend when the gateway knows it, escaped", () => {
    const back = 'https://mend.test/projects/p"1';
    const linked = undeliveredAnswer("web", { _tag: "Stopped", by: "Maria" }, back);
    expect(linked.body).toContain('<a href="https://mend.test/projects/p&#34;1">Open in Mend</a>');
    expect(undeliveredAnswer("web", { _tag: "Stopped", by: "Maria" }).body).not.toContain("<a ");
  });
});
