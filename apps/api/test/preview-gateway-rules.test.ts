import type { PreviewGatewayResolution } from "@mend/domain/workbench";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { serveFixture } from "./fixtures/preview/apps.ts";
import { localForwards } from "./support/preview-forward.ts";
import {
  APP_PORT,
  type GatewayWorld,
  gatewayWorld,
  PREVIEWS,
  rawExchange,
  ROUTINGS,
  send,
  WORKSPACE,
} from "./support/preview-gateway-world.ts";

/**
 * Every refusal and stripping rule of the preview gateway (ADR 0017, "What the gateway strips and
 * refuses", "Refused for now"; decision 6), end to end through the listener: one row per rule, each
 * against a fresh gateway in front of the fixture app. A refused row must never dial the app.
 */

interface Seen {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
  readonly body: string;
}

interface Row {
  readonly rule: string;
  readonly routing?: keyof typeof ROUTINGS;
  readonly resolution?: PreviewGatewayResolution;
  readonly ask: (world: GatewayWorld) => Promise<Seen>;
  readonly holds: (seen: Seen, world: GatewayWorld) => void;
  readonly delivered: boolean;
}

const Echoed = Schema.fromJsonString(
  Schema.Struct({ headers: Schema.Record(Schema.String, Schema.String) }),
);
const appSaw = (seen: Seen) => Schema.decodeUnknownSync(Echoed)(seen.body).headers;

const rawAnswer = (text: string): Seen => {
  const [head = "", body = ""] = text.split("\r\n\r\n");
  const [status = "", ...lines] = head.split("\r\n");
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(status.split(" ")[1] ?? 0), headers, body };
};

const raw = (text: (world: GatewayWorld) => string) => (world: GatewayWorld) =>
  rawExchange(world.port, text(world)).then(rawAnswer);

const get =
  (path: string, headers: (world: GatewayWorld) => Record<string, string> = () => ({})) =>
  (world: GatewayWorld) =>
    send(world.port, {
      host: world.hostOf("web"),
      path,
      headers: { cookie: world.cookieFor("carol", "web"), ...headers(world) },
    });

const setCookies = (seen: Seen) => {
  const header = seen.headers["set-cookie"];
  return typeof header === "string" ? [header] : [...(header ?? [])];
};
const cookieName = (setCookie: string) => (setCookie.split(";")[0] ?? "").split("=")[0] ?? "";

