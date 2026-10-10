import type { MendConnection } from "./config.js";
import { MendApiError } from "./mend-http.js";
import { isEndFrame, mintTtyTicket, resizeFrame, ttyUrl, type TtyAddress } from "./tty-protocol.js";

/**
 * One terminal's attachment to a session's PTY over `/api/tty` (apps/api/src/routes/tty.ts), with
 * its lifecycle: a ticket and a socket per attempt, reattaching while the process runs, and nothing
 * left behind once it is closed. Free of VS Code (`tty-terminal.ts` adapts it to a pseudoterminal),
 * so the lifecycle is tested on its own.
 *
 * - **Closed means closed.** A close while the ticket is being minted, or while a reattach waits,
 *   leaves no socket behind: every step after a wait asks again.
 * - **Retry what can pass, stop on a refusal.** A failed mint or a dropped socket counts against
 *   the same bounded backoff; a 401, 403 or 404 from the API is a refusal, and retrying it cannot
 *   change it.
 */

/** How many times a dropped or refused-in-transit terminal tries again before it says so. */
export const RECONNECTS = 5;

/** Whether the PTY's process runs: asked after a socket closed without the server's `end`. */
export type PtyLiveness = "live" | "ended" | "refused" | "unknown";

/** The slice of a WebSocket the attachment uses. */
export interface TtySocket {
  binaryType: BinaryType;
  readonly readyState: number;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(): void;
  addEventListener(type: "open" | "close", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
}

export interface TtyAttachmentDeps {
  readonly connection: () => Promise<MendConnection>;
  readonly address: TtyAddress;
  readonly liveness: () => Promise<PtyLiveness>;
  /** Text for the terminal: decoded PTY output, or a line of the attachment's own. */
  readonly write: (text: string) => void;
  /** The attachment ended, for good; 0 when the process ended, 1 otherwise. */
  readonly ended: (code: number) => void;
  readonly mint?: (connection: MendConnection, address: TtyAddress) => Promise<string>;
  readonly openSocket?: (url: URL) => TtySocket;
  readonly sleep?: (ms: number) => Promise<void>;
}

const OPEN = 1;

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;

/** A 401, 403 or 404 from the API: this caller may not have this terminal, and asking again will not change that. */
export const isRefusal = (cause: unknown): boolean =>
  cause instanceof MendApiError && cause.status !== null && [401, 403, 404].includes(cause.status);

const PROCESS_ENDED = "[the process ended · the session's record keeps its output]";

export class TtyAttachment {
  private socket: TtySocket | null = null;
  private dimensions: { readonly columns: number; readonly rows: number } | null = null;
  private decoder = new TextDecoder();
  private closed = false;
  private attempts = 0;
  private readonly mint: (connection: MendConnection, address: TtyAddress) => Promise<string>;
  private readonly openSocket: (url: URL) => TtySocket;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: TtyAttachmentDeps) {
    this.mint = deps.mint ?? mintTtyTicket;
    this.openSocket =
      deps.openSocket ??
      ((url) => {
        if (typeof WebSocket !== "function") {
          throw new Error("This VS Code has no WebSocket in its extension host; update VS Code.");
        }
        return new WebSocket(url);
      });
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  start(dimensions: { readonly columns: number; readonly rows: number } | null): void {
    this.dimensions = dimensions;
    void this.connect(false);
  }

  /** Detach: the process keeps running. Safe at any point, a pending mint or reattach included. */
  close(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
  }

  isClosed(): boolean {
    return this.closed;
  }

  input(data: string): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== OPEN) return;
    socket.send(new TextEncoder().encode(data));
  }

  resize(columns: number, rows: number): void {
    this.dimensions = { columns, rows };
    const socket = this.socket;
    if (socket !== null && socket.readyState === OPEN) socket.send(resizeFrame(columns, rows));
  }

  private say(line: string): void {
    this.deps.write(`\r\n${dim(line)}\r\n`);
  }

  private end(line: string, code: number): void {
    if (this.closed) return;
    this.say(line);
    this.closed = true;
    this.socket?.close();
    this.socket = null;
    this.deps.ended(code);
  }

  private async connect(reattach: boolean): Promise<void> {
    if (this.closed) return;
    let url: URL;
    try {
      const connection = await this.deps.connection();
      if (this.closed) return;
      const ticket = await this.mint(connection, this.deps.address);
      if (this.closed) return;
      url = ttyUrl(connection.url, this.deps.address, ticket);
    } catch (cause) {
      if (this.closed) return;
      const reason = cause instanceof Error ? cause.message : String(cause);
      if (isRefusal(cause)) {
        this.end(`Mend refused this terminal: ${reason}`, 1);
        return;
      }
      await this.retry(reattach, `could not reach Mend for a ticket: ${reason}`);
      return;
    }
    let socket: TtySocket;
    try {
      socket = this.openSocket(url);
    } catch (cause) {
      this.end(cause instanceof Error ? cause.message : String(cause), 1);
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    let opened = false;
    let ended = false;
    socket.addEventListener("open", () => {
      if (this.closed) {
        socket.close();
        return;
      }
      opened = true;
      this.attempts = 0;
      if (reattach) {
        // The replay starts from the beginning again: clear what the last attachment drew.
        this.decoder = new TextDecoder();
        this.deps.write("\x1bc");
      }
      const size = this.dimensions;
      if (size !== null) socket.send(resizeFrame(size.columns, size.rows));
    });
    socket.addEventListener("message", (event) => {
      const data = event.data;
      if (typeof data === "string") {
        if (isEndFrame(data)) ended = true;
        return;
      }
      if (data instanceof ArrayBuffer) {
        this.deps.write(this.decoder.decode(new Uint8Array(data), { stream: true }));
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      if (this.closed) return;
      if (ended) {
        this.end(PROCESS_ENDED, 0);
        return;
      }
      void this.afterDrop(opened);
    });
  }

  /**
   * A socket closed without `end`. A refused upgrade and a dropped network look the same to a
   * WebSocket, so the API says whether the process still runs: reattach while it does or while
   * nothing answers, stop when it ended or the caller may no longer see it.
   */
  private async afterDrop(opened: boolean): Promise<void> {
    const liveness = await this.deps.liveness().catch((): PtyLiveness => "unknown");
    if (this.closed) return;
    if (liveness === "ended") {
      this.end(PROCESS_ENDED, 0);
      return;
    }
    if (liveness === "refused") {
      this.end("[Mend no longer lets this editor see the session · the process keeps running]", 1);
      return;
    }
    await this.retry(true, opened ? "connection lost" : "Mend did not open the terminal");
  }

  private async retry(reattach: boolean, why: string): Promise<void> {
    this.attempts += 1;
    if (this.attempts > RECONNECTS) {
      this.end(
        `[${why} · tried ${RECONNECTS} times · the process keeps running · open the terminal again]`,
        1,
      );
      return;
    }
    this.say(`[${why} · reattaching (${this.attempts}/${RECONNECTS})]`);
    await this.sleep(Math.min(1000 * 2 ** this.attempts, 10_000));
    if (this.closed) return;
    await this.connect(reattach);
  }
}
