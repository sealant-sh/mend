import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import * as http from "node:http";
import * as net from "node:net";

import { SessionProcessId } from "@mend/domain";
import { describe, expect, it } from "@mend/test-ci/effect-vitest";
import { Effect, Schema } from "effect";

import { serveFixture } from "./fixtures/preview/apps.ts";
import { localForwards } from "./support/preview-forward.ts";
import {
  APP_PORT,
  bound,
  type GatewayWorld,
  gatewayWorld,
  PLATFORM_SESSION,
  PREVIEWS,
  type PreviewKey,
  ROUTINGS,
  send,
  WORKSPACE,
} from "./support/preview-gateway-world.ts";

const RequestHeaders = Schema.Record(Schema.String, Schema.String);
const decodeDigest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ method: Schema.String, path: Schema.String, headers: RequestHeaders }),
  ),
);
const decodeEchoed = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ headers: RequestHeaders })),
);
const decodeEvent = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ i: Schema.Number, sentAt: Schema.Number })),
);

const waitFor = <A>(what: string, ms: number, read: () => A | null): Promise<A> =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const value = read();
      if (value !== null) return resolve(value);
      if (Date.now() - started > ms) return reject(new Error(`not seen within ${ms} ms: ${what}`));
      setTimeout(poll, 10);
    };
    poll();
  });

const happensWithin = (ms: number, happened: () => boolean): Promise<boolean> =>
  waitFor("", ms, () => (happened() ? true : null)).then(
    () => true,
    () => false,
  );

const relayWorld = (routing: keyof typeof ROUTINGS = "domain") =>
  Effect.gen(function* () {
    const app = yield* Effect.acquireRelease(
      Effect.promise(() => serveFixture("all")),
      (running) => Effect.promise(running.stop),
    );
    const forwards = localForwards([
      { workspaceId: WORKSPACE, port: APP_PORT, entry: { kind: "listen", localPort: app.port } },
    ]);
    const world = yield* gatewayWorld({ forwards: forwards.layer, routing });
    return { forwards, world };
  });

/**
 * A dev server that answers the first request on each connection and drops the connection on any
 * later one without a byte of answer: a keep-alive socket it closed just as the next request came.
 */
const closesReusedConnections = Effect.acquireRelease(
  Effect.promise(async () => {
    const dropped: Array<string> = [];
    const served = new WeakSet<object>();
    const server = http.createServer((request, response) => {
      const line = `${request.method} ${request.url}`;
      if (served.has(request.socket)) {
        dropped.push(line);
        request.socket.destroy();
        return;
      }
      served.add(request.socket);
      request.resume();
      request.on("end", () => response.end(line));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no TCP address");
    return { port: address.port, dropped, server };
  }),
  ({ server }) =>
    Effect.promise(() => {
      server.closeAllConnections();
      return new Promise((done) => server.close(done));
    }),
);

const getAs = (
  world: GatewayWorld,
  cookie: string,
  path: string,
  options: { readonly key?: PreviewKey; readonly headers?: Record<string, string> } = {},
) =>
  Effect.promise(() =>
    send(world.port, {
      host: world.hostOf(options.key ?? "web"),
      path,
      headers: { cookie, ...options.headers },
    }),
  );

const cookieNameOf = (setCookie: string) => (setCookie.split(";")[0] ?? "").split("=")[0] ?? "";

interface RawClient {
  readonly write: (bytes: string | Buffer) => void;
  readonly received: () => Buffer;
  readonly closed: () => boolean;
  readonly destroy: () => void;
}

const connectRaw = (port: number): Promise<RawClient> =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const parts: Array<Buffer> = [];
    let closed = false;
    socket.on("data", (chunk: Buffer) => parts.push(chunk));
    socket.on("close", () => {
      closed = true;
    });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      socket.on("error", () => undefined);
      resolve({
        write: (bytes) => socket.write(bytes),
        received: () => Buffer.concat(parts),
        closed: () => closed,
        destroy: () => socket.destroy(),
      });
    });
  });

