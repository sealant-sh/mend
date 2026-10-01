/**
 * Messages sent from this phone that the conversation has not shown back yet.
 *
 * A send shows at once: the message joins the end of the conversation as a pending turn, keyed
 * by an id the phone made (`clientId`). The server's answer to the send names the turn it
 * recorded; from then on the pending turn is matched by that id, never by its text, so two sends
 * of the same words stay two turns and a recorded turn is never shown twice. When the recorded
 * turn arrives in the conversation it takes the pending turn's place and its key, so the row does
 * not remount, move, or flash. A send the server refused stays where it was, marked, with retry.
 *
 * Nothing here touches React Native, so it runs under vitest.
 */

import type {
  AgentConversationEntry,
  AgentItemDto,
  AgentRequestDto,
  AgentTurnDto,
} from "@mend/agent-conversation";

import { parseTurnInput } from "./turn-input";

export interface LocalImage {
  readonly name: string;
  /** The file as the workspace sees it. */
  readonly path: string;
  /** The phone's own copy, for the thumbnail. */
  readonly uri: string;
}

export interface PendingTurn {
  readonly clientId: string;
  /** What the composer held, for Edit. */
  readonly text: string;
  /** The turn as submitted: the text and the image lines. */
  readonly input: string;
  readonly images: ReadonlyArray<LocalImage>;
  /**
   * `sending`: the request is out, or queued behind an earlier send. `sent`: the server recorded
   * turn `turnId`. `failed`: the server refused it, or never answered.
   */
  readonly status: "sending" | "sent" | "failed";
  readonly turnId: string | null;
  readonly error: string | null;
}

export type PendingTurnEvent =
  | {
      readonly type: "queued";
      readonly clientId: string;
      readonly text: string;
      readonly input: string;
      readonly images: ReadonlyArray<LocalImage>;
    }
  | { readonly type: "delivered"; readonly clientId: string; readonly turnId: string }
  | { readonly type: "failed"; readonly clientId: string; readonly error: string }
  | { readonly type: "retried"; readonly clientId: string }
  | { readonly type: "discarded"; readonly clientId: string };

const patch = (
  pending: ReadonlyArray<PendingTurn>,
  clientId: string,
  next: (turn: PendingTurn) => PendingTurn | null,
): ReadonlyArray<PendingTurn> => {
  let changed = false;
  const updated = pending.map((turn) => {
    if (turn.clientId !== clientId) return turn;
    const replaced = next(turn);
    if (replaced === null) return turn;
    changed = true;
    return replaced;
  });
  return changed ? updated : pending;
};

export const pendingTurnsReducer = (
  pending: ReadonlyArray<PendingTurn>,
  event: PendingTurnEvent,
): ReadonlyArray<PendingTurn> => {
  switch (event.type) {
    case "queued":
      if (pending.some((turn) => turn.clientId === event.clientId)) return pending;
      return [
        ...pending,
        {
          clientId: event.clientId,
          text: event.text,
          input: event.input,
          images: event.images,
          status: "sending",
          turnId: null,
          error: null,
        },
      ];
    case "delivered":
      return patch(pending, event.clientId, (turn) =>
        turn.status === "sending"
          ? { ...turn, status: "sent", turnId: event.turnId, error: null }
          : null,
      );
    case "failed":
      return patch(pending, event.clientId, (turn) =>
        turn.status === "sending" ? { ...turn, status: "failed", error: event.error } : null,
      );
    case "retried":
      return patch(pending, event.clientId, (turn) =>
        turn.status === "failed" ? { ...turn, status: "sending", error: null } : null,
      );
    case "discarded": {
      const kept = pending.filter(
        (turn) => turn.clientId !== event.clientId || turn.status !== "failed",
      );
      return kept.length === pending.length ? pending : kept;
    }
  }
};

// ─── the conversation as the phone shows it ─────────────────────────────────

export interface TurnImageView {
  readonly name: string;
  readonly path: string;
  /** The phone's copy when this phone sent it; null for an image read back from the record. */
  readonly uri: string | null;
}

