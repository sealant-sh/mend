import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendKeysConfig } from "./git-auth.ts";

/**
 * The ssh-agent bridge (docs/GIT-ACCESS.md decision 2): `mend keys share` on
 * the machine that holds the key opens ONE standing WebSocket per account to
 * this server and relays its local ssh-agent over it. While connected, this service
 * serves a real unix agent socket under the keys dir; git ops for
 * bridge-mode projects point SSH_AUTH_SOCK at it and the signature happens
 * where the key physically lives (a hardware key blinks on the laptop).
 *
 * Nothing secret ever transits: agent-protocol messages are challenges,
 * identity lists, and signatures. Frames are relayed VERBATIM — the only
 * inspection anywhere is the client's peek at each message's type byte to
 * narrate what is being asked. The agent protocol is strict request/response
 * per connection, so requests are serialized through one FIFO — simplest,
 * and hardware keys could not answer two touches at once anyway.
 *
 * The transport is deliberately abstract here (a send callback plus a feed
 * handle): the store must not grow platform dependencies; the WebSocket half
 * lives in @mend/api.
 */

/** Observation, not judgment: is a signer connected, and who says it is. */
export interface AgentBridgeStatus {
  readonly connected: boolean;
  readonly clientName: string | null;
  readonly since: Date | null;
}

/** What the WS route hands the bridge when a share client connects. */
export interface AgentBridgeClient {
  /** The client's self-reported hostname — display only. */
  readonly name: string;
  /** Deliver one JSON text frame to the share client. */
  readonly send: (frame: string) => void;
}

/** What the bridge hands back: feed incoming frames, detach on close. */
export interface AgentBridgeHandle {
  readonly feed: (frame: string) => void;
  readonly detach: () => void;
}

/** The readable fail-fast for bridge-mode ops with nobody on the other end. */
export const NO_SIGNER_MESSAGE =
  "no signer connected — run `mend keys share` on the machine that holds your key";

/**
 * A share client answered a request, failed it, or timed out. Wire shape
 * over the WebSocket (JSON text frames, agent messages base64, length
 * prefix included — relayed verbatim):
 *   client → server  {"t":"hello","host":"laptop"}
 *   server → client  {"t":"req","id":1,"context":"adopt x → ssh://…","payload":"<b64>"}
 *   client → server  {"t":"res","id":1,"payload":"<b64>"} | {"t":"err","id":1,"message":"…"}
 */
interface ShareFrame {
  readonly t?: string;
  readonly id?: number;
  readonly payload?: string;
  readonly message?: string;
}

/** SSH_AGENT_FAILURE, framed — the honest answer when the bridge cannot ask. */
const AGENT_FAILURE = Buffer.from([0, 0, 0, 1, 5]);

/**
 * A touch can take as long as a human takes; the share client already fails
 * a request at 60s, so this server-side backstop only catches a vanished
 * client that never answered at all.
 */
const REQUEST_TIMEOUT_MS = 75_000;

export class AgentBridge extends Context.Service<
  AgentBridge,
  {
    /**
     * Serve `userId`'s shared agent; that user's second share replaces the first. Each account has
     * its own bridge (docs/adr/0003-organizations-and-tenancy.md): a signer never answers for
     * anyone else.
     */
    readonly attach: (
      userId: string,
      client: AgentBridgeClient,
    ) => Effect.Effect<AgentBridgeHandle>;
    readonly status: (userId: string) => Effect.Effect<AgentBridgeStatus>;
    /** Where `userId`'s bridged agent socket lives while connected. */
    readonly socketPath: (userId: string) => string;
    /**
     * Attribute in-flight requests: ops that sign through `userId`'s bridge wrap themselves so the
     * share client can say WHAT asked for a signature. Returns the end function. Attribution rides
     * concurrency (the newest open op wins) — honest for the user-initiated, serialized ops the
     * bridge exists for.
     */
    readonly begin: (userId: string, description: string) => Effect.Effect<() => void>;
  }
>()("@mend/store/AgentBridge") {}

interface PendingRequest {
  readonly id: number;
  readonly connection: net.Socket;
  readonly payload: Buffer;
  timer: NodeJS.Timeout | null;
}

/**
 * The socket file name for one account's bridge: a short digest of the account id. Unix socket
 * paths are capped near 104 bytes on macOS, so the id itself (arbitrary length, arbitrary
 * characters) never becomes part of the path.
 */
export const bridgeSocketName = (userId: string): string =>
  `${createHash("sha256").update(userId).digest("hex").slice(0, 16)}.sock`;

