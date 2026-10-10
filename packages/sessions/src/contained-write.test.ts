/**
 * The two writers that keep a pasted image inside its directory (`writeContained` on this machine,
 * `containedPut` in a workspace), raced the way the reviews of mend#615 raced them: real renames,
 * directories and files, made at the moment the writer makes a directory or creates the file.
 *
 * Since review 3 a writer creates one new file, exclusively, and does nothing else by name: no
 * staging, no rename, no take-back. A race can move that file with its directory, among files the
 * racer holds already (in a person executor the writer is that person; on this machine a rename
 * cannot leave the workspace's mount), but it can never make the writer follow a link, replace,
 * remove or change the mode of anything else. That is what these tests hold it to.
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
  statSync: nodeFs.statSync,
  mkdirSync: nodeFs.mkdirSync,
  openSync: nodeFs.openSync,
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

/** Every entry under `dir`, with its kind and bytes, so a test can say nothing else changed. */
const snapshot = (dir: string): Record<string, string> => {
  const seen: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at).toSorted()) {
      const full = path.join(at, entry);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) {
        seen[full] = `dir ${(stat.mode & 0o7777).toString(8)}`;
        walk(full);
      } else if (stat.isSymbolicLink()) {
        seen[full] = `link ${fs.readlinkSync(full)}`;
      } else {
        seen[full] = `file ${(stat.mode & 0o7777).toString(8)} ${fs.readFileSync(full, "utf8")}`;
      }
    }
  };
  walk(dir);
  return seen;
};

/** Whether `fs.openSync` is about to create the image (its last argument names no directory). */
const creatingImage = (args: ReadonlyArray<unknown>) => String(args[0]).endsWith("/a.png");

describe.each(writers)("a contained write $name", ({ write }) => {
  it("moved out while it writes, moves only its own new file, and changes nothing else (review 3)", () => {
    const { dir, root, outside, paste } = fixture();
    fs.mkdirSync(paste);
    const moved = path.join(outside, "moved");
    fs.writeFileSync(path.join(outside, "theirs"), "someone else's");
    hook(
      "openSync",
      racing(
        creatingImage,
        () => {
          nodeFs.renameSync(paste, moved);
          original.mkdirSync(paste);
        },
        "before",
      ),
    );
    const before = snapshot(dir);
    const result = write(root);
    unhook();
    expect(result).toBeNull();
    // The only entries that were not there: the racer's renamed directory, and in it the image,
    // created in the directory the writer entered, wherever that went. Everything else is as it
    // was, the racer's own new `paste` aside.
    const after = snapshot(dir);
    const added = Object.keys(after).filter((entry) => !(entry in before));
    expect(added.toSorted()).toEqual([moved, path.join(moved, "a.png")].toSorted());
    expect(new Uint8Array(fs.readFileSync(path.join(moved, "a.png")))).toEqual(BYTES);
    for (const [entry, was] of Object.entries(before)) {
      if (entry !== paste) expect(after[entry]).toBe(was);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a name taken just before it creates the file, and leaves what is there as it was", () => {
    const { dir, root, outside, paste } = fixture();
    fs.mkdirSync(paste);
    const victim = path.join(outside, "victim");
    fs.writeFileSync(victim, "untouched");
    // A link to someone else's file, put at the name the moment before the writer creates it.
    hook(
      "openSync",
      racing(creatingImage, () => fs.symlinkSync(victim, path.join(paste, "a.png")), "before"),
    );
    const before = snapshot(dir);
    const result = write(root);
    unhook();
    expect(result).toBe(`already there: ${root}/paste/a.png`);
    const after = snapshot(dir);
    expect(after[victim]).toBe(before[victim]);
    expect(after[path.join(paste, "a.png")]).toBe(`link ${victim}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a name already taken by a link or a hard link, writing through neither", () => {
    const { dir, root, outside, paste } = fixture();
    fs.mkdirSync(paste);
    const victim = path.join(outside, "victim");
    fs.writeFileSync(victim, "untouched");
    fs.linkSync(victim, path.join(paste, "a.png"));
    expect(write(root)).toBe(`already there: ${root}/paste/a.png`);
    fs.rmSync(path.join(paste, "a.png"));
    fs.symlinkSync(victim, path.join(paste, "a.png"));
    expect(write(root)).toBe(`already there: ${root}/paste/a.png`);
    expect(fs.readFileSync(victim, "utf8")).toBe("untouched");
    expect(modeOf(victim)).toBe(0o644 & ~process.umask(process.umask()));
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
          nodeFs.renameSync(paste, path.join(root, "discarded-new"));
          nodeFs.renameSync(privateDir, paste);
        },
      ),
    );
    const refused = write(root);
    unhook();
    // The directory now at `paste` is the private one: still 0700, the image in it.
    expect(refused).toBeNull();
    expect(modeOf(paste)).toBe(0o700);
    expect(new Uint8Array(fs.readFileSync(path.join(paste, "a.png")))).toEqual(BYTES);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("makes a missing directory with its mode in the one mkdir, and the file with its own, created once", () => {
    const { dir, root, paste } = fixture();
    expect(write(root)).toBeNull();
    // Never wider than asked for: the umask may narrow it on this machine.
    expect(modeOf(paste) & ~0o755).toBe(0);
    expect(modeOf(path.join(paste, "a.png"))).toBe(0o644);
    expect(new Uint8Array(fs.readFileSync(path.join(paste, "a.png")))).toEqual(BYTES);
    expect(fs.readdirSync(paste)).toEqual(["a.png"]);
    // The same name again is refused, the first file kept.
    expect(write(root)).toBe(`already there: ${root}/paste/a.png`);
    expect(new Uint8Array(fs.readFileSync(path.join(paste, "a.png")))).toEqual(BYTES);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
