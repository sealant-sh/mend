/**
 * The detail pane's read-only output preview.
 *
 * It reads the session's own conversation record through the existing
 * `GET /sessions/:id/transcript` — the same read the web chat makes, live from
 * the running workspace's harness state while a session runs and from the
 * store once it settles. That endpoint is the whole preview contract: this
 * module renders what the record carries and nothing else.
 *
 * Two things it deliberately is not. It is not an attach: the TTY bridge hands
 * over write authority and suspends the dashboard, and a preview that did that
 * would make merely selecting a row take the terminal. And it is not a
 * reconstruction: when the record is empty the pane says so rather than
 * inventing plausible output.
 *
 * Pure functions plus one fetch; dashboard.tsx owns the query and the paint.
 */

import { stripVTControlCharacters } from "node:util";

/** One conversation event as the server sends it (api-contracts `TranscriptEvent`). */
export interface TranscriptEventDto {
  readonly kind: string;
  readonly text: string | null;
  readonly name: string | null;
  readonly command: string | null;
  readonly output: string | null;
}

export interface SessionTranscriptDto {
  /** The harness whose record this is — it may differ from the session's own. */
  readonly sourceHarness: string;
  readonly events: ReadonlyArray<TranscriptEventDto>;
}

/**
 * What a rendered line is, so the pane can colour it without re-parsing:
 * who spoke, or which half of a tool call it belongs to. `meta` is the
 * preview's own voice — a separator or a truncation fact, never content.
 */
export type PreviewLineKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "command"
  | "output"
  | "meta"
  | "blank";

export interface PreviewLine {
  readonly kind: PreviewLineKind;
  readonly text: string;
  /** First line of its block — the pane draws the speaker glyph only here. */
  readonly lead: boolean;
}

/**
 * How many wrapped lines each kind of block may spend. A preview is a glance,
 * not the transcript: a 400-line tool output would push every turn off screen,
 * so each block states its size and stops.
 */
const BLOCK_LINES: Readonly<Record<PreviewLineKind, number>> = {
  user: 6,
  assistant: 14,
  reasoning: 4,
  command: 3,
  output: 5,
  meta: 1,
  blank: 1,
};

/**
 * A control string and its payload: OSC (window title, hyperlink, clipboard),
 * DCS (tmux passthrough, Sixel), SOS, PM, APC (kitty graphics) — up to the
 * terminator, or to the end of the text when the harness cut it short.
 *
 * These go first because `stripVTControlCharacters` only recognises a narrow
 * payload — a window title with a space in it survives as rubbish — and because
 * its CSI branch otherwise runs on to the next BEL and eats the real text in
 * between. A bare BEL is dropped up front for that second reason.
 */
const CONTROL_STRING =
  // eslint-disable-next-line no-control-regex -- matching control bytes is the point
  /(?:\u001b[\]P^_X]|[\u0090\u0098\u009d\u009e\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g;
const BELL = "\u0007";

/** Everything C0/C1 except newline and tab: unprintable inside a preview line. */
// eslint-disable-next-line no-control-regex -- matching control bytes is the point
const UNSAFE_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * What a line still says after its carriage returns: text written after a `\r`
 * overwrote the text before it, so only the last write survives. A progress bar
 * reads as its final state instead of the hundred near-identical lines it would
 * become if every redraw were kept. The approximation is deliberate — a real
 * terminal leaves the tail of a longer earlier write showing, which is noise no
 * reader of a preview wants.
 */
const lastWrite = (line: string): string =>
  line.includes("\r")
    ? (line
        .split("\r")
        .filter((part) => part !== "")
        .at(-1) ?? "")
    : line;

/**
 * Terminal output as text a pane can print.
 *
 * Tool output in the record is raw terminal bytes — colour, cursor moves, title
 * writes, progress redraws. Printed as-is inside the dashboard's own frame those
 * sequences would repaint its chrome and scramble the layout, so every escape is
 * removed before a line is measured, wrapped or shown. `stripVTControlCharacters`
 * takes the CSI/OSC/DCS families; carriage returns and the remaining C0/C1 bytes
 * it leaves behind are handled here.
 *
 * Idempotent: text that is already plain comes back unchanged.
 */
export const plainText = (text: string): string =>
  stripVTControlCharacters(text.replaceAll(CONTROL_STRING, "").replaceAll(BELL, ""))
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map(lastWrite)
    .join("\n")
    .replaceAll(UNSAFE_CONTROLS, "");

const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Printable ASCII (and tab) measures itself; most preview text is ASCII. */
const NON_ASCII = /[^\u0020-\u007e\t]/;

/** A cluster that opens with a combining mark or joiner hangs off its neighbour. */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]/u;

