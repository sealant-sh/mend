import * as http from "node:http";
import * as net from "node:net";

import { SessionProcessId } from "@mend/domain";
import { describe, expect, it, TestClock } from "@mend/test-ci/effect-vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";

import { type DigestAnswer, serveFixture } from "../test/fixtures/preview/apps.ts";
import { patternChunks, uploadGenerated } from "../test/support/preview-bytes.ts";
import { localForwards } from "../test/support/preview-forward.ts";
import {
  APP_PORT,
  bound,
  dormant,
  type GatewayWorldOptions,
  gatewayWorld,
  opening,
  PREVIEWS,
  rawExchange,
  send,
  watchGatewayRequests,
  WORKSPACE,
} from "../test/support/preview-gateway-world.ts";
import { PREVIEW_GATEWAY_DEFAULTS } from "./preview-gateway-settings.ts";
import { PreviewStartFailed } from "./preview-targets.ts";

const appRunning = Effect.acquireRelease(
  Effect.promise(() => serveFixture("all")),
  (app) => Effect.promise(app.stop),
);

const worldWithApp = (options: Omit<GatewayWorldOptions, "forwards"> = {}) =>
  Effect.gen(function* () {
    const app = yield* appRunning;
    const forwards = localForwards([
      { workspaceId: WORKSPACE, port: APP_PORT, entry: { kind: "listen", localPort: app.port } },
    ]);
    const world = yield* gatewayWorld({ ...options, forwards: forwards.layer });
    return { world, forwards };
  });

const gatedStarts = (world: Effect.Success<ReturnType<typeof gatewayWorld>>) =>
  Effect.gen(function* () {
    const asked = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    world.targets.ensureRunning = (request) =>
      Deferred.succeed(asked, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(
          Effect.sync(() => {
            world.targets.resolutions.set(PREVIEWS.web.id, bound());
            return request.sourceAttemptId;
          }),
        ),
      );
    return { asked, release: Deferred.succeed(release, undefined) };
  });

const realDelay = (ms: number) => Effect.promise(() => new Promise((done) => setTimeout(done, ms)));

const until = (what: string, holds: () => boolean, ms = 3_000) =>
  Effect.gen(function* () {
    for (let waited = 0; !holds(); waited += 10) {
      if (waited > ms) return yield* Effect.die(`${what} within ${ms} ms`);
      yield* realDelay(10);
    }
  });

const fetchAt = (port: number, host: string, cookie: string, path = "/") =>
  Effect.promise(() => send(port, { host, path, headers: { cookie } }));

const statusOf = (raw: string) => raw.split("\r\n")[0] ?? "";

describe("the preview gateway's listener", () => {
  it.live("answers CONNECT 405 on the socket and closes it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world } = yield* worldWithApp();
        const raw = yield* Effect.promise(() =>
          rawExchange(
            world.port,
            "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
          ),
        );
        expect(statusOf(raw), "CONNECT is refused by status").toBe(
          "HTTP/1.1 405 Method Not Allowed",
        );
        expect(raw, "the answer closes the connection").toMatch(/\r\nconnection: close\r\n/i);
      }),
    ),
  );

  it.live("refuses a request with two Host fields before any binding read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world, forwards } = yield* worldWithApp();
        const host = world.hostOf("web");
        const cookie = world.cookieFor("carol", "web");
        const raw = yield* Effect.promise(() =>
          rawExchange(
            world.port,
            `GET / HTTP/1.1\r\nHost: ${host}\r\nHost: ${host}\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`,
          ),
        );
        expect(statusOf(raw), "a doubled Host is refused").toBe("HTTP/1.1 400 Bad Request");
        expect(world.targets.snapshotReads, "nothing read the preview's binding").toBe(0);
        expect(forwards.dials, "nothing dialled the app").toEqual([]);
      }),
    ),
  );

  it.live("answers a malformed request 400 and closes the socket", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world } = yield* worldWithApp();
        const raw = yield* Effect.promise(() => rawExchange(world.port, "NOT HTTP AT ALL\r\n\r\n"));
        expect(statusOf(raw), "the parser's refusal").toBe("HTTP/1.1 400 Bad Request");
      }),
    ),
  );

  it.live("refuses a request pipelined behind an outstanding one, and serves the first", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world } = yield* worldWithApp();
        world.targets.resolutions.set(PREVIEWS.web.id, dormant());
        const start = yield* gatedStarts(world);
        const host = world.hostOf("web");
        const cookie = world.cookieFor("carol", "web");
        const request = (path: string) =>
          `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nCookie: ${cookie}\r\n\r\n`;
        const exchange = yield* Effect.forkChild(
          Effect.promise(() =>
            rawExchange(world.port, request("/first") + request("/second"), 5_000),
          ),
        );
        yield* Deferred.await(start.asked);
        yield* start.release;
        const raw = yield* Fiber.join(exchange);
        const statuses = raw.match(/HTTP\/1\.1 \d{3}/g);
        expect(statuses, "the first is served, the pipelined one refused after it").toEqual([
          "HTTP/1.1 200",
          "HTTP/1.1 400",
        ]);
        expect(raw, "the app saw the first request only").toContain('"path":"/first"');
        expect(raw, "the app never saw the second").not.toContain('"path":"/second"');
      }),
    ),
  );
});

