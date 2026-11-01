import { ScreenRtcUnavailable } from "@mend/api-contracts";
import { ScreensRepo } from "@mend/db";
import type { ProofRegion, Screen } from "@mend/domain/workbench";
import { asSealantUser, ForwardSessionOwner } from "@mend/sealant";
import { ForwardAdapter, ScreenHost } from "@mend/sessions";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schedule,
  Semaphore,
  type Scope,
} from "effect";
import * as Context from "effect/Context";

import { streamScreenVideo, type ScreenVideoFrame } from "./screen-video.ts";

/** Each subscription holds the encoder forward, never the screen or a viewer budget slot. */
export interface ScreenVideoSubscriber {
  readonly frame: (frame: ScreenVideoFrame) => void;
  readonly ended: () => void;
}

/** One upstream per screen process, shared by RTC viewers and intentional capture. */
export class ScreenVideoSource extends Context.Service<
  ScreenVideoSource,
  {
    readonly subscribe: (
      screen: Screen,
      subscriber: ScreenVideoSubscriber,
      region?: ProofRegion,
    ) => Effect.Effect<ProofRegion | null, ScreenRtcUnavailable, Scope.Scope>;
  }
>()("@mend/api/ScreenVideoSource") {}

interface Upstream {
  readonly subscribers: Set<ScreenVideoSubscriber>;
  readonly ready: Deferred.Deferred<void, ScreenRtcUnavailable>;
  readonly fiber: Fiber.Fiber<void>;
}

const make: Effect.Effect<
  ScreenVideoSource["Service"],
  never,
  ScreensRepo | ScreenHost | ForwardAdapter | Scope.Scope
> = Effect.gen(function* () {
  const repo = yield* ScreensRepo;
  const host = yield* ScreenHost;
  const forward = yield* ForwardAdapter;
  const scope = yield* Effect.scope;
  const upstreams = new Map<string, Upstream>();
  const joining = yield* Semaphore.make(1);

  return ScreenVideoSource.of({
    subscribe: Effect.fn("ScreenVideoSource.subscribe")(function* (screen, subscriber, region) {
      if (region !== undefined) {
        const actual = {
          ...region,
          width: region.width - (region.width % 2),
          height: region.height - (region.height % 2),
        };
        const ready = yield* Deferred.make<void, ScreenRtcUnavailable>();
        let started = false;
        const pump = Effect.scoped(
          Effect.gen(function* () {
            const encoder = yield* host
              .regionEncoder(screen, actual)
              .pipe(Effect.mapError(() => new ScreenRtcUnavailable()));
            const owner = yield* host.ownerOf(screen.sessionId);
            yield* streamScreenVideo({
              pointer: Effect.gen(function* () {
                const now = yield* repo.ofSession(screen.sessionId);
                if (
                  now?.id !== screen.id ||
                  now.life._tag !== "Live" ||
                  now.processId !== screen.processId
                )
                  return yield* new ScreenRtcUnavailable();
                return true;
              }),
              open: () =>
                forward
                  .open(
                    {
                      workspaceId: screen.workspaceId,
                      port: encoder.port,
                      binding: { kind: "session", session: ForwardSessionOwner.make(encoder.pty) },
                    },
                    { purpose: "screen", timeoutMs: 3000 },
                  )
                  .pipe(
                    asSealantUser(owner),
                    Effect.retry({ times: 20, schedule: Schedule.spaced("100 millis") }),
                    Effect.map(({ bytes }) => bytes),
                    Effect.mapError(() => new ScreenRtcUnavailable()),
                  ),
              emit: (frame) => {
                started = true;
                Deferred.doneUnsafe(ready, Exit.void);
                subscriber.frame(frame);
              },
            });
          }),
        ).pipe(
          Effect.catch(() => Effect.void),
          Effect.ensuring(
            Effect.sync(() => {
              Deferred.doneUnsafe(ready, Exit.fail(new ScreenRtcUnavailable()));
              if (started) subscriber.ended();
            }),
          ),
        );
        const fiber = yield* Effect.forkScoped(pump);
        yield* Deferred.await(ready).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.fail(new ScreenRtcUnavailable()),
          }),
          Effect.onError(() => Fiber.interrupt(fiber)),
        );
        return actual;
      }
      const key = `${screen.id}:${screen.processId}`;
      const held = yield* Effect.acquireRelease(
        joining.withPermit(
          Effect.gen(function* () {
            let upstream = upstreams.get(key);
            if (upstream === undefined) {
              const ready = yield* Deferred.make<void, ScreenRtcUnavailable>();
              const subscribers = new Set<ScreenVideoSubscriber>([subscriber]);
              const pump = Effect.scoped(
                Effect.gen(function* () {
                  const pty =
                    screen.processId === null ? null : yield* host.ptyOf(screen.processId);
                  if (pty === null) return yield* new ScreenRtcUnavailable();
                  const owner = yield* host.ownerOf(screen.sessionId);
                  yield* streamScreenVideo({
                    pointer: Effect.gen(function* () {
                      const now = yield* repo.ofSession(screen.sessionId);
                      if (
                        now?.id !== screen.id ||
                        now.life._tag !== "Live" ||
                        now.processId !== screen.processId
                      )
                        return yield* new ScreenRtcUnavailable();
                      return now.input._tag !== "Person";
                    }),
                    open: (pointer) =>
                      forward
                        .open(
                          {
                            workspaceId: screen.workspaceId,
                            port: (pointer ? 7900 : 8100) + screen.display,
                            binding: { kind: "session", session: ForwardSessionOwner.make(pty) },
                          },
                          { purpose: "screen", timeoutMs: 3000 },
                        )
                        .pipe(
                          asSealantUser(owner),
                          Effect.map(({ bytes }) => bytes),
                          Effect.mapError(() => new ScreenRtcUnavailable()),
                        ),
                    emit: (frame) => {
                      Deferred.doneUnsafe(ready, Exit.void);
                      for (const observer of subscribers) observer.frame(frame);
                    },
                  });
                }),
              ).pipe(
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    yield* Deferred.fail(ready, new ScreenRtcUnavailable());
                    if (!Cause.hasInterruptsOnly(cause))
                      yield* Effect.logWarning("screen video: encoder stream ended");
                  }),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (upstreams.get(key)?.subscribers === subscribers) upstreams.delete(key);
                    Deferred.doneUnsafe(ready, Exit.fail(new ScreenRtcUnavailable()));
                    for (const observer of subscribers) observer.ended();
                  }),
                ),
                Effect.asVoid,
              );
              const fiber = yield* Effect.forkIn(pump, scope);
              upstream = { subscribers, ready, fiber };
              upstreams.set(key, upstream);
            } else upstream.subscribers.add(subscriber);
            return upstream;
          }),
        ),
        (released) =>
          Effect.suspend(() => {
            released.subscribers.delete(subscriber);
            if (released.subscribers.size > 0) return Effect.void;
            if (upstreams.get(key) === released) upstreams.delete(key);
            return Fiber.interrupt(released.fiber).pipe(Effect.asVoid);
          }),
      );
      yield* Deferred.await(held.ready).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(new ScreenRtcUnavailable()),
        }),
      );
      return null;
    }),
  });
});

/** Only the API process builds this layer; all consumers share this exact layer object. */
export const ScreenVideoSourceLive: Layer.Layer<
  ScreenVideoSource,
  never,
  ScreensRepo | ScreenHost | ForwardAdapter
> = Layer.effect(ScreenVideoSource, make);
