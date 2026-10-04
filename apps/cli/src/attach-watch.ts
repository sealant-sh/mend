import { terminalReadOnlyLine } from "@mend/domain/workbench";

import { csiUKeysOf, isDetachChunk } from "./shared.ts";

/**
 * Attaching to a terminal someone else owns (docs/adr/0013-whoever-sends-a-turn-pays.md, "Terminal
 * sessions: only the owner types"): the server streams its output and drops the caller's input, so
 * the CLI says so before the terminal draws and sends no keys or resizes.
 */

/** The slice of a session's detail that says whether this caller types in its terminal. */
export interface TerminalControlFacts {
  readonly session: { readonly ownerUserId?: string | null };
  /** Absent from servers before organizations; `terminalInput` absent before docs/adr/0013. */
  readonly control?: { readonly terminalInput?: boolean };
}

/** Whether this caller only reads the terminal. An older server's answer types, as it always did. */
export const watchesTerminal = (detail: TerminalControlFacts | null): boolean =>
  detail?.control?.terminalInput === false;

/** The owner by name from the organization's roster, else the words every client falls back to. */
export const ownerNameOf = (
  ownerUserId: string | null | undefined,
  members: ReadonlyArray<{ readonly userId: string; readonly name: string }>,
): string => members.find((member) => member.userId === ownerUserId)?.name ?? "its owner";

/** What a watcher reads before the terminal streams. */
export const watchNotice = (ownerName: string): string => terminalReadOnlyLine(ownerName);

/** Ctrl+C as the raw byte, or as a CSI-u report once the owner's TUI pushed the kitty protocol. */
const isInterruptChunk = (data: Buffer): boolean =>
  data.includes(0x03) ||
  csiUKeysOf(data).some(
    (key) => key.code === 99 && (key.mods & ~1) === 4 && (key.event === 1 || key.event === 2),
  );

/**
 * What a key does while watching. Ctrl+] and Ctrl+C both detach: the session is the owner's, so
 * nothing a watcher presses ever stops it. Every other key goes nowhere.
 */
export const watchKey = (data: Buffer, detachKeyEnabled: boolean): "detach" | null =>
  (detachKeyEnabled && isDetachChunk(data)) || isInterruptChunk(data) ? "detach" : null;
