/**
 * The two writers that keep a pasted image inside its directory (`writeContained` on this machine,
 * `containedPut` in a workspace), raced the way the review of mend#615 raced them: real renames and
 * directories, made at the moment the writer reads a directory's path, makes a directory or renames
 * the file into place.
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
  readlinkSync: nodeFs.readlinkSync,
  mkdirSync: nodeFs.mkdirSync,
  renameSync: nodeFs.renameSync,
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

/** `fn`, calling `after` once, the first time it returns for `when` (its arguments, its result). */
const once =
  (
    fn: (...args: Array<never>) => unknown,
    when: (args: ReadonlyArray<unknown>, result: unknown) => boolean,
    after: () => void,
  ) =>
  (...args: Array<never>): unknown => {
    const result = fn(...args);
    if (!done.has(fn) && when(args, result)) {
      done.add(fn);
      after();
    }
    return result;
  };
const done = new Set<unknown>();

afterEach(() => {
  done.clear();
  Object.assign(nodeFs, original);
  syncBuiltinESMExports();
});

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
    Reflect.set(
      nodeFs,
      "readlinkSync",
      once(
        original.readlinkSync,
        (_args, result) => result === paste,
        () => {
          original.renameSync(paste, path.join(outside, "moved"));
          original.mkdirSync(paste);
        },
      ),
    );
    syncBuiltinESMExports();
    const refused = write(root);
    Object.assign(nodeFs, original);
    syncBuiltinESMExports();
    expect(refused).toBe("its directory moved during the write");
    expect(fs.readdirSync(path.join(outside, "moved"))).toEqual([]);
    expect(fs.readdirSync(paste)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses, and takes its file back, when the directory is moved out just after the rename (finding 1)", () => {
    const { dir, root, outside, paste } = fixture();
    fs.mkdirSync(paste);
    Reflect.set(
      nodeFs,
      "renameSync",
      once(
        original.renameSync,
        (args) => String(args[1]).endsWith("/a.png"),
        () => {
          original.renameSync(paste, path.join(outside, "moved"));
          original.mkdirSync(paste);
        },
      ),
    );
    syncBuiltinESMExports();
    const refused = write(root);
    Object.assign(nodeFs, original);
    syncBuiltinESMExports();
    expect(refused).toBe("its directory moved during the write");
    expect(fs.readdirSync(path.join(outside, "moved"))).toEqual([]);
    expect(fs.existsSync(path.join(paste, "a.png"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("changes the mode of no directory put in place of the one it made (finding 2)", () => {
    const { dir, root, paste } = fixture();
    const privateDir = path.join(root, "private");
    fs.mkdirSync(privateDir, { mode: 0o700 });
    fs.chmodSync(privateDir, 0o700);
    Reflect.set(
      nodeFs,
      "mkdirSync",
      once(
        original.mkdirSync,
        (args) => String(args[0]).endsWith("/paste"),
        () => {
          original.renameSync(paste, path.join(root, "discarded-new"));
          original.renameSync(privateDir, paste);
        },
      ),
    );
    syncBuiltinESMExports();
    const refused = write(root);
    Object.assign(nodeFs, original);
    syncBuiltinESMExports();
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
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
