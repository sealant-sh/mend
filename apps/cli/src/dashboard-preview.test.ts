import { describe, expect, it } from "vitest";

import {
  displayWidth,
  plainText,
  previewLines,
  TRANSCRIPT_KEY,
  wrapText,
  type SessionTranscriptDto,
  type TranscriptEventDto,
} from "./dashboard-preview.ts";

const ESC = "\u001b";

const event = (
  over: Partial<TranscriptEventDto> & { readonly kind: string },
): TranscriptEventDto => ({
  text: null,
  name: null,
  command: null,
  output: null,
  ...over,
});

const transcript = (events: ReadonlyArray<TranscriptEventDto>): SessionTranscriptDto => ({
  sourceHarness: "claude",
  events,
});

describe("plainText", () => {
  it("drops the escape families a harness writes around its output", () => {
    expect(plainText(`${ESC}[31mred${ESC}[0m`)).toBe("red");
    expect(plainText(`${ESC}]0;session title\u0007ls`)).toBe("ls");
    expect(plainText(`${ESC}]8;;https://mend.run${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe("link");
    expect(plainText(`${ESC}[?25lworking${ESC}[?25h`)).toBe("working");
    expect(plainText(`${ESC}Pdcs payload${ESC}\\tail`)).toBe("tail");
    expect(plainText(`${ESC}_Gkitty graphics${ESC}\\tail`)).toBe("tail");
    // An escape the harness cut short takes the rest of the text with it.
    expect(plainText(`kept${ESC}]0;never terminated`)).toBe("kept");
    // A C1 control byte introduces the same sequences without an ESC.
    expect(plainText("\u009b31mred")).toBe("red");
  });

  it("normalises CRLF and reads a bare CR as the overwrite a terminal does", () => {
    expect(plainText("first\r\nsecond")).toBe("first\nsecond");
    expect(plainText("10%\r40%\r100%")).toBe("100%");
    expect(plainText("done\r")).toBe("done");
    expect(plainText("\r\r")).toBe("");
    // Only the line that carries the CR is rewritten.
    expect(plainText("keep\n10%\rdone")).toBe("keep\ndone");
  });

  it("removes the control bytes stripping escapes leaves behind, keeping newline and tab", () => {
    expect(plainText("a\u0008b\u0007c\u0000d\u007fe")).toBe("abcde");
    expect(plainText("page\u000cbreak\u000bline")).toBe("pagebreakline");
    expect(plainText("one\ttwo\nthree")).toBe("one\ttwo\nthree");
  });

  it("leaves text that is already plain alone, and is idempotent", () => {
    const noisy = `${ESC}[32mok\u0007\n10%\rdone\r\nnext`;
    expect(plainText(noisy)).toBe("ok\ndone\nnext");
    expect(plainText(plainText(noisy))).toBe(plainText(noisy));
  });
});

describe("displayWidth", () => {
  it("counts terminal columns, not UTF-16 units", () => {
    expect(displayWidth("plain")).toBe(5);
    // Two columns each, one UTF-16 unit each.
    expect(displayWidth("\u4f60\u597d")).toBe(4);
    expect(displayWidth("\uff28\uff49")).toBe(4);
    // A combining acute rides on the letter before it.
    expect(displayWidth("e\u0301")).toBe(1);
    expect(displayWidth("caf\u00e9")).toBe(4);
    // One emoji cluster, however many units it is made of.
    expect(displayWidth("\ud83d\ude80")).toBe(2);
    expect(displayWidth("\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67")).toBe(2);
    // U+FE0F asks a narrow glyph to be drawn as a double-wide emoji.
    expect(displayWidth("\u2600\ufe0f")).toBe(2);
  });
});

describe("wrapText", () => {
  it("wraps on words and keeps the record's own newlines", () => {
    expect(wrapText("one two three four", 9)).toEqual(["one two", "three", "four"]);
    expect(wrapText("first\n\nsecond", 20)).toEqual(["first", "", "second"]);
  });

  it("cuts an unbreakable token rather than hiding it", () => {
    expect(wrapText("aaaaaaaaaaaa", 8)).toEqual(["aaaaaaaa", "aaaa"]);
  });

  it("never returns nothing — an empty block is still one empty line", () => {
    expect(wrapText("", 20)).toEqual([""]);
  });

  it("wraps the text of terminal output, not its escapes", () => {
    expect(wrapText(`${ESC}[1mone${ESC}[0m two three four`, 9)).toEqual([
      "one two",
      "three",
      "four",
    ]);
    // Coloured output that would otherwise wrap early on invisible bytes.
    expect(wrapText(`${ESC}[32mpassed${ESC}[0m ${ESC}[32mpassed${ESC}[0m`, 20)).toEqual([
      "passed passed",
    ]);
  });

  it("measures wide and combining characters in columns when it wraps", () => {
    // Four double-wide glyphs fill a pane eight columns across.
    expect(wrapText("\u4f60\u597d\u4e16\u754c\u4f60\u597d", 8)).toEqual([
      "\u4f60\u597d\u4e16\u754c",
      "\u4f60\u597d",
    ]);
    // Combining marks take no column, so this still fits on one line.
    expect(wrapText("e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301", 8)).toEqual([
      "e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301",
    ]);
    // An unbreakable run of emoji is cut between clusters, never inside one.
    expect(wrapText("\ud83d\ude80".repeat(6), 8)).toEqual([
      "\ud83d\ude80".repeat(4),
      "\ud83d\ude80".repeat(2),
    ]);
  });

  it("keeps every line inside the pane, whatever the text is made of", () => {
    const samples = [
      "ordinary english prose that wraps somewhere in the middle",
      "\u4f60\u597d\u4e16\u754c \u3053\u3093\u306b\u3061\u306f \uc548\ub155\ud558\uc138\uc694",
      "\ud83d\ude80\ud83d\ude80 \ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67 mixed \u2600\ufe0f text",
      "/very/long/unbreakable/path/without/any/spaces/at/all/\u4f60\u597d",
      `${ESC}[33mwarning${ESC}[0m: \u30c6\u30b9\u30c8 failed\r\n  at line 3`,
      "a\u0301".repeat(30),
    ];
    for (const sample of samples) {
      for (const width of [8, 12, 20, 33]) {
        for (const line of wrapText(sample, width)) {
          expect(displayWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    }
  });
});

describe("previewLines", () => {
  it("renders each speaker's turn with its own kind, so the pane can colour it", () => {
    const lines = previewLines(
      transcript([
        event({ kind: "user", text: "fix the reaper" }),
        event({ kind: "assistant", text: "reading engine.ts" }),
        event({ kind: "tool", name: "shell", command: "pnpm test", output: "2 passed" }),
      ]),
      { width: 40, maxLines: 50 },
    );
    expect(lines.map((line) => [line.kind, line.text])).toEqual([
      ["user", "fix the reaper"],
      ["blank", ""],
      ["assistant", "reading engine.ts"],
      ["command", "pnpm test"],
      ["output", "2 passed"],
    ]);
    expect(lines[0]?.lead).toBe(true);
  });

  it("names a tool that is not a shell command instead of dropping it", () => {
    const lines = previewLines(transcript([event({ kind: "tool", name: "Edit", output: "ok" })]), {
      width: 40,
      maxLines: 50,
    });
    expect(lines.map((line) => line.text)).toEqual(["Edit", "ok"]);
  });

  it("marks continuation lines so only the first carries the speaker glyph", () => {
    const lines = previewLines(
      transcript([event({ kind: "assistant", text: "one two three four five six" })]),
      { width: 10, maxLines: 50 },
    );
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.map((line) => line.lead)).toEqual([true, ...lines.slice(1).map(() => false)]);
  });

  it("caps a huge tool output and states how much it held back", () => {
    const output = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
    const lines = previewLines(transcript([event({ kind: "tool", command: "ls", output })]), {
      width: 40,
      maxLines: 200,
    });
    const truncation = lines.at(-1);
    expect(truncation?.kind).toBe("meta");
    expect(truncation?.text).toBe("… 35 more lines");
  });

  it("keeps the MOST RECENT lines and says how many earlier ones it dropped", () => {
    const events = Array.from({ length: 20 }, (_, index) =>
      event({ kind: "user", text: `turn ${index}` }),
    );
    const lines = previewLines(transcript(events), { width: 40, maxLines: 5 });
    expect(lines).toHaveLength(5);
    expect(lines[0]?.kind).toBe("meta");
    expect(lines[0]?.text).toContain("earlier lines");
    expect(lines.at(-1)?.text).toBe("turn 19");
  });

  it("invents nothing when the record is empty — the pane says so instead", () => {
    expect(previewLines(transcript([]), { width: 40, maxLines: 20 })).toEqual([]);
    // Blank turns carry no output either; they must not become empty rows.
    expect(
      previewLines(transcript([event({ kind: "assistant", text: "   " })]), {
        width: 40,
        maxLines: 20,
      }),
    ).toEqual([]);
  });

  it("renders raw terminal output as text, not as escapes", () => {
    const lines = previewLines(
      transcript([
        event({
          kind: "tool",
          command: `${ESC}[1mpnpm test${ESC}[0m`,
          output: `${ESC}]0;pnpm\u0007building 10%\rbuilding 100%\r\n${ESC}[32m2 passed${ESC}[0m`,
        }),
      ]),
      { width: 40, maxLines: 50 },
    );
    expect(lines.map((line) => [line.kind, line.text])).toEqual([
      ["command", "pnpm test"],
      ["output", "building 100%"],
      ["output", "2 passed"],
    ]);
  });

  it("treats a turn of nothing but escapes as empty rather than a blank row", () => {
    expect(
      previewLines(transcript([event({ kind: "assistant", text: `${ESC}[2J${ESC}[H\u0007` })]), {
        width: 40,
        maxLines: 20,
      }),
    ).toEqual([]);
  });

  it("skips event kinds it does not render rather than guessing at them", () => {
    expect(
      previewLines(transcript([event({ kind: "unknown-future-kind", text: "x" })]), {
        width: 40,
        maxLines: 20,
      }),
    ).toEqual([]);
  });

  it("never opens or closes with a separator", () => {
    const lines = previewLines(
      transcript([event({ kind: "user", text: "a" }), event({ kind: "assistant", text: "b" })]),
      { width: 40, maxLines: 20 },
    );
    expect(lines[0]?.kind).not.toBe("blank");
    expect(lines.at(-1)?.kind).not.toBe("blank");
  });
});

describe("TRANSCRIPT_KEY", () => {
  it("is its own cache family, so the preview stales without the workbench", () => {
    expect(TRANSCRIPT_KEY("sess-1")).toEqual(["transcript", "sess-1"]);
  });
});
