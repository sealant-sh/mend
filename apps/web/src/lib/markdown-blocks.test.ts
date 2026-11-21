import { describe, expect, it } from "vitest";

import { markdownBlocks } from "./markdown-blocks.ts";

describe("markdownBlocks", () => {
  it("cuts at blank lines, and the blocks put back together are the text", () => {
    const text = "# Title\n\nFirst paragraph.\n\nSecond paragraph,\nstill second.\n\n- a\n- b";
    const blocks = markdownBlocks(text);
    expect(blocks).toEqual([
      "# Title\n\n",
      "First paragraph.\n\n",
      "Second paragraph,\nstill second.\n\n",
      "- a\n- b",
    ]);
    expect(blocks.join("")).toBe(text);
  });

  it("keeps a finished block the same string as the text grows after it", () => {
    const reply =
      "One.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nTwo, and a list:\n\n- x\n\n- y\n\nThree.";
    let held: ReadonlyArray<string> = [];
    for (let length = 1; length <= reply.length; length += 1) {
      const blocks = markdownBlocks(reply.slice(0, length));
      // Every block but the last one of the shorter text is unchanged in the longer one.
      expect(blocks.slice(0, Math.max(0, held.length - 1))).toEqual(
        held.slice(0, Math.max(0, held.length - 1)),
      );
      held = blocks;
    }
    expect(held).toEqual([
      "One.\n\n",
      "```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n",
      "Two, and a list:\n\n",
      "- x\n\n- y\n\n",
      "Three.",
    ]);
  });

  it("never cuts inside a code fence, even one left open", () => {
    expect(markdownBlocks("~~~~\na\n\n~~~\n\nb")).toEqual(["~~~~\na\n\n~~~\n\nb"]);
    expect(markdownBlocks("```\na\n\n```js\nb\n```\n\nc")).toEqual([
      "```\na\n\n```js\nb\n```\n\n",
      "c",
    ]);
  });

  it("keeps what continues a block after a blank line with it", () => {
    // A loose list's next item, and an item's indented paragraph.
    expect(markdownBlocks("1. a\n\n2. b\n\n   more of b\n\nAfter.")).toEqual([
      "1. a\n\n2. b\n\n   more of b\n\n",
      "After.",
    ]);
  });

  it("reads a text with a link or footnote definition as one block", () => {
    const text = "See [the docs][d].\n\nMore.\n\n[d]: https://example.test";
    expect(markdownBlocks(text)).toEqual([text]);
  });
});
