import { EventEmitter } from "node:events";
import * as http from "node:http";

import { describe, expect, it } from "@mend/test-ci/effect-vitest";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";

import { serveFixture } from "../test/fixtures/preview/apps.ts";
import { localForwards } from "../test/support/preview-forward.ts";
import {
  APP_PORT,
  bound,
  dormant,
  type GatewayWorld,
  type GatewayWorldOptions,
  gatewayWorld,
  PREVIEWS,
  send,
  WORKSPACE,
} from "../test/support/preview-gateway-world.ts";
import { PREVIEW_GATEWAY_DEFAULTS } from "./preview-gateway-settings.ts";
import { listening, type ListeningServer } from "./preview-gateway.ts";

const worldWithApp = (options: Omit<GatewayWorldOptions, "forwards"> = {}) =>
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
    return yield* gatewayWorld({ ...options, forwards: forwards.layer });
  });

const realDelay = (ms: number) => Effect.promise(() => new Promise((done) => setTimeout(done, ms)));

const get = (world: GatewayWorld, cookie: string, path = "/", headers = {}) =>
  Effect.promise(() =>
    send(world.port, {
      host: world.hostOf("web"),
      path,
      headers: { cookie, ...headers },
    }),
  );

const stream = (world: GatewayWorld, cookie: string, path: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const seen = { events: 0, ended: false, status: 0 };
      const request = http.get({
        host: "127.0.0.1",
        port: world.port,
        path,
        headers: { host: world.hostOf("web"), cookie },
        agent: false,
      });
      request.on("response", (response) => {
        seen.status = response.statusCode ?? 0;
        response.setEncoding("utf8");
        response.on("data", (text: string) => {
          seen.events += text.split("\n\n").length - 1;
        });
        response.on("end", () => {
          seen.ended = true;
        });
      });
      request.on("error", () => {
        seen.ended = true;
      });
      return { seen, request };
    }),
    ({ request }) => Effect.sync(() => request.destroy()),
  ).pipe(Effect.map(({ seen }) => seen));

const until = (what: string, holds: () => boolean, ms = 5_000) =>
  Effect.gen(function* () {
    for (let waited = 0; !holds(); waited += 10) {
      if (waited > ms) return yield* Effect.die(`${what} within ${ms} ms`);
      yield* realDelay(10);
    }
  });

const invalidGrant = (world: GatewayWorld) =>
  `${world.cookieFor("carol", "web").split("=")[0] ?? ""}=mpg_${"z".repeat(43)}`;

const from = (address: string) => ({ "x-forwarded-for": address });

describe("a request to a running Service", () => {
  it.live("reads the binding once, then serves from what it read while it stays bound", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* worldWithApp();
        const cookie = world.cookieFor("carol", "web");
        for (let index = 0; index < 6; index += 1) {
          expect((yield* get(world, cookie, `/r${index}`)).status).toBe(200);
        }
        expect(world.targets.snapshotReads, "one read for six requests").toBe(1);
      }),
    ),
  );

  it.live(
    "keeps every open stream when a refresh cannot read the bindings",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = yield* worldWithApp();
          const seen = yield* stream(
            world,
            world.cookieFor("carol", "web"),
            "/events?every=250&count=12",
          );
          yield* until("the first event", () => seen.events > 0);
          world.targets.failReads = true;
          yield* realDelay(1_500);
          expect(seen.ended, "the stream outlived a failed refresh").toBe(false);
          world.targets.failReads = false;
          yield* until("every event", () => seen.ended);
          expect(seen.events, "every event arrived").toBe(12);
        }),
      ),
    10_000,
  );
});

describe("a request to a stopped preview", () => {
  it.live("is refused before it starts anything when the workspace lends the viewer nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* worldWithApp();
        world.targets.resolutions.set(PREVIEWS.web.id, dormant());
        world.lending.refused.add("carol");
        const reply = yield* get(world, world.cookieFor("carol", "web"));
        expect(reply.status, "as if there were no such preview").toBe(404);
        expect(world.targets.starts, "nothing joined or started a wave").toEqual([]);
      }),
    ),
  );

  it.live(
    "one account's spent start budget never refuses another account waiting on the wave",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = yield* worldWithApp({
            budgets: { accountPreviewStartsPerMinute: 1 },
          });
          world.targets.resolutions.set(PREVIEWS.web.id, dormant());
          world.budgets.previewStarts.take("carol", 1, Date.now());
          const gate = yield* Deferred.make<void>();
          world.targets.beforeClaim = gate;
          world.targets.ensureRunning = (request) =>
            Effect.sync(() => {
              world.targets.resolutions.set(PREVIEWS.web.id, bound());
              return request.sourceAttemptId;
            });
          const carol = yield* Effect.forkChild(get(world, world.cookieFor("carol", "web")));
          yield* until("carol's wave", () => world.targets.starts.length === 1);
          const dave = yield* Effect.forkChild(get(world, world.cookieFor("dave", "web")));
          yield* realDelay(200);
          yield* Deferred.succeed(gate, undefined);
          const carolReply = yield* Fiber.join(carol);
          expect(carolReply.status, "carol's own budget").toBe(429);
          expect(carolReply.headers["retry-after"], "and when to ask again").toBeDefined();
          expect((yield* Fiber.join(dave)).status, "dave's start, on dave's budget").toBe(200);
          expect(world.targets.launches.length, "one launch, dave's").toBe(1);
        }),
      ),
  );
});

