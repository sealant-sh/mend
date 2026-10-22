import * as fs from "node:fs";

import { Schema } from "effect";

export const GitPath = Schema.String.pipe(Schema.brand("GitPath"));
export type GitPath = typeof GitPath.Type;

export const NUL = Buffer.from([0]);
export const TAB = 0x09;
export const pathOf = (bytes: Buffer): GitPath => GitPath.make(bytes.toString("latin1"));
export const bytesOf = (file: GitPath): Buffer => Buffer.from(file, "latin1");
export const nulList = (files: Iterable<GitPath>): Buffer =>
  Buffer.concat([...files].flatMap((file) => [bytesOf(file), NUL]));
const onDisk = (top: string, file: GitPath): Buffer =>
  Buffer.concat([Buffer.from(`${top}/`), bytesOf(file)]);

/** What is at the file's path; undefined when nothing is, a file where its directory was included. */
export const statOnDisk = (top: string, file: GitPath): fs.Stats | undefined => {
  try {
    return fs.lstatSync(onDisk(top, file));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "ENOTDIR"].includes(String(error.code))
    ) {
      return undefined;
    }
    throw error;
  }
};

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const octal = (byte: number): string => `\\${byte.toString(8).padStart(3, "0")}`;

export const displayPath = (file: GitPath): string => {
  const bytes = bytesOf(file);
  try {
    return UTF8.decode(bytes).replace(/\p{Cc}/gu, (control) =>
      [...Buffer.from(control)].map(octal).join(""),
    );
  } catch {
    return [...bytes]
      .map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : octal(byte)))
      .join("");
  }
};

export const nulFields = (bytes: Buffer): ReadonlyArray<Buffer> => {
  const fields: Array<Buffer> = [];
  for (let at = 0; at < bytes.length; ) {
    const end = bytes.indexOf(0, at);
    const stop = end === -1 ? bytes.length : end;
    if (stop > at) fields.push(bytes.subarray(at, stop));
    at = stop + 1;
  }
  return fields;
};

const wordsAndPath = (
  field: Buffer,
  count: number,
): { readonly words: ReadonlyArray<string>; readonly path: GitPath } => {
  let at = 0;
  for (let seen = 0; seen < count; seen += 1) at = field.indexOf(0x20, at) + 1;
  return {
    words: field
      .subarray(0, at - 1)
      .toString()
      .split(" "),
    path: pathOf(field.subarray(at)),
  };
};

export interface TrackedEntry {
  readonly kind: "tracked";
  readonly path: GitPath;
  readonly staged: string;
  readonly unstaged: string;
  readonly headMode: string;
  readonly headSha: string;
  readonly indexSha: string;
}

type StatusEntry =
  | TrackedEntry
  | { readonly kind: "untracked"; readonly path: GitPath }
  | { readonly kind: "unmerged"; readonly path: GitPath };

export const leadOf = (field: Buffer): string => String.fromCharCode(field[0] ?? 0);
export const namesDirectory = (field: Buffer): boolean => field.at(-1) === 0x2f;

export const parseStatus = (fields: ReadonlyArray<Buffer>): ReadonlyArray<StatusEntry> =>
  fields.flatMap((field): ReadonlyArray<StatusEntry> => {
    if (leadOf(field) === "1") {
      // 1 XY sub mH mI mW hH hI path
      const { words, path: file } = wordsAndPath(field, 8);
      const xy = words[1] ?? "..";
      return [
        {
          kind: "tracked",
          path: file,
          staged: xy[0] ?? ".",
          unstaged: xy[1] ?? ".",
          headMode: words[3] ?? "000000",
          headSha: words[6] ?? "",
          indexSha: words[7] ?? "",
        },
      ];
    }
    if (leadOf(field) === "u") return [{ kind: "unmerged", path: wordsAndPath(field, 10).path }];
    // An untracked directory is a nested repository; it is not the checkout's to carry.
    if (leadOf(field) === "?" && !namesDirectory(field)) {
      return [{ kind: "untracked", path: pathOf(field.subarray(2)) }];
    }
    return [];
  });
