import {
  ReadableStream,
  TransformStream,
  WritableStream,
  type WritableStreamDefaultController,
} from "node:stream/web";

import type { ForwardDestination } from "@mend/sealant";
import { openBoundedForward, SealantClient, toPlatformError } from "@mend/sealant";
import type {
  BoundedWorkspaceForward,
  BoundedWorkspaceForwardClose,
  Workspace,
} from "@sealant/sdk";
import { ForwardDialError, ForwardResetError } from "@sealant/sdk";
import { Effect, Layer, Logger, References } from "effect";

import { ForwardAdapterLive, type ForwardDialRecord } from "../src/forward.ts";
import { fakeWorkspace } from "./fake-workspace.ts";

/**
 * A bounded forward with the SDK's shape and its stream rules, over in-memory streams: reading
 * `readable` is the only credit the workspace side gets, a write may leave one chunk the workspace
 * has not taken before it waits, `writable.close()` is the FIN, and `close()` or a workspace reset
 * errors both streams with a `ForwardResetError` at once.
 */
export interface FakeWorkspaceSide {
  /** What the client sent, until its FIN or the workspace's own. */
  readonly fromClient: AsyncIterable<Uint8Array>;
  readonly send: (bytes: Uint8Array) => Promise<void>;
  /**
   * The workspace's FIN, after which it takes nothing more, as the SDK has it: a client chunk not
   * taken by then makes the outcome a `workspace-ended` reset and fails the client's writes, while
   * what the workspace sent still drains. With nothing untaken it is a clean end, and a later
   * client write fails with `workspace-ended`.
   */
  readonly end: () => Promise<void>;
  readonly reset: (reason: "target-error" | "runtime-lost" | "owner-exited") => void;
}

export interface FakeForward {
  readonly forward: BoundedWorkspaceForward;
  /** True once the client side reset it (`close()`, or a stream cancel/abort). */
  readonly closedByClient: () => boolean;
}

const WINDOW_CHUNKS = 1;

export const fakeForward = (
  behaviour: (side: FakeWorkspaceSide) => Promise<void>,
  binding: BoundedWorkspaceForward["binding"] = { kind: "port" },
): FakeForward => {
  const fromWorkspace = new TransformStream<Uint8Array, Uint8Array>(
    undefined,
    { highWaterMark: 1 },
    { highWaterMark: 0 },
  );
  const workspaceWriter = fromWorkspace.writable.getWriter();
  let state: "open" | "ended" | "failed" = "open";
  let failure: ForwardResetError | null = null;
  let clientReset = false;
  let clientFin = false;
  const untaken: Uint8Array[] = [];
  let heldWrite: PromiseWithResolvers<void> | null = null;
  let taker: (() => void) | null = null;
  let writableController: WritableStreamDefaultController | null = null;
  const closing = Promise.withResolvers<BoundedWorkspaceForwardClose>();

  const wakeTaker = () => {
    const wake = taker;
    taker = null;
    wake?.();
  };
  const stopWriting = (error: ForwardResetError) => {
    heldWrite?.reject(error);
    heldWrite = null;
    writableController?.error(error);
    wakeTaker();
  };
  const fail = (reason: ForwardResetError["reason"]) => {
    if (state !== "open") return;
    state = "failed";
    failure = new ForwardResetError(reason);
    void workspaceWriter.abort(failure).catch(() => undefined);
    stopWriting(failure);
    closing.resolve({ kind: "reset", reason });
  };
  const fromClient: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        for (;;) {
          if (state !== "open") return { done: true, value: undefined };
          const chunk = untaken.shift();
          if (chunk !== undefined) {
            if (heldWrite !== null && untaken.length <= WINDOW_CHUNKS) {
              heldWrite.resolve();
              heldWrite = null;
            }
            return { done: false, value: chunk };
          }
          if (clientFin) return { done: true, value: undefined };
          await new Promise<void>((resolve) => {
            taker = resolve;
          });
        }
      },
    }),
  };
  const side: FakeWorkspaceSide = {
    fromClient,
    send: (bytes) => workspaceWriter.write(bytes),
    end: async () => {
      if (state !== "open") return;
      const drained = workspaceWriter.close();
      if (untaken.length === 0 && heldWrite === null) {
        state = "ended";
        wakeTaker();
        closing.resolve({ kind: "end" });
      } else {
        state = "failed";
        failure = new ForwardResetError("workspace-ended");
        stopWriting(failure);
        closing.resolve({ kind: "reset", reason: "workspace-ended" });
      }
      await drained;
    },
    reset: fail,
  };
  void behaviour(side).catch(() => fail("target-error"));
  // The client's own streams: a cancel or abort is the client's reset, as the SDK's are.
  const reader = fromWorkspace.readable.getReader();
  const readable = new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        const next = await reader.read();
        if (next.done === true) controller.close();
        else controller.enqueue(next.value);
      },
      cancel: () => {
        clientReset = true;
        fail("aborted");
      },
    },
    { highWaterMark: 0 },
  );
  const writable = new WritableStream<Uint8Array>({
    start: (controller) => {
      writableController = controller;
    },
    write: async (chunk) => {
      if (state === "failed") throw failure;
      if (state === "ended") throw new ForwardResetError("workspace-ended");
      untaken.push(chunk);
      wakeTaker();
      if (untaken.length <= WINDOW_CHUNKS) return;
      heldWrite = Promise.withResolvers<void>();
      await heldWrite.promise;
    },
    close: () => {
      clientFin = true;
      wakeTaker();
    },
    abort: () => {
      clientReset = true;
      fail("aborted");
    },
  });
  return {
    forward: {
      readable,
      writable,
      binding,
      closed: closing.promise,
      close: () => {
        if (state === "open") clientReset = true;
        fail("aborted");
      },
    },
    closedByClient: () => clientReset,
  };
};

