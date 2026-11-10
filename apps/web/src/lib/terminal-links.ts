/** A terminal buffer row as link finding reads it; ghostty-web's buffer lines have this shape. */
export interface LinkRow {
  readonly length: number;
  /** In ghostty-web 0.4.0 this marks a row that continues the row above it after a soft wrap. */
  readonly isWrapped: boolean;
  getCell(x: number): { getCodepoint(): number } | undefined;
}

export interface CellPosition {
  readonly x: number;
  readonly y: number;
}

export interface FoundLink {
  readonly url: string;
  readonly range: { readonly start: CellPosition; readonly end: CellPosition };
}

// ghostty-web's own UrlRegexProvider patterns, so a link that fits one row is found as before.
const URL_PATTERN =
  /(?:https?:\/\/|mailto:|ftp:\/\/|ssh:\/\/|git:\/\/|tel:|magnet:|gemini:\/\/|gopher:\/\/|news:)[\w\-.~:/?#@!$&*+,;=%]+/gi;
const TRAILING_PUNCTUATION = /[.,;!?)\]]+$/;

/** One UTF-16 unit per cell, so a string offset is a cell offset. */
const rowText = (row: LinkRow): string => {
  let text = "";
  for (let x = 0; x < row.length; x++) {
    const codepoint = row.getCell(x)?.getCodepoint() ?? 0;
    text += codepoint < 32 || codepoint > 0xffff ? " " : String.fromCharCode(codepoint);
  }
  return text;
};

/**
 * The links that touch row `y`, each matched across the whole soft-wrapped line the row belongs
 * to, so a URL wrapped over several rows is one link from any of them.
 */
export const linksOnRow = (
  y: number,
  rowAt: (y: number) => LinkRow | undefined,
): ReadonlyArray<FoundLink> => {
  let top = y;
  while (top > 0 && rowAt(top)?.isWrapped === true) top -= 1;
  let bottom = y;
  while (rowAt(bottom + 1)?.isWrapped === true) bottom += 1;

  const segments: Array<{ readonly y: number; readonly offset: number }> = [];
  let text = "";
  for (let row = top; row <= bottom; row++) {
    segments.push({ y: row, offset: text.length });
    const line = rowAt(row);
    if (line !== undefined) text += rowText(line);
  }
  const positionOf = (offset: number): CellPosition => {
    const segment = segments.findLast((candidate) => candidate.offset <= offset) ?? {
      y: top,
      offset: 0,
    };
    return { x: offset - segment.offset, y: segment.y };
  };

  const links: Array<FoundLink> = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, "");
    if (url.length <= 8) continue;
    const start = positionOf(match.index);
    const end = positionOf(match.index + url.length - 1);
    if (start.y <= y && y <= end.y) links.push({ url, range: { start, end } });
  }
  return links;
};
