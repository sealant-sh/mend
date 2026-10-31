import { randomBytes } from "node:crypto";

import {
  BudgetExceeded,
  NotFound,
  type ScreenRtcAnswer,
  ScreenRtcUnavailable,
} from "@mend/api-contracts";
import { ScreensRepo } from "@mend/db";
import { type SessionId, ViewerConnectionId } from "@mend/domain";
import type { Screen } from "@mend/domain/workbench";
import { NetworkConfig } from "@mend/network";
import { asSealantUser, ForwardSessionOwner } from "@mend/sealant";
import { ForwardAdapter, ScreenHost, Screens } from "@mend/sessions";
import {
  Cause,
  Config,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Schema,
  type Scope,
} from "effect";
import * as Context from "effect/Context";
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters } from "werift";

import type { AccessSubject } from "./access-recheck.ts";
import { Budgets } from "./budgets.ts";
import { ConnectionRegistry, reserveSocket } from "./connections.ts";
import { ScreenH264 } from "./screen-h264.ts";
import { ScreenRtcUdp } from "./screen-rtc-udp.ts";
import { ScreenWatch } from "./screen-watch.ts";

type RtcError = NotFound | BudgetExceeded | ScreenRtcUnavailable;
/** The one-call signalling boundary. The layer holds admitted peers after the HTTP answer. */
export class ScreenRtc extends Context.Service<
  ScreenRtc,
  {
    readonly connect: (
      subject: AccessSubject,
      session: SessionId,
      offer: string,
    ) => Effect.Effect<ScreenRtcAnswer, RtcError>;
  }
>()("@mend/api/ScreenRtc") {}

const InputMessage = Schema.Union([
  Schema.Struct({
    x: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1279 }))),
    y: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 799 }))),
    buttons: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
  }),
  Schema.Struct({
    keysym: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 0xffffffff }))),
    down: Schema.Boolean,
  }),
]);
const parseInput = Schema.decodeUnknownOption(Schema.fromJsonString(InputMessage));
type InputMessage = typeof InputMessage.Type;
interface Subscriber {
  readonly track: MediaStreamTrack;
  readonly connected: () => boolean;
  readonly stop: () => void;
  waiting: boolean;
}
interface Upstream {
  readonly subscribers: Set<Subscriber>;
  readonly ready: Deferred.Deferred<void, ScreenRtcUnavailable>;
  readonly fiber: Fiber.Fiber<void>;
}

/** An explicit port and IPv4 hostname, set by the operator or the packaged edge. */
export interface ScreenRtcOptions {
  readonly port: number;
  readonly host: string;
}
type Dependencies =
  | ScreensRepo
  | ScreenHost
  | ForwardAdapter
  | Screens
  | ScreenWatch
  | Budgets
  | ConnectionRegistry;

/** One encoder forward per live screen, one public UDP socket for all peers. */
export const makeScreenRtcLayer = (
  options: ScreenRtcOptions,
): Layer.Layer<ScreenRtc, never, Dependencies> => Layer.effect(ScreenRtc, make(options));

