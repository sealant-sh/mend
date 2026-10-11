import { describe, expect, it } from "vitest";

import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  type TerminalBufferLineLike,
} from "./terminal-links";

function createBufferLine(text: string, isWrapped = false): TerminalBufferLineLike {
  return {
    isWrapped,
    translateToString: (trimRight = false) => (trimRight ? text.replace(/\s+$/u, "") : text),
  };
}

describe("extractTerminalLinks", () => {
  it("finds http urls and path tokens", () => {
    const line =
      "failed at https://example.com/docs and src/components/ThreadTerminalDrawer.tsx:42";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "url",
        text: "https://example.com/docs",
        start: 10,
        end: 34,
      },
      {
        kind: "path",
        text: "src/components/ThreadTerminalDrawer.tsx:42",
        start: 39,
        end: 81,
      },
    ]);
  });

  it("trims trailing punctuation from links", () => {
    const line = "(https://example.com/docs), ./src/main.ts:12.";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "url",
        text: "https://example.com/docs",
        start: 1,
        end: 25,
      },
      {
        kind: "path",
        text: "./src/main.ts:12",
        start: 28,
        end: 44,
      },
    ]);
  });

  it("finds Windows absolute paths with forward slashes", () => {
    const line = "see C:/Users/someone/project/src/file.ts:42 for details";
    const path = "C:/Users/someone/project/src/file.ts:42";
    const start = line.indexOf(path);
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "path",
        text: path,
        start,
        end: start + path.length,
      },
    ]);
  });

  it("trims trailing punctuation from Windows forward-slash paths", () => {
    const line = "(C:/tmp/x.ts).";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "path",
        text: "C:/tmp/x.ts",
        start: 1,
        end: 12,
      },
    ]);
  });
});

describe("collectWrappedTerminalLinkLine", () => {
  it("reconstructs a wrapped line from any physical row", () => {
    const firstSegment = "see https://example.com/a";
    const secondSegment = "/bc?x=1";
    const lines = [
      createBufferLine("prompt> "),
      createBufferLine(firstSegment),
      createBufferLine(secondSegment, true),
      createBufferLine("done"),
    ];

    const fromFirstRow = collectWrappedTerminalLinkLine(2, (index) => lines[index]);
    const fromWrappedRow = collectWrappedTerminalLinkLine(3, (index) => lines[index]);

    expect(fromFirstRow).toEqual({
      text: `${firstSegment}${secondSegment}`,
      segments: [
        {
          bufferLineNumber: 2,
          text: firstSegment,
          startIndex: 0,
          endIndex: firstSegment.length,
        },
        {
          bufferLineNumber: 3,
          text: secondSegment,
          startIndex: firstSegment.length,
          endIndex: firstSegment.length + secondSegment.length,
        },
      ],
    });
    expect(fromWrappedRow).toEqual(fromFirstRow);
  });

  it("preserves trailing spaces on continued segments for downstream offsets", () => {
    const firstSegment = "prefix   ";
    const secondSegment = "https://example.com/path";
    const lines = [createBufferLine(firstSegment), createBufferLine(secondSegment, true)];

    const wrappedLine = collectWrappedTerminalLinkLine(2, (index) => lines[index]);

    expect(wrappedLine?.text).toBe(`${firstSegment}${secondSegment}`);
    expect(extractTerminalLinks(wrappedLine?.text ?? "")).toEqual([
      {
        kind: "url",
        text: secondSegment,
        start: firstSegment.length,
        end: firstSegment.length + secondSegment.length,
      },
    ]);
  });
});