const rawClient = (world: GatewayWorld) =>
  Effect.acquireRelease(
    Effect.promise(() => connectRaw(world.port)),
    (client) => Effect.sync(client.destroy),
  );

interface RawHead {
  readonly status: number;
  readonly fields: ReadonlyArray<readonly [string, string]>;
  readonly size: number;
}

const readHead = (bytes: Buffer): RawHead | null => {
  const end = bytes.indexOf("\r\n\r\n");
  if (end === -1) return null;
  const [statusLine = "", ...lines] = bytes.subarray(0, end).toString("latin1").split("\r\n");
  const fields = lines.map((line): readonly [string, string] => {
    const colon = line.indexOf(":");
    return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
  });
  return { status: Number(statusLine.split(" ")[1]), fields, size: end + 4 };
};

const fieldOf = (head: RawHead, name: string) =>
  head.fields.flatMap(([field, value]) => (field === name ? [value] : []));

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const acceptOf = (key: string) =>
  createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");

const upgradeRequest = (options: {
  readonly host: string;
  readonly cookie: string;
  readonly origin: string;
  readonly key: string;
  readonly path?: string;
}) =>
  [
    `GET ${options.path ?? "/socket"} HTTP/1.1`,
    `Host: ${options.host}`,
    `Cookie: ${options.cookie}`,
    `Origin: ${options.origin}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Key: ${options.key}`,
    "",
    "",
  ].join("\r\n");

const TEXT = 0x1;

/** One short text frame, masked as a browser must send it. */
const clientTextFrame = (text: string): Buffer => {
  const payload = Buffer.from(text, "utf8");
  const mask = randomBytes(4);
  const frame = Buffer.alloc(6 + payload.length);
  frame.writeUInt8(0x80 | TEXT, 0);
  frame.writeUInt8(0x80 | payload.length, 1);
  mask.copy(frame, 2);
  for (let index = 0; index < payload.length; index += 1) {
    frame.writeUInt8(payload.readUInt8(index) ^ mask.readUInt8(index % 4), 6 + index);
  }
  return frame;
};

/** One short text frame, unmasked as a server sends it. */
const serverTextFrame = (text: string): Buffer => {
  const payload = Buffer.from(text, "utf8");
  return Buffer.concat([Buffer.from([0x80 | TEXT, payload.length]), payload]);
};

interface Frame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly masked: boolean;
  readonly text: string;
}

const readFrame = (bytes: Buffer): Frame | null => {
  if (bytes.length < 2) return null;
  const first = bytes.readUInt8(0);
  const second = bytes.readUInt8(1);
  const length = second & 0x7f;
  if (length >= 126) throw new Error("only short frames are expected");
  const masked = (second & 0x80) !== 0;
  const start = masked ? 6 : 2;
  if (bytes.length < start + length) return null;
  const payload = Buffer.from(bytes.subarray(start, start + length));
  if (masked) {
    for (let index = 0; index < length; index += 1) {
      payload.writeUInt8(payload.readUInt8(index) ^ bytes.readUInt8(2 + (index % 4)), index);
    }
  }
  return {
    fin: (first & 0x80) !== 0,
    opcode: first & 0x0f,
    masked,
    text: payload.toString("utf8"),
  };
};

const upgradedFrame = (bytes: Buffer) => {
  const head = readHead(bytes);
  if (head === null) return null;
  if (head.status !== 101) return { head, frame: null };
  const frame = readFrame(bytes.subarray(head.size));
  return frame === null ? null : { head, frame };
};