describe("refusals before anything starts", () => {
  it.live("answers an unassigned tailnet port 404", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world, forwards } = yield* worldWithApp({ routing: "tailnet" });
        const reply = yield* Effect.promise(() =>
          send(world.port, { host: "mend-preview.tail.ts.net:20999", path: "/" }),
        );
        expect(reply.status, "no preview has that port").toBe(404);
        expect(forwards.dials, "nothing dialled the app").toEqual([]);
      }),
    ),
  );

  it.live("refuses a service worker script 403 without reading its binding", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world, forwards } = yield* worldWithApp();
        const reply = yield* Effect.promise(() =>
          send(world.port, {
            host: world.hostOf("web"),
            path: "/sw.js",
            headers: { cookie: world.cookieFor("carol", "web"), "service-worker": "script" },
          }),
        );
        expect(reply.status, "a service worker script is refused").toBe(403);
        expect(world.targets.snapshotReads, "nothing read the binding").toBe(0);
        expect(forwards.dials, "nothing dialled the app").toEqual([]);
      }),
    ),
  );

  it.live("states the https refusal and starts nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world, forwards } = yield* worldWithApp();
        world.targets.resolutions.set(PREVIEWS.web.id, {
          _tag: "Refused",
          reason: "https-unsupported",
        });
        const reply = yield* fetchAt(
          world.port,
          world.hostOf("web"),
          world.cookieFor("carol", "web"),
        );
        expect(reply.status, "the gateway does not implement TLS to the dev server").toBe(501);
        expect(reply.body, "the page says why, in the status-line voice").toContain(
          "preview · web · it speaks https, which previews do not relay yet · your request was not delivered",
        );
        expect(world.targets.starts, "no start was asked for").toEqual([]);
        expect(forwards.dials, "nothing dialled the app").toEqual([]);
      }),
    ),
  );

  it.live("names the person whose Stop won the race against a request's start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world } = yield* worldWithApp();
        world.targets.resolutions.set(PREVIEWS.web.id, dormant());
        world.targets.ensureRunning = () =>
          Effect.suspend(() => {
            world.targets.resolutions.set(PREVIEWS.web.id, {
              _tag: "Stopped",
              control: {
                _tag: "Stopped",
                revision: 1,
                seq: 1,
                by: "maria",
                at: new Date(0),
                byName: "Maria",
              },
            });
            return Effect.fail(new PreviewStartFailed({ reason: "stopped" }));
          });
        const reply = yield* fetchAt(
          world.port,
          world.hostOf("web"),
          world.cookieFor("carol", "web"),
        );
        expect(reply.status, "the request was held, then not delivered").toBe(503);
        expect(reply.body, "and the page says who stopped the preview").toContain(
          "preview · web · Maria stopped the preview · your request was not delivered",
        );
      }),
    ),
  );

  it.live("answers a preview a person stopped with a page naming them, and never starts it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world, forwards } = yield* worldWithApp();
        world.targets.resolutions.set(PREVIEWS.web.id, {
          _tag: "Stopped",
          control: {
            _tag: "Stopped",
            revision: 3,
            by: "maria",
            at: new Date(0),
            seq: 1,
            byName: "Maria",
          },
        });
        const reply = yield* Effect.promise(() =>
          send(world.port, {
            host: world.hostOf("web"),
            path: "/form",
            method: "POST",
            headers: { cookie: world.cookieFor("carol", "web"), origin: world.originOf("web") },
            body: "field=1",
          }),
        );
        expect(reply.status, "the Stop stands").toBe(503);
        expect(reply.body, "the page says who stopped it").toContain(
          "preview · web · Maria stopped the preview · your request was not delivered",
        );
        expect(reply.body, "and links to its project in Mend, where Start is").toMatch(
          /<a href="https:\/\/mend\.test\/projects\/[^"]+">Open in Mend<\/a>/,
        );
        expect(reply.headers["cache-control"], "the page is never cached").toBe(
          "no-store, private",
        );
        expect(world.targets.starts, "ensureRunning was never called").toEqual([]);
        expect(forwards.dials, "nothing dialled the app").toEqual([]);
      }),
    ),
  );

  it.live(
    "refuses past the per-preview ceiling with the budget's words, starting nothing more",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { world } = yield* worldWithApp({
            settings: {
              limits: {
                ...PREVIEW_GATEWAY_DEFAULTS.limits,
                perPreview: 1,
                gateway: 256,
                forwards: 128,
              },
            },
          });
          world.targets.resolutions.set(PREVIEWS.web.id, dormant());
          const start = yield* gatedStarts(world);
          const cookie = world.cookieFor("carol", "web");
          const held = yield* Effect.forkChild(
            fetchAt(world.port, world.hostOf("web"), cookie, "/held"),
          );
          yield* Deferred.await(start.asked);
          const refused = yield* fetchAt(world.port, world.hostOf("web"), cookie, "/over");
          expect(refused.status, "a second open request on the preview is refused").toBe(429);
          expect(refused.body, "the refusal says which ceiling").toContain(
            "budget reached · 1 open requests for one preview · nothing running was stopped",
          );
          yield* start.release;
          expect((yield* Fiber.join(held)).status, "the held one is still delivered").toBe(200);
          expect(world.targets.starts.length, "one start for the held request only").toBe(1);
        }),
      ),
  );
});

