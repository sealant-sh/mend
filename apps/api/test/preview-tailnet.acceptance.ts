import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { sessionCookiePolicy } from "@mend/auth";
import { MEND_EVENTS_CHANNEL, TAILNET_PORT_QUIET_HOURS } from "@mend/db";
import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { Effect, Layer, ManagedRuntime } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import type { BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { publicNetworkPolicy } from "../src/public-network-policy.ts";
import { type DigestAnswer, type EchoedHeaders, spawnFixture } from "./fixtures/preview/apps.ts";
import {
  type AcceptanceGatewayOptions,
  previewSignIn,
  startGateway,
} from "./support/preview-acceptance-world.ts";
import { type BrowserKind, launchBrowser } from "./support/preview-browser.ts";
import { createPreviewDatabase, exitAttempts } from "./support/preview-database.ts";
import { startEdge, sweepEdges } from "./support/preview-edge.ts";
import { freePort } from "./support/preview-gateway-world.ts";

const TAILNET = "mend-test.ts.net";
const MEND_COOKIE = sessionCookiePolicy({ appUrl: `https://mend.${TAILNET}` }).name;

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const next of disposers.splice(0).toReversed()) await next();
});
afterAll(sweepEdges);

const report = (line: string) => process.stderr.write(`${line}\n`);

interface Seen {
  readonly path: string;
  readonly method: string;
  readonly status: number;
  readonly cookie: boolean;
  readonly site: string | undefined;
}

/** Mend's own API on the tailnet, as far as its origin policy goes: one probe, and sign-in. */
const startMend = async () => {
  const seen: Array<Seen> = [];
  const server = createServer();
  server.on("request", (request, response) => {
    response.on("finish", () =>
      seen.push({
        path: request.url ?? "",
        method: request.method ?? "",
        status: response.statusCode,
        cookie: (request.headers.cookie ?? "").includes(`${MEND_COOKIE}=`),
        site: request.headers["sec-fetch-site"]?.toString(),
      }),
    );
  });
  const port = await freePort();
  const holder: { origin: string | null } = { origin: null };
  const routes = HttpRouter.use((router) =>
    Effect.gen(function* () {
      yield* router.add("*", "/api/probe", () =>
        Effect.succeed(HttpServerResponse.text("reached Mend")),
      );
      yield* router.add("GET", "/preview-auth", () =>
        Effect.succeed(HttpServerResponse.text("Mend's sign-in")),
      );
    }),
  );
  return {
    port,
    seen,
    serve: async (origin: string) => {
      holder.origin = origin;
      const network = makePublicNetwork(PublicOrigin.make(origin), []);
      const runtime = ManagedRuntime.make(
        HttpRouter.serve(Layer.mergeAll(routes, publicNetworkPolicy(network)), {
          disableLogger: true,
          disableListenLog: true,
        }).pipe(Layer.provide(NodeHttpServer.layer(() => server, { port, host: "127.0.0.1" }))),
      );
      await runtime.runPromise(Effect.void);
      disposers.push(() => runtime.dispose());
    },
  };
};

const isEchoed = (value: unknown): value is EchoedHeaders =>
  typeof value === "object" && value !== null && "headers" in value && "rawHeaders" in value;

const isDigest = (value: unknown): value is DigestAnswer =>
  typeof value === "object" && value !== null && "sha256" in value && "bytes" in value;

interface Tailnet {
  readonly kind: BrowserKind;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly mend: Awaited<ReturnType<typeof startMend>>;
  readonly mendOrigin: string;
  readonly ports: ReadonlyArray<number>;
  readonly authUrl: (userId: string, key: "web" | "docs", path?: string) => Promise<string>;
  readonly originOf: (key: "web" | "docs") => string;
  readonly stopWeb: () => Promise<void>;
  readonly exitWeb: () => Promise<void>;
  readonly starts: () => number;
  readonly quietDayPasses: () => Promise<void>;
}

