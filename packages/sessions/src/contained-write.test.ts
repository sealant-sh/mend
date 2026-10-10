/**
 * The two writers that keep a pasted image inside its directory (`writeContained` on this machine,
 * `containedPut` in a workspace), raced the way the reviews of mend#615 raced them: real renames,
 * directories and files, made at the moment the writer checks a directory's path, makes a
 * directory, renames the file into place or takes it back.
 */

import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeContained } from "./pasted-images.ts";
import { SCRIPT_CONTAINED_PUT_FUNCTION } from "./script-transport.ts";

const require = createRequire(import.meta.url);
/** The `fs` both writers call: its functions replaced here reach them. */
const nodeFs: typeof fs = require("node:fs");
const original = {
  lstatSync: nodeFs.lstatSync,
  statSync: nodeFs.statSync,
  mkdirSync: nodeFs.mkdirSync,
  renameSync: nodeFs.renameSync,
};

/** `fs[name]` replaced, for both writers, by `replacement` (given the original). */
const hook = (
  name: keyof typeof original,
  replacement: (call: (...args: Array<never>) => unknown) => (...args: Array<never>) => unknown,
) => {
  Reflect.set(nodeFs, name, replacement(original[name]));
  syncBuiltinESMExports();
};
const unhook = () => {
  Object.assign(nodeFs, original);
  syncBuiltinESMExports();
};

const containedPut: (
  root: string,
  directoryMode: number,
  fileMode: number,
  target: string,
  bytes: Uint8Array,
) => string | null = new Function(
  "fs",
  "require",
  `${SCRIPT_CONTAINED_PUT_FUNCTION}; return containedPut;`,
)(nodeFs, require);

const BYTES = new Uint8Array(Buffer.from("pasted image bytes"));
const modeOf = (at: string) => fs.lstatSync(at).mode & 0o7777;

/**
 * `call`, running `race` once: before the first call `when` matches (`at: "before"`), or after it
 * returned (`at: "after"`).
 */
const racing =
  (
    when: (args: ReadonlyArray<unknown>) => boolean,
    race: () => void,
    at: "before" | "after" = "after",
  ) =>
  (call: (...args: Array<never>) => unknown) => {
    let raced = false;
    return (...args: Array<never>): unknown => {
      const now = !raced && when(args);
      if (now) raced = true;
      if (now && at === "before") race();
      const result = call(...args);
      if (now && at === "after") race();
      return result;
    };
  };

afterEach(unhook);

/** Every name in `dir` the writers leave only while they work. */
const leftovers = (dir: string) =>
  fs.readdirSync(dir).filter((entry) => entry.startsWith(".mend-"));

const fixture = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mend-contained-")));
  const root = path.join(dir, "root");
  const outside = path.join(dir, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.chmodSync(outside, 0o700);
  return { dir, root, outside, paste: path.join(root, "paste") };
};

const writers = [
  {
    name: "on this machine (writeContained)",
    write: (root: string) =>
      writeContained({ root, directoryMode: 0o755, fileMode: 0o644 }, ["paste"], "a.png", BYTES),
  },
  {
    name: "in a workspace (containedPut)",
    write: (root: string) => containedPut(root, 0o755, 0o644, `${root}/paste/a.png`, BYTES),
  },
] as const;