/** One account's bridge: its socket, its share client, its FIFO of agent requests. */
const makeUserBridge = (socketPath: string) => {
  const bridgeDir = path.dirname(socketPath);
  let client: AgentBridgeClient | null = null;
  let server: net.Server | null = null;
  let since: Date | null = null;
  let nextId = 1;
  /** Head of the queue is in flight; the rest wait their turn. */
  let queue: PendingRequest[] = [];
  const contexts: Array<{ readonly id: number; readonly description: string }> = [];
  let nextContextId = 1;

  const currentContext = (): string =>
    contexts.length === 0 ? "mend" : (contexts.at(-1)?.description ?? "mend");

  const failRequest = (request: PendingRequest): void => {
    if (request.timer !== null) clearTimeout(request.timer);
    if (!request.connection.destroyed) request.connection.write(AGENT_FAILURE);
  };

  const pump = (): void => {
    const head = queue[0];
    if (head === undefined || head.timer !== null) return; // idle, or in flight
    const active = client;
    if (active === null) {
      queue.shift();
      failRequest(head);
      pump();
      return;
    }
    head.timer = setTimeout(() => {
      queue = queue.filter((request) => request !== head);
      head.timer = null;
      failRequest(head);
      pump();
    }, REQUEST_TIMEOUT_MS);
    active.send(
      JSON.stringify({
        t: "req",
        id: head.id,
        context: currentContext(),
        payload: head.payload.toString("base64"),
      }),
    );
  };

  const settle = (id: number, response: Buffer | null): void => {
    const request = queue.find((candidate) => candidate.id === id);
    if (request === undefined) return; // already timed out
    queue = queue.filter((candidate) => candidate !== request);
    if (request.timer !== null) clearTimeout(request.timer);
    request.timer = null;
    if (response === null) failRequest({ ...request, timer: null });
    else if (!request.connection.destroyed) request.connection.write(response);
    pump();
  };

  const handleConnection = (connection: net.Socket): void => {
    let pending: Buffer = Buffer.alloc(0);
    connection.on("data", (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      // Complete agent messages only: 4-byte BE length + payload, verbatim.
      while (pending.length >= 4) {
        const size = pending.readUInt32BE(0);
        if (pending.length < 4 + size) return;
        const payload = pending.subarray(0, 4 + size);
        pending = pending.subarray(4 + size);
        queue.push({ id: nextId, connection, payload: Buffer.from(payload), timer: null });
        nextId += 1;
        pump();
      }
    });
    connection.on("close", () => {
      queue = queue.filter((request) => {
        if (request.connection !== connection) return true;
        if (request.timer !== null) clearTimeout(request.timer);
        return false;
      });
      pump();
    });
    connection.on("error", () => {});
  };

  /**
   * Remove whatever occupies the socket path, surviving what `rmSync` cannot: a dead pod's
   * socket file on an NFS-backed shared mount answers `lstat` with EINVAL, and `rmSync`
   * (which stats first) threw that at every reconnect — the bridge could never re-attach
   * after a pod swap until someone `rm`ed the file by hand (observed live, k8s PoC,
   * 2026-08-30). `unlink` needs no stat, so it succeeds there; any residue is left for
   * `listen` to report loudly rather than being guessed at here.
   */
  const removeSocketFile = (): void => {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // ENOENT (nothing there) or an unlink the filesystem refuses — bind decides next.
    }
  };

  const teardown = (): void => {
    client = null;
    since = null;
    for (const request of queue) failRequest(request);
    queue = [];
    server?.close();
    server = null;
    removeSocketFile();
  };

  const attach = async (incoming: AgentBridgeClient): Promise<AgentBridgeHandle> => {
    // One signer per account; the newest share wins (a laptop reconnecting after a network
    // change must not be locked out by its own ghost).
    teardown();
    fs.mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });
    removeSocketFile();
    const bridgeServer = net.createServer(handleConnection);
    await new Promise<void>((resolve, reject) => {
      bridgeServer.once("error", reject);
      bridgeServer.listen(socketPath, () => {
        bridgeServer.removeListener("error", reject);
        resolve();
      });
    });
    fs.chmodSync(socketPath, 0o600);
    server = bridgeServer;
    client = incoming;
    since = new Date();
    return {
      feed: (frame: string) => {
        let parsed: ShareFrame;
        try {
          parsed = JSON.parse(frame) as ShareFrame;
        } catch {
          return;
        }
        if (typeof parsed.id !== "number") return;
        if (parsed.t === "res" && typeof parsed.payload === "string") {
          settle(parsed.id, Buffer.from(parsed.payload, "base64"));
        } else if (parsed.t === "err") {
          settle(parsed.id, null);
        }
      },
      detach: () => {
        // Only the attached client may tear the bridge down — a replaced ghost's late close
        // must not kill its successor.
        if (client === incoming) teardown();
      },
    };
  };

  const status = (): AgentBridgeStatus => ({
    connected: client !== null,
    clientName: client === null ? null : client.name,
    since,
  });

  const begin = (description: string): (() => void) => {
    const id = nextContextId;
    nextContextId += 1;
    contexts.push({ id, description });
    return () => {
      const index = contexts.findIndex((entry) => entry.id === id);
      if (index !== -1) contexts.splice(index, 1);
    };
  };

  return { attach, status, begin };
};

export const AgentBridgeLive: Layer.Layer<AgentBridge, never, MendKeysConfig> = Layer.effect(
  AgentBridge,
  Effect.gen(function* () {
    const config = yield* MendKeysConfig;
    const bridgesRoot = path.join(config.root, "_bridge");
    const bridges = new Map<string, ReturnType<typeof makeUserBridge>>();

    const socketPath = (userId: string): string => path.join(bridgesRoot, bridgeSocketName(userId));

    const bridgeOf = (userId: string) => {
      const existing = bridges.get(userId);
      if (existing !== undefined) return existing;
      const created = makeUserBridge(socketPath(userId));
      bridges.set(userId, created);
      return created;
    };

    const attach = Effect.fn("AgentBridge.attach")(function* (
      userId: string,
      incoming: AgentBridgeClient,
    ) {
      const handle = yield* Effect.promise(() => bridgeOf(userId).attach(incoming));
      yield* Effect.logInfo("agent bridge connected").pipe(
        Effect.annotateLogs({ clientName: incoming.name, userId }),
      );
      return handle;
    });

    const status = Effect.fn("AgentBridge.status")(function* (userId: string) {
      return yield* Effect.sync(
        () =>
          bridges.get(userId)?.status() ?? {
            connected: false,
            clientName: null,
            since: null,
          },
      );
    });

    const begin = Effect.fn("AgentBridge.begin")(function* (userId: string, description: string) {
      return yield* Effect.sync(() => bridgeOf(userId).begin(description));
    });

    return { attach, status, socketPath, begin };
  }),
);