const onTailnet = async (
  kind: BrowserKind,
  tag: string,
  shape: Partial<AcceptanceGatewayOptions> = {},
  poolSize?: number,
): Promise<Tailnet> => {
  const database = await createPreviewDatabase(`${tag}_${kind}`);
  disposers.push(database.drop);
  const gatewayPort = await freePort();
  const mend = await startMend();
  const edge = await startEdge("tailscale-standin", {
    upstreamPort: gatewayPort,
    domain: TAILNET,
    tailnet: { ports: 2, mendUpstreamPort: mend.port },
  });
  disposers.push(edge.stop);
  const tailnet = edge.tailnet;
  if (tailnet === null || tailnet.mendOrigin === null)
    throw new Error("the stand-in serves no name");
  await mend.serve(tailnet.mendOrigin);
  report(
    `${kind}: tailscaled stand-in ${edge.image} (${edge.version}) on ${tailnet.ports.join(", ")}`,
  );
  const localPorts = { web: await freePort(), docs: await freePort() };
  const options: AcceptanceGatewayOptions = {
    databaseUrl: database.url,
    routing: {
      mode: "tailnet-https",
      hostname: tailnet.hostname,
      ports: tailnet.ports.slice(0, poolSize),
    },
    appUrl: tailnet.mendOrigin,
    port: gatewayPort,
    localPorts,
    ...shape,
  };
  const gateway = await startGateway(options);
  disposers.push(gateway.close);
  const web = await spawnFixture("all", localPorts.web);
  const docs = await spawnFixture("digest", localPorts.docs);
  disposers.push(docs.stop);
  const webStopped = { done: false };
  const stopWeb = async () => {
    if (webStopped.done) return;
    webStopped.done = true;
    await web.stop();
  };
  disposers.push(stopWeb);
  const signIn = previewSignIn(database.url, options.routing, database.previews);
  disposers.push(signIn.dispose);
  const browser = await launchBrowser(kind, {
    loopbackHosts: [tailnet.hostname, new URL(tailnet.mendOrigin).hostname],
    spki: tailnet.spki,
  });
  disposers.push(() => browser.close());
  report(`${kind}: ${browser.version()}`);
  // Playwright's Firefox takes no certificate of its own; Chromium trusts only the stand-in's.
  const context = await browser.newContext({ ignoreHTTPSErrors: kind === "firefox" });
  await context.addCookies([
    {
      name: MEND_COOKIE,
      value: "mend-sign-in",
      url: tailnet.mendOrigin,
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return {
    kind,
    context,
    page: await context.newPage(),
    mend,
    mendOrigin: tailnet.mendOrigin,
    ports: tailnet.ports,
    authUrl: (userId, key, path) => signIn.authUrl(userId, key, path),
    originOf: (key) => signIn.originOf(database.previews[key].id),
    stopWeb,
    exitWeb: async () => {
      await signIn.run(exitAttempts("web"));
      const { worktreeId, projectId } = database.previews.web;
      await signIn.run(
        Effect.flatMap(SqlClient.SqlClient, (sql) => {
          const event = JSON.stringify({ type: "worktree", worktreeId, projectId });
          return sql`SELECT pg_notify(${MEND_EVENTS_CHANNEL}, ${event})`.pipe(Effect.orDie);
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    },
    starts: () => gateway.starts.length,
    quietDayPasses: () =>
      signIn.run(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql`UPDATE preview_ports
            SET last_used_at = last_used_at - make_interval(hours => ${TAILNET_PORT_QUIET_HOURS + 1})`.pipe(
            Effect.orDie,
            Effect.asVoid,
          ),
        ),
      ),
  };
};

describe.each<BrowserKind>(["chromium", "firefox"])(
  "previews on a tailnet's ts.net name behind a tailscaled stand-in, in %s",
  (kind) => {
    it("reaches two previews on two ports, each signed in on its own port's grant", async () => {
      const at = await onTailnet(kind, "tailnet_ports");
      const opened = await at.page.goto(await at.authUrl("carol", "web", "/echo-headers"));
      const web = at.originOf("web");
      expect(at.page.url()).toBe(`${web}/echo-headers`);
      expect(opened?.status()).toBe(200);
      const echoed: unknown = await opened?.json();
      if (!isEchoed(echoed)) throw new Error("the web preview did not echo its headers");
      const names = Object.keys(echoed.headers);
      expect(
        names.filter((name) => name.startsWith("tailscale-")),
        "no Tailscale-* field the stand-in set reached the app",
      ).toEqual([]);
      expect(
        names.filter((name) => name === "x-forwarded-for"),
        "no inbound X-Forwarded-For",
      ).toEqual([]);
      expect(echoed.headers["x-forwarded-host"], "the gateway's own X-Forwarded-Host").toBe(
        new URL(web).host,
      );
      expect(String(echoed.headers["cookie"] ?? ""), "no grant reached the app").not.toContain(
        "mend-preview",
      );

      const docsOpened = await at.page.goto(await at.authUrl("carol", "docs", "/echo-headers"));
      const docs = at.originOf("docs");
      expect(at.page.url()).toBe(`${docs}/echo-headers`);
      const digest: unknown = await docsOpened?.json();
      expect(isDigest(digest) && digest.path, "the docs preview's own app answered").toBe(
        "/echo-headers",
      );
      expect([new URL(web).port, new URL(docs).port]).toEqual(at.ports.map(String));

      const grants = (await at.context.cookies())
        .filter((cookie) => cookie.name.startsWith("__Host-mend-preview"))
        .map(({ name, domain, path, httpOnly, sameSite, secure }) => ({
          name,
          domain,
          path,
          httpOnly,
          sameSite,
          secure,
        }))
        .toSorted((a, b) => a.name.localeCompare(b.name));
      expect(grants).toEqual(
        at.ports
          .toSorted((a, b) => `${a}`.localeCompare(`${b}`))
          .map((port) => ({
            name: `__Host-mend-preview-${port}`,
            domain: new URL(web).hostname,
            path: "/",
            httpOnly: true,
            sameSite: "Lax",
            secure: true,
          })),
      );
      report(`${kind}: ${web} and ${docs} each opened on its own port's grant`);
    });

    it("opens nothing on another port with one port's grant, and sends the viewer to Mend's sign-in", async () => {
      const at = await onTailnet(kind, "tailnet_grant");
      await at.page.goto(await at.authUrl("carol", "web", "/echo-headers"));
      await at.authUrl("alice", "docs");
      const docs = at.originOf("docs");
      const answered = at.page.waitForResponse((response) => response.url() === `${docs}/pricing`);
      const reachedMend = at.page.waitForResponse((response) =>
        response.url().startsWith(`${at.mendOrigin}/preview-auth?`),
      );
      await at.page.goto(`${docs}/pricing`);
      const answer = await answered;
      expect(answer.status(), "no grant for this port").toBe(302);
      expect(answer.headers()["location"]).toMatch(
        new RegExp(`^${at.mendOrigin.replaceAll(".", "\\.")}/preview-auth\\?preview=`),
      );
      expect(
        await answer.request().headerValue("cookie"),
        "the browser sent the other port's grant, which opened nothing",
      ).toContain(`__Host-mend-preview-${at.ports[0]}=`);
      const signIn = await reachedMend;
      expect(signIn.status(), "the sign-in navigation passed Mend's sibling-site check").toBe(200);
      const seen = at.mend.seen.at(-1);
      expect(seen).toMatchObject({
        path: expect.stringMatching(/^\/preview-auth\?/),
        status: 200,
        cookie: true,
      });
      report(
        `${kind}: ${docs} with only port ${at.ports[0]}'s grant went to Mend's sign-in (Sec-Fetch-Site ${seen?.site ?? "absent"})`,
      );
    });

    it("carries an event stream, a WebSocket and a held upload through the stand-in", async () => {
      const at = await onTailnet(kind, "tailnet_streams", {
        starts: { web: { _tag: "Fixture", fixture: "all", delayMs: 1_500 } },
      });
      await at.page.goto(await at.authUrl("carol", "web", "/echo-headers"));
      const streamed = await at.page.evaluate(
        () =>
          new Promise<{ events: number; echoed: string }>((resolve, reject) => {
            const events: Array<string> = [];
            const source = new EventSource("/events?count=3&every=100");
            source.addEventListener("message", (event) => {
              events.push(String(event.data));
              if (events.length < 3) return;
              source.close();
              const socket = new WebSocket(`${location.origin.replace(/^https/, "wss")}/socket`);
              socket.addEventListener("open", () => socket.send("over the tailnet"));
              socket.addEventListener("message", (message) => {
                socket.close();
                resolve({ events: events.length, echoed: String(message.data) });
              });
              socket.addEventListener("error", () => reject(new Error("the socket failed")));
            });
            source.addEventListener("error", () => {
              if (events.length < 3) reject(new Error("the event stream failed"));
            });
          }),
      );
      expect(streamed).toEqual({ events: 3, echoed: "over the tailnet" });

      await at.stopWeb();
      await at.exitWeb();
      const held = await at.page.evaluate(async () => {
        const body = new Uint8Array(8 * 1024 * 1024);
        for (let i = 0; i < body.length; i += 1) body[i] = (i * 31) % 251;
        const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body)))
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        const started = Date.now();
        const reply = await fetch("/upload", { method: "POST", body });
        return {
          status: reply.status,
          answer: await reply.text(),
          sha,
          bytes: body.length,
          heldMs: Date.now() - started,
        };
      });
      expect(
        held.status,
        `the upload was delivered once the preview started (${held.answer.slice(0, 120)})`,
      ).toBe(200);
      const digest: unknown = JSON.parse(held.answer);
      if (!isDigest(digest)) throw new Error("the started preview did not digest the upload");
      expect([digest.bytes, digest.sha256], "the upload arrived whole").toEqual([
        held.bytes,
        held.sha,
      ]);
      expect(held.heldMs, "it was held while the preview started").toBeGreaterThan(1_000);
      expect(at.starts(), "the held upload started the preview once").toBe(1);
      report(
        `${kind}: 3 events, a WebSocket echo, and 8 MiB held ${held.heldMs} ms for a start, through the stand-in`,
      );
    });

    it("gives a port to another preview only after a quiet day, and that preview's first open clears what the earlier one stored", async () => {
      const at = await onTailnet(kind, "tailnet_reuse", {}, 1);
      const port = at.ports[0];
      const opened = at.page.waitForResponse((response) =>
        response.url().includes("/__mend/auth?"),
      );
      await at.page.goto(await at.authUrl("carol", "web", "/echo-headers"));
      expect(
        (await (await opened).allHeaders())["clear-site-data"],
        "a port no preview held",
      ).toBeUndefined();
      const web = at.originOf("web");
      expect(new URL(web).port).toBe(String(port));
      await at.page.evaluate(() => localStorage.setItem("left-by", "web"));
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await expect(
        at.authUrl("carol", "docs", "/echo-headers"),
        "the one port was in use within the quiet period",
      ).rejects.toMatchObject({ _tag: "PreviewPoolFull", size: 1 });

      await at.quietDayPasses();
      const reopened = at.page.waitForResponse((response) =>
        response.url().includes("/__mend/auth?"),
      );
      await at.page.goto(await at.authUrl("carol", "docs", "/echo-headers"));
      const docs = at.originOf("docs");
      expect(docs, "the docs preview has the web preview's port").toBe(web);
      expect((await (await reopened).allHeaders())["clear-site-data"]).toBe('"cache", "storage"');
      expect(at.page.url()).toBe(`${docs}/echo-headers`);
      expect(
        await at.page.evaluate(() => localStorage.getItem("left-by")),
        "what the earlier preview stored on the port is gone",
      ).toBeNull();
      report(
        `${kind}: port ${port} went from web to docs after a quiet day, and the browser cleared web's storage there`,
      );
    });

    it("keeps a port whose preview opened a WebSocket after a quiet day: another preview's open finds the pool full", async () => {
      const at = await onTailnet(kind, "tailnet_renew", {}, 1);
      await at.page.goto(await at.authUrl("carol", "web", "/echo-headers"));
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await at.quietDayPasses();
      await at.page.evaluate(
        () =>
          new Promise<void>((resolve, reject) => {
            const socket = new WebSocket(`${location.origin.replace(/^https/, "wss")}/socket`);
            Reflect.set(globalThis, "heldSocket", socket);
            socket.addEventListener("open", () => resolve());
            socket.addEventListener("error", () => reject(new Error("the socket failed")));
          }),
      );
      await expect(
        at.authUrl("carol", "docs", "/echo-headers"),
        "web's open socket keeps the one port",
      ).rejects.toMatchObject({ _tag: "PreviewPoolFull", size: 1 });
      const echoed = await at.page.evaluate(
        () =>
          new Promise<string>((resolve, reject) => {
            const socket: unknown = Reflect.get(globalThis, "heldSocket");
            if (!(socket instanceof WebSocket) || socket.readyState !== WebSocket.OPEN)
              return reject(new Error("web's socket closed"));
            socket.addEventListener("message", (message) => resolve(String(message.data)));
            socket.send("still open");
          }),
      );
      expect(echoed, "web's socket stayed open").toBe("still open");
      report(
        `${kind}: web's WebSocket opened after a quiet day kept port ${at.ports[0]}, and docs found the pool full`,
      );
    });

    it("refuses a preview page's requests to Mend's API on the same tailnet, and keeps its links", async () => {
      const at = await onTailnet(kind, "tailnet_sibling");
      await at.page.goto(await at.authUrl("carol", "web", "/echo-headers"));
      const before = at.mend.seen.length;
      await at.page.evaluate(async (mend) => {
        await fetch(`${mend}/api/probe?fetch`, { credentials: "include" }).catch(() => null);
        await fetch(`${mend}/api/probe?no-cors`, { mode: "no-cors", credentials: "include" }).catch(
          () => null,
        );
        await new Promise((resolve) => {
          const image = new Image();
          image.addEventListener("load", resolve);
          image.addEventListener("error", resolve);
          image.src = `${mend}/api/probe?image`;
        });
        const frame = document.createElement("iframe");
        frame.name = "sink";
        document.body.append(frame);
        const form = document.createElement("form");
        form.method = "POST";
        form.action = `${mend}/api/probe?form`;
        form.target = "sink";
        document.body.append(form);
        const loaded = new Promise((resolve) => frame.addEventListener("load", resolve));
        form.submit();
        await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 3_000))]);
      }, at.mendOrigin);
      const navigated = at.page.waitForResponse((response) =>
        response.url().endsWith("/api/probe?navigation"),
      );
      await at.page.evaluate(
        (mend) => location.assign(`${mend}/api/probe?navigation`),
        at.mendOrigin,
      );
      expect((await navigated).status(), "a link to Mend still opens").toBe(200);
      const probes = at.mend.seen
        .slice(before)
        .filter((seen) => seen.path.startsWith("/api/probe"));
      expect(
        probes.map(({ path, method, status, cookie, site }) => ({
          path,
          method,
          status,
          cookie,
          site,
        })),
      ).toEqual([
        { path: "/api/probe?fetch", method: "GET", status: 403, cookie: true, site: "same-site" },
        { path: "/api/probe?no-cors", method: "GET", status: 403, cookie: true, site: "same-site" },
        { path: "/api/probe?image", method: "GET", status: 403, cookie: true, site: "same-site" },
        { path: "/api/probe?form", method: "POST", status: 403, cookie: true, site: "same-site" },
        {
          path: "/api/probe?navigation",
          method: "GET",
          status: 200,
          cookie: true,
          site: "same-site",
        },
      ]);
      report(
        `${kind}: from ${new URL(at.originOf("web")).host}, Mend refused a fetch, a no-cors fetch, an image and a form post carrying its cookie, and opened a link`,
      );
    });
  },
);
