import { Schema } from "effect";

import { SessionControlEventId, SessionId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

export * from "./session-control-rules.ts";

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
 * `shared-control-ask` to `shared-control-take-back` are shared control for one person
 * (docs/adr/0026, decision 7): the actor did it, and `refId` names the person it concerned (the
 * one who asked, or whose grant was taken back). `shared-control-on` and `shared-control-off`
 * stay the switch for everyone; `off` also ends every grant.
 * `continued-after-terminal` is Mend's own (SLNT-1235): a session taken over in a terminal went
 * back to being a conversation once no terminal was open on it, at a turn boundary; the actor is
 * the session's owner, whose terminal it was, and `refId` the terminal agent that ended.
 * `terminal-unsent-left` goes beside it when someone had typed in that terminal and not sent it:
 * those words were left behind.
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
  "shared-control-ask",
  "shared-control-withdraw",
  "shared-control-grant",
  "shared-control-decline",
  "shared-control-take-back",
  "continued-after-terminal",
  "terminal-unsent-left",
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