describe("a request to a stopped preview starts it and is held", () => {
  it.live("answers the DidNotStart page when the start outlasts the hold", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world, forwards } = yield* worldWithApp({ settings: { startHoldMs: 1_000 } });
        world.targets.resolutions.set(PREVIEWS.web.id, dormant(2));
        world.targets.ensureRunning = () => Effect.never;
        const reply = yield* fetchAt(
          world.port,
          world.hostOf("web"),
          world.cookieFor("carol", "web"),
        );
        expect(reply.status, "the held request is answered when the hold ends").toBe(503);
        expect(reply.body, "the page says the start timed out and nothing was delivered").toContain(
          "preview · web · did not start in 1 s · start timed out · your request was not delivered",
        );
        expect(world.targets.starts, "one start, from the dormant preview's source").toMatchObject([
          { previewId: PREVIEWS.web.id, revision: 2, sourceAttemptId: "attempt-0" },
        ]);
        expect(forwards.dials, "nothing dialled the app").toEqual([]);
      }),
    ),
  );

  it.effect("holds every waiter to the first waiter's deadline on the gateway's clock", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world } = yield* worldWithApp();
        world.targets.resolutions.set(PREVIEWS.web.id, dormant());
        const asked = yield* Deferred.make<void>();
        world.targets.ensureRunning = () =>
          Deferred.succeed(asked, undefined).pipe(Effect.andThen(Effect.never));
        const first = yield* Effect.forkChild(
          fetchAt(world.port, world.hostOf("web"), world.cookieFor("carol", "web"), "/first"),
        );
        yield* Deferred.await(asked);
        yield* TestClock.adjust("60 seconds");
        const second = yield* Effect.forkChild(
          fetchAt(world.port, world.hostOf("web"), world.cookieFor("dave", "web"), "/second"),
        );
        yield* until("the second waiter read the binding", () => world.targets.snapshotReads === 2);
        yield* realDelay(50);
        yield* TestClock.adjust("119 seconds");
        yield* realDelay(100);
        expect(first.pollUnsafe(), "the first waiter is still held at 179 s").toBeUndefined();
        expect(second.pollUnsafe(), "the second waiter is still held").toBeUndefined();
        yield* TestClock.adjust("1 second");
        const answers = yield* Effect.forEach([first, second], Fiber.join);
        expect(
          answers.map((reply) => [
            reply.status,
            reply.body.includes("did not start in 3 min · start timed out"),
          ]),
          "both are answered at the first waiter's deadline, 3 min after it arrived",
        ).toEqual([
          [503, true],
          [503, true],
        ]);
        expect(world.targets.starts, "one start, its deadline the first waiter's").toMatchObject([
          { deadline: 180_000 },
        ]);
      }),
    ),
  );

  it.live("100 concurrent requests share one start, and every one is delivered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world } = yield* worldWithApp({
          settings: {
            limits: {
              ...PREVIEW_GATEWAY_DEFAULTS.limits,
              perPreview: 128,
              gateway: 256,
              forwards: 128,
            },
          },
          budgets: { accountPreviewConnections: 128 },
        });
        world.targets.resolutions.set(PREVIEWS.web.id, dormant());
        world.targets.ensureRunning = (request) =>
          Effect.promise(() => new Promise((done) => setTimeout(done, 300))).pipe(
            Effect.andThen(
              Effect.sync(() => {
                world.targets.resolutions.set(PREVIEWS.web.id, bound());
                return SessionProcessId.make(`${request.sourceAttemptId}-again`);
              }),
            ),
          );
        const cookie = world.cookieFor("carol", "web");
        const replies = yield* Effect.forEach(
          Array.from({ length: 100 }, (_, index) => index),
          (index) => fetchAt(world.port, world.hostOf("web"), cookie, `/r/${index}`),
          { concurrency: "unbounded" },
        );
        expect(world.targets.starts.length, "one start for all 100").toBe(1);
        expect(
          replies.filter((reply) => reply.status === 200).length,
          "every held request reached the app once it was up",
        ).toBe(100);
        const paths = replies.map((reply): string => {
          const answered: DigestAnswer = JSON.parse(reply.body);
          return answered.path;
        });
        expect(new Set(paths).size, "each request arrived as itself").toBe(100);
      }),
    ),
  );

  it.live("a request while the start's process is still opening joins that start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world } = yield* worldWithApp();
        world.targets.resolutions.set(PREVIEWS.web.id, dormant());
        const start = yield* gatedStarts(world);
        const host = world.hostOf("web");
        const first = yield* Effect.forkChild(
          fetchAt(world.port, host, world.cookieFor("carol", "web"), "/first"),
        );
        yield* Deferred.await(start.asked);
        world.targets.resolutions.set(PREVIEWS.web.id, opening("attempt-1"));
        const second = yield* Effect.forkChild(
          fetchAt(world.port, host, world.cookieFor("dave", "web"), "/second"),
        );
        yield* until(
          "the second request read the binding",
          () => world.targets.snapshotReads === 2,
        );
        yield* realDelay(100);
        expect(second.pollUnsafe(), "the second request is held").toBeUndefined();
        yield* start.release;
        const replies = yield* Effect.forEach([first, second], Fiber.join);
        expect(
          replies.map((reply) => reply.status),
          "both are delivered once the start ends",
        ).toEqual([200, 200]);
        expect(replies[1]?.body, "the second reached the app as itself").toContain(
          '"path":"/second"',
        );
        expect(world.targets.starts.length, "one start for both").toBe(1);
      }),
    ),
  );

  it.live("a first waiter leaving does not end the start the others wait on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world } = yield* worldWithApp();
        world.targets.resolutions.set(PREVIEWS.web.id, dormant());
        const start = yield* gatedStarts(world);
        const host = world.hostOf("web");
        const leaver = net.connect({ host: "127.0.0.1", port: world.port });
        leaver.on("error", () => undefined);
        leaver.write(
          `GET /leaves HTTP/1.1\r\nHost: ${host}\r\nCookie: ${world.cookieFor("carol", "web")}\r\n\r\n`,
        );
        yield* Deferred.await(start.asked);
        leaver.destroy();
        yield* realDelay(100);
        const stays = yield* Effect.forkChild(
          fetchAt(world.port, host, world.cookieFor("dave", "web"), "/stays"),
        );
        yield* until("the second waiter read the binding", () => world.targets.snapshotReads === 2);
        yield* start.release;
        const reply = yield* Fiber.join(stays);
        expect(reply.status, "the remaining waiter is delivered").toBe(200);
        expect(reply.body, "to the app").toContain('"path":"/stays"');
        expect(
          world.targets.starts.length,
          "the start ran once, through the first waiter leaving",
        ).toBe(1);
      }),
    ),
  );

  it.live("delivers a held upload whole, having read only a bounded prefix while holding", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world } = yield* worldWithApp();
        world.targets.resolutions.set(PREVIEWS.web.id, dormant());
        const start = yield* gatedStarts(world);
        const watch = watchGatewayRequests(world.port);
        yield* Effect.addFinalizer(() => Effect.sync(watch.stop));
        const bytes = 64 * 1024 * 1024;
        const upload = yield* Effect.forkChild(
          Effect.promise(() =>
            uploadGenerated(`http://127.0.0.1:${world.port}/upload`, {
              bytes,
              headers: {
                host: world.hostOf("web"),
                cookie: world.cookieFor("carol", "web"),
                origin: world.originOf("web"),
              },
            }),
          ),
        );
        yield* Deferred.await(start.asked);
        yield* realDelay(1_000);
        const held = watch.seen.find((request) => request.path === "/upload");
        expect(held, "the gateway parsed the upload's head").toBeDefined();
        const readWhileHeld = held?.socket.bytesRead ?? Number.POSITIVE_INFINITY;
        expect(
          readWhileHeld,
          "while held the gateway read a bounded prefix, not the body",
        ).toBeLessThan(1024 * 1024);
        yield* start.release;
        const result = yield* Fiber.join(upload);
        const answered: DigestAnswer = JSON.parse(result.body);
        expect(result.status, "the upload was delivered").toBe(200);
        expect(answered.bytes, "every byte arrived").toBe(bytes);
        expect(answered.sha256, "the bytes arrived as sent").toBe(result.sentSha256);
      }),
    ),
  );

  it.live("sends 100 Continue only once the request is delivered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world } = yield* worldWithApp();
        world.targets.resolutions.set(PREVIEWS.web.id, dormant());
        const start = yield* gatedStarts(world);
        let releasedAt = 0;
        const reply = yield* Effect.forkChild(
          Effect.promise(
            () =>
              new Promise<{ readonly continuedAt: number; readonly answer: DigestAnswer }>(
                (resolve, reject) => {
                  const body = Buffer.concat([...patternChunks(256 * 1024)]);
                  let continuedAt = 0;
                  const outgoing = http.request({
                    host: "127.0.0.1",
                    port: world.port,
                    method: "PUT",
                    path: "/expect",
                    agent: false,
                    headers: {
                      host: world.hostOf("web"),
                      cookie: world.cookieFor("carol", "web"),
                      origin: world.originOf("web"),
                      expect: "100-continue",
                      "content-length": String(body.length),
                    },
                  });
                  outgoing.on("error", reject);
                  outgoing.once("continue", () => {
                    continuedAt = Date.now();
                    outgoing.end(body);
                  });
                  outgoing.on("response", (response) => {
                    const parts: Array<Buffer> = [];
                    response.on("data", (chunk: Buffer) => parts.push(chunk));
                    response.on("end", () =>
                      resolve({
                        continuedAt,
                        answer: JSON.parse(Buffer.concat(parts).toString("utf8")),
                      }),
                    );
                  });
                  outgoing.flushHeaders();
                },
              ),
          ),
        );
        yield* Deferred.await(start.asked);
        yield* realDelay(500);
        releasedAt = Date.now();
        yield* start.release;
        const { continuedAt, answer } = yield* Fiber.join(reply);
        expect(continuedAt, "Continue came after the preview was up").toBeGreaterThanOrEqual(
          releasedAt,
        );
        expect(answer.bytes, "the body followed Continue, whole").toBe(256 * 1024);
        expect(answer.headers["expect"], "the app never saw the expectation").toBeUndefined();
      }),
    ),
  );

  it.live(
    "answers 503 to a client still uploading, having read a bounded number of its bytes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { world } = yield* worldWithApp();
          world.targets.resolutions.set(PREVIEWS.web.id, dormant());
          world.targets.ensureRunning = () =>
            Effect.promise(() => new Promise((done) => setTimeout(done, 500))).pipe(
              Effect.andThen(Effect.fail(new PreviewStartFailed({ reason: "command-failed" }))),
            );
          const watch = watchGatewayRequests(world.port);
          yield* Effect.addFinalizer(() => Effect.sync(watch.stop));
          const total = 256 * 1024 * 1024;
          const head = `POST /big HTTP/1.1\r\nHost: ${world.hostOf("web")}\r\nCookie: ${world.cookieFor("carol", "web")}\r\nOrigin: ${world.originOf("web")}\r\nContent-Length: ${total}\r\n\r\n`;
          const outcome = yield* Effect.promise(
            () =>
              new Promise<{
                readonly answer: string;
                readonly readWhenAnswered: number;
                readonly sentWhenAnswered: number;
              }>((resolve) => {
                const socket = net.connect({ host: "127.0.0.1", port: world.port });
                let sent = 0;
                let answer = "";
                let readWhenAnswered = -1;
                let sentWhenAnswered = -1;
                const parts: Array<Buffer> = [];
                socket.on("data", (chunk: Buffer) => {
                  parts.push(chunk);
                  answer = Buffer.concat(parts).toString("utf8");
                  if (readWhenAnswered >= 0) return;
                  readWhenAnswered = watch.seen[0]?.socket.bytesRead ?? -1;
                  sentWhenAnswered = sent;
                });
                socket.on("error", () => undefined);
                socket.on("close", () => resolve({ answer, readWhenAnswered, sentWhenAnswered }));
                socket.write(head);
                const pump = () => {
                  for (const chunk of patternChunks(total - sent)) {
                    if (sentWhenAnswered >= 0) return;
                    sent += chunk.length;
                    if (!socket.write(chunk)) return void socket.once("drain", pump);
                  }
                };
                pump();
              }),
          );
          expect(statusOf(outcome.answer), "the client got the 503, not a reset").toBe(
            "HTTP/1.1 503 Service Unavailable",
          );
          expect(outcome.answer, "the answer closes the connection").toMatch(
            /\r\nconnection: close\r\n/i,
          );
          expect(outcome.answer, "the page says the command failed").toContain(
            "did not start · command failed · your request was not delivered",
          );
          expect(
            outcome.sentWhenAnswered,
            "the client was still uploading when answered",
          ).toBeLessThan(total);
          expect(
            outcome.readWhenAnswered,
            "the gateway read a bounded number of bytes",
          ).toBeGreaterThan(0);
          expect(outcome.readWhenAnswered, "and not the body").toBeLessThan(1024 * 1024);
        }),
      ),
  );
});

