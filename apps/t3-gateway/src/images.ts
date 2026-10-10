import { randomUUID } from "node:crypto";

/**
 * Images on a t3code message (ADR 0012, "The surface", phase 2). t3code's client hands the gateway
 * each image as a data URL (`assets.persistChatAttachments`, its path for a server without upload
 * URLs); the gateway keeps the bytes in its state file until the message is sent, then places each
 * image in the session's workspace through Mend's `POST /api/sessions/:id/images` and names its
 * path in the turn, the way Mend's Slack runner does (`packages/slack/src/images.ts`): the agent
 * opens the file. Mend's rules are the gateway's: the formats it sniffs and its size limit.
 */

/** Mend's limit for one image (`PASTED_IMAGE_MAX_BYTES` in @mend/sessions). */
export const MEND_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** How many images one message may carry. */
export const MAX_IMAGES_PER_MESSAGE = 10;

/** The formats Mend takes, by their bytes (`detectImageType` in @mend/sessions). */
export type MendImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>, at = 0): boolean =>
  signature.every((byte, index) => bytes[at + index] === byte);

/** The format from the bytes themselves, as Mend reads it; null for one Mend refuses. */
export const detectImageType = (bytes: Uint8Array): MendImageType | null => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  return null;
};

/** The bytes of a `data:<mime>;base64,<data>` URL, or null when it is not one. */
export const parseDataUrl = (
  dataUrl: string,
): { readonly mimeType: string; readonly bytes: Uint8Array } | null => {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl.trim());
  if (match === null) return null;
  const [, mimeType = "", data = ""] = match;
  if (!/^[A-Za-z0-9+/=\s]*$/.test(data)) return null;
  return { mimeType: mimeType.toLowerCase(), bytes: new Uint8Array(Buffer.from(data, "base64")) };
};

/** A new attachment id, in t3code's id alphabet (`ChatAttachmentId`). */
export const newAttachmentId = (): string => `mend-image-${randomUUID()}`;

/** An image a message carries: what t3code shows, and where Mend placed it once sent. */
export interface MessageImage {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

/** The note a turn with images carries, so the agent opens them (as Slack's does). */
export const IMAGES_NOTE =
  "Images from t3code are saved as files in the workspace, at the paths shown. Open a path to see the image.";

/** What the gateway appends to a message's text for the images it placed. */
export const imagesBlock = (
  placed: ReadonlyArray<{ readonly name: string; readonly path: string }>,
): string =>
  placed.length === 0
    ? ""
    : `\n\n${placed.map((image) => `[image: ${image.name} · ${image.path}]`).join("\n")}\n\n${IMAGES_NOTE}`;

/** A message's text as the agent receives it: the person's words, then the images' paths. */
export const turnInputOf = (
  text: string,
  placed: ReadonlyArray<{ readonly name: string; readonly path: string }>,
): string => `${text}${imagesBlock(placed)}`;

/** The person's own words of a turn the gateway sent with images: the block it added, taken off. */
export const wordsOf = (
  input: string,
  placed: ReadonlyArray<{ readonly name: string; readonly path: string }>,
): string => {
  const block = imagesBlock(placed);
  return block.length > 0 && input.endsWith(block) ? input.slice(0, -block.length) : input;
};
