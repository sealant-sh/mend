import { createServer } from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Context, Deferred, Effect, Layer, Option, Schedule, Stream, Tracer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { describe, expect, it } from "vitest";

import { requestOpened, serveObserved } from "./http-observation.ts";

const encoder = new TextEncoder();

interface Seen {
  readonly name: string;
  readonly spanId: string;
  readonly parent: string | undefined;
  readonly endedBefore: ReadonlyArray<string>;
}

/**
 * A real Node server (SLNT-1404): it writes a stream's body inside the request's fiber, so a span
 * that ended with the handler would still be the parent of everything the body does.
 */
const serve = Effect.fnUntraced(function* (
  routes: Layer.Layer<never, never, HttpRouter.HttpRouter>,
) {
  const seen: Array<Seen> = [];
  const ended: Array<string> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = Tracer.nativeTracer.span(options);
      seen.push({
        name: options.name,
        spanId: span.spanId,
        parent: Option.getOrUndefined(options.parent)?.spanId,
        endedBefore: [...ended],
      });
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        ended.push(options.name);
        end(endTime, exit);
      };
      return span;
    },
  });
  const context = yield* Layer.build(
    serveObserved(routes, { disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
      Layer.provide(Layer.succeed(Tracer.Tracer, tracer)),
    ),
  );
  const address = Context.get(context, HttpServer.HttpServer).address;
  const port = address._tag === "UnixPathAddress" ? 0 : address.port;
  return { seen, url: (path: string) => `http://127.0.0.1:${port}${path}` };
});

describe("a request that lives on once it is open", () => {
  it("an event stream's span ends when its headers go out, and its body runs outside it", async () => {
    const routes = HttpRouter.use((router) =>
      router.add(
        "GET",
        "/api/events",
        Effect.succeed(
          HttpServerResponse.stream(
            Stream.fromSchedule(Schedule.spaced("5 millis")).pipe(
              Stream.take(3),
              Stream.mapEffect(() =>
                Effect.succeed(encoder.encode(": ping\n\n")).pipe(Effect.withSpan("frame")),
              ),
            ),
            { contentType: "text/event-stream" },
          ),
        ),
      ),
    );
    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const served = yield* serve(routes);
          const response = yield* Effect.promise(() => fetch(served.url("/api/events")));
          yield* Effect.promise(() => response.text());
          return served.seen;
        }),
      ),
    );
    const request = seen.find((span) => span.name === "GET");
    const frames = seen.filter((span) => span.name === "frame");
    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(frame.parent).toBeUndefined();
      expect(frame.endedBefore).toContain("GET");
    }
    expect(request).toBeDefined();
  });

  it("a socket's span ends once its handler says it is open", async () => {
    const opened = Deferred.makeUnsafe<void>();
    const routes = HttpRouter.use((router) =>
      router.add(
        "GET",
        "/ws",
        Effect.gen(function* () {
          yield* requestOpened(101);
          yield* Effect.void.pipe(Effect.withSpan("after"));
          yield* Deferred.succeed(opened, undefined);
          return HttpServerResponse.empty({ status: 204 });
        }),
      ),
    );
    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const served = yield* serve(routes);
          yield* Effect.promise(() => fetch(served.url("/ws")));
          yield* Deferred.await(opened);
          return served.seen;
        }),
      ),
    );
    expect(seen.find((span) => span.name === "after")?.endedBefore).toContain("GET");
  });
});