describe("a held request ends when its viewer's access does", () => {
  it.live("answers 401 when the viewer's sign-in ends during the hold, and the start goes on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world } = yield* worldWithApp();
        world.targets.resolutions.set(PREVIEWS.web.id, dormant());
        const start = yield* gatedStarts(world);
        const held = yield* Effect.forkChild(
          fetchAt(world.port, world.hostOf("web"), world.cookieFor("carol", "web")),
        );
        yield* Deferred.await(start.asked);
        world.revokeGrants("carol");
        yield* world.publish({
          kind: "event",
          event: { type: "user", userId: "carol", facet: "access" },
          payload: "{}",
        });
        const reply = yield* Fiber.join(held);
        expect(reply.status, "access that ended during the hold is a sign-in refusal").toBe(401);
        expect(reply.body, "in the gateway's words").toContain(
          "<p>Not signed in to this preview.</p>",
        );
        yield* start.release;
        const after = yield* fetchAt(
          world.port,
          world.hostOf("web"),
          world.cookieFor("dave", "web"),
        );
        expect(after.status, "the start carried on without its first waiter").toBe(200);
        expect(world.targets.starts.length, "and ran once").toBe(1);
      }),
    ),
  );

  it.live("counts a held request against its account, and member removal closes it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world } = yield* worldWithApp();
        world.targets.resolutions.set(PREVIEWS.web.id, dormant());
        const start = yield* gatedStarts(world);
        const held = yield* Effect.forkChild(
          Effect.exit(fetchAt(world.port, world.hostOf("web"), world.cookieFor("carol", "web"))),
        );
        yield* Deferred.await(start.asked);
        expect(
          yield* world.connections.countFor("carol", "preview"),
          "the held request is an open preview connection of carol's",
        ).toBe(1);
        expect(yield* world.connections.closeForUser("carol"), "removal closed one").toBe(1);
        const outcome = yield* Fiber.join(held);
        expect(Exit.isFailure(outcome), "the held request was closed, not answered").toBe(true);
        let open = 1;
        for (let tries = 0; open > 0 && tries < 100; tries += 1) {
          yield* realDelay(10);
          open = yield* world.connections.countFor("carol", "preview");
        }
        expect(open, "nothing of carol's stays registered").toBe(0);
      }),
    ),
  );

  it.live("refuses an account's request past its open preview connections, 429", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world, forwards } = yield* worldWithApp({
          budgets: { accountPreviewConnections: 1 },
        });
        world.targets.resolutions.set(PREVIEWS.web.id, dormant());
        const start = yield* gatedStarts(world);
        const held = yield* Effect.forkChild(
          fetchAt(world.port, world.hostOf("web"), world.cookieFor("carol", "web"), "/held"),
        );
        yield* Deferred.await(start.asked);
        const refused = yield* fetchAt(
          world.port,
          world.hostOf("docs"),
          world.cookieFor("carol", "docs"),
          "/over",
        );
        expect(refused.status, "carol's second open request is refused as a budget").toBe(429);
        expect(refused.body, "with the budget's words").toContain(
          "budget reached · 1 open preview requests for one account · nothing running was stopped",
        );
        const other = yield* Effect.forkChild(
          fetchAt(world.port, world.hostOf("web"), world.cookieFor("dave", "web"), "/dave"),
        );
        yield* start.release;
        expect((yield* Fiber.join(held)).status, "carol's held request is still delivered").toBe(
          200,
        );
        expect((yield* Fiber.join(other)).status, "another account is not counted").toBe(200);
        expect(forwards.dials.length, "only the two delivered requests were dialled").toBe(2);
      }),
    ),
  );

  it.live("refuses a second start for an account at its in-flight start budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world } = yield* worldWithApp({ budgets: { accountPreviewStartsInFlight: 1 } });
        world.targets.resolutions.set(PREVIEWS.web.id, dormant());
        world.targets.resolutions.set(PREVIEWS.docs.id, dormant());
        const asked = yield* Deferred.make<void>();
        world.targets.ensureRunning = () =>
          Deferred.succeed(asked, undefined).pipe(Effect.andThen(Effect.never));
        const held = yield* Effect.forkChild(
          fetchAt(world.port, world.hostOf("web"), world.cookieFor("carol", "web")),
        );
        yield* Deferred.await(asked);
        const refused = yield* fetchAt(
          world.port,
          world.hostOf("docs"),
          world.cookieFor("carol", "docs"),
        );
        expect(refused.status, "a second preview start for carol is refused as a budget").toBe(429);
        expect(refused.body, "with the budget's words").toContain(
          "budget reached · 1 preview starts at once for one account · nothing running was stopped",
        );
        expect(world.targets.launches.length, "the refused start launched nothing").toBe(1);
        yield* Fiber.interrupt(held);
      }),
    ),
  );
});