export interface TurnView {
  /** The text the person wrote, without the image lines. */
  readonly text: string;
  readonly images: ReadonlyArray<TurnImageView>;
  /** `sending` until the server recorded it, `failed` when it did not; else `recorded`. */
  readonly delivery: "sending" | "failed" | "recorded";
  /** The send's error, or the recorded turn's own. */
  readonly error: string | null;
  /** The pending turn behind this row, for retry and edit. */
  readonly clientId: string | null;
  /** The recorded turn, once there is one. */
  readonly turn: AgentTurnDto | null;
}

export type ConversationRow =
  | { readonly kind: "turn"; readonly key: string; readonly view: TurnView }
  | { readonly kind: "item"; readonly key: string; readonly item: AgentItemDto }
  | { readonly kind: "request"; readonly key: string; readonly request: AgentRequestDto };

const pendingKey = (clientId: string): string => `local:${clientId}`;

const withUris = (
  images: ReadonlyArray<{ readonly name: string; readonly path: string }>,
  local: ReadonlyArray<LocalImage>,
): ReadonlyArray<TurnImageView> =>
  images.map((image) => ({
    name: image.name,
    path: image.path,
    uri: local.find((own) => own.path === image.path)?.uri ?? null,
  }));

/** Recorded turn ids the conversation holds. */
const recordedTurnIds = (entries: ReadonlyArray<AgentConversationEntry>): ReadonlySet<string> =>
  new Set(entries.flatMap((entry) => (entry.kind === "turn" ? [entry.turn.id] : [])));

const pendingRow = (turn: PendingTurn): ConversationRow => ({
  kind: "turn",
  key: pendingKey(turn.clientId),
  view: {
    text: turn.text,
    images: turn.images.map((image) => ({ name: image.name, path: image.path, uri: image.uri })),
    delivery: turn.status === "failed" ? "failed" : "sending",
    error: turn.error,
    clientId: turn.clientId,
    turn: null,
  },
});

/**
 * The conversation with this phone's sends folded in. A recorded turn this phone sent keeps the
 * pending turn's key and its local thumbnails. A send the conversation does not hold yet stays in
 * the order it was made: before any later send of this phone's that is recorded (a failed send
 * does not jump below the message typed after it), else at the end.
 */
export const reconcileConversation = (
  entries: ReadonlyArray<AgentConversationEntry>,
  pending: ReadonlyArray<PendingTurn>,
): ReadonlyArray<ConversationRow> => {
  const recorded = recordedTurnIds(entries);
  const order = new Map<string, number>();
  pending.forEach((turn, index) => {
    if (turn.turnId !== null) order.set(turn.turnId, index);
  });
  const waiting = pending.filter((turn) => turn.turnId === null || !recorded.has(turn.turnId));
  const placed = new Set<string>();
  const rows: Array<ConversationRow> = [];
  for (const entry of entries) {
    if (entry.kind !== "turn") {
      rows.push(entry);
      continue;
    }
    const index = order.get(entry.turn.id);
    const own = index === undefined ? undefined : pending[index];
    if (own !== undefined && index !== undefined) {
      for (const earlier of waiting) {
        if (placed.has(earlier.clientId)) continue;
        if (pending.indexOf(earlier) > index) break;
        placed.add(earlier.clientId);
        rows.push(pendingRow(earlier));
      }
    }
    const parsed = parseTurnInput(entry.turn.input);
    rows.push({
      kind: "turn",
      key: own === undefined ? entry.key : pendingKey(own.clientId),
      view: {
        text: parsed.text,
        images: withUris(parsed.images, own?.images ?? []),
        delivery: "recorded",
        error: entry.turn.error,
        clientId: own?.clientId ?? null,
        turn: entry.turn,
      },
    });
  }
  for (const turn of waiting) {
    if (!placed.has(turn.clientId)) rows.push(pendingRow(turn));
  }
  return rows;
};

/** A send the conversation does not show recorded yet — the agent is about to be busy. */
export const hasUnrecordedSend = (
  entries: ReadonlyArray<AgentConversationEntry>,
  pending: ReadonlyArray<PendingTurn>,
): boolean => {
  const recorded = recordedTurnIds(entries);
  return pending.some(
    (turn) =>
      turn.status === "sending" ||
      (turn.status === "sent" && turn.turnId !== null && !recorded.has(turn.turnId)),
  );
};