const make = (
  options: ScreenRtcOptions,
): Effect.Effect<ScreenRtc["Service"], never, Dependencies | Scope.Scope> =>
  Effect.gen(function* () {
    const repo = yield* ScreensRepo;
    const host = yield* ScreenHost;
    const forward = yield* ForwardAdapter;
    const screens = yield* Screens;
    const watch = yield* ScreenWatch;
    const budgets = yield* Budgets;
    const connections = yield* ConnectionRegistry;
    const scope = yield* Effect.scope;
    const udp = new ScreenRtcUdp(options.port, options.host);
    yield* Effect.addFinalizer(() => Effect.sync(() => udp.close()));
    const upstreams = new Map<string, Upstream>();

    const join = (screen: Screen, subscriber: Subscriber) =>
      Effect.gen(function* () {
        const key = `${screen.id}:${screen.processId}`;
        let upstream = upstreams.get(key);
        if (upstream === undefined) {
          const ready = yield* Deferred.make<void, ScreenRtcUnavailable>();
          const subscribers = new Set<Subscriber>([subscriber]);
          const pump = Effect.scoped(
            Effect.gen(function* () {
              const pty = screen.processId === null ? null : yield* host.ptyOf(screen.processId);
              if (pty === null) return yield* new ScreenRtcUnavailable();
              const owner = yield* host.ownerOf(screen.sessionId);
              const { bytes } = yield* forward
                .open(
                  {
                    workspaceId: screen.workspaceId,
                    port: 7900 + screen.display,
                    binding: { kind: "session", session: ForwardSessionOwner.make(pty) },
                  },
                  { purpose: "screen", timeoutMs: 3000 },
                )
                .pipe(asSealantUser(owner));
              const parser = new ScreenH264();
              for (;;) {
                const read = yield* bytes.read().pipe(Effect.timeout("5 seconds"));
                if (read.kind === "eof") return yield* new ScreenRtcUnavailable();
                const frames = parser.push(read.bytes);
                if (frames === null) return yield* new ScreenRtcUnavailable();
                for (const frame of frames) {
                  yield* Deferred.succeed(ready, undefined);
                  for (const viewer of subscribers) {
                    if (!viewer.connected() || (viewer.waiting && !frame.idr)) continue;
                    viewer.waiting = false;
                    for (const packet of frame.packets) viewer.track.writeRtp(packet.clone());
                  }
                }
              }
            }),
          ).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logWarning("screen RTC: encoder stream ended").pipe(
                    Effect.andThen(Deferred.fail(ready, new ScreenRtcUnavailable())),
                    Effect.asVoid,
                  ),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                upstreams.delete(key);
                for (const viewer of subscribers) viewer.stop();
              }),
            ),
          );
          const fiber = yield* Effect.forkIn(pump, scope);
          upstream = { subscribers, ready, fiber };
          upstreams.set(key, upstream);
        } else upstream.subscribers.add(subscriber);
        const held = upstream;
        yield* Effect.addFinalizer(() =>
          Effect.suspend(() => {
            held.subscribers.delete(subscriber);
            if (held.subscribers.size > 0) return Effect.void;
            upstreams.delete(key);
            return Fiber.interrupt(held.fiber).pipe(Effect.asVoid);
          }),
        );
        yield* Deferred.await(held.ready).pipe(
          Effect.timeoutOrElse({
            duration: "4 seconds",
            orElse: () => Effect.fail(new ScreenRtcUnavailable()),
          }),
        );
      });

    return ScreenRtc.of({
      connect: Effect.fn("ScreenRtc.connect")(function* (subject, sessionId, offer) {
        // Visibility precedes the budget and any workspace dial.
        yield* watch.admit(subject, sessionId);
        const answer = yield* Deferred.make<ScreenRtcAnswer, RtcError>();
        let accessEnded = false;
        const run = Effect.scoped(
          watch
            .hold(subject, sessionId, (viewer) =>
              Effect.gen(function* () {
                const held = yield* reserveSocket(connections, {
                  userId: subject.userId,
                  sessionId,
                  kind: "screen",
                  limits: {
                    account: budgets.limits.accountScreenViewers,
                    session: budgets.limits.screenViewers,
                  },
                });
                if (held._tag === "Refused") {
                  const budget =
                    held.ceiling === "account" ? "accountScreenViewers" : "screenViewers";
                  return yield* new BudgetExceeded({
                    budget,
                    limit: budgets.limits[budget],
                    retryAfterSeconds: null,
                    message: "screen viewer budget reached",
                  });
                }
                const screen = yield* repo.ofSession(sessionId);
                if (screen?.life._tag !== "Live") return yield* new ScreenRtcUnavailable();
                const connection = ViewerConnectionId.make(
                  `vc_${randomBytes(16).toString("base64url")}`,
                );
                const ended = yield* Deferred.make<void>();
                const stop = () => {
                  Deferred.doneUnsafe(ended, Exit.void);
                };
                const peer = new RTCPeerConnection({
                  codecs: {
                    video: [
                      new RTCRtpCodecParameters({
                        mimeType: "video/H264",
                        clockRate: 90000,
                        parameters:
                          "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
                      }),
                    ],
                  },
                  iceServers: [],
                  iceLite: true,
                  iceUseIpv4: true,
                  iceUseIpv6: false,
                  iceUseTcp: false,
                  iceInterfaceAddresses: { udp4: "127.0.0.1" },
                  bundlePolicy: "max-bundle",
                  maxMessageSize: 1024,
                });
                const mayTakeInput = viewer.ownerUserId === subject.userId;
                yield* Effect.addFinalizer(() =>
                  Effect.gen(function* () {
                    if (mayTakeInput)
                      yield* screens.lapse(
                        sessionId,
                        connection,
                        held.revoked() || accessEnded ? "revoked" : "disconnected",
                      );
                    yield* Effect.promise(() => peer.close()).pipe(Effect.ignore);
                  }),
                );
                yield* held.opened(() => Effect.sync(stop), Effect.succeed(true));
                if (held.revoked()) return yield* new ScreenRtcUnavailable();
                const track = new MediaStreamTrack({ kind: "video" });
                peer.addTrack(track);
                peer.connectionStateChange.subscribe((state) => {
                  if (state === "closed" || state === "failed" || state === "disconnected") stop();
                });
                let heard = true;
                const inbound = yield* Queue.bounded<InputMessage>(128);
                peer.onDataChannel.subscribe((channel) => {
                  if (channel.label !== "input") {
                    channel.close();
                    return;
                  }
                  channel.stateChanged.subscribe((state) => {
                    if (state === "closed") stop();
                  });
                  channel.onMessage.subscribe((data) => {
                    if (held.revoked()) return;
                    if (data === "ping") {
                      heard = true;
                      return;
                    }
                    if (
                      typeof data !== "string" ||
                      Buffer.byteLength(data) > Math.min(1024, budgets.limits.frameBytes || 1024)
                    ) {
                      stop();
                      return;
                    }
                    const parsed = parseInput(data);
                    if (Option.isNone(parsed)) {
                      stop();
                      return;
                    }
                    if (!mayTakeInput) return;
                    if (!Queue.offerUnsafe(inbound, parsed.value)) stop();
                  });
                });
                yield* Effect.forkScoped(
                  Effect.forever(
                    Effect.gen(function* () {
                      const input = yield* Queue.take(inbound);
                      if (!held.revoked())
                        yield* screens.input(sessionId, connection, [
                          "keysym" in input
                            ? { _tag: "Key", ...input }
                            : { _tag: "Pointer", ...input },
                        ]);
                    }),
                  ),
                );
                yield* Effect.tryPromise({
                  try: () => peer.setRemoteDescription({ type: "offer", sdp: offer }),
                  catch: () => new ScreenRtcUnavailable(),
                });
                yield* join(screen, {
                  track,
                  connected: () => peer.connectionState === "connected",
                  stop,
                  waiting: true,
                });
                const local = yield* Effect.tryPromise({
                  try: async () => {
                    await peer.setLocalDescription(await peer.createAnswer());
                    const sdp = peer.localDescription?.sdp;
                    if (sdp === undefined) throw new Error("no screen RTC answer");
                    return udp.register(sdp);
                  },
                  catch: () => new ScreenRtcUnavailable(),
                });
                yield* Effect.addFinalizer(() => Effect.sync(local.close));
                yield* watch.open(connection, subject.userId, sessionId);
                yield* Deferred.succeed(answer, { answer: local.sdp, connection });
                // Data-channel pings prove the browser is still here, even without mouse/key input.
                const heartbeat = Effect.forever(
                  Effect.gen(function* () {
                    yield* Effect.sleep("5 seconds");
                    if (!heard) {
                      stop();
                      return;
                    }
                    heard = false;
                    if (mayTakeInput) yield* screens.heartbeat(sessionId, connection);
                  }),
                );
                yield* Effect.raceFirst(
                  Deferred.await(ended),
                  Effect.raceFirst(
                    heartbeat,
                    Effect.sleep("10 seconds").pipe(
                      Effect.andThen(
                        Effect.suspend(() =>
                          peer.connectionState === "connected" ? Effect.never : Effect.sync(stop),
                        ),
                      ),
                    ),
                  ),
                );
              }),
            )
            .pipe(
              Effect.catchTag("ScreenAccessEnded", () => {
                accessEnded = true;
                return Effect.fail(new ScreenRtcUnavailable());
              }),
            ),
        ).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? Deferred.failCause(answer, exit.cause)
              : Deferred.fail(answer, new ScreenRtcUnavailable()),
          ),
        );
        yield* Effect.forkIn(run.pipe(Effect.ignore), scope);
        return yield* Deferred.await(answer);
      }),
    });
  });

/** Dev uses 3140/udp; the packaged edge sets 443. Resolve the configured web hostname to IPv4. */
export const ScreenRtcLive: Layer.Layer<
  ScreenRtc,
  Config.ConfigError,
  Dependencies | NetworkConfig
> = Layer.unwrap(
  Effect.gen(function* () {
    const network = yield* NetworkConfig;
    const port = yield* Config.schema(
      Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
      "MEND_SCREEN_RTC_UDP_PORT",
    ).pipe(Config.withDefault(3140));
    const host = yield* Config.String("MEND_SCREEN_RTC_PUBLIC_HOST").pipe(
      Config.withDefault(new URL(network.appUrl).hostname),
    );
    return makeScreenRtcLayer({ port, host });
  }),
);