describe("an account's preview start window", () => {
  it.effect(
    "refuses a start past the account's window 429 with a Retry-After, and admits one a minute later",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { world } = yield* worldWithApp({ budgets: { accountPreviewStartsPerMinute: 2 } });
          world.targets.ensureRunning = () =>
            Effect.succeed(SessionProcessId.make("attempt-0")).pipe(
              Effect.tap(() =>
                Effect.sync(() => world.targets.resolutions.set(PREVIEWS.web.id, dormant())),
              ),
            );
          const startOnce = Effect.gen(function* () {
            world.targets.resolutions.set(PREVIEWS.web.id, dormant());
            return yield* fetchAt(world.port, world.hostOf("web"), world.cookieFor("carol", "web"));
          });
          for (const turn of [1, 2]) {
            const reply = yield* startOnce;
            expect(reply.status, `start ${turn} ran and did not bind`).toBe(503);
          }
          expect(world.targets.launches.length, "two starts launched").toBe(2);
          const refused = yield* startOnce;
          expect(refused.status, "the third start in a minute is refused as a budget").toBe(429);
          expect(refused.body, "with the window's words").toContain(
            "budget reached · 2 preview starts per minute for one account · nothing running was stopped",
          );
          expect(refused.headers["retry-after"], "and when to try again").toBe("60");
          expect(world.targets.launches.length, "the refused start launched nothing").toBe(2);
          const dave = yield* fetchAt(
            world.port,
            world.hostOf("web"),
            world.cookieFor("dave", "web"),
          );
          expect(dave.status, "another account has its own window").toBe(503);
          expect(world.targets.launches.length, "and its start ran").toBe(3);
          yield* TestClock.adjust("61 seconds");
          expect((yield* startOnce).status, "a minute later carol may start again").toBe(503);
          expect(world.targets.launches.length, "and her start ran").toBe(4);
        }),
      ),
  );
});