const openEchoSocket = (world: GatewayWorld, cookie: string, text: string) =>
  Effect.gen(function* () {
    const client = yield* rawClient(world);
    client.write(
      upgradeRequest({
        host: world.hostOf("web"),
        cookie,
        origin: world.originOf("web"),
        key: randomBytes(16).toString("base64"),
      }),
    );
    const opened = yield* Effect.promise(() =>
      waitFor("the 101", 3_000, () => readHead(client.received())),
    );
    expect(opened.status, "the app accepted the upgrade").toBe(101);
    client.write(clientTextFrame(text));
    const echoed = yield* Effect.promise(() =>
      waitFor("the echo", 3_000, () => readFrame(client.received().subarray(opened.size))),
    );
    expect(echoed.text, "the app echoed the frame").toBe(text);
    return client;
  });

const serveEagerUpgrade = async (text: string) => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let seen = "";
    const onData = (chunk: Buffer) => {
      seen += chunk.toString("latin1");
      if (!seen.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      const key = /^sec-websocket-key:\s*(\S+)\s*$/im.exec(seen)?.[1] ?? "";
      socket.write(
        Buffer.concat([
          Buffer.from(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptOf(key)}\r\n\r\n`,
            "latin1",
          ),
          serverTextFrame(text),
        ]),
      );
    };
    socket.on("data", onData);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  return {
    port: address.port,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
};

interface ReceivedEvent {
  readonly i: number;
  readonly at: number;
}

interface EventStream {
  readonly status: () => number | null;
  readonly events: () => ReadonlyArray<ReceivedEvent>;
  readonly ended: () => boolean;
  readonly destroy: () => void;
}

const openEvents = (world: GatewayWorld, cookie: string, path: string): EventStream => {
  const events: Array<ReceivedEvent> = [];
  let status: number | null = null;
  let ended = false;
  let pending = "";
  const end = () => {
    ended = true;
  };
  const request = http.request({
    host: "127.0.0.1",
    port: world.port,
    path,
    headers: { host: world.hostOf("web"), cookie, accept: "text/event-stream" },
    agent: false,
  });
  request.on("error", end);
  request.on("close", end);
  request.on("response", (response) => {
    status = response.statusCode ?? 0;
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      const blocks = `${pending}${chunk}`.split("\n\n");
      pending = blocks.pop() ?? "";
      for (const block of blocks) {
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (data !== undefined) events.push({ i: decodeEvent(data.slice(6)).i, at: Date.now() });
      }
    });
    response.on("error", end);
    response.on("close", end);
  });
  request.end();
  return {
    status: () => status,
    events: () => events,
    ended: () => ended,
    destroy: () => request.destroy(),
  };
};

const eventStream = (world: GatewayWorld, cookie: string, path: string) =>
  Effect.acquireRelease(
    Effect.sync(() => openEvents(world, cookie, path)),
    (stream) => Effect.sync(stream.destroy),
  );

describe("the preview gateway relays to the app", () => {
  it.live(
    "delivers the exact path and query, with the app's own Host and the preview's forwarded host and scheme",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { world } = yield* relayWorld();
          const target = "/deep/path%20with%20space/file.js?q=1&q=2&empty=&enc=a%2Fb%3D";
          const reply = yield* getAs(world, world.cookieFor("carol", "web"), target);
          expect(reply.status, "the app answered").toBe(200);
          const seen = decodeDigest(reply.body);
          expect(seen.method, "the method reached the app").toBe("GET");
          expect(seen.path, "path and query reached the app unchanged").toBe(target);
          expect(seen.headers["host"], "Host is the app's own address").toBe(
            `localhost:${APP_PORT}`,
          );
          expect(seen.headers["x-forwarded-host"], "X-Forwarded-Host is the preview's host").toBe(
            world.hostOf("web"),
          );
          expect(seen.headers["x-forwarded-proto"], "X-Forwarded-Proto is https").toBe("https");
        }),
      ),
  );

  it.live('asks a host = "preserve" app as the preview\'s own host', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world } = yield* relayWorld();
        world.targets.resolutions.set(PREVIEWS.web.id, bound({ host: "preserve" }));
        const reply = yield* getAs(world, world.cookieFor("carol", "web"), "/");
        expect(reply.status, "the app answered").toBe(200);
        expect(decodeDigest(reply.body).headers["host"], "Host is the preview's host").toBe(
          world.hostOf("web"),
        );
      }),
    ),
  );

  it.live("reuses one viewer's forward across keep-alive requests and never shares it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { forwards, world } = yield* relayWorld();
        const carol = world.cookieFor("carol", "web");
        for (const path of ["/one", "/two", "/three"]) {
          const reply = yield* getAs(world, carol, path);
          expect(reply.status, `carol's ${path} was answered`).toBe(200);
        }
        expect(forwards.dials.length, "carol's three requests made one dial").toBe(1);
        const dave = world.cookieFor("dave", "web");
        for (const path of ["/one", "/two", "/three"]) {
          const reply = yield* getAs(world, dave, path);
          expect(reply.status, `dave's ${path} was answered`).toBe(200);
        }
        expect(forwards.dials.length, "dave's requests made exactly one dial of his own").toBe(2);
        expect(
          forwards.dials.map((dial) => dial.requested),
          "every dial asked for the preview's session binding",
        ).toEqual([
          { kind: "session", session: PLATFORM_SESSION },
          { kind: "session", session: PLATFORM_SESSION },
        ]);
      }),
    ),
  );

  it.live(
    "keeps a pooled forward under an event stream quieter than the free-socket expiry",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { forwards, world } = yield* relayWorld();
          const cookie = world.cookieFor("carol", "web");
          const first = yield* getAs(world, cookie, "/warm");
          expect(first.status, "the first request was answered").toBe(200);
          const stream = yield* eventStream(world, cookie, "/events?every=4500&count=3");
          yield* Effect.promise(() =>
            waitFor("the stream to finish", 15_000, () => (stream.ended() ? true : null)),
          );
          const events = stream.events();
          expect(stream.status(), "the stream was answered").toBe(200);
          expect(
            events.map((event) => event.i),
            "every event arrived, in order",
          ).toEqual([0, 1, 2]);
          const gaps = events.slice(1).map((event, index) => event.at - (events[index]?.at ?? 0));
          for (const gap of gaps) {
            expect(gap, "events arrived about 4.5 s apart, past the 4 s expiry").toBeGreaterThan(
              4_400,
            );
          }
          expect(forwards.dials.length, "the stream reused the pooled forward").toBe(1);
        }),
      ),
    20_000,
  );

  it.live("relays a WebSocket frame the browser sent in the same write as its upgrade", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world } = yield* relayWorld();
        const client = yield* rawClient(world);
        const key = randomBytes(16).toString("base64");
        const text = "sent with the upgrade";
        client.write(
          Buffer.concat([
            Buffer.from(
              upgradeRequest({
                host: world.hostOf("web"),
                cookie: world.cookieFor("carol", "web"),
                origin: world.originOf("web"),
                key,
              }),
              "latin1",
            ),
            clientTextFrame(text),
          ]),
        );
        const answer = yield* Effect.promise(() =>
          waitFor("the 101 and the echo", 3_000, () => upgradedFrame(client.received())),
        );
        expect(answer.head.status, "the app accepted the upgrade").toBe(101);
        expect(
          fieldOf(answer.head, "sec-websocket-accept"),
          "the handshake answers this client's key",
        ).toEqual([acceptOf(key)]);
        expect(answer.frame, "the frame written with the upgrade came back").toEqual({
          fin: true,
          opcode: TEXT,
          masked: false,
          text,
        });
      }),
    ),
  );

  it.live("relays a WebSocket frame the app sent in the same write as its 101", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { forwards, world } = yield* relayWorld();
        const text = "sent with the 101";
        const eager = yield* Effect.acquireRelease(
          Effect.promise(() => serveEagerUpgrade(text)),
          (server) => Effect.promise(server.stop),
        );
        const eagerPort = APP_PORT + 1;
        forwards.route({
          workspaceId: WORKSPACE,
          port: eagerPort,
          entry: { kind: "listen", localPort: eager.port },
        });
        world.targets.resolutions.set(PREVIEWS.web.id, bound({ port: eagerPort }));
        const client = yield* rawClient(world);
        const key = randomBytes(16).toString("base64");
        client.write(
          upgradeRequest({
            host: world.hostOf("web"),
            cookie: world.cookieFor("carol", "web"),
            origin: world.originOf("web"),
            key,
          }),
        );
        const frame = serverTextFrame(text);
        const answer = yield* Effect.promise(() =>
          waitFor("the 101 and the app's frame", 3_000, () => {
            const head = readHead(client.received());
            if (head === null) return null;
            const after = client.received().subarray(head.size);
            return head.status !== 101 || after.length >= frame.length ? { head, after } : null;
          }),
        );
        expect(answer.head.status, "the app's 101 reached the client").toBe(101);
        expect(
          fieldOf(answer.head, "sec-websocket-accept"),
          "the handshake answers this client's key",
        ).toEqual([acceptOf(key)]);
        expect(answer.after.toString("hex"), "the app's frame arrived intact").toBe(
          frame.toString("hex"),
        );
      }),
    ),
  );

  it.live(
    "answers a refused upgrade with the app's status and body, then closes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { world } = yield* relayWorld();
          const client = yield* rawClient(world);
          client.write(
            upgradeRequest({
              host: world.hostOf("web"),
              cookie: world.cookieFor("carol", "web"),
              origin: world.originOf("web"),
              key: randomBytes(16).toString("base64"),
              path: "/upgrade-refused",
            }),
          );
          const body = "upgrade refused";
          const answer = yield* Effect.promise(() =>
            waitFor("the refusal and its body", 3_000, () => {
              const head = readHead(client.received());
              if (head === null) return null;
              const after = client.received().subarray(head.size);
              return after.length >= body.length || client.closed() ? { head, after } : null;
            }),
          );
          expect(answer.head.status, "the app's 400 reached the client").toBe(400);
          expect(fieldOf(answer.head, "connection"), "the answer says the socket closes").toEqual([
            "close",
          ]);
          expect(answer.after.toString("utf8"), "the app's body arrived intact").toBe(body);
          expect(
            yield* Effect.promise(() => happensWithin(3_000, client.closed)),
            "the socket closes after the answer",
          ).toBe(true);
        }),
      ),
    10_000,
  );

  it.live("relays the app's own Authorization and cookies untouched, and never a grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world } = yield* relayWorld();
        const grant = world.cookieFor("carol", "web");
        const grantSecret = grant.slice(grant.indexOf("=") + 1);
        const echoedReply = yield* getAs(
          world,
          `${grant}; better-auth.session_token=secret; app=1`,
          "/echo-headers",
          { headers: { authorization: "Bearer x" } },
        );
        expect(echoedReply.status, "the app answered").toBe(200);
        const echoed = decodeEchoed(echoedReply.body);
        expect(echoed.headers["cookie"], "every cookie but the grant reached it").toBe(
          "better-auth.session_token=secret; app=1",
        );
        expect(echoed.headers["authorization"], "the app's own Authorization reached it").toBe(
          "Bearer x",
        );
        expect(
          echoedReply.body.includes(grantSecret),
          "the grant appears nowhere in what the app read",
        ).toBe(false);

        const setReply = yield* getAs(world, grant, "/set-cookies");
        expect(setReply.status, "the app answered").toBe(200);
        const setCookies = setReply.headers["set-cookie"] ?? [];
        expect(
          setCookies.map(cookieNameOf),
          "the app's own cookies reach the browser, the grant-named one dropped",
        ).toEqual(["plain", "scoped", "dated", "secret"]);
        expect(
          setCookies.filter((cookie) => /;\s*domain\s*=/i.test(cookie)),
          "no Set-Cookie keeps a Domain attribute",
        ).toEqual([]);
        expect(
          setCookies.filter((cookie) => cookieNameOf(cookie).startsWith("__Host-mend-preview")),
          "the app cannot set a cookie named like the grant",
        ).toEqual([]);
        expect(
          (setReply.headers["cache-control"] ?? "").split(",").map((part) => part.trim()),
          "Cache-Control keeps the answer private",
        ).toContain("private");
        expect(setReply.headers["x-robots-tag"], "X-Robots-Tag says noindex").toBe("noindex");
        expect(
          setReply.headers["clear-site-data"],
          "the app cannot clear the browser's data for the host",
        ).toBeUndefined();
      }),
    ),
  );

  it.live("never lets a Tailscale-* field reach the app, on a tailnet or a domain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const routings: ReadonlyArray<keyof typeof ROUTINGS> = ["tailnet", "domain"];
        for (const routing of routings) {
          const { world } = yield* relayWorld(routing);
          const reply = yield* getAs(world, world.cookieFor("carol", "web"), "/echo-headers", {
            headers: {
              "tailscale-user-login": "mallory@example.com",
              "Tailscale-User-Name": "Mallory",
              "Tailscale-User-Profile-Pic": "https://example.com/m.png",
              "Tailscale-App-Capabilities": "{}",
              "x-forwarded-for": "203.0.113.9",
            },
          });
          expect(reply.status, `the app answered on the ${routing}`).toBe(200);
          const headers = Object.keys(decodeEchoed(reply.body).headers);
          expect(
            headers.filter((name) => name.startsWith("tailscale-")),
            `no Tailscale-* field reached the app on the ${routing}`,
          ).toEqual([]);
          expect(
            headers.filter((name) => name === "x-forwarded-for"),
            `no inbound X-Forwarded-For reached the app on the ${routing}`,
          ).toEqual([]);
        }
      }),
    ),
  );

  it.live("namespaces HttpOnly app cookies per preview on the tailnet, both ways", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world } = yield* relayWorld("tailnet");
        const web = PREVIEWS.web.label;
        const docs = PREVIEWS.docs.label;
        const grant = world.cookieFor("carol", "web");

        const setReply = yield* getAs(world, grant, "/set-cookies");
        expect(setReply.status, "the app answered").toBe(200);
        expect(
          (setReply.headers["set-cookie"] ?? []).map(cookieNameOf),
          "the HttpOnly cookie travels in the web preview's namespace, the others as the app named them",
        ).toEqual(["plain", "scoped", "dated", `p-${web}.secret`]);

        const echoedReply = yield* getAs(
          world,
          `p-${web}.secret=4; p-${docs}.secret=9; plain=1; ${grant}`,
          "/echo-headers",
        );
        expect(echoedReply.status, "the app answered").toBe(200);
        expect(
          decodeEchoed(echoedReply.body).headers["cookie"],
          "the app reads its own cookie under its own name, never the docs preview's or the grant",
        ).toBe("secret=4; plain=1");
      }),
    ),
  );

  it.live("refuses requests and upgrades from another preview's origin before any dial", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { forwards, world } = yield* relayWorld();
        const grant = world.cookieFor("carol", "web");
        const posted = yield* Effect.promise(() =>
          send(world.port, {
            host: world.hostOf("web"),
            method: "POST",
            path: "/act",
            headers: { cookie: grant, origin: world.originOf("docs") },
            body: "x",
          }),
        );
        expect(posted.status, "a POST from the docs preview's page is refused").toBe(403);
        const client = yield* rawClient(world);
        client.write(
          upgradeRequest({
            host: world.hostOf("web"),
            cookie: grant,
            origin: world.originOf("docs"),
            key: randomBytes(16).toString("base64"),
          }),
        );
        const refused = yield* Effect.promise(() =>
          waitFor("the upgrade's answer", 3_000, () => readHead(client.received())),
        );
        expect(refused.status, "an upgrade from the docs preview's page is refused").toBe(403);
        expect(forwards.dials, "nothing was dialled").toEqual([]);
        expect(forwards.opens, "no forward was opened").toEqual([]);

        const own = yield* Effect.promise(() =>
          send(world.port, {
            host: world.hostOf("web"),
            method: "POST",
            path: "/act",
            headers: { cookie: grant, origin: world.originOf("web") },
            body: "x",
          }),
        );
        expect(own.status, "the same POST from the web preview's own page is delivered").toBe(200);
        expect(forwards.dials.length, "the delivered POST was dialled").toBe(1);
      }),
    ),
  );

  it.live(
    "ends a viewer's pool and open stream once lending is refused",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { world } = yield* relayWorld();
          const cookie = world.cookieFor("carol", "web");
          const stream = yield* eventStream(world, cookie, "/events?every=1000&count=60");
          yield* Effect.promise(() =>
            waitFor("a first event", 3_000, () => (stream.events().length > 0 ? true : null)),
          );
          expect(stream.ended(), "the stream is open before lending is refused").toBe(false);
          world.lending.refused.add("carol");
          const reply = yield* getAs(world, cookie, "/");
          expect(reply.status, "carol's next request is refused").toBe(404);
          expect(reply.body, "the refusal says no such preview").toBe("No such preview.");
          expect(
            yield* Effect.promise(() => happensWithin(2_000, stream.ended)),
            "carol's open stream ends",
          ).toBe(true);
          expect(stream.events().length, "the stream ended early, not by finishing").toBeLessThan(
            60,
          );
          expect(
            [...new Set(world.lending.askers)],
            "every lending check ran as carol, never as the workspace's creator",
          ).toEqual(["carol"]);
        }),
      ),
    10_000,
  );

  it.live("never tries the Docker route for the session-bound dial loopback refused", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const forwards = localForwards([
          {
            workspaceId: WORKSPACE,
            port: APP_PORT,
            entry: { kind: "refused", reason: "connection-refused" },
          },
        ]);
        const world = yield* gatewayWorld({ forwards: forwards.layer });
        const reply = yield* getAs(world, world.cookieFor("carol", "web"), "/");
        expect(reply.status, "nothing listened on the process's own loopback").toBe(502);
        expect(reply.body, "and the page says so").toContain("nothing listens");
        expect(
          forwards.opens.map((open) => open.destination.route),
          "the dial stopped at loopback: the sidecar cannot prove the session",
        ).toEqual(["loopback"]);
        expect(
          forwards.opens.map((open) => open.destination.binding),
          "and asked for the attempt's session",
        ).toEqual([{ kind: "session", session: PLATFORM_SESSION }]);
      }),
    ),
  );

  it.live(
    "dials a docker-hosted Service by port, on to the Docker route after loopback refuses",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const forwards = localForwards([
            {
              workspaceId: WORKSPACE,
              port: APP_PORT,
              entry: { kind: "refused", reason: "connection-refused" },
            },
          ]);
          const world = yield* gatewayWorld({ forwards: forwards.layer });
          world.targets.resolutions.set(PREVIEWS.web.id, bound({ dial: "port-scoped" }));
          yield* getAs(world, world.cookieFor("carol", "web"), "/");
          expect(
            forwards.opens.map((open) => open.destination),
            "a port-scoped dial, never one claiming the process",
          ).toEqual([
            { route: "loopback", binding: { kind: "port" } },
            { route: "docker", binding: { kind: "port" } },
          ]);
        }),
      ),
  );

  it.live(
    "retries a bodiless GET once on a fresh forward when a reused one closes before answering",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* closesReusedConnections;
          const forwards = localForwards([
            {
              workspaceId: WORKSPACE,
              port: APP_PORT,
              entry: { kind: "listen", localPort: app.port },
            },
          ]);
          const world = yield* gatewayWorld({ forwards: forwards.layer });
          const cookie = world.cookieFor("carol", "web");
          expect((yield* getAs(world, cookie, "/first")).status, "the first request").toBe(200);
          const second = yield* getAs(world, cookie, "/second");
          expect(second.status, "the GET the app dropped arrived on a fresh forward").toBe(200);
          expect(second.body, "and the app answered it").toBe("GET /second");
          expect(forwards.dials.length, "one dial more than the pooled one").toBe(2);
          expect(app.dropped, "the app dropped the GET on the reused connection").toEqual([
            "GET /second",
          ]);
        }),
      ),
  );

  it.live("never retries a request that carried a body; it answers 502", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const app = yield* closesReusedConnections;
        const forwards = localForwards([
          {
            workspaceId: WORKSPACE,
            port: APP_PORT,
            entry: { kind: "listen", localPort: app.port },
          },
        ]);
        const world = yield* gatewayWorld({ forwards: forwards.layer });
        const cookie = world.cookieFor("carol", "web");
        expect((yield* getAs(world, cookie, "/first")).status, "the first request").toBe(200);
        const posted = yield* Effect.promise(() =>
          send(world.port, {
            host: world.hostOf("web"),
            path: "/form",
            method: "POST",
            headers: { cookie, origin: world.originOf("web") },
            body: "field=1",
          }),
        );
        expect(posted.status, "a dropped POST is not sent twice").toBe(502);
        expect(posted.body, "and the page says the app did not answer").toContain(
          "the app did not answer",
        );
        expect(forwards.dials.length, "no second dial").toBe(1);
        expect(app.dropped, "the app saw the POST once").toEqual(["POST /form"]);
      }),
    ),
  );

  it.live(
    "rechecks lending on a user event and closes only that viewer's upgraded socket",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { world } = yield* relayWorld();
          const carol = yield* openEchoSocket(world, world.cookieFor("carol", "web"), "carol's");
          const dave = yield* openEchoSocket(world, world.cookieFor("dave", "web"), "dave's");
          world.lending.refused.add("carol");
          world.lending.refused.add("dave");
          yield* world.publish({
            kind: "event",
            event: { type: "user", userId: "carol", facet: "access" },
            payload: "{}",
          });
          expect(
            yield* Effect.promise(() => happensWithin(2_000, carol.closed)),
            "carol's socket closes on her user event, well before the 50 s sweep",
          ).toBe(true);
          expect(dave.closed(), "dave's user event has not come, so his socket stays").toBe(false);
        }),
      ),
    10_000,
  );

  it.live(
    "rechecks every viewer's lending on an organization event",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { world } = yield* relayWorld();
          const carol = yield* openEchoSocket(world, world.cookieFor("carol", "web"), "carol's");
          const dave = yield* openEchoSocket(world, world.cookieFor("dave", "web"), "dave's");
          world.lending.refused.add("dave");
          yield* world.publish({
            kind: "event",
            event: { type: "organization", organizationId: "org-a" },
            payload: "{}",
          });
          expect(
            yield* Effect.promise(() => happensWithin(2_000, dave.closed)),
            "dave, no longer lent to, loses his socket",
          ).toBe(true);
          expect(carol.closed(), "carol, still lent to, keeps hers").toBe(false);
        }),
      ),
    10_000,
  );

  it.live(
    "closes an upgraded socket when the preview's attempt changes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { world } = yield* relayWorld();
          const client = yield* openEchoSocket(
            world,
            world.cookieFor("carol", "web"),
            "before the restart",
          );
          yield* Effect.sleep("1500 millis");
          expect(
            client.closed(),
            "the socket outlives a refresh while the attempt is unchanged",
          ).toBe(false);
          world.targets.resolutions.set(
            PREVIEWS.web.id,
            bound({ attemptId: SessionProcessId.make("attempt-2") }),
          );
          yield* world.publish({
            kind: "event",
            event: { type: "worktree", worktreeId: "wt-1", projectId: "p-shared" },
            payload: "{}",
          });
          expect(
            yield* Effect.promise(() => happensWithin(2_000, client.closed)),
            "the socket of the old attempt closes",
          ).toBe(true);
        }),
      ),
    10_000,
  );
});