describe.each(writers)("a contained write $name", ({ write }) => {
  it("refuses, and takes its file back, when the directory is moved out after its path was checked (finding 1)", () => {
    const { dir, root, outside, paste } = fixture();
    fs.mkdirSync(paste);
    const moved = path.join(outside, "moved");
    hook(
      "lstatSync",
      racing(
        (args) => args[0] === paste,
        () => {
          original.renameSync(paste, moved);
          original.mkdirSync(paste);
        },
      ),
    );
    const refused = write(root);
    unhook();
    expect(refused).toBe("its directory moved during the write");
    expect(fs.readdirSync(moved)).toEqual([]);
    expect(fs.readdirSync(paste)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses, and takes its file back, when the directory is moved out just after the rename (finding 1)", () => {
    const { dir, root, outside, paste } = fixture();
    fs.mkdirSync(paste);
    const moved = path.join(outside, "moved");
    hook(
      "renameSync",
      racing(
        (args) => String(args[1]).endsWith("/a.png"),
        () => {
          original.renameSync(paste, moved);
          original.mkdirSync(paste);
        },
      ),
    );
    const refused = write(root);
    unhook();
    expect(refused).toBe("its directory moved during the write");
    expect(fs.readdirSync(moved)).toEqual([]);
    expect(fs.existsSync(path.join(paste, "a.png"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the file readable by its writer alone until it is proved in place (review 2, 615-1a)", () => {
    const { dir, root, paste } = fixture();
    fs.mkdirSync(paste);
    const seen: Array<number> = [];
    hook(
      "renameSync",
      racing(
        (args) => String(args[1]).endsWith("/a.png"),
        () => seen.push(modeOf(path.join(paste, "a.png"))),
      ),
    );
    expect(write(root)).toBeNull();
    unhook();
    expect(seen).toEqual([0o600]);
    expect(modeOf(path.join(paste, "a.png"))).toBe(0o644);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("takes back only its own file: one swapped in at the name stays, and its own bytes are gone (review 2, 615-r2-1)", () => {
    const { dir, root, outside, paste } = fixture();
    fs.mkdirSync(paste);
    const moved = path.join(outside, "moved");
    const theirs = path.join(outside, "theirs.png");
    const oursAside = path.join(outside, "ours-aside");
    fs.writeFileSync(theirs, "someone else's file");
    hook(
      "lstatSync",
      racing(
        (args) => args[0] === paste,
        () => {
          original.renameSync(paste, moved);
          original.mkdirSync(paste);
        },
      ),
    );
    // The take-back starts: the writer's file is moved away and another put at its name.
    hook(
      "renameSync",
      racing(
        (args) => String(args[1]).includes("/.mend-quarantine-"),
        () => {
          original.renameSync(path.join(moved, "a.png"), oursAside);
          original.renameSync(theirs, path.join(moved, "a.png"));
        },
        "before",
      ),
    );
    const refused = write(root);
    unhook();
    expect(refused).toBe("its directory moved during the write");
    expect(fs.readFileSync(path.join(moved, "a.png"), "utf8")).toBe("someone else's file");
    expect(leftovers(moved)).toEqual([]);
    // The writer's own file, wherever it went, holds none of the image.
    expect(fs.statSync(oursAside).size).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes nothing where no descriptor can be walked into (review 2, 615-1b)", () => {
    const { dir, root, paste } = fixture();
    hook("statSync", (call) => (...args: Array<never>) => {
      const at = String(args[0]);
      if (at.startsWith("/proc/self/fd/") || at.startsWith("/dev/fd/")) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return call(...args);
    });
    const refused = write(root);
    unhook();
    expect(refused).toBe(`no /proc/self/fd or /dev/fd here to keep the write inside ${root}`);
    expect(fs.existsSync(paste)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("changes the mode of no directory put in place of the one it made (finding 2)", () => {
    const { dir, root, paste } = fixture();
    const privateDir = path.join(root, "private");
    fs.mkdirSync(privateDir, { mode: 0o700 });
    fs.chmodSync(privateDir, 0o700);
    hook(
      "mkdirSync",
      racing(
        (args) => String(args[0]).endsWith("/paste"),
        () => {
          original.renameSync(paste, path.join(root, "discarded-new"));
          original.renameSync(privateDir, paste);
        },
      ),
    );
    const refused = write(root);
    unhook();
    // The directory now at `paste` is the private one: still 0700, the image in it, where the
    // path says.
    expect(refused).toBeNull();
    expect(modeOf(paste)).toBe(0o700);
    expect(new Uint8Array(fs.readFileSync(path.join(paste, "a.png")))).toEqual(BYTES);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("makes a missing directory with its mode in the one mkdir, and replaces a hard link at the name without touching its other name", () => {
    const { dir, root, outside, paste } = fixture();
    expect(write(root)).toBeNull();
    // Never wider than asked for: the umask may narrow it on this machine.
    expect(modeOf(paste) & ~0o755).toBe(0);
    expect(modeOf(path.join(paste, "a.png"))).toBe(0o644);
    fs.rmSync(path.join(paste, "a.png"));
    fs.writeFileSync(path.join(outside, "victim"), "untouched");
    fs.linkSync(path.join(outside, "victim"), path.join(paste, "a.png"));
    expect(write(root)).toBeNull();
    expect(fs.readFileSync(path.join(outside, "victim"), "utf8")).toBe("untouched");
    expect(new Uint8Array(fs.readFileSync(path.join(paste, "a.png")))).toEqual(BYTES);
    expect(leftovers(paste)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
