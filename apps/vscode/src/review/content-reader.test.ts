import { describe, expect, it } from "vitest";

import type { MendConnection } from "../config.js";
import { MendApiError } from "../mend-http.js";
import { ContentCache, ContentReader, documentText, type ChangeAddress } from "./content-reader.js";
import type { FileContents } from "./review-wire.js";

const address = (overrides: Partial<ChangeAddress> = {}): ChangeAddress => ({
  worktreeId: "w1",
  path: "src/a.ts",
  at: "cp1",
  absent: false,
  ...overrides,
});

/** A reader over a fake Mend whose answer depends on who asks, counting what it was asked. */
const readerOf = (answer: (connection: MendConnection) => FileContents | Error) => {
  let connection: MendConnection = { url: "http://mend", token: "dana" };
  const asked: Array<string> = [];
  const reader = new ContentReader(
    {
      contents: async (worktreeId, path, at) => {
        asked.push(`${connection.token} ${worktreeId}/${path}@${at}`);
        const found = answer(connection);
        if (found instanceof Error) throw found;
        return found;
      },
    },
    async () => connection,
  );
  return {
    reader,
    asked,
    signInAs: (next: MendConnection) => {
      connection = next;
    },
  };
};

const text = (value: string): FileContents => ({
  kind: "text",
  text: value,
  truncated: false,
  size: value.length,
});

describe("a file over the 1 MiB Mend reads", () => {
  it("is refused in words, never shown as the whole file", () => {
    const cut: FileContents = {
      kind: "text",
      text: "const same = 1;\n",
      truncated: true,
      size: 3 * 1024 * 1024,
    };
    const shown = documentText("pnpm-lock.yaml", cut);
    expect(shown).toBe(
      "pnpm-lock.yaml is 3.0 MiB. Mend reads a file up to 1 MiB, so this side is not shown and the two sides are not compared.",
    );
    expect(shown).not.toContain("const same");
  });
});

describe("the sides of a file's diff", () => {
  it("reads the side its status says the file is not on as empty, without asking Mend", async () => {
    const { reader, asked } = readerOf(() => text("x"));
    expect(await reader.read(address({ absent: true }), "absent")).toBe("");
    expect(asked).toEqual([]);
  });

  it("says a file Mend has not got is missing, never an empty file, and asks again next time", async () => {
    const { reader, asked } = readerOf(() => new MendApiError("checkpoint cp9 not found", 404));
    await expect(reader.read(address({ at: "cp9" }), "k")).rejects.toThrow(
      "Mend has no src/a.ts at this checkpoint: checkpoint cp9 not found",
    );
    await expect(reader.read(address({ at: "cp9" }), "k")).rejects.toThrow();
    expect(asked).toHaveLength(2);
  });
});

describe("what was read is kept for one connection", () => {
  it("serves it again without asking, while offline too", async () => {
    let offline = false;
    const { reader, asked } = readerOf(() =>
      offline ? new MendApiError("Mend is offline", null) : text("dana's"),
    );
    expect(await reader.read(address(), "k")).toBe("dana's");
    offline = true;
    expect(await reader.read(address(), "k")).toBe("dana's");
    expect(asked).toHaveLength(1);
  });

  it("never serves one account's text to another, or to another server", async () => {
    const { reader, asked, signInAs } = readerOf((connection) => text(`${connection.token}'s`));
    expect(await reader.read(address(), "k")).toBe("dana's");
    signInAs({ url: "http://mend", token: "ana" });
    expect(await reader.read(address(), "k")).toBe("ana's");
    signInAs({ url: "http://other", token: "ana" });
    expect(await reader.read(address(), "k")).toBe("ana's");
    expect(asked).toHaveLength(3);
  });

  it("forgets everything on sign-out", async () => {
    const { reader, asked } = readerOf(() => text("x"));
    await reader.read(address(), "k");
    reader.clear();
    await reader.read(address(), "k");
    expect(asked).toHaveLength(2);
  });
});

describe("the cache's bounds", () => {
  it("drops the least recently read past its entry bound", () => {
    const cache = new ContentCache(2, 1_000);
    expect(cache.get("me", "a")).toBe(undefined);
    cache.set("me", "a", "A");
    cache.set("me", "b", "B");
    expect(cache.get("me", "a")).toBe("A");
    cache.set("me", "c", "C");
    expect([cache.get("me", "a"), cache.get("me", "b"), cache.get("me", "c")]).toEqual([
      "A",
      undefined,
      "C",
    ]);
  });

  it("drops the oldest past its byte bound, and never keeps one larger than it", () => {
    const cache = new ContentCache(100, 15);
    cache.get("me", "a");
    cache.set("me", "a", "12345");
    cache.set("me", "b", "12345");
    expect(cache.size).toBe(1);
    expect(cache.get("me", "b")).toBe("12345");
    cache.set("me", "huge", "x".repeat(11));
    expect(cache.get("me", "huge")).toBe(undefined);
  });

  it("does not keep what a read under the previous connection brought back", () => {
    const cache = new ContentCache(10, 1_000);
    cache.get("dana", "a");
    cache.get("ana", "a");
    cache.set("dana", "a", "dana's");
    expect(cache.get("ana", "a")).toBe(undefined);
  });
});
