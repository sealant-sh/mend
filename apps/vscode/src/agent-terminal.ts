import { canSteerSession } from "@mend/domain/workbench";
import * as vscode from "vscode";

import type { MendClient } from "./client.js";
import { displaySession } from "./session-lines.js";
import { isRefusal } from "./tty-attachment.js";
import { attachableProcesses, type TtyAddress } from "./tty-protocol.js";
import { MendTtyTerminal } from "./tty-terminal.js";
import type { Session } from "./types.js";

/** Whether the server lets `viewer` steer, and so attach to the terminal of, `session`. */
export const maySteer = (session: Session, viewer: string): boolean =>
  canSteerSession(
    {
      ownerUserId: session.ownerUserId,
      sharedControlEnabledAt:
        session.sharedControlEnabledAt === null ? null : new Date(session.sharedControlEnabledAt),
    },
    viewer,
  );

/** Whether `viewer` types in the session's terminals: its owner, or anyone when Mend cannot say. */
export const ownsSession = (session: Session, viewer: string | null): boolean =>
  viewer === null || session.ownerUserId === null || viewer === session.ownerUserId;

/** A member's name as the organization lists it; "another person" when it cannot say. */
export const memberName = async (client: MendClient, userId: string | null): Promise<string> => {
  if (userId === null) return "another person";
  const names = await client.memberNames();
  return names.find((member) => member.userId === userId)?.name ?? "another person";
};

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
  const terminal = vscode.window.createTerminal({
    name: facts.name,
    pty: new MendTtyTerminal({
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
    }),
  });
  terminal.show();
  return terminal;
};
