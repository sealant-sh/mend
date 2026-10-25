import * as net from "node:net";
import {
  ReadableStream,
  type ReadableStreamDefaultController,
  WritableStream,
  type WritableStreamDefaultController,
} from "node:stream/web";

import {
  type ForwardDestination,
  openBoundedForward,
  SealantClient,
  toPlatformError,
} from "@mend/sealant";
import { ForwardAdapter, type ForwardDialRecord } from "@mend/sessions";
import { adapterLayer, dialLog, fakeWorkspace, refusal } from "@mend/sessions/testing";
import type { BoundedWorkspaceForward, BoundedWorkspaceForwardClose } from "@sealant/sdk";
import { ForwardResetError } from "@sealant/sdk";
import { Effect, Layer } from "effect";

/**
 * Workspace ports as local TCP ports, for the preview gateway's tests: a `SealantClient` that only
 * looks workspaces up and opens forwards, under the real `ForwardAdapterLive` with Docker refused
 * after a bound loopback refusal. Each `(workspaceId, port)` dials `127.0.0.1:<localPort>`, or is
 * refused with a typed reason. The sidecar route never answers (`name-unresolved`), so a refusal
 * is reported as loopback's.
 */

export type LocalForwardRefusal = "connection-refused" | "binding-unsupported";

export type LocalForwardEntry =
  | { readonly kind: "listen"; readonly localPort: number }
  | { readonly kind: "refused"; readonly reason: LocalForwardRefusal };

export interface LocalForwardRoute {
  readonly workspaceId: string;
  readonly port: number;
  readonly entry: LocalForwardEntry;
}

/** One open the SDK was asked for, the sidecar attempt included. */
export interface LocalForwardOpen {
  readonly workspaceId: string;
  readonly port: number;
  readonly destination: ForwardDestination;
}

export interface LocalForwardOptions {
  /**
   * The negative control: reads each TCP socket eagerly into memory whatever the consumer does.
   */
  readonly unbounded?: boolean;
}

export interface LocalForwards {
  /** `ForwardAdapter` and `SealantClient`, and a logger that records each dial (it replaces the default). */
  readonly layer: Layer.Layer<ForwardAdapter | SealantClient>;
  /** Every dial the adapter finished: target, requested binding, purpose, arrival or issue. */
  readonly dials: ReadonlyArray<ForwardDialRecord>;
  readonly opens: ReadonlyArray<LocalForwardOpen>;
  /** Points `(workspaceId, port)` somewhere else from the next dial on. */
  readonly route: (route: LocalForwardRoute) => void;
}

const routeKey = (workspaceId: string, port: number) => `${workspaceId}\u0000${port}`;

const settledClose = () => {
  let settled = false;
  const { promise, resolve } = Promise.withResolvers<BoundedWorkspaceForwardClose>();
  return {
    promise,
    settle: (close: BoundedWorkspaceForwardClose) => {
      if (settled) return false;
      settled = true;
      resolve(close);
      return true;
    },
  };
};

/**
 * The SDK's bounded forward over one connected TCP socket. Bounded: reading `readable` is the only
 * credit (the socket stays paused otherwise), a write resolves on the socket's callback,
 * `writable.close()` is a FIN, and `close()` (or a cancel/abort) is a reset (RST). The target's FIN
 * ends the forward: `end` when no client write was waiting, else a `workspace-ended` reset that
 * fails the writes while what the target sent still drains (an early answer, as the SDK has it).
 */
