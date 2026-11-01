import { describe, expect, it } from "@mend/test-ci/effect-vitest";
import { Deferred, Effect, Fiber } from "effect";

import { serveFixture } from "../test/fixtures/preview/apps.ts";
import { localForwards } from "../test/support/preview-forward.ts";
import {
  APP_PORT,
  bound,
  dormant,
  gatewayWorld,
  opening,
  PREVIEWS,
  rawExchange,
  send,
  WORKSPACE,
} from "../test/support/preview-gateway-world.ts";
import { PreviewStartFailed } from "./preview-targets.ts";

const delay = (ms: number) =>
  Effect.promise(() => new Promise<void>((done) => setTimeout(done, ms)));
const setup = Effect.gen(function* () {
  const app = yield* Effect.acquireRelease(
    Effect.promise(() => serveFixture("all")),
    (fixture) => Effect.promise(fixture.stop),
  );
  const forwards = localForwards([
    { workspaceId: WORKSPACE, port: APP_PORT, entry: { kind: "listen", localPort: app.port } },
  ]);
  const world = yield* gatewayWorld({ forwards: forwards.layer });
  world.targets.resolutions.set(PREVIEWS.web.id, dormant());
  const release = yield* Deferred.make<void>();
  const asked = yield* Deferred.make<void>();
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
  const request = (path: string, headers: Record<string, string> = {}, method = "GET") =>
    Effect.promise(() =>
      send(world.port, {
        host: world.hostOf("web"),
        path,
        method,
        headers: { cookie: world.cookieFor("carol", "web"), ...headers },
      }),
    );
  return { world, request, release: Deferred.succeed(release, undefined), asked };
});

const navigation = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

