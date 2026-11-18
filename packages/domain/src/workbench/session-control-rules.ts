import type { OrganizationRole } from "./organization.ts";

// Who may steer a session and type in its terminal: plain rules, free of Effect, so a client that
// checks them loads no Schema (`./session-control.ts` holds the Schemas and re-exports these).

/** The facts a steering decision reads. */
export interface SteeringFacts {
  readonly ownerUserId: string | null;
  /**
   * Set while the owner shares control with everyone who can see the project: shared control as
   * it was before it went to one person at a time (docs/adr/0026, decision 7).
   */
  readonly sharedControlEnabledAt: Date | null;
  /**
   * The people the owner granted shared control to, one by one, each after they asked
   * (docs/adr/0026, decision 7). Empty on a server from before, and while nobody holds a grant.
   */
  readonly sharedControlUserIds: ReadonlyArray<string>;
}

/**
 * Steering a session the caller can already see: its owner always; anyone else while the owner
 * shares control with everyone, or with them. A session with no owner is steered by nobody.
 */
export const canSteerSession = (session: SteeringFacts, callerUserId: string): boolean =>
  session.ownerUserId !== null &&
  (callerUserId === session.ownerUserId ||
    session.sharedControlEnabledAt !== null ||
    session.sharedControlUserIds.includes(callerUserId));

/**
 * Whether anyone besides the owner may steer the session now: shared control with everyone, or
 * with at least one person. What "shared control on" means to a client that knows only on and off.
 */
export const sharesControl = (
  session: Pick<SteeringFacts, "ownerUserId" | "sharedControlEnabledAt" | "sharedControlUserIds">,
): boolean =>
  session.ownerUserId !== null &&
  (session.sharedControlEnabledAt !== null || session.sharedControlUserIds.length > 0);

/**
 * Asking the owner for shared control of a session the caller can see (docs/adr/0026, decision
 * 7): anyone but its owner who cannot already steer it. A session with no owner has nobody to ask.
 */
export const canAskSharedControl = (session: SteeringFacts, callerUserId: string): boolean =>
  session.ownerUserId !== null &&
  callerUserId !== session.ownerUserId &&
  !canSteerSession(session, callerUserId);

/**
 * Typing into a session's terminal, starting its agent in one, opening a shell or running a
 * command in its workspace: the owner's alone, even while control is shared
 * (docs/adr/0013-whoever-sends-a-turn-pays.md). Each runs on whatever login the workspace holds
 * and has no turn to switch it at, so a steerer's keys would spend the owner's. Steering a
 * terminal session means continuing it as a conversation.
 */
export const canTypeInTerminal = (
  session: Pick<SteeringFacts, "ownerUserId">,
  callerUserId: string,
): boolean => session.ownerUserId !== null && callerUserId === session.ownerUserId;

/** What everyone but the owner reads beside a session's terminal (docs/adr/0013). */
export const terminalReadOnlyLine = (ownerName: string): string =>
  `This session runs in a terminal. Only ${ownerName} types here; they can continue it as a conversation.`;

/**
 * Whether resuming a session, or sending a review back to it, starts its agent in a terminal: the
 * owner's alone, even while control is shared (docs/adr/0013). Only a conversation
 * (`agent-protocol`) on the same harness comes back as one; anything else, a session that never
 * launched an agent included, opens a terminal. `agentKind` is the kind of the session's current
 * agent process, null when it has none. Clients read it to offer a steerer only what the server
 * takes from them.
 */
export const startsInTerminal = (agentKind: string | null, harnessChanges = false): boolean =>
  agentKind !== "agent-protocol" || harnessChanges;

/**
 * Whether a viewer may resume a session, or send a review back to it: steering it, and, when
 * that starts its agent in a terminal, owning it (docs/adr/0003, docs/adr/0013). `control` is the
 * session control view the server sends, or a client's own reading of the same rules.
 */
export const canRelaunchSession = (
  control: { readonly steer: boolean; readonly terminalInput: boolean },
  agentKind: string | null,
  harnessChanges = false,
): boolean =>
  control.steer && (control.terminalInput || !startsInTerminal(agentKind, harnessChanges));

/** What a terminal session's owner alone does, beyond typing in it (docs/adr/0013). */
export type TerminalOwnerAct = "resume" | "send-back";

/** What everyone but the owner reads where resuming or sending a review back would be. */
export const terminalOwnerOnlyLine = (ownerName: string, act: TerminalOwnerAct): string =>
  `This session runs in a terminal. Only ${ownerName} ${
    act === "resume" ? "resumes it" : "sends comments to it"
  }; they can continue it as a conversation.`;

/**
 * Turning shared control on, for everyone or for one person who asked, is the owner's choice
 * alone: in a worktree that shares one home it lends their credentials. Turning it off, or taking
 * it back from one person, is also open to an organization owner, who can always take back a
 * teammate's session.
 */
export const canToggleSharedControl = (
  session: SteeringFacts,
  caller: { readonly userId: string; readonly role: OrganizationRole },
  enable: boolean,
): boolean =>
  session.ownerUserId !== null &&
  (caller.userId === session.ownerUserId || (!enable && caller.role === "owner"));