describe("the gateway's own ceilings", () => {
  const capped = { bodyCap: { _tag: "Capped", bytes: 64 * 1024 } } as const;

  it.live("refuses a declared body over the cap 413, unread and undelivered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world, forwards } = yield* worldWithApp({ settings: capped });
        const result = yield* Effect.promise(() =>
          uploadGenerated(`http://127.0.0.1:${world.port}/upload`, {
            bytes: 1024 * 1024,
            headers: {
              host: world.hostOf("web"),
              cookie: world.cookieFor("carol", "web"),
              origin: world.originOf("web"),
            },
          }),
        );
        expect(result.status, "a declared length over the cap is refused").toBe(413);
        expect(result.body, "and the page says it was not delivered").toContain(
          "preview · web · the request body is over 65536 bytes · your request was not delivered",
        );
        expect(world.targets.snapshotReads, "refused before the binding was read").toBe(0);
        expect(forwards.dials, "nothing dialled the app").toEqual([]);
      }),
    ),
  );

  it.live("cuts a chunked body at the cap and says only that it passed it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world } = yield* worldWithApp({ settings: capped });
        const result = yield* Effect.promise(() =>
          uploadGenerated(`http://127.0.0.1:${world.port}/upload`, {
            bytes: 8 * 1024 * 1024,
            chunked: true,
            headers: {
              host: world.hostOf("web"),
              cookie: world.cookieFor("carol", "web"),
              origin: world.originOf("web"),
            },
          }),
        );
        expect(result.status, "a body that passes the cap is refused").toBe(413);
        expect(result.body, "without claiming nothing was delivered").toContain(
          "preview · web · the request body passed 65536 bytes",
        );
        expect(result.body, "part of it reached the app").not.toContain("not delivered");
      }),
    ),
  );

  it.live("refuses a dial past the gateway's forward ceiling", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world } = yield* worldWithApp({
          settings: {
            limits: {
              ...PREVIEW_GATEWAY_DEFAULTS.limits,
              perPreview: 64,
              gateway: 256,
              forwards: 1,
            },
          },
        });
        const stream = new AbortController();
        const first = yield* Effect.forkChild(
          Effect.promise(
            () =>
              new Promise<number>((resolve, reject) => {
                const outgoing = http.get(
                  {
                    host: "127.0.0.1",
                    port: world.port,
                    path: "/events?every=200&count=50",
                    agent: false,
                    signal: stream.signal,
                    headers: { host: world.hostOf("web"), cookie: world.cookieFor("carol", "web") },
                  },
                  (response) => resolve(response.statusCode ?? 0),
                );
                outgoing.on("error", (error) =>
                  stream.signal.aborted ? undefined : reject(error),
                );
              }),
          ),
        );
        expect(yield* Fiber.join(first), "the first stream holds the one forward").toBe(200);
        const refused = yield* fetchAt(
          world.port,
          world.hostOf("web"),
          world.cookieFor("dave", "web"),
        );
        expect(refused.status, "another viewer's dial is refused").toBe(429);
        expect(refused.body, "with the ceiling's words").toContain(
          "budget reached · 1 open forwards across previews · nothing running was stopped",
        );
        stream.abort();
      }),
    ),
  );
});