describe("interactive preview startup", () => {
  it.live("names a person's resource stop on a dormant preview page", () =>
    Effect.gen(function* () {
      const { world, request } = yield* setup;
      world.targets.ensureRunning = () =>
        Effect.fail(
          new PreviewStartFailed({
            reason: "command-failed",
            resourceStopped: { name: "db", by: "Maria" },
          }),
        );
      const reply = yield* request("/");
      expect(reply.status).toBe(503);
      expect(reply.body).toContain(
        "preview · web · @db stopped by Maria · your request was not delivered",
      );
    }),
  );

  it.live("holds a resource stop even when its preview Service is already running", () =>
    Effect.gen(function* () {
      const { world, request } = yield* setup;
      world.targets.resolutions.set(PREVIEWS.web.id, bound());
      world.targets.resourceStop = { name: "db", by: "Maria" };
      const reply = yield* request("/");
      expect(reply.status).toBe(503);
      expect(reply.body).toContain("@db stopped by Maria");
      expect(world.targets.starts).toHaveLength(0);
      world.targets.resourceStop = null;
      expect((yield* request("/")).status).toBe(200);
    }),
  );

  it.live(
    "answers navigation immediately, starts once, and preserves the path and query when ready",
    () =>
      Effect.gen(function* () {
        const { world, request, release, asked } = yield* setup;
        const first = yield* request("/requested?keep=1", navigation).pipe(
          Effect.timeout("1 second"),
        );
        expect(first.status).toBe(503);
        expect(first.body).toContain("<canvas");
        expect(first.body).toContain("preview · web · starting");
        expect(first.body).not.toContain('http-equiv="refresh"');
        expect(first.headers).toMatchObject({
          "retry-after": "2",
          "cache-control": "no-store, private",
          "x-robots-tag": "noindex",
        });
        yield* Deferred.await(asked);
        const poll = yield* request("/__mend/status");
        expect(JSON.parse(poll.body)).toEqual({
          state: "starting",
          line: "preview · web · starting",
        });
        expect(world.targets.starts).toHaveLength(1);
        yield* release;
        yield* delay(50);
        expect(JSON.parse((yield* request("/__mend/status")).body).state).toBe("ready");
        const app = yield* request("/requested?keep=1", navigation);
        expect(app.status).toBe(200);
        expect(JSON.parse(app.body).path).toBe("/requested?keep=1");
      }),
  );

  it.live("reports setup and server progress, and reserves status behind grant and admission", () =>
    Effect.gen(function* () {
      const { world, request } = yield* setup;
      world.targets.resolutions.set(PREVIEWS.web.id, {
        _tag: "Starting",
        revision: 0,
        attemptId: null,
        workspaceId: null,
      });
      expect(JSON.parse((yield* request("/__mend/status")).body)).toEqual({
        state: "starting",
        line: "preview · web · setup",
      });
      world.targets.resolutions.set(PREVIEWS.web.id, opening("attempt-1"));
      expect(JSON.parse((yield* request("/__mend/status")).body)).toEqual({
        state: "starting",
        line: "preview · web · server",
      });
      const missing = yield* Effect.promise(() =>
        send(world.port, { host: world.hostOf("web"), path: "/__mend/status" }),
      );
      expect(missing.status).toBe(401);
      expect((yield* request("/__mend/status", { origin: "https://other.test" })).status).toBe(403);
      expect(
        (yield* request("/__mend/status", {
          "sec-fetch-site": "same-site",
          "sec-fetch-mode": "cors",
        })).status,
      ).toBe(403);
      expect(
        (yield* request("/__mend/status", { origin: world.originOf("web") }, "POST")).status,
      ).toBe(405);
      world.targets.resolutions.set(PREVIEWS.web.id, bound());
      world.lending.refused.add("carol");
      expect((yield* request("/__mend/status")).status).toBe(404);
    }),
  );

  it.live("uses preferred HTML only without Fetch Metadata", () =>
    Effect.gen(function* () {
      const { request } = yield* setup;
      const html = yield* request("/", { accept: "text/html,application/json;q=0.8" }).pipe(
        Effect.timeout("1 second"),
      );
      expect(html.body).toContain("<canvas");
    }),
  );

  it.live("keeps fetches, assets, POSTs and WebSocket upgrades held", () =>
    Effect.gen(function* () {
      const { world, request, asked, release } = yield* setup;
      yield* request("/", navigation);
      yield* Deferred.await(asked);
      world.targets.resolutions.set(PREVIEWS.web.id, opening("attempt-1"));
      const headers = [
        { "sec-fetch-mode": "cors", accept: "text/html" },
        { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" },
        { accept: "application/json,text/html;q=0.2" },
        { accept: "text/html;q=0" },
      ];
      const waiters = yield* Effect.forEach(headers, (h) => Effect.forkChild(request("/asset", h)));
      const post = yield* Effect.forkChild(
        request("/post", { origin: world.originOf("web"), ...navigation }, "POST"),
      );
      const socket = yield* Effect.forkChild(
        Effect.promise(() =>
          rawExchange(
            world.port,
            `GET /ws HTTP/1.1\r\nHost: ${world.hostOf("web")}\r\nCookie: ${world.cookieFor("carol", "web")}\r\nOrigin: ${world.originOf("web")}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
            500,
          ),
        ),
      );
      yield* Deferred.await(asked);
      yield* delay(100);
      for (const waiter of [...waiters, post, socket]) expect(waiter.pollUnsafe()).toBeUndefined();
      yield* release;
      for (const waiter of [...waiters, post]) expect((yield* Fiber.join(waiter)).status).toBe(200);
      expect(yield* Fiber.join(socket)).toContain("101 Switching Protocols");
      expect(world.targets.starts).toHaveLength(1);
    }),
  );

  it.live("reports a failed start without refresh or a new wake", () =>
    Effect.gen(function* () {
      const { world, request } = yield* setup;
      world.targets.ensureRunning = () =>
        Effect.fail(new PreviewStartFailed({ reason: "command-failed" }));
      yield* request("/", navigation);
      yield* delay(50);
      const failed = yield* request("/__mend/status");
      expect(JSON.parse(failed.body)).toEqual({
        state: "failed",
        line: "preview · web · did not start · command failed · your request was not delivered",
      });
      const page = yield* request("/", navigation);
      expect(page.body).toContain("did not start · command failed");
      expect(page.body).not.toContain("<canvas");
      expect(page.body).not.toContain("<script");
      expect(page.body).not.toContain('http-equiv="refresh"');
      expect(world.targets.starts).toHaveLength(1);
    }),
  );

  it.live("never wakes a person's Stop, for navigation or status", () =>
    Effect.gen(function* () {
      const { world, request } = yield* setup;
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
      const page = yield* request("/", navigation);
      expect(page.status).toBe(503);
      expect(page.body).toContain("Maria stopped the preview");
      expect(page.body).not.toContain("<canvas");
      expect(JSON.parse((yield* request("/__mend/status")).body).state).toBe("failed");
      expect(world.targets.starts).toHaveLength(0);
    }),
  );
});