export const takeFirst = (side: FakeWorkspaceSide) =>
  side.fromClient[Symbol.asyncIterator]().next();

/** Echoes what the client sends, then ends after the client's FIN. */
export const echo = async (side: FakeWorkspaceSide): Promise<void> => {
  for await (const chunk of side.fromClient) await side.send(chunk);
  await side.end();
};

export const refusal = (
  reason: Exclude<
    ForwardDialError["reason"],
    "unrecognized-refusal" | "protocol-unsupported" | "transport-unavailable"
  >,
  status = 502,
) => new ForwardDialError({ reason, status, message: `refused: ${reason}` });

/** How one dial answers: a forward, or the SDK's rejection. */
export type DialScript = (
  destination: ForwardDestination,
  signal: AbortSignal,
) => Promise<BoundedWorkspaceForward>;

/** Tallies of what the scripted SDK was asked. */
export interface DialLedger {
  readonly lookups: number;
  readonly dials: ReadonlyArray<ForwardDestination>;
}

/** A SealantClient whose forwards are scripted, through Mend's real seam (`openBoundedForward`). */
export const scriptedSealant = (
  script: DialScript,
  lookup: () => Effect.Effect<Workspace, ReturnType<typeof toPlatformError>> = () =>
    Effect.succeed(fakeWorkspace("ws-1")),
) => {
  const dials: ForwardDestination[] = [];
  const ledger = { lookups: 0, dials };
  const layer = Layer.mock(SealantClient)({
    getWorkspace: () =>
      Effect.suspend(() => {
        ledger.lookups += 1;
        return lookup();
      }),
    openForward: (_workspace, _port, destination, options) =>
      openBoundedForward(
        (signal) => {
          dials.push(destination);
          return script(destination, signal);
        },
        options.signal,
        toPlatformError,
      ),
  });
  const read: DialLedger = ledger;
  return { layer, ledger: read };
};

export const adapterLayer = (sealant: Layer.Layer<SealantClient>) =>
  ForwardAdapterLive.pipe(Layer.provide(sealant));

/** Every `forward.dial` record the adapter logs. */
export const dialLog = () => {
  const records: ForwardDialRecord[] = [];
  const layer = Logger.layer([
    Logger.make((options) => {
      const message = Array.isArray(options.message)
        ? options.message.join(" ")
        : String(options.message);
      if (message !== "forward.dial") return;
      const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
      const dial = annotations["dial"];
      if (typeof dial === "string") records.push(JSON.parse(dial));
    }),
  ]);
  return { records, layer };
};

/** A promise and its resolvers, for holding a dial open until a test releases it. */
export const held = <A>() => Promise.withResolvers<A>();

/** Rejects with the abort reason once `signal` aborts, as the SDK's open does. */
export const untilAborted = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
