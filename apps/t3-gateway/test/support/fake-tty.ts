import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import type { FakeWorkbench } from "./fake-workbench.ts";

/**
 * Mend's terminal for the fake: `POST /api/sessions/:id/shell` (the owner's, with a live
 * workspace), `POST /api/processes/:id/stop`, `POST /api/upgrade-tickets` minting a single-use,
 * thirty-second `tty` ticket for one process, and the `/api/tty?ticket=&process=` WebSocket, whose
 * shell answers what it is sent: `$ ` on connect, then each input echoed back. Just enough
 * WebSocket framing for that (RFC 6455), with no library.
 */

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TICKET_TTL_MS = 30_000;

const frame = (opcode: number, payload: Buffer): Buffer => {
  const length = payload.byteLength;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65_536
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
        : Buffer.concat([Buffer.from([0x80 | opcode, 127]), Buffer.alloc(8)]);
  if (length >= 65_536) header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
};

/** The complete frames at the start of `buffer`, and what is left after them. */
const readFrames = (
  buffer: Buffer,
): {
  readonly frames: ReadonlyArray<{ opcode: number; payload: Buffer }>;
  readonly rest: Buffer;
} => {
  const frames: Array<{ opcode: number; payload: Buffer }> = [];
  let at = 0;
  for (;;) {
    if (buffer.byteLength - at < 2) break;
    const opcode = (buffer[at] ?? 0) & 0x0f;
    const second = buffer[at + 1] ?? 0;
    let length = second & 0x7f;
    let cursor = at + 2;
    if (length === 126) {
      if (buffer.byteLength - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.byteLength - cursor < 8) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    const masked = (second & 0x80) !== 0;
    const mask = masked ? buffer.subarray(cursor, cursor + 4) : null;
    if (masked) cursor += 4;
    if (buffer.byteLength - cursor < length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask !== null) {
      for (let index = 0; index < payload.byteLength; index++) {
        payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
      }
    }
    frames.push({ opcode, payload });
    at = cursor + length;
  }
  return { frames, rest: buffer.subarray(at) };
};

export class FakeTty {
  /** Process id → the session it is a shell of, and whether it still runs. */
  readonly shells = new Map<string, { readonly sessionId: string; running: boolean }>();
  readonly tickets = new Map<
    string,
    { readonly process: string; readonly expiresAt: number; spent: boolean }
  >();
  /** What the shells were sent, as text. */
  readonly typed: Array<string> = [];
  readonly resizes: Array<{ readonly cols: number; readonly rows: number }> = [];
  /** Every `/api/tty` upgrade's outcome, without the ticket. */
  readonly upgrades: Array<"accepted" | "refused"> = [];
  private readonly sockets = new Map<string, Duplex>();
  private shellCount = 0;

  constructor(private readonly workbench: FakeWorkbench) {}

  /** Ends a shell from Mend's side: its socket gets `{"t":"end"}` and closes. */
  end(processId: string): void {
    const socket = this.sockets.get(processId);
    if (socket === undefined) return;
    socket.write(frame(1, Buffer.from(JSON.stringify({ t: "end" }))));
    socket.end(frame(8, Buffer.alloc(0)));
    this.sockets.delete(processId);
  }

  /** Answers a terminal route, or false when the request is not one. */
  route(
    request: IncomingMessage,
    response: ServerResponse,
    body: () => Promise<unknown>,
    accepted: boolean,
  ): boolean | Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://fake");
    const json = (status: number, value: unknown): true => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
      return true;
    };
    const shell = /^\/api\/sessions\/([^/]+)\/shell$/.exec(url.pathname);
    const stop = /^\/api\/processes\/([^/]+)\/stop$/.exec(url.pathname);
    const ticket = url.pathname === "/api/upgrade-tickets";
    if (request.method !== "POST" || (shell === null && stop === null && !ticket)) return false;
    if (!accepted) return json(401, { _tag: "Unauthorized" });
    return body().then((value) => {
      if (shell !== null) {
        const sessionId = decodeURIComponent(shell[1] ?? "");
        if (!this.workbench.sessions.has(sessionId)) return json(404, { _tag: "NotFound" });
        if (this.workbench.control.get(sessionId) === false) {
          return json(403, { _tag: "SessionNotSteerable", sessionId, message: "not yours" });
        }
        const agent = this.workbench.agents.get(sessionId);
        if (agent === undefined || agent.exitedAt !== null) {
          return json(409, { _tag: "SessionNotLive", id: sessionId });
        }
        this.shellCount += 1;
        const id = `shell-${this.shellCount}`;
        this.shells.set(id, { sessionId, running: true });
        return json(200, { id, sessionId, kind: "shell" });
      }
      if (stop !== null) {
        const id = decodeURIComponent(stop[1] ?? "");
        const known = this.shells.get(id);
        if (known === undefined) return json(404, { _tag: "NotFound" });
        known.running = false;
        this.end(id);
        return json(200, { id, sessionId: known.sessionId, kind: "shell" });
      }
      const payload = typeof value === "object" && value !== null ? value : {};
      const entries = Object.fromEntries(Object.entries(payload));
      if (entries["target"] !== "tty" || typeof entries["process"] !== "string") {
        return json(400, { _tag: "UpgradeTicketInvalid", message: "a tty ticket names a process" });
      }
      const minted = `tkt_${randomBytes(16).toString("base64url")}`;
      this.tickets.set(minted, {
        process: entries["process"],
        expiresAt: Date.now() + TICKET_TTL_MS,
        spent: false,
      });
      return json(200, { ticket: minted, expiresInSeconds: 30 });
    });
  }

  /** `/api/tty`: a ticket spent once, for exactly its process, then the shell. */
  readonly upgrade = (request: IncomingMessage, socket: Duplex): void => {
    const url = new URL(request.url ?? "/", "http://fake");
    const refuse = () => {
      this.upgrades.push("refused");
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    };
    if (url.pathname !== "/api/tty") return refuse();
    const process = url.searchParams.get("process") ?? "";
    const ticket = this.tickets.get(url.searchParams.get("ticket") ?? "");
    if (
      ticket === undefined ||
      ticket.spent ||
      ticket.expiresAt <= Date.now() ||
      ticket.process !== process
    ) {
      return refuse();
    }
    ticket.spent = true;
    const shell = this.shells.get(process);
    if (shell === undefined || !shell.running) return refuse();
    this.upgrades.push("accepted");
    const key = request.headers["sec-websocket-key"] ?? "";
    const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    this.sockets.set(process, socket);
    socket.write(frame(2, Buffer.from("$ ")));
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      const { frames, rest } = readFrames(Buffer.concat([pending, chunk]));
      pending = Buffer.from(rest);
      for (const { opcode, payload } of frames) {
        if (opcode === 8) {
          this.sockets.delete(process);
          socket.end(frame(8, Buffer.alloc(0)));
          return;
        }
        if (opcode === 1) {
          const parsed: unknown = JSON.parse(payload.toString("utf8"));
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            "t" in parsed &&
            parsed.t === "resize"
          ) {
            const cols = "cols" in parsed && typeof parsed.cols === "number" ? parsed.cols : 0;
            const rows = "rows" in parsed && typeof parsed.rows === "number" ? parsed.rows : 0;
            this.resizes.push({ cols, rows });
          }
          continue;
        }
        if (opcode === 2) {
          const text = payload.toString("utf8");
          this.typed.push(text);
          socket.write(frame(2, Buffer.from(text)));
        }
      }
    });
    socket.on("error", () => this.sockets.delete(process));
  };
}