/** U+FE0F asks for emoji presentation, which a terminal draws double-wide. */
const EMOJI_PRESENTATION = "\ufe0f";

/** East Asian Wide/Fullwidth blocks plus the emoji planes. */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0xa4cf], // Kana, Bopomofo, CJK unified ideographs, Yi
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // Vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x16fe0, 0x16fe4], // Tangut and Nushu marks
  [0x17000, 0x18cd5], // Tangut
  [0x1b000, 0x1b2ff], // Kana supplement and extensions
  [0x1f200, 0x1f2ff], // Enclosed ideographic supplement
  [0x1f300, 0x1faff], // Emoji planes
  [0x20000, 0x3fffd], // CJK unified ideographs, extension B onwards
];

const isWide = (code: number): boolean =>
  WIDE_RANGES.some(([low, high]) => code >= low && code <= high);

const graphemeWidth = (cluster: string): number => {
  if (ZERO_WIDTH.test(cluster)) return 0;
  if (cluster.includes(EMOJI_PRESENTATION)) return 2;
  return isWide(cluster.codePointAt(0) ?? 0) ? 2 : 1;
};

/**
 * How many terminal columns `text` occupies.
 *
 * `String.length` counts UTF-16 units, which is the wrong ruler for a pane: a
 * terminal spends two columns on a CJK glyph that counts as one unit, none on a
 * combining mark, and two on an emoji cluster however many units it is made of.
 * Wrapping on units therefore overruns the pane and corrupts the frame beside
 * it. Grapheme clusters come from `Intl.Segmenter`, so this stays dependency
 * free; the wide set is the usual Unicode block list, which matches what
 * terminals draw double for everything short of font-specific edge cases.
 *
 * @param text - Plain text. Escape sequences must already be gone (`plainText`).
 */
export const displayWidth = (text: string): number => {
  if (!NON_ASCII.test(text)) return text.length;
  let width = 0;
  for (const { segment } of GRAPHEMES.segment(text)) width += graphemeWidth(segment);
  return width;
};

/** Split `text` at `limit` columns, always advancing by at least one grapheme. */
const cutToWidth = (text: string, limit: number): readonly [string, string] => {
  if (!NON_ASCII.test(text)) return [text.slice(0, limit), text.slice(limit)];
  let width = 0;
  for (const { segment, index } of GRAPHEMES.segment(text)) {
    const next = width + graphemeWidth(segment);
    if (next > limit) {
      // A lone grapheme wider than the whole limit still has to move forward.
      const at = index === 0 ? segment.length : index;
      return [text.slice(0, at), text.slice(at)];
    }
    width = next;
  }
  return [text, ""];
};

/**
 * Greedy word wrap at `width` terminal columns, keeping the record's own
 * newlines and dropping any terminal escapes the text still carries. Never
 * returns [].
 */
export const wrapText = (text: string, width: number): ReadonlyArray<string> => {
  const limit = Math.max(8, width);
  const out: Array<string> = [];
  for (const paragraph of plainText(text).replaceAll("\t", "  ").split("\n")) {
    const trimmed = paragraph.trimEnd();
    if (trimmed === "") {
      out.push("");
      continue;
    }
    let line = "";
    let lineWidth = 0;
    for (const word of trimmed.split(/ +/)) {
      const wordWidth = displayWidth(word);
      if (line === "") {
        line = word;
        lineWidth = wordWidth;
      } else if (lineWidth + 1 + wordWidth <= limit) {
        line = `${line} ${word}`;
        lineWidth += 1 + wordWidth;
      } else {
        out.push(line);
        line = word;
        lineWidth = wordWidth;
      }
      // A single unbreakable token (a path, a base64 blob) is cut, not hidden.
      while (lineWidth > limit) {
        const [head, rest] = cutToWidth(line, limit);
        out.push(head);
        line = rest;
        lineWidth = displayWidth(rest);
      }
    }
    if (line !== "") out.push(line);
  }
  return out.length === 0 ? [""] : out;
};

