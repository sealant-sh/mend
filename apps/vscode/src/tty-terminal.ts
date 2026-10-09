import * as vscode from "vscode";

import type { MendConnection } from "./config.js";
import { isEndFrame, mintTtyTicket, resizeFrame, ttyUrl, type TtyAddress } from "./tty-protocol.js";

/**
 * A session's terminal inside VS Code, over Mend's terminal data plane (`/api/tty`), the same one
 * `mend attach`, the desktop app and the phone use. It needs no SSH: it works wherever the API
 * does, through a LAN, a private network or an https edge.
 *
 * Wire protocol (apps/api/src/routes/tty.ts):
 *   server → client   binary = PTY output bytes (replay from `?from=`, then live)
 *   server → client   text   = `{"t":"end"}` then close (the process settled)
 *   client → server   binary = PTY input bytes
 *   client → server   text   = `{"t":"resize","cols":n,"rows":n}`
 *
 * The socket's URL carries an upgrade ticket (docs/adr/0004, "Upgrade tickets"): single use, thirty
 * seconds, minted for exactly this terminal over the API with the token in a header. The token
 * itself never rides a URL.
 */

/** How often a dropped terminal reattaches before it says so and stops. */
const RECONNECTS = 5;

export interface TtyTerminalOptions {
  readonly connection: () => Promise<MendConnection>;
  readonly address: TtyAddress;
  /** Shown first, dimmed: whose terminal this is and how to leave it. */
  readonly banner: string;
  /** Whether the PTY's process still runs, asked after an unexpected close. */
  readonly stillLive: () => Promise<boolean>;
}

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;

/** The pseudoterminal behind one VS Code terminal tab. Closing the tab detaches; the process runs on. */
export class MendTtyTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  private socket: WebSocket | null = null;
  private dimensions: vscode.TerminalDimensions | undefined;
  private decoder = new TextDecoder();
  private closed = false;
  private attempts = 0;

  constructor(private readonly options: TtyTerminalOptions) {}

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    this.dimensions = initialDimensions;
    this.writeEmitter.fire(`${dim(this.options.banner)}\r\n`);
    void this.connect(false);
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
  }

  handleInput(data: string): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    socket.send(new TextEncoder().encode(data));
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.dimensions = dimensions;
    const socket = this.socket;
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(resizeFrame(dimensions.columns, dimensions.rows));
    }
  }

  private say(line: string): void {
    this.writeEmitter.fire(`\r\n${dim(line)}\r\n`);
  }

  private end(line: string, code: number): void {
    if (this.closed) return;
    this.say(line);
    this.closed = true;
    this.socket = null;
    // The tab stays open with the last screen; a key closes it.
    this.closeEmitter.fire(code);
  }

  private async connect(reattach: boolean): Promise<void> {
    if (this.closed) return;
    let url: URL;
    try {
      const connection = await this.options.connection();
      url = ttyUrl(
        connection.url,
        this.options.address,
        await mintTtyTicket(connection, this.options.address),
      );
    } catch (cause) {
      this.end(
        `Mend could not open this terminal: ${cause instanceof Error ? cause.message : String(cause)}`,
        1,
      );
      return;
    }
    if (typeof WebSocket !== "function") {
      this.end("This VS Code has no WebSocket in its extension host; update VS Code.", 1);
      return;
    }
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    let opened = false;
    let ended = false;
    socket.addEventListener("open", () => {
      opened = true;
      this.attempts = 0;
      if (reattach) {
        // The replay starts from the beginning again: clear what the last attachment drew.
        this.decoder = new TextDecoder();
        this.writeEmitter.fire("\x1bc");
      }
      const size = this.dimensions;
      if (size !== undefined) socket.send(resizeFrame(size.columns, size.rows));
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data === "string") {
        if (isEndFrame(data)) ended = true;
        return;
      }
      if (data instanceof ArrayBuffer) {
        this.writeEmitter.fire(this.decoder.decode(new Uint8Array(data), { stream: true }));
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      if (this.closed) return;
      if (ended) {
        this.end("[the process ended · the session's record keeps its output]", 0);
        return;
      }
      void this.afterDrop(opened);
    });
  }

  /**
   * A socket closed without `end`. A refused upgrade and a dropped network look the same from
   * here, so the API says whether the process still runs: reattach while it does, stop when not.
   */
  private async afterDrop(opened: boolean): Promise<void> {
    const live = await this.options.stillLive().catch(() => true);
    if (!live) {
      this.end("[the process ended · the session's record keeps its output]", 0);
      return;
    }
    this.attempts += 1;
    if (this.attempts > RECONNECTS) {
      this.end(
        opened
          ? "[the connection to Mend dropped and did not come back · the process keeps running · open the terminal again]"
          : "[Mend refused this terminal · the process keeps running]",
        1,
      );
      return;
    }
    this.say(`[connection lost · reattaching (${this.attempts}/${RECONNECTS})]`);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(1000 * 2 ** this.attempts, 10_000)),
    );
    await this.connect(true);
  }
}