const tcpForward = (
  socket: net.Socket,
  binding: BoundedWorkspaceForward["binding"],
  unbounded: boolean,
): BoundedWorkspaceForward => {
  const closed = settledClose();
  let failure: ForwardResetError | null = null;
  let writeFailure: ForwardResetError | null = null;
  let writing = 0;
  let ended = false;
  let readableController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let writableController: WritableStreamDefaultController | null = null;
  const eager: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  const wakeReader = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };

  const reset = (reason: ForwardResetError["reason"], destroy: "reset" | "destroy") => {
    if (!closed.settle({ kind: "reset", reason })) return;
    failure = new ForwardResetError(reason);
    writeFailure = failure;
    readableController?.error(failure);
    writableController?.error(failure);
    wakeReader();
    if (destroy === "reset") socket.resetAndDestroy();
    else socket.destroy();
  };

  socket.on("error", () => reset("target-error", "destroy"));
  socket.on("close", () => {
    if (!ended) reset("connection-lost", "destroy");
  });
  socket.on("end", () => {
    ended = true;
    wakeReader();
    if (writing === 0) {
      closed.settle({ kind: "end" });
      socket.end();
      return;
    }
    closed.settle({ kind: "reset", reason: "workspace-ended" });
    writeFailure = new ForwardResetError("workspace-ended");
    writableController?.error(writeFailure);
    socket.destroy();
  });

  if (unbounded) {
    socket.on("data", (chunk: Buffer) => {
      eager.push(chunk);
      wakeReader();
    });
  } else socket.pause();

  const nextChunk = (): Promise<Uint8Array | null> => {
    if (unbounded) {
      const chunk = eager.shift();
      if (chunk !== undefined) return Promise.resolve(chunk);
      if (ended || failure !== null) return Promise.resolve(null);
      return new Promise<void>((resolve) => {
        wake = resolve;
      }).then(nextChunk);
    }
    if (ended || failure !== null) return Promise.resolve(null);
    return new Promise((resolve) => {
      const onData = (chunk: Buffer) => {
        socket.pause();
        done();
        resolve(chunk);
      };
      const onStop = () => {
        done();
        resolve(null);
      };
      const done = () => {
        socket.off("data", onData);
        socket.off("end", onStop);
        socket.off("close", onStop);
      };
      socket.on("data", onData);
      socket.once("end", onStop);
      socket.once("close", onStop);
      socket.resume();
    });
  };

  const readable = new ReadableStream<Uint8Array>(
    {
      start: (controller) => {
        readableController = controller;
      },
      pull: async (controller) => {
        const chunk = await nextChunk();
        if (failure !== null) return;
        if (chunk === null) controller.close();
        else controller.enqueue(chunk);
      },
      cancel: () => reset("aborted", "reset"),
    },
    { highWaterMark: 0 },
  );

  const writable = new WritableStream<Uint8Array>({
    start: (controller) => {
      writableController = controller;
    },
    write: (chunk) => {
      if (writeFailure !== null) return Promise.reject(writeFailure);
      if (ended) return Promise.reject(new ForwardResetError("workspace-ended"));
      writing += 1;
      return new Promise<void>((resolve, reject) => {
        socket.write(chunk, (error) => {
          writing -= 1;
          if (error === null || error === undefined) resolve();
          else reject(writeFailure ?? new ForwardResetError("target-error"));
        });
      });
    },
    close: () => {
      if (!ended) socket.end();
    },
    abort: () => reset("aborted", "reset"),
  });

  return {
    readable,
    writable,
    binding,
    closed: closed.promise,
    close: () => reset("aborted", "reset"),
  };
};

const dialLocal = (
  localPort: number,
  binding: BoundedWorkspaceForward["binding"],
  signal: AbortSignal,
  unbounded: boolean,
): Promise<BoundedWorkspaceForward> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const socket = net.connect({ host: "127.0.0.1", port: localPort, allowHalfOpen: true });
    const onAbort = () => {
      socket.destroy();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      signal.removeEventListener("abort", onAbort);
      socket.removeAllListeners("error");
      resolve(tcpForward(socket, binding, unbounded));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      signal.removeEventListener("abort", onAbort);
      reject(
        error.code === "ECONNREFUSED" ? refusal("connection-refused") : refusal("dial-failed", 502),
      );
    });
  });

export const localForwards = (
  routes: ReadonlyArray<LocalForwardRoute>,
  options: LocalForwardOptions = {},
): LocalForwards => {
  const table = new Map<string, LocalForwardEntry>();
  const route = (next: LocalForwardRoute) =>
    table.set(routeKey(next.workspaceId, next.port), next.entry);
  for (const next of routes) route(next);
  const opens: LocalForwardOpen[] = [];
  const unbounded = options.unbounded === true;

  const sealant = Layer.mock(SealantClient)({
    getWorkspace: (id) => Effect.succeed(fakeWorkspace(id)),
    openForward: (workspace, port, destination, open) =>
      openBoundedForward(
        (signal) => {
          opens.push({ workspaceId: workspace.id, port, destination });
          if (destination.route === "docker") return Promise.reject(refusal("name-unresolved"));
          const entry = table.get(routeKey(workspace.id, port));
          if (entry === undefined) return Promise.reject(refusal("connection-refused"));
          if (entry.kind === "refused") return Promise.reject(refusal(entry.reason));
          return dialLocal(entry.localPort, destination.binding, signal, unbounded);
        },
        open.signal,
        toPlatformError,
      ),
  });
  const log = dialLog();
  return {
    layer: Layer.mergeAll(adapterLayer(sealant, "refuse"), sealant, log.layer),
    dials: log.records,
    opens,
    route,
  };
};
