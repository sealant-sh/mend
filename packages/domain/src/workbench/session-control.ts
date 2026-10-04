import { Schema } from "effect";

import { SessionControlEventId, SessionId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";
import type { OrganizationRole } from "./organization.ts";

/**
 * Who did what to a session beyond sending turns (docs/adr/0003-organizations-and-tenancy.md).
 * Turns carry their author and approvals their decider; these are the other steering acts, so a
 * shared session always says who interrupted, attached or stopped it, or stopped its Services.
 * `idle-stop` is Mend's own: the protocol agent sat idle past MEND_PROTOCOL_IDLE_STOP_MINUTES, and
 * the actor is the session's owner, whose agent it was. `discard-unsaved-stop` is the owner's
 * explicit "discard unsaved and stop": the one act that ends a workspace while captures are still
 * pending (docs/adr/0002-session-capture-store.md, "Stop drains, then terminates").
 * `terminal-watch` is an attach by someone other than the owner: output only, since only the
 * owner types in a session's terminal (docs/adr/0013-whoever-sends-a-turn-pays.md).
 */
export const SessionControlKind = Schema.Literals([
  "interrupt",
  "terminal-attach",
  "terminal-watch",
  "shell-open",
  "stop",
  "services-stop",
  "idle-stop",
  "shared-control-on",
  "shared-control-off",
  "discard-unsaved-stop",
]);
export type SessionControlKind = typeof SessionControlKind.Type;

export class SessionControlEvent extends Schema.Class<SessionControlEvent>("SessionControlEvent")({
  id: SessionControlEventId,
  sessionId: SessionId,
  actorUserId: Schema.String,
  kind: SessionControlKind,
  /** The turn, process or Service the act concerned, when it concerned one. */
  refId: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
}) {}

/** The facts a steering decision reads. */
export interface SteeringFacts {
  readonly ownerUserId: string | null;
  readonly sharedControlEnabledAt: Date | null;
}

/**
 * Steering a session the caller can already see: its owner always, anyone else only while the
 * owner shares control. A session with no owner is steered by nobody.
 */
export const canSteerSession = (session: SteeringFacts, callerUserId: string): boolean =>
  session.ownerUserId !== null &&
  (callerUserId === session.ownerUserId || session.sharedControlEnabledAt !== null);

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
 * Turning shared control on is the owner's choice alone: it lends their credentials. Turning it
 * off is also open to an organization owner, who can always take back a teammate's session.
 */
export const canToggleSharedControl = (
  session: SteeringFacts,
  caller: { readonly userId: string; readonly role: OrganizationRole },
  enable: boolean,
): boolean =>
  session.ownerUserId !== null &&
  (caller.userId === session.ownerUserId || (!enable && caller.role === "owner"));
