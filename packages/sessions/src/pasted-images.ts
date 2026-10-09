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
 *
 * A person-layout executor (docs/adr/0016) writes a paste as the person who sent it, into their
 * own saved directory (`people/<account id>/paste/`), since nobody's user but root's may make a
 * directory in the harness home itself. Every writer keeps the file inside the directory it names
 * (the harness home, or the person's saved directory): it enters no link on the way, changes the
 * mode of no directory already there, and refuses rather than write anywhere else (mend#597 review,
 * finding 2: a `paste` link planted in the harness home led a root write, and a 0755 chmod, outside
 * it).
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { posix } from "node:path";

import { Effect, Schema } from "effect";

import { savedDirOf } from "./harness-layout.ts";
import { HARNESS_HOME_MOUNT_PATH } from "./harness-state.ts";
import type { ContainedPlacement } from "./workspace-files.ts";

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

/**
 * Where a paste goes in a live workspace, and what keeps it there (`ContainedPlacement`). A shared
 * executor: the harness home's `paste/`, written as root, a new directory 0755 and the file 0644,
 * as before. A person executor (docs/adr/0016): the sender's own saved directory, written as them;
 * a new `paste/` is the group's (`mend`), group-writable and setgid like a shared conversation
 * (decision 2), so a process of anyone in the workspace reads the file, which is 0640.
 */
export const pastedImagePlacement = (
  name: string,
  /** The sender's account id in a person executor; null in a shared one. */
  person: string | null,
): { readonly path: string; readonly within: ContainedPlacement } => {
  if (person === null) {
    return {
      path: pastedImageWorkspacePath(name),
      within: { root: HARNESS_HOME_MOUNT_PATH, directoryMode: 0o755, fileMode: 0o644 },
    };
  }
  const saved = savedDirOf(HARNESS_HOME_MOUNT_PATH, person);
  return {
    path: posix.join(saved, PASTED_IMAGE_DIR, name),
    within: { root: saved, directoryMode: 0o2770, fileMode: 0o640 },
  };
};

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
  const hostPath = path.join(harnessHome, PASTED_IMAGE_DIR, name);
  const failed = (message: string) =>
    new PastedImageError({
      reason: "write-failed",
      message: `Could not store the image: ${message}`,
    });
  // The harness home is Mend's, made here before a launch; everything below it is the workspace's
  // too (mounted read-write), so the write enters no link there.
  yield* Effect.try({
    try: () => fs.mkdirSync(harnessHome, { recursive: true, mode: 0o755 }),
    catch: (cause) => failed(cause instanceof Error ? cause.message : String(cause)),
  });
  // The workspace reads the file as whatever uid the harness runs under; the mode-keeper in
  // harness-state.ts widens the tree too, but only every 15 s — a paste must be readable the
  // instant the path lands.
  const refused = yield* Effect.try({
    try: () =>
      writeContained(
        { root: harnessHome, directoryMode: 0o755, fileMode: 0o644 },
        [PASTED_IMAGE_DIR],
        name,
        bytes,
      ),
    catch: (cause) => failed(cause instanceof Error ? cause.message : String(cause)),
  });
  if (refused !== null) return yield* failed(refused);
  return {
    hostPath,
    path: pastedImageWorkspacePath(name),
    mediaType,
    bytes: bytes.byteLength,
  } satisfies StoredPastedImage;
});

/** A descriptor's directory, entered again without walking its path (Linux). */
const proc = (fd: number) => `/proc/self/fd/${fd}`;

const codeOf = (error: unknown): string =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "error";

/**
 * `bytes` as `<within.root>/<directories…>/<name>` on this machine, kept there as the workspace's
 * writer keeps a file (`SCRIPT_CONTAINED_PUT_FUNCTION`): the root entered at its real path, each
 * directory below it opened through no link (through the last one's descriptor where `/proc` has
 * it), one missing made `directoryMode` and one already there left as it is, the file staged
 * exclusively through no link and renamed into place while its directory is still where its path
 * says. Null once written; else why not, naming paths only.
 */
export const writeContained = (
  within: ContainedPlacement,
  directories: ReadonlyArray<string>,
  name: string,
  bytes: Uint8Array,
): string | null => {
  const c = fs.constants;
  if (
    name === "" ||
    name.includes("/") ||
    [name, ...directories].some((part) => part === "." || part === ".." || part.includes("/"))
  ) {
    return "not a plain path";
  }
  let real: string;
  try {
    real = fs.realpathSync(within.root);
  } catch {
    return `could not enter ${within.root}`;
  }
  const enterFlags = c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW;
  let dfd: number;
  try {
    dfd = fs.openSync(real, enterFlags);
  } catch {
    return `could not enter ${within.root}`;
  }
  const pinned = fs.existsSync(proc(dfd));
  let literal = real;
  let shown = within.root;
  const at = (entry: string) => `${pinned ? proc(dfd) : literal}/${entry}`;
  const linkOrNot = (entry: string) => {
    try {
      return fs.lstatSync(at(entry)).isSymbolicLink() ? "a link" : "not a directory";
    } catch {
      return "not a directory";
    }
  };
  try {
    for (const part of directories) {
      let next: number;
      let made = false;
      try {
        next = fs.openSync(at(part), enterFlags);
      } catch (error) {
        if (codeOf(error) !== "ENOENT") return `${linkOrNot(part)}: ${shown}/${part}`;
        try {
          fs.mkdirSync(at(part), { mode: 0o700 });
          made = true;
        } catch (mkdirError) {
          if (codeOf(mkdirError) !== "EEXIST") {
            return `could not make ${shown}/${part} (${codeOf(mkdirError)})`;
          }
        }
        try {
          next = fs.openSync(at(part), enterFlags);
        } catch {
          return `${linkOrNot(part)}: ${shown}/${part}`;
        }
      }
      try {
        if (made) fs.fchmodSync(next, within.directoryMode);
      } catch (error) {
        fs.closeSync(next);
        return `could not set the mode of ${shown}/${part} (${codeOf(error)})`;
      }
      fs.closeSync(dfd);
      dfd = next;
      literal = `${literal}/${part}`;
      shown = `${shown}/${part}`;
    }
    const staging = `.mend-part-${randomBytes(8).toString("hex")}`;
    const unstage = () => {
      try {
        fs.unlinkSync(at(staging));
      } catch {
        // Nothing staged, or gone already.
      }
    };
    const expected = path.join(real, ...directories);
    const inPlace = () => {
      try {
        return (pinned ? fs.readlinkSync(proc(dfd)) : fs.realpathSync(literal)) === expected;
      } catch {
        return false;
      }
    };
    let fd: number | undefined;
    try {
      fd = fs.openSync(at(staging), c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fchmodSync(fd, within.fileMode);
    } catch (error) {
      if (fd !== undefined) unstage();
      return `could not write (${codeOf(error)})`;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    if (!inPlace()) {
      unstage();
      return "its directory moved during the write";
    }
    try {
      fs.renameSync(at(staging), at(name));
    } catch (error) {
      unstage();
      return `could not write (${codeOf(error)})`;
    }
    return null;
  } finally {
    fs.closeSync(dfd);
  }
};
