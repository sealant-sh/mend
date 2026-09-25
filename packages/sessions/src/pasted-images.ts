/**
 * Images pasted onto a session's terminal.
 *
 * A TUI's own Ctrl+V reads the clipboard of the machine it runs on — the
 * workspace container, which has none. What both harness TUIs do accept is a
 * pasted PATH to an image file: codex attaches it as an image input, claude
 * reads it. So the client uploads the bytes, Mend writes them under the
 * session's durable harness home (`sessions/<id>/harness-home/paste/`, mounted
 * read-write into every workspace the session gets at
 * `HARNESS_HOME_MOUNT_PATH`), and the terminal pastes the container path.
 *
 * Capture mode mounts nothing (ADR-0002), so there the bytes go into the live workspace's own
 * harness home through exec, at the same path (`SessionEngine.storePastedImage`); a session with no
 * live workspace answers "not live" rather than storing a file no workspace will see.
 *
 * The harness home, not the worktree: nothing to exclude from the change or
 * the checkpoints, nothing a `git clean -fdx` can take, and the directory
 * lives and dies with the session. `paste/` sits beside the relocated harness
 * state directories, so the settle-time state capture (which tars only those)
 * never carries the images.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { posix } from "node:path";

import { Effect, Schema } from "effect";

import { HARNESS_HOME_MOUNT_PATH } from "./harness-state.ts";

export const PASTED_IMAGE_DIR = "paste";
/** Codex base64-encodes the file into every request that carries it; keep it bounded. */
export const PASTED_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export const PASTED_IMAGE_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
} as const;
export type PastedImageMediaType = keyof typeof PASTED_IMAGE_TYPES;

export class PastedImageError extends Schema.TaggedErrorClass<PastedImageError>()(
  "PastedImageError",
  {
    reason: Schema.Literals(["not-an-image", "too-large", "write-failed"]),
    message: Schema.String,
  },
) {}

/** What a paste answers wherever it landed: the path the terminal pastes, the format, the size. */
export interface PlacedPastedImage {
  /** The file as the workspace sees it — what the terminal pastes. */
  readonly path: string;
  readonly mediaType: PastedImageMediaType;
  readonly bytes: number;
}

export interface StoredPastedImage {
  /** Where the bytes landed on this side of the mount. */
  readonly hostPath: string;
  /** The same file as the workspace sees it — what the terminal pastes. */
  readonly path: string;
  readonly mediaType: PastedImageMediaType;
  readonly bytes: number;
}

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>, at = 0): boolean =>
  signature.every((byte, index) => bytes[at + index] === byte);

/**
 * The format from the bytes themselves. A client's declared type is a claim;
 * codex reads the file's dimensions before attaching it, so a mislabelled
 * upload would fail silently at the far end instead of here.
 */
export const detectImageType = (bytes: Uint8Array): PastedImageMediaType | null => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return "image/webp";
  return null;
};

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** `20260902-143012-3f9a.png` — sortable, unique enough, readable in a prompt. */
export const pastedImageName = (
  mediaType: PastedImageMediaType,
  now: Date,
  nonce: string,
): string => {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${nonce}.${PASTED_IMAGE_TYPES[mediaType]}`;
};

/** An accepted paste: its format from the bytes, and the file name it lands under. */
export interface CheckedPastedImage {
  readonly mediaType: PastedImageMediaType;
  readonly name: string;
}

/** Where a pasted image sits as the workspace sees it — what the terminal pastes. */
export const pastedImageWorkspacePath = (name: string): string =>
  posix.join(HARNESS_HOME_MOUNT_PATH, PASTED_IMAGE_DIR, name);

/** Refuse what is too large or not an image, before any byte is written; name what is not. */
export const checkPastedImage = Effect.fn("checkPastedImage")(function* (
  bytes: Uint8Array,
  options: { readonly now?: Date; readonly nonce?: string } = {},
) {
  if (bytes.byteLength > PASTED_IMAGE_MAX_BYTES) {
    return yield* new PastedImageError({
      reason: "too-large",
      message: `The image is ${Math.ceil(bytes.byteLength / 1024 / 1024)} MB; the limit is ${PASTED_IMAGE_MAX_BYTES / 1024 / 1024} MB.`,
    });
  }
  const mediaType = detectImageType(bytes);
  if (mediaType === null) {
    return yield* new PastedImageError({
      reason: "not-an-image",
      message: "Only PNG, JPEG, GIF, and WebP images can be pasted.",
    });
  }
  const name = pastedImageName(
    mediaType,
    options.now ?? new Date(),
    options.nonce ?? Math.random().toString(16).slice(2, 6).padEnd(4, "0"),
  );
  return { mediaType, name } satisfies CheckedPastedImage;
});

/**
 * Write one pasted image into the session's harness home on this machine — the co-located store,
 * where that directory is mounted into every workspace the session gets. `harnessHome` is the
 * host-side directory (`harnessHomePathOf` in the store); the directory is created if the session
 * has not launched yet, and the launch mounts it. Capture mode mounts nothing: the engine writes
 * into the live workspace instead (`SessionEngine.storePastedImage`).
 */
export const storePastedImage = Effect.fn("storePastedImage")(function* (
  harnessHome: string,
  bytes: Uint8Array,
  options: { readonly now?: Date; readonly nonce?: string } = {},
) {
  const { mediaType, name } = yield* checkPastedImage(bytes, options);
  const directory = path.join(harnessHome, PASTED_IMAGE_DIR);
  const hostPath = path.join(directory, name);
  yield* Effect.tryPromise({
    try: async () => {
      // The workspace reads the file as whatever uid the harness runs under;
      // the mode-keeper in harness-state.ts widens the tree too, but only
      // every 15 s — a paste must be readable the instant the path lands.
      await fs.mkdir(directory, { recursive: true, mode: 0o755 });
      await fs.writeFile(hostPath, bytes, { mode: 0o644 });
    },
    catch: (cause) =>
      new PastedImageError({
        reason: "write-failed",
        message: `Could not store the image: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
  return {
    hostPath,
    path: pastedImageWorkspacePath(name),
    mediaType,
    bytes: bytes.byteLength,
  } satisfies StoredPastedImage;
});
