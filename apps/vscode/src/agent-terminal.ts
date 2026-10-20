import * as vscode from "vscode";

import type { MendClient } from "./client.js";
import { maySteer, ownsSession } from "./session-capability.js";
import { displaySession } from "./session-lines.js";
import { isRefusal } from "./tty-attachment.js";
import { attachableProcesses, type TtyAddress } from "./tty-protocol.js";
import { MendTtyTerminal } from "./tty-terminal.js";
import type { Session } from "./types.js";

/** A member's name as the organization lists it; "another person" when it cannot say. */
export const memberName = async (client: MendClient, userId: string | null): Promise<string> => {
  if (userId === null) return "another person";
  const names = await client.memberNames();
  return names.find((member) => member.userId === userId)?.name ?? "another person";
};

/** Each tab's pseudoterminal, so the review can paste into the agent's terminal (G12 fallback). */
const ptys = new WeakMap<vscode.Terminal, MendTtyTerminal>();

/** Pastes into one of Mend's terminal tabs, without Enter; false when it is not one or never opened. */
export const pasteInto = async (terminal: vscode.Terminal, text: string): Promise<boolean> =>
  (await ptys.get(terminal)?.paste(text)) ?? false;

/** The process one of Mend's terminal tabs is attached to: its socket reaches that one alone. */
export const terminalProcess = (terminal: vscode.Terminal): string | null =>
  ptys.get(terminal)?.processId() ?? null;

/**
 * One of a session's terminals in a VS Code tab over Mend's terminal data plane (`/api/tty`),
 * shown and focused. The owner types; anyone else the server lets in watches.
 */
export const attachTerminal = async (
  client: MendClient,
  facts: {
    readonly session: Session;
    readonly address: TtyAddress;
    readonly name: string;
    readonly viewer: string | null;
  },
): Promise<vscode.Terminal> => {
  const { session, address, viewer } = facts;
  const banner = ownsSession(session, viewer)
    ? `Mend · ${displaySession(session)} · closing this tab detaches; the process keeps running`
    : `read-only · ${await memberName(client, session.ownerUserId)}'s session`;
  const processId = "process" in address ? address.process : null;
  const pty = new MendTtyTerminal({
    connection: () => client.connection(),
    address,
    banner,
    liveness: async () => {
      try {
        const now = await client.sessionDetail(session.id);
        // Admission first: the server refuses the upgrade to whoever may no longer steer
        // (shared control turned off), however live the process is.
        if (viewer !== null && !maySteer(now.session, viewer)) return "not-steerable";
        const running =
          processId === null
            ? now.currentAgent !== null && now.currentAgent.exitedAt === null
            : attachableProcesses(now.processes).some((process) => process.id === processId);
        return running ? "live" : "ended";
      } catch (cause) {
        return isRefusal(cause) ? "refused" : "unknown";
      }
    },
  });
  const terminal = vscode.window.createTerminal({ name: facts.name, pty });
  ptys.set(terminal, pty);
  terminal.show();
  return terminal;
};