const isBlank = (line: PreviewLine | undefined): boolean => line?.kind === "blank";

/**
 * The record as preview lines, newest last — the pane scrolls to the bottom,
 * the way a terminal does. `maxLines` caps the whole block from the END: a long
 * session keeps its most recent turns and states how much it dropped.
 */
export const previewLines = (
  transcript: SessionTranscriptDto,
  options: { readonly width: number; readonly maxLines: number },
): ReadonlyArray<PreviewLine> => {
  const width = Math.max(8, options.width);
  const lines: Array<PreviewLine> = [];
  const push = (kind: PreviewLineKind, text: string): void => {
    const wrapped = wrapText(text, width);
    const budget = BLOCK_LINES[kind];
    for (const [index, line] of wrapped.slice(0, budget).entries()) {
      lines.push({ kind, text: line, lead: index === 0 });
    }
    if (wrapped.length > budget) {
      lines.push({ kind: "meta", text: `… ${wrapped.length - budget} more lines`, lead: false });
    }
  };
  const separate = (): void => {
    if (lines.length > 0 && !isBlank(lines.at(-1))) {
      lines.push({ kind: "blank", text: "", lead: false });
    }
  };

  for (const event of transcript.events) {
    // Sanitised here too, so a turn of nothing but escapes reads as empty.
    const text = plainText(event.text ?? "").trim();
    switch (event.kind) {
      case "user":
        if (text === "") break;
        separate();
        push("user", text);
        break;
      case "assistant":
        if (text === "") break;
        separate();
        push("assistant", text);
        break;
      case "reasoning":
        if (text === "") break;
        push("reasoning", text);
        break;
      case "tool": {
        const command = plainText(event.command ?? "").trim();
        push("command", command === "" ? (event.name ?? "tool") : command);
        const output = plainText(event.output ?? "").trimEnd();
        if (output !== "") push("output", output);
        break;
      }
      default:
        break;
    }
  }
  while (lines.length > 0 && isBlank(lines[0])) lines.shift();
  while (lines.length > 0 && isBlank(lines.at(-1))) lines.pop();

  const max = Math.max(1, options.maxLines);
  if (lines.length <= max) return lines;
  const kept = lines.slice(lines.length - (max - 1));
  return [
    { kind: "meta", text: `… ${lines.length - kept.length} earlier lines`, lead: true },
    ...kept,
  ];
};

/**
 * The window of lines a pane of `rows` shows, `offset` lines back from the
 * tail. The preview is pinned to the newest turn the way a terminal is, so the
 * window is measured from the END and the reader walks BACKWARDS through it.
 * Slicing here rather than scrolling a viewport keeps the newest line the one
 * that is guaranteed on screen, whatever the layout rounds to.
 */
export interface PreviewWindow {
  readonly lines: ReadonlyArray<PreviewLine>;
  /** The offset actually used, after clamping to what exists. */
  readonly offset: number;
  /** Older lines exist above this window. */
  readonly earlier: number;
  /** Newer lines exist below it — the reader has scrolled back. */
  readonly later: number;
}

export const previewWindow = (
  lines: ReadonlyArray<PreviewLine>,
  rows: number,
  offset: number,
): PreviewWindow => {
  const height = Math.max(1, rows);
  const furthest = Math.max(0, lines.length - height);
  const clamped = Math.max(0, Math.min(furthest, Math.trunc(offset)));
  const end = lines.length - clamped;
  const start = Math.max(0, end - height);
  return {
    lines: lines.slice(start, end),
    offset: clamped,
    earlier: start,
    later: lines.length - end,
  };
};

/** The preview's own cache family — invalidated by conversation events only. */
export const TRANSCRIPT_KEY = (sessionId: string): ReadonlyArray<string> => [
  "transcript",
  sessionId,
];

export const fetchTranscript = (
  api: <T>(method: "GET", route: string) => Promise<T>,
  sessionId: string,
): Promise<SessionTranscriptDto> =>
  api<SessionTranscriptDto>("GET", `/sessions/${sessionId}/transcript`);
