import { execFile } from "node:child_process";

import { describe, expect, it } from "vitest";

import { NESTING_LIMIT, PARSED_TEXT_LIMIT } from "../src/find-parser.ts";

/** Lines of `line` up to `PARSED_TEXT_LIMIT`, the longest message find parses. */
const filled = (line: string) =>
  Array.from({ length: Math.floor(PARSED_TEXT_LIMIT / (line.length + 1)) }, () => line).join("\n");

/** Its last line: whether `support/parse-apart.ts` read `text` as written. */
const parsedApart = (text: string) =>
  new Promise<unknown>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [new URL("./support/parse-apart.ts", import.meta.url).pathname],
      { maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) return reject(error);
        resolve(JSON.parse(stdout.trim().split("\n").at(-1) ?? ""));
      },
    );
    child.stdin?.end(text);
  });

describe("the deepest message find parses", () => {
  // Lists `NESTING_LIMIT` deep were the costliest shape per byte measured: 2.6 s on an idle machine,
  // and a loaded runner loads the parser from source eight times slower.
  it("fits in half the find worker's heap", { timeout: 30_000 }, async () => {
    expect(await parsedApart(filled(`${"- ".repeat(NESTING_LIMIT)}x`))).toEqual({
      asWritten: false,
    });
  });
});
