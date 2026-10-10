import * as vscode from "vscode";

import type { MendConnection } from "./config.js";
import { TtyAttachment, type PtyLiveness } from "./tty-attachment.js";
import type { TtyAddress } from "./tty-protocol.js";

/**
 * A session's terminal inside VS Code, over Mend's terminal data plane (`/api/tty`), the same one
 * `mend attach`, the desktop app and the phone use. It needs no SSH: it works wherever the API
 * does, through a LAN, a private network or an https edge. The attachment and its lifecycle are
 * `TtyAttachment`; this adapts it to a pseudoterminal.
 *
 * The socket's URL carries an upgrade ticket (docs/adr/0004, "Upgrade tickets"): single use, thirty
 * seconds, minted for exactly this terminal over the API with the token in a header. The token
 * itself never rides a URL.
 */

export interface TtyTerminalOptions {
  readonly connection: () => Promise<MendConnection>;
  readonly address: TtyAddress;
  /** Shown first, dimmed: whose terminal this is and how to leave it. */
  readonly banner: string;
  /** Whether the PTY's process still runs, asked after an unexpected close. */
  readonly liveness: () => Promise<PtyLiveness>;
}

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;

/** The pseudoterminal behind one VS Code terminal tab. Closing the tab detaches; the process runs on. */
export class MendTtyTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  private readonly attachment: TtyAttachment;

  constructor(private readonly options: TtyTerminalOptions) {
    this.attachment = new TtyAttachment({
      connection: options.connection,
      address: options.address,
      liveness: options.liveness,
      write: (text) => this.writeEmitter.fire(text),
      // The tab stays open with the last screen; a key closes it.
      ended: (code) => this.closeEmitter.fire(code),
    });
  }

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    this.writeEmitter.fire(`${dim(this.options.banner)}\r\n`);
    this.attachment.start(initialDimensions ?? null);
  }

  close(): void {
    this.attachment.close();
  }

  handleInput(data: string): void {
    this.attachment.input(data);
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.attachment.resize(dimensions.columns, dimensions.rows);
  }
}
