import * as os from "node:os";
import { Worker } from "node:worker_threads";

import { Data, Duration, Effect, Exit, Layer, Semaphore, type Scope } from "effect";
import * as Context from "effect/Context";

import type { FramebufferRead } from "./rfb-framebuffer.ts";

export type WorkerRequest =
  | { readonly _tag: "Decode"; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly _tag: "Copy" }
  | { readonly _tag: "Encode"; readonly bytes: Uint8Array<ArrayBuffer> };

export type WorkerReply =
  | { readonly _tag: "Decoded"; readonly read: FramebufferRead }
  | { readonly _tag: "Pixels"; readonly pixels: Uint8Array<ArrayBuffer> }
  | { readonly _tag: "Png"; readonly png: Uint8Array };

type Reply<Tag extends WorkerReply["_tag"]> = Extract<WorkerReply, { readonly _tag: Tag }>;

/** `screen-worker.ts` beside this module, as tests and `node` running the source load it. */
export const SCREEN_WORKER = new URL("./screen-worker.ts", import.meta.url);
/** At most this many decodes, and as many encodes, run at once across every hand. */
export const SCREEN_WORKERS_AT_ONCE = Math.max(1, Math.min(4, os.availableParallelism() - 1));
export const DECODE_DEADLINE = Duration.seconds(2);
export const ENCODE_DEADLINE = Duration.seconds(2);

export class WorkerStopped extends Data.TaggedError("WorkerStopped")<{
  readonly reason: "deadline" | "failed";
}> {}

export interface Decoder {
  readonly decode: (bytes: Uint8Array) => Effect.Effect<FramebufferRead, WorkerStopped>;
  readonly copy: Effect.Effect<Uint8Array<ArrayBuffer>, WorkerStopped>;
}

export class ScreenWorkers extends Context.Service<
  ScreenWorkers,
  {
    /** One hand's framebuffer, on a thread of its own until the scope closes. */
    readonly decoder: Effect.Effect<Decoder, never, Scope.Scope>;
    readonly encodePng: (
      pixels: Uint8Array<ArrayBuffer>,
    ) => Effect.Effect<Uint8Array, WorkerStopped>;
  }
>()("@mend/sessions/ScreenWorkers") {}

interface Thread {
  readonly ask: <Tag extends WorkerReply["_tag"]>(
    request: WorkerRequest,
    tag: Tag,
    deadline: Duration.Duration,
  ) => Effect.Effect<Reply<Tag>, WorkerStopped>;
  readonly stop: Effect.Effect<void>;
}

const isReply = <Tag extends WorkerReply["_tag"]>(
  reply: WorkerReply | undefined,
  tag: Tag,
): reply is Reply<Tag> => reply?._tag === tag;

const threadOf = (url: URL): Thread => {
  const worker = new Worker(url);
  worker.unref();
  let alive = true;
  const waiting: Array<(reply: WorkerReply | undefined) => void> = [];
  const stopped = () => {
    alive = false;
    for (const resume of waiting.splice(0)) resume(undefined);
  };
  worker.on("message", (reply: WorkerReply) => waiting.shift()?.(reply));
  worker.on("error", stopped);
  worker.on("exit", stopped);
  const stop = Effect.promise(() => worker.terminate()).pipe(Effect.asVoid);
  const failed = new WorkerStopped({ reason: "failed" });
  return {
    stop,
    ask: (request, tag, deadline) =>
      Effect.callback<WorkerReply | undefined>((resume) => {
        if (!alive) return resume(Effect.succeed(undefined));
        waiting.push((reply) => resume(Effect.succeed(reply)));
        worker.postMessage(request, "bytes" in request ? [request.bytes.buffer] : []);
      }).pipe(
        Effect.flatMap((reply) =>
          isReply(reply, tag) ? Effect.succeed(reply) : Effect.fail(failed),
        ),
        Effect.timeoutOrElse({
          duration: deadline,
          orElse: () =>
            Effect.andThen(stop, Effect.fail(new WorkerStopped({ reason: "deadline" }))),
        }),
      ),
  };
};

export const screenWorkersLayer = (url: URL): Layer.Layer<ScreenWorkers> =>
  Layer.effect(
    ScreenWorkers,
    Effect.gen(function* () {
      const decodes = yield* Semaphore.make(SCREEN_WORKERS_AT_ONCE);
      const encodes = yield* Semaphore.make(SCREEN_WORKERS_AT_ONCE);
      const idle: Array<Thread> = [];
      yield* Effect.addFinalizer(() => Effect.forEach(idle.splice(0), (thread) => thread.stop));
      return {
        decoder: Effect.acquireRelease(
          Effect.sync(() => threadOf(url)),
          (thread) => thread.stop,
        ).pipe(
          Effect.map((thread) => ({
            decode: (bytes) =>
              decodes.withPermit(
                thread
                  .ask({ _tag: "Decode", bytes: new Uint8Array(bytes) }, "Decoded", DECODE_DEADLINE)
                  .pipe(Effect.map((reply) => reply.read)),
              ),
            copy: thread
              .ask({ _tag: "Copy" }, "Pixels", DECODE_DEADLINE)
              .pipe(Effect.map((reply) => reply.pixels)),
          })),
        ),
        encodePng: (pixels) =>
          encodes.withPermit(
            Effect.suspend(() => {
              const thread = idle.pop() ?? threadOf(url);
              return thread.ask({ _tag: "Encode", bytes: pixels }, "Png", ENCODE_DEADLINE).pipe(
                Effect.onExit((exit) =>
                  Exit.isSuccess(exit) ? Effect.sync(() => idle.push(thread)) : thread.stop,
                ),
                Effect.map((reply) => reply.png),
              );
            }),
          ),
      };
    }),
  );