describe("the work before a grant stands", () => {
  it.live("stops at the admission ceiling, 429 with a Retry-After, whatever the grants", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ceiling = 4;
        const world = yield* worldWithApp({
          settings: {
            limits: {
              ...PREVIEW_GATEWAY_DEFAULTS.limits,
              admitting: ceiling,
            },
          },
        });
        const held = yield* Deferred.make<void>();
        world.standingHeld.current = held;
        const replies = yield* Effect.forkChild(
          Effect.all(
            Array.from({ length: ceiling + 3 }, () => get(world, invalidGrant(world))),
            { concurrency: "unbounded" },
          ),
        );
        yield* realDelay(300);
        world.standingHeld.current = null;
        yield* Deferred.succeed(held, undefined);
        const answered = yield* Fiber.join(replies);
        const refused = answered.filter((reply) => reply.status === 429);
        expect(refused.length, "only the requests past the ceiling").toBe(3);
        for (const reply of refused) {
          expect(reply.headers["retry-after"], "each says when to ask again").toBe("1");
        }
        expect(
          answered.filter((reply) => reply.status === 401).length,
          "the rest were read, and refused for their grant",
        ).toBe(ceiling);
      }),
    ),
  );

  it.live("counts each client address in its own window, behind a trusted proxy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* worldWithApp({
          budgets: { addressPreviewRequestsPerMinute: 3 },
          settings: { trustedProxies: ["127.0.0.1/32"] },
        });
        for (let index = 0; index < 3; index += 1) {
          expect((yield* get(world, invalidGrant(world), "/", from("203.0.113.7"))).status).toBe(
            401,
          );
        }
        const refused = yield* get(world, invalidGrant(world), "/", from("203.0.113.7"));
        expect(refused.status, "the fourth from one address").toBe(429);
        expect(refused.headers["retry-after"], "with when to ask again").toBeDefined();
        expect(
          (yield* get(world, invalidGrant(world), "/", from("198.51.100.9"))).status,
          "another address has its own window",
        ).toBe(401);
      }),
    ),
  );
});

describe("an import wave behind an HTTP/2 edge", () => {
  it.live(
    "delivers more requests at once than the account's open requests, waiting for forwards",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = yield* worldWithApp({
            budgets: { accountPreviewConnections: 8 },
          });
          const cookie = world.cookieFor("carol", "web");
          const replies = yield* Effect.all(
            Array.from({ length: 40 }, () => get(world, cookie, "/events?every=50&count=2")),
            { concurrency: "unbounded" },
          );
          expect(
            replies.map((reply) => reply.status).filter((status) => status !== 200),
            "every module of the wave delivered",
          ).toEqual([]);
        }),
      ),
  );
});

describe("a viewer's pool under long streams", () => {
  it.live(
    "answers a request that waited past the bound for a forward, undelivered",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = yield* worldWithApp({ settings: { queueWaitMs: 300 } });
          const cookie = world.cookieFor("carol", "web");
          const streams = yield* Effect.all(
            Array.from({ length: 6 }, () => stream(world, cookie, "/events?every=1000&count=30")),
          );
          yield* until("six open streams", () => streams.every((seen) => seen.events > 0));
          const started = Date.now();
          const reply = yield* get(world, cookie, "/after-the-streams");
          expect(reply.status).toBe(503);
          expect(reply.body).toContain("every forward to it stayed busy");
          expect(Date.now() - started, "within its bound").toBeLessThan(2_000);
        }),
      ),
    10_000,
  );
});

describe("the listener", () => {
  it.effect("closes a server whose listen was interrupted before it answered", () =>
    Effect.gen(function* () {
      const closes = { count: 0 };
      const server: ListeningServer = Object.assign(new EventEmitter(), {
        listen: () => server,
        close: () => {
          closes.count += 1;
          return server;
        },
      });
      const scope = yield* Scope.make();
      const fiber = yield* Effect.forkChild(
        Scope.provide(listening(server, { bind: "127.0.0.1", port: 1 }), scope),
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      yield* Scope.close(scope, Exit.void);
      expect(closes.count, "the pending listen's server closed").toBeGreaterThan(0);
    }),
  );
});
