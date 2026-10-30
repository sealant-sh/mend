import { SessionId, Timestamp, ViewerConnectionId } from "@mend/domain";
import { DisplayNumber, ScreenLapse, ScreenLife } from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";

/**
 * A session's screen, for the people who watch it (docs/adr/0020-guis-in-sessions.md). Anyone who
 * can see the session reads it and watches it (D2); only its owner takes over and hands back (D3).
 *
 * Watching is a WebSocket: `GET /api/screen-socket?session=<id>&ticket=<screen ticket>`. Its
 * first frame is text, `ScreenSocketHello`, naming the connection Take over sends. Every later
 * frame from the server is binary RFB 3.8, starting with the server's ProtocolVersion; the
 * handshake offers security type None, since the ticket is the credential. A client hands only
 * the binary frames to its RFB viewer (Mend's web wraps the socket so noVNC never sees the text
 * frame). From the client, only binary RFB frames are read; a text frame closes the socket. The
 * server pings every five seconds; a client that answers nothing for ten is closed and loses the
 * input it held. The socket closes with one of `SCREEN_SOCKET_CLOSE`.
 */
export const ScreenSocketHello = Schema.Struct({
  type: Schema.Literal("connection"),
  connection: ViewerConnectionId,
});
export type ScreenSocketHello = typeof ScreenSocketHello.Type;

/** How the screen socket closes, and why. The reason text names the detail (a refusal, a cause). */
export const SCREEN_SOCKET_CLOSE = {
  /** The screen stopped. */
  screenEnded: 1000,
  /** The viewer's access ended: its project turned private, its device was revoked, it left the organization. */
  accessEnded: 1008,
  /** A client frame over `MEND_BUDGET_FRAME_BYTES`. */
  frameTooLarge: 1009,
  /** The connection to the screen was reset. */
  screenReset: 1011,
  /** Mend could not recheck the viewer's access in time; try again. */
  recheckUnavailable: 1013,
  /** The viewer broke the RFB handshake, sent a message outside the allow-list, or sent text. */
  viewerRefused: 4400,
  /** The session has no live screen this server can watch. */
  noScreen: 4404,
  /** The client answered no ping for ten seconds. */
  stoppedAnswering: 4408,
  /** The client left more than 8 MiB unsent. */
  fellBehind: 4413,
  /** The screen could not be dialled or signed in to. */
  unreachable: 4502,
} as const;

/** Who holds a screen's input, as watchers see it. */
export const ScreenHolder = Schema.Union([
  /** The agent holds it, or waits for its next look to take it (`awaiting`). */
  Schema.TaggedStruct("Agent", { awaiting: Schema.Boolean }),
  /** A person holds it, or is being handed it (`taking`). */
  Schema.TaggedStruct("Person", { userId: Schema.String, taking: Schema.Boolean }),
  /** The holder lapsed; the agent waits until the owner takes over, hands back, or the timeout. */
  Schema.TaggedStruct("Paused", { reason: ScreenLapse }),
]);
export type ScreenHolder = typeof ScreenHolder.Type;

export const ScreenRead = Schema.Union([
  Schema.TaggedStruct("NoScreen", {}),
  Schema.TaggedStruct("Screen", {
    display: DisplayNumber,
    width: Schema.Int,
    height: Schema.Int,
    life: ScreenLife,
    holder: ScreenHolder,
    /** When the holder was given the input, as the screen's log recorded it. */
    since: Schema.NullOr(Timestamp),
    /** The one person who may take over. */
    ownerUserId: Schema.NullOr(Schema.String),
  }),
]);
export type ScreenRead = typeof ScreenRead.Type;

/** What Take over or Hand back did. */
export const ScreenControlResult = Schema.Union([
  Schema.TaggedStruct("Changed", { holder: ScreenHolder }),
  Schema.TaggedStruct("Unchanged", {}),
  Schema.TaggedStruct("Refused", { why: Schema.Literals(["owner-only", "held", "look-first"]) }),
  Schema.TaggedStruct("NoScreen", {}),
  /** No hand could put the person's input on the screen, so it was not taken. */
  Schema.TaggedStruct("NoHand", {}),
  /** The connection is not a screen socket of the caller's open on this session. */
  Schema.TaggedStruct("NotWatching", {}),
]);
export type ScreenControlResult = typeof ScreenControlResult.Type;

export const screensGroup = HttpApiGroup.make("screens")
  .add(
    HttpApiEndpoint.get("read", "/sessions/:id/screen", {
      params: { id: SessionId },
      success: ScreenRead,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("take", "/sessions/:id/screen/take", {
      params: { id: SessionId },
      payload: Schema.Struct({ connection: ViewerConnectionId }),
      success: ScreenControlResult,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("handBack", "/sessions/:id/screen/hand-back", {
      params: { id: SessionId },
      success: ScreenControlResult,
      error: NotFound,
    }),
  )
  .middleware(AuthMiddleware);
