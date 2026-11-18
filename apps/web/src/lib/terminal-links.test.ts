import { describe, expect, it } from "vitest";

import { type LinkRow, linksOnRow } from "#/lib/terminal-links";

/** Lay printed lines out on a terminal `cols` wide, soft-wrapping each the way the terminal does. */
const screen = (cols: number, printed: ReadonlyArray<string>) => {
  const rows: Array<LinkRow> = [];
  for (const line of printed) {
    const chunks = line.match(new RegExp(`.{1,${cols}}`, "g")) ?? [""];
    chunks.forEach((chunk, index) => {
      const padded = chunk.padEnd(cols);
      rows.push({
        length: cols,
        isWrapped: index > 0,
        getCell: (x) => (x < cols ? { getCodepoint: () => padded.codePointAt(x) ?? 0 } : undefined),
      });
    });
  }
  return (y: number) => rows[y];
};

const signIn =
  "http://localhost:3001/authorize?response_type=code&client_id=ed88fd8d-2472-45a2-846a-906326886951&code_challenge=nwe2V9YY9sgIoTrmrc1rYraDcVoSlWomLYOGiey7rv4&code_challenge_method=S256&state=NB0vslFU4";

describe("linksOnRow", () => {
  it("finds a soft-wrapped URL whole from every row it covers", () => {
    const rowAt = screen(40, ["If the browser didn't open, visit:", `  ${signIn}`, "Waiting"]);
    const lastRow = Math.ceil((signIn.length + 2) / 40);
    for (let y = 1; y <= lastRow; y++) {
      expect(linksOnRow(y, rowAt)).toEqual([
        {
          url: signIn,
          range: { start: { x: 2, y: 1 }, end: { x: (signIn.length + 1) % 40, y: lastRow } },
        },
      ]);
    }
    expect(linksOnRow(0, rowAt)).toEqual([]);
    expect(linksOnRow(lastRow + 1, rowAt)).toEqual([]);
  });

  it("finds a URL that fits on one row", () => {
    const rowAt = screen(80, ["see https://mend.run/docs, then go on"]);
    expect(linksOnRow(0, rowAt)).toEqual([
      { url: "https://mend.run/docs", range: { start: { x: 4, y: 0 }, end: { x: 24, y: 0 } } },
    ]);
  });

  it("does not join a row that starts a new line", () => {
    const rowAt = screen(20, ["https://mend.run/abc", "defg"]);
    expect(linksOnRow(0, rowAt).map((link) => link.url)).toEqual(["https://mend.run/abc"]);
    expect(linksOnRow(1, rowAt)).toEqual([]);
  });
});
