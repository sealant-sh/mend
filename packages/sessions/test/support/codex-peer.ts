import type { InteractiveSession } from "@sealant/sdk";
import { Schema } from "effect";

/**
 * A scripted codex app-server on the far side of a pipe session: answers the handshake, then
 * follows `turnScript` for each `turn/start` (an error entry rejects the turn, a string accepts
 * it with that provider turn id). Records every interrupt it receives.
 */
export const PeerRequest = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(
    Schema.Struct({
      turnId: Schema.optionalKey(Schema.String),
      expectedTurnId: Schema.optionalKey(Schema.String),
      input: Schema.optionalKey(
        Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
      ),
    }),
  ),
});
export type PeerRequest = typeof PeerRequest.Type;

export const makePipe = (
  turnScript: Array<{ error: string } | string>,
  controls: {
    readonly steer?: (request: PeerRequest, push: (frame: unknown) => void) => Promise<void>;
    readonly start?: (
      request: PeerRequest,
      push: (frame: unknown) => void,
      pushRaw: (text: string) => void,
    ) => Promise<void>;
  } = {},
) => {
  const pending: Array<{ sequence: bigint; data: Uint8Array }> = [];
  let notify: (() => void) | null = null;
  let sequence = 0n;
  const interrupted: string[] = [];
  const written: Array<PeerRequest> = [];
  const pushRaw = (text: string) => {
    pending.push({ sequence: sequence++, data: new TextEncoder().encode(text) });
    notify?.();
  };
  const push = (value: unknown) => pushRaw(`${JSON.stringify(value)}\n`);
  let turnIndex = 0;
  let ended = false;
  const pipe: InteractiveSession = {
    id: "sealant-session-1",
    workspaceId: "ws-1",
    runId: "run-1",
    mode: "pipe",
    send: (input) => {
      const text = typeof input === "string" ? input : new TextDecoder().decode(input);
      const message: unknown = JSON.parse(text);
      if (typeof message !== "object" || message === null) return Promise.resolve();
      const request = Schema.decodeUnknownSync(PeerRequest)(message);
      written.push(request);
      if (request.id === undefined) return Promise.resolve();
      switch (request.method) {
        case "initialize":
          push({ id: request.id, result: {} });
          break;
        case "thread/start":
        case "thread/resume":
          push({ id: request.id, result: { thread: { id: "thread-1" } } });
          break;
        case "turn/start": {
          if (controls.start !== undefined) return controls.start(request, push, pushRaw);
          const step = turnScript[turnIndex++] ?? "turn-fallback";
          if (typeof step === "string") push({ id: request.id, result: { turn: { id: step } } });
          else push({ id: request.id, error: { message: step.error } });
          break;
        }
        case "turn/steer":
          if (controls.steer !== undefined) return controls.steer(request, push);
          push({ id: request.id, result: { turnId: request.params?.expectedTurnId } });
          break;
        case "turn/interrupt":
          interrupted.push(request.params?.turnId ?? "unknown");
          push({ id: request.id, result: {} });
          break;
        default:
          push({ id: request.id, result: {} });
      }
      return Promise.resolve();
    },
    output: (options) => {
      const signal = options?.signal;
      return (async function* () {
        for (;;) {
          if (signal?.aborted === true) return;
          const next = pending.shift();
          if (next === undefined && ended) return;
          if (next !== undefined) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => {
            notify = resolve;
            // A push that landed between the empty shift and this arm must not
            // sleep forever — with one exchange in flight there is no later
            // push to recover the lost wakeup.
            if (pending.length > 0) resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          notify = null;
        }
      })();
    },
    resize: () => Promise.reject(new Error("pipe sessions have no terminal")),
    signal: () => Promise.resolve(),
    status: () => Promise.reject(new Error("not in test")),
    close: () => Promise.resolve(),
    attach: () => Promise.reject(new Error("not in test")),
  };
  /** The app-server's output ends once what was pushed is read. */
  const end = () => {
    ended = true;
    notify?.();
  };
  return { pipe, interrupted, written, push, pushRaw, end };
};