const ROWS: ReadonlyArray<Row> = [
  {
    rule: "CONNECT is answered 405 by the listener's connect handler, and the socket closes",
    ask: raw(() => "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"),
    holds: (seen) => {
      expect(seen.status, "CONNECT is refused").toBe(405);
      expect(seen.headers["connection"], "the answer closes the connection").toBe("close");
    },
    delivered: false,
  },
  {
    rule: "a request with two Host fields is refused 400",
    ask: raw(
      (world) =>
        `GET / HTTP/1.1\r\nHost: ${world.hostOf("web")}\r\nHost: ${world.hostOf("web")}\r\nCookie: ${world.cookieFor("carol", "web")}\r\nConnection: close\r\n\r\n`,
    ),
    holds: (seen) => expect(seen.status, "a doubled Host is refused").toBe(400),
    delivered: false,
  },
  {
    rule: "an unassigned tailnet port is 404",
    routing: "tailnet",
    ask: (world) => send(world.port, { host: "mend-preview.tail.ts.net:20999", path: "/" }),
    holds: (seen) => expect(seen.status, "no preview has that port").toBe(404),
    delivered: false,
  },
  {
    rule: "a preview host on another port than the domain's is 404",
    ask: (world) =>
      send(world.port, {
        host: `${PREVIEWS.web.label}.preview.test:8443`,
        path: "/",
        headers: { cookie: world.cookieFor("carol", "web") },
      }),
    holds: (seen) => expect(seen.status, "the port is part of the preview's origin").toBe(404),
    delivered: false,
  },
  {
    rule: "a service worker script is refused 403",
    ask: get("/sw.js", () => ({ "service-worker": "script" })),
    holds: (seen) => expect(seen.status, "a service worker could answer /__mend/").toBe(403),
    delivered: false,
  },
  {
    rule: "an https Service is refused with the stated line",
    resolution: { _tag: "Refused", reason: "https-unsupported" },
    ask: get("/"),
    holds: (seen) => {
      expect(seen.status, "the gateway does not speak TLS to the dev server").toBe(501);
      expect(seen.body, "the page says why").toContain(
        "preview · web · it speaks https, which previews do not relay yet · your request was not delivered",
      );
    },
    delivered: false,
  },
  {
    rule: "a /__mend/ path is the gateway's own and never reaches the app",
    ask: get("/__mend/anything"),
    holds: (seen) => expect(seen.status, "reserved for the gateway").toBe(404),
    delivered: false,
  },
  {
    rule: "only the grant is held back: the app's own cookies and Authorization reach it untouched",
    ask: (world) =>
      get("/echo-headers", (w) => ({
        cookie: `${w.cookieFor("carol", "web")}; better-auth.session_token=s1; __Secure-better-auth.session_token=s2; app=1`,
        authorization: "Bearer mend-or-app",
        "x-mend-invitation": "inv_1",
      }))(world),
    holds: (seen) => {
      const headers = appSaw(seen);
      expect(headers["cookie"], "every cookie but the grant").toBe(
        "better-auth.session_token=s1; __Secure-better-auth.session_token=s2; app=1",
      );
      expect(headers["authorization"], "Authorization as sent").toBe("Bearer mend-or-app");
      expect(headers["x-mend-invitation"], "an app header of any name").toBe("inv_1");
    },
    delivered: true,
  },
  {
    rule: "inbound Forwarded and X-Forwarded-* are replaced by the gateway's own",
    ask: get("/echo-headers", () => ({
      forwarded: "for=203.0.113.9;host=evil.example",
      "x-forwarded-for": "203.0.113.9",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "http",
      "x-real-ip": "203.0.113.9",
    })),
    holds: (seen, world) => {
      const headers = appSaw(seen);
      expect(headers["forwarded"], "no inbound Forwarded").toBeUndefined();
      expect(headers["x-forwarded-for"], "no inbound X-Forwarded-For").toBeUndefined();
      expect(headers["x-real-ip"], "no inbound X-Real-IP").toBeUndefined();
      expect(headers["x-forwarded-host"], "the preview's own host").toBe(world.hostOf("web"));
      expect(headers["x-forwarded-proto"], "the preview's own scheme").toBe("https");
      expect(headers["host"], "Host rewritten to the dev server's").toBe(`localhost:${APP_PORT}`);
    },
    delivered: true,
  },
  {
    rule: "hop-by-hop headers and the ones Connection names never reach the app",
    ask: get("/echo-headers", () => ({
      connection: "keep-alive, x-hop",
      "x-hop": "1",
      "keep-alive": "timeout=5",
      te: "trailers",
      "proxy-authorization": "Basic eA==",
    })),
    holds: (seen) => {
      const headers = appSaw(seen);
      expect(headers["x-hop"], "a header Connection names").toBeUndefined();
      expect(headers["te"], "TE").toBeUndefined();
      expect(headers["proxy-authorization"], "Proxy-Authorization").toBeUndefined();
      expect(headers["keep-alive"], "Keep-Alive").toBeUndefined();
    },
    delivered: true,
  },
  {
    rule: "Set-Cookie loses its Domain, and a cookie named like the grant is dropped",
    ask: get("/set-cookies"),
    holds: (seen) => {
      const cookies = setCookies(seen);
      expect(cookies.map(cookieName), "the app's cookies, less the grant-named one").toEqual([
        "plain",
        "scoped",
        "dated",
        "secret",
      ]);
      expect(
        cookies.filter((cookie) => /;\s*domain\s*=/i.test(cookie)),
        "no Domain attribute is left",
      ).toEqual([]);
      expect(
        cookies.find((cookie) => cookieName(cookie) === "dated"),
        "an Expires date with its comma survives whole",
      ).toContain("Expires=Wed, 21 Oct 2037 07:28:00 GMT");
    },
    delivered: true,
  },
  {
    rule: "every answer is Cache-Control private and X-Robots-Tag noindex, and Clear-Site-Data is dropped",
    ask: get("/set-cookies"),
    holds: (seen) => {
      expect(
        String(seen.headers["cache-control"] ?? "")
          .split(",")
          .map((part) => part.trim()),
        "no shared cache keeps a viewer's page",
      ).toContain("private");
      expect(seen.headers["x-robots-tag"], "not indexed").toBe("noindex");
      expect(seen.headers["clear-site-data"], "cannot clear the host's grants").toBeUndefined();
    },
    delivered: true,
  },
  {
    rule: "on a ts.net name, HttpOnly app cookies are renamed per preview, both ways",
    routing: "tailnet",
    ask: async (world) => {
      const set = await get("/set-cookies")(world);
      const label = PREVIEWS.web.label;
      const echoed = await get("/echo-headers", (w) => ({
        cookie: `p-${label}.secret=4; p-${PREVIEWS.docs.label}.secret=9; plain=1; ${w.cookieFor("carol", "web")}`,
      }))(world);
      return { ...echoed, headers: { ...echoed.headers, "set-cookie": setCookies(set) } };
    },
    holds: (seen) => {
      expect(
        setCookies(seen).map(cookieName),
        "the HttpOnly cookie in the web preview's namespace",
      ).toEqual(["plain", "scoped", "dated", `p-${PREVIEWS.web.label}.secret`]);
      expect(
        appSaw(seen)["cookie"],
        "the app reads its own cookie by its own name, never another preview's",
      ).toBe("secret=4; plain=1");
    },
    delivered: true,
  },
];

describe("the preview gateway's refusals and stripping rules, end to end", () => {
  it.each(ROWS.map((row) => [row.rule, row] as const))("%s", async (_, row) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* Effect.acquireRelease(
            Effect.promise(() => serveFixture("all")),
            (running) => Effect.promise(running.stop),
          );
          const forwards = localForwards([
            {
              workspaceId: WORKSPACE,
              port: APP_PORT,
              entry: { kind: "listen", localPort: app.port },
            },
          ]);
          const world = yield* gatewayWorld({
            forwards: forwards.layer,
            ...(row.routing === undefined ? {} : { routing: row.routing }),
          });
          if (row.resolution !== undefined) {
            world.targets.resolutions.set(PREVIEWS.web.id, row.resolution);
          }
          const seen = yield* Effect.promise(() => row.ask(world));
          row.holds(seen, world);
          expect(
            forwards.dials.length > 0,
            row.delivered ? "the request reached the app" : "nothing dialled the app",
          ).toBe(row.delivered);
          expect(world.targets.starts, "no rule starts a preview").toEqual([]);
        }),
      ),
    );
  });
});
