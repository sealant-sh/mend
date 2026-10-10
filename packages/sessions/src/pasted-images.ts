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
 * a new `paste/` is 0770 and the file 0640, both in the group `mend` (every person's own group),
 * so a process of anyone in the workspace reads it. No setgid bit: `mkdir` cannot set one, and the
 * writer changes the mode of no directory after making it (mend#615 review, finding 2).
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
    within: { root: saved, directoryMode: 0o770, fileMode: 0o640 },
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

const codeOf = (error: unknown): string =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "error";

/**
 * `bytes` as `<within.root>/<directories…>/<name>` on this machine, kept there as the workspace's
 * writer keeps a file (`SCRIPT_CONTAINED_PUT_FUNCTION`), with the same rules:
 *
 * - every directory reached through the descriptor of the one above it (`/proc/self/fd/<n>/…`, or
 *   `/dev/fd/<n>/…` where that is proved to reach the same directory), through no link, from the
 *   root's real path; with neither, nothing is written (mend#615 review 2, 615-1b);
 * - a missing directory made with `directoryMode` in its `mkdir` (under this process's umask, as
 *   before), and no directory's mode changed after (615-2);
 * - the file staged 0600 through no link and set `fileMode` through its own descriptor only once
 *   it is renamed into place and proved there (615-1a);
 * - a refused write truncates its file and takes its names back through a private quarantine name,
 *   removing only what is proved to be its own file (615-r2-1).
 *
 * Null once written; else why not, naming paths only.
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
  const fdDir = descriptorDirectory(dfd);
  let shown = within.root;
  const at = (entry: string) => `${fdDir}${dfd}/${entry}`;
  const linkOrNot = (entry: string) => {
    try {
      return fs.lstatSync(at(entry)).isSymbolicLink() ? "a link" : "not a directory";
    } catch {
      return "not a directory";
    }
  };
  let fd: number | undefined;
  try {
    if (fdDir === null) {
      return `no /proc/self/fd or /dev/fd here to keep the write inside ${within.root}`;
    }
    for (const part of directories) {
      let next: number;
      try {
        next = fs.openSync(at(part), enterFlags);
      } catch (error) {
        if (codeOf(error) !== "ENOENT") return `${linkOrNot(part)}: ${shown}/${part}`;
        try {
          fs.mkdirSync(at(part), { mode: within.directoryMode });
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
      fs.closeSync(dfd);
      dfd = next;
      shown = `${shown}/${part}`;
    }
    const expected = path.join(real, ...directories);
    // The directory at the path the file names, reached through no link, is the pinned one.
    const inPlace = () => {
      try {
        const held = fs.fstatSync(dfd);
        const named = fs.lstatSync(expected);
        return (
          named.isDirectory() &&
          named.dev === held.dev &&
          named.ino === held.ino &&
          fs.realpathSync(expected) === expected
        );
      } catch {
        return false;
      }
    };
    const moved = "its directory moved during the write";
    if (!inPlace()) return moved;
    const staging = `.mend-part-${randomBytes(8).toString("hex")}`;
    let staged: fs.Stats | null = null;
    const ours = (stat: fs.Stats) =>
      staged !== null && stat.dev === staged.dev && stat.ino === staged.ino;
    /** A name of the staged file taken back: renamed aside first, removed only once proved ours. */
    const takeBack = (entry: string) => {
      const aside = `.mend-quarantine-${randomBytes(8).toString("hex")}`;
      try {
        fs.renameSync(at(entry), at(aside));
      } catch {
        return;
      }
      try {
        const stat = fs.lstatSync(at(aside));
        if (ours(stat)) {
          fs.unlinkSync(at(aside));
        } else if (stat.isDirectory()) {
          fs.renameSync(at(aside), at(entry));
        } else {
          fs.linkSync(at(aside), at(entry));
          fs.unlinkSync(at(aside));
        }
      } catch {
        // Left where it is: what is not proved ours is never removed.
      }
    };
    const refuse = (why: string, entry: string) => {
      try {
        if (fd !== undefined) fs.ftruncateSync(fd, 0);
      } catch {
        // The file goes with its names below.
      }
      takeBack(entry);
      return why;
    };
    try {
      fd = fs.openSync(at(staging), c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o600);
      staged = fs.fstatSync(fd);
      fs.writeFileSync(fd, bytes);
    } catch (error) {
      return refuse(`could not write (${codeOf(error)})`, staging);
    }
    try {
      fs.renameSync(at(staging), at(name));
    } catch (error) {
      return refuse(`could not write (${codeOf(error)})`, staging);
    }
    let landed = false;
    try {
      landed = inPlace() && ours(fs.lstatSync(path.join(expected, name)));
    } catch {
      landed = false;
    }
    if (!landed) return refuse(moved, name);
    try {
      fs.fchmodSync(fd, within.fileMode);
    } catch (error) {
      return refuse(`could not set its mode (${codeOf(error)})`, name);
    }
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.closeSync(dfd);
  }
};

/**
 * The first of `/proc/self/fd/` and `/dev/fd/` through which `<base><fd>/.` is the directory `fd`
 * holds, so a path under it reaches that directory whatever its name is now; null when neither
 * does (macOS's `/dev/fd` opens a descriptor, it does not walk into one).
 */
const descriptorDirectory = (fd: number): string | null => {
  const held = fs.fstatSync(fd);
  for (const base of ["/proc/self/fd/", "/dev/fd/"]) {
    try {
      const seen = fs.statSync(`${base}${fd}/.`);
      if (seen.dev === held.dev && seen.ino === held.ino) return base;
    } catch {
      // Not here.
    }
  }
  return null;
};
