import type { SlackMessage } from "./blocks.ts";
import { escapeSlack } from "./markup.ts";
import type { SlackThreadFile, ThreadContext } from "./thread.ts";

/**
 * Screenshots from the thread (docs/adr/0006-slack.md, "What the session receives"): the images in
 * the request and in the thread messages a session receives are attached through the same path as
 * an image pasted into a session. Mend fetches each with the bot token (`files:read`), stores it
 * in the session's harness home as a pasted image, and the turn names the path the workspace sees.
 * The limits are the paste's own, per image, plus a bound on what one turn carries; an image over
 * any of them is skipped, and both the turn and the requester are told which and why.
 */

/** What one turn attaches at most, beside the paste's own per-image rules. */
export interface ThreadImageLimits {
  /** The media types an image may have, as the paste accepts them. */
  readonly mediaTypes: ReadonlyArray<string>;
  /** The most one image may be, in bytes: the paste's limit. */
  readonly maxBytes: number;
  /** The most images one turn attaches. */
  readonly maxImages: number;
  /** The most bytes of images one turn attaches. */
  readonly maxTotalBytes: number;
}

/** Why an image was not attached. */
export type ThreadImageSkip =
  /** Not one of the media types the paste accepts, as Slack says or as its bytes show. */
  | "type"
  /** Over the paste's limit for one image. */
  | "size"
  /** Past the number of images one turn attaches. */
  | "count"
  /** Past the bytes of images one turn attaches. */
  | "total"
  /** Slack gave no URL for it, or did not return it. */
  | "unreadable"
  /** Mend could not write it into the session's harness home. */
  | "not-stored";

/** What became of one image of the turn. */
export type ThreadImage =
  | {
      readonly kind: "attached";
      readonly file: SlackThreadFile;
      /** The file as the workspace sees it. */
      readonly path: string;
      readonly bytes: number;
    }
  | {
      readonly kind: "skipped";
      readonly file: SlackThreadFile;
      readonly reason: ThreadImageSkip;
      /** The reason, worded for the turn and for the requester. */
      readonly words: string;
    };

/** A file Slack calls an image. Other files are only named in the turn. */
export const isImageFile = (file: SlackThreadFile): boolean =>
  file.mimetype?.startsWith("image/") === true;

/**
 * The images a turn may attach, in the order they are taken: the request's own first, then the
 * thread's, newest message first. Only messages the session receives count, and a file shared
 * twice is taken once.
 */
export const turnImages = (
  requestFiles: ReadonlyArray<SlackThreadFile>,
  context: ThreadContext = { messages: [], omitted: 0 },
): ReadonlyArray<SlackThreadFile> => {
  const seen = new Set<string>();
  return [
    ...requestFiles,
    ...context.messages.toReversed().flatMap((message) => message.files),
  ].filter((file) => {
    if (!isImageFile(file) || seen.has(file.id)) return false;
    seen.add(file.id);
    return true;
  });
};

const megabytes = (bytes: number): string => {
  const value = bytes / 1024 / 1024;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
};

/** The reason an image was skipped, as the turn and the requester read it. */
export const imageSkipWords = (reason: ThreadImageSkip, limits: ThreadImageLimits): string => {
  switch (reason) {
    case "type":
      return "not a PNG, JPEG, GIF or WebP image";
    case "size":
      return `over the ${megabytes(limits.maxBytes)} MB an image may be`;
    case "count":
      return `past the ${limits.maxImages} images one turn carries`;
    case "total":
      return `past the ${megabytes(limits.maxTotalBytes)} MB of images one turn carries`;
    case "unreadable":
      return "Slack did not return the file";
    case "not-stored":
      return "Mend could not store the file";
  }
};

export const skippedImage = (
  file: SlackThreadFile,
  reason: ThreadImageSkip,
  limits: ThreadImageLimits,
): ThreadImage => ({ kind: "skipped", file, reason, words: imageSkipWords(reason, limits) });

/**
 * Why an image is skipped before it is fetched, from what Slack says of it, or null to fetch it.
 * `taken` is what the turn already attached. An image whose size Slack does not give is fetched,
 * with the room left as the most it may be.
 */
export const imageRefusal = (
  file: SlackThreadFile,
  taken: { readonly count: number; readonly bytes: number },
  limits: ThreadImageLimits,
): ThreadImageSkip | null => {
  if (file.mimetype === null || !limits.mediaTypes.includes(file.mimetype)) return "type";
  if (file.urlPrivate === null) return "unreadable";
  if (file.size !== null && file.size > limits.maxBytes) return "size";
  if (taken.count >= limits.maxImages) return "count";
  if (taken.bytes + (file.size ?? 0) > limits.maxTotalBytes) return "total";
  return null;
};

/** The most bytes a fetch may return: the image limit, or the room the turn has left. */
export const fetchLimit = (
  taken: { readonly bytes: number },
  limits: ThreadImageLimits,
): { readonly maxBytes: number; readonly over: ThreadImageSkip } => {
  const room = limits.maxTotalBytes - taken.bytes;
  return room < limits.maxBytes
    ? { maxBytes: room, over: "total" }
    : { maxBytes: limits.maxBytes, over: "size" };
};

const fileName = (file: SlackThreadFile): string => file.name ?? file.id;

/** One file as the turn names it: an attached image by its path, a skipped one with why. */
export const fileLine = (
  file: SlackThreadFile,
  images: ReadonlyMap<string, ThreadImage> = new Map(),
): string => {
  const image = images.get(file.id);
  if (image?.kind === "attached") return `[image: ${fileName(file)} · ${image.path}]`;
  if (image?.kind === "skipped") {
    return `[image: ${fileName(file)} · not attached · ${image.words}]`;
  }
  return `[${isImageFile(file) ? "image" : "file"}: ${fileName(file)}]`;
};

/** The line a turn with attached images carries, so the agent opens them. */
export const ATTACHED_IMAGES_NOTE =
  "Images from Slack are saved as files in the workspace, at the paths shown. Open a path to see the image.";

/** The requester's reply when images were left out, or null when none were. */
export const imagesNotAttached = (images: ReadonlyArray<ThreadImage>): SlackMessage | null => {
  const skipped = images.flatMap((image) =>
    image.kind === "skipped" ? [`${fileName(image.file)} · ${image.words}`] : [],
  );
  if (skipped.length === 0) return null;
  const text = escapeSlack(`not attached · ${skipped.join("; ")}`);
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
};
