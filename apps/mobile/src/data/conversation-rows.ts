/**
 * The conversation as the phone shows it: each person's message read back as its words and the
 * images it carries, with this phone's own copy of an image it sent shown as a thumbnail.
 *
 * Nothing here touches React Native, so it runs under vitest.
 */

import type {
  AgentConversationEntry,
  AgentItemDto,
  AgentRequestDto,
  AgentSteerDeliveryDto,
  AgentTurnDto,
  AgentTurnSteerDto,
} from "@mend/agent-conversation";

import { parseTurnInput } from "./turn-input";

export interface LocalImage {
  readonly name: string;
  /** The file as the workspace sees it. */
  readonly path: string;
  /** The phone's own copy, for the thumbnail. */
  readonly uri: string;
}

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
  readonly error: string | null;
  readonly turn: AgentTurnDto;
}

export interface SteerView {
  readonly text: string;
  readonly images: ReadonlyArray<TurnImageView>;
  readonly steer: AgentTurnSteerDto;
}

export type ConversationRow =
  | { readonly kind: "turn"; readonly key: string; readonly view: TurnView }
  | { readonly kind: "steer"; readonly key: string; readonly view: SteerView }
  | { readonly kind: "item"; readonly key: string; readonly item: AgentItemDto }
  | { readonly kind: "request"; readonly key: string; readonly request: AgentRequestDto };

const withUris = (
  images: ReadonlyArray<{ readonly name: string; readonly path: string }>,
  local: ReadonlyArray<LocalImage>,
): ReadonlyArray<TurnImageView> =>
  images.map((image) => ({
    name: image.name,
    path: image.path,
    uri: local.find((own) => own.path === image.path)?.uri ?? null,
  }));

/** What became of a steer, said quietly under its words. */
export const steerDeliveryWords = (delivery: AgentSteerDeliveryDto): string => {
  switch (delivery._tag) {
    case "Sending":
      return "sending";
    case "Accepted":
      return delivery.evidence === "provider-acknowledged"
        ? "the agent acknowledged it"
        : "written to the agent";
    case "Queued":
      return "sent as the next turn";
    case "Unknown":
      return "delivery not confirmed";
    case "NotSent":
      return "not sent";
  }
};

/**
 * The conversation's rows. `ownImages` holds, by recorded turn or steer id, the images this phone
 * sent with it, so the row shows the phone's copy rather than only the name.
 */
export const conversationRows = (
  entries: ReadonlyArray<AgentConversationEntry>,
  ownImages: ReadonlyMap<string, ReadonlyArray<LocalImage>>,
): ReadonlyArray<ConversationRow> =>
  entries.flatMap((entry): ReadonlyArray<ConversationRow> => {
    if (entry.kind === "steer") {
      const parsed = parseTurnInput(entry.steer.input);
      return [
        {
          kind: "steer",
          key: entry.key,
          view: {
            text: parsed.text,
            images: withUris(parsed.images, ownImages.get(entry.steer.id) ?? []),
            steer: entry.steer,
          },
        },
      ];
    }
    if (entry.kind !== "turn") return [entry];
    const parsed = parseTurnInput(entry.turn.input);
    return [
      {
        kind: "turn",
        key: entry.key,
        view: {
          text: parsed.text,
          images: withUris(parsed.images, ownImages.get(entry.turn.id) ?? []),
          error: entry.turn.error,
          turn: entry.turn,
        },
      },
    ];
  });