describe("a viewer's pool", () => {
  it.live(
    "drops a forward left free past its expiry, and keeps one in use",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { world, forwards } = yield* worldWithApp();
          const cookie = world.cookieFor("carol", "web");
          const host = world.hostOf("web");
          expect((yield* fetchAt(world.port, host, cookie, "/a")).status, "first answer").toBe(200);
          yield* realDelay(1_000);
          expect((yield* fetchAt(world.port, host, cookie, "/b")).status, "second answer").toBe(
            200,
          );
          expect(forwards.dials.length, "a forward free for 1 s is reused").toBe(1);
          yield* realDelay(4_500);
          expect((yield* fetchAt(world.port, host, cookie, "/c")).status, "third answer").toBe(200);
          expect(forwards.dials.length, "a forward free for 4.5 s was dropped").toBe(2);
        }),
      ),
    15_000,
  );
});

describe("the gateway's refresh", () => {
  it.effect("reads only previews with something open, and forgets one left empty", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world } = yield* worldWithApp();
        const host = world.hostOf("web");
        world.lending.refused.add("carol");
        const refused = yield* fetchAt(world.port, host, world.cookieFor("carol", "web"));
        expect(refused.status, "no forward is lent, so no pool opens").toBe(404);
        world.targets.batchReads.length = 0;
        yield* TestClock.adjust("3 seconds");
        yield* realDelay(50);
        expect(world.targets.batchReads.flat(), "a preview with nothing open").toEqual([]);

        const served = yield* fetchAt(world.port, host, world.cookieFor("dave", "web"));
        expect(served.status, "dave's pool stays open after the answer").toBe(200);
        yield* TestClock.adjust("2 seconds");
        yield* realDelay(50);
        expect(world.targets.batchReads.flat(), "a preview with an open pool").toContain(
          PREVIEWS.web.id,
        );
      }),
    ),
  );
});

describe("the gateway's layer", () => {
  it.live("closes its listener with its scope", () =>
    Effect.gen(function* () {
      const port = yield* Effect.scoped(
        Effect.gen(function* () {
          const { world } = yield* worldWithApp();
          const reply = yield* fetchAt(
            world.port,
            world.hostOf("web"),
            world.cookieFor("carol", "web"),
          );
          expect(reply.status, "served while open").toBe(200);
          return world.port;
        }),
      );
      const refused = yield* Effect.promise(
        () =>
          new Promise<string>((resolve) => {
            const socket = net.connect({ host: "127.0.0.1", port });
            socket.on("connect", () => resolve("connected"));
            socket.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
          }),
      );
      expect(refused, "nothing listens once the scope closed").toBe("ECONNREFUSED");
    }),
  );
});
