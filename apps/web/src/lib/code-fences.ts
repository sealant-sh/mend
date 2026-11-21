// A skill's file as it is shown in the skill panel, cut into the text that stays plain and the code
// that is coloured (SLNT-1260). A Markdown file's code is its fenced blocks, each by its fence's
// language; any other file is code as a whole, by its extension (`run.sh`, `config.json`).

/** A part of a file; the parts' texts, in order, make the file. */
export type FilePiece = { readonly start: number } & (
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly language: string; readonly text: string }
);

/** A fence's opening: up to three spaces, three or more backticks or tildes, then its info. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Extensions whose file is Markdown: its fenced blocks are the code. */
const MARKDOWN = new Set(["md", "markdown", "mdx"]);

/** The language a fence names: the first word of its info (```ts title="x"` is `ts`), or "". */
export const fenceInfoLanguage = (info: string): string =>
  (info.trim().split(/\s+/)[0] ?? "").replace(/^\{?\.?/, "").replace(/\}$/, "");

/** `contents` cut into plain text and fenced code blocks. */
export const fencedPieces = (contents: string): ReadonlyArray<FilePiece> => {
  const pieces: Array<FilePiece> = [];
  // Where the plain text not yet given out starts, and the open fence when inside one.
  let textStart = 0;
  let fence: { readonly marks: string; readonly language: string; readonly body: number } | null =
    null;
  const pushText = (end: number) => {
    if (end > textStart)
      pieces.push({ start: textStart, kind: "text", text: contents.slice(textStart, end) });
  };
  const pushCode = (end: number) => {
    if (fence !== null && end > fence.body)
      pieces.push({
        start: fence.body,
        kind: "code",
        language: fence.language,
        text: contents.slice(fence.body, end),
      });
  };
  let at = 0;
  while (at < contents.length) {
    const end = contents.indexOf("\n", at);
    const next = end === -1 ? contents.length : end + 1;
    const line = contents.slice(at, end === -1 ? contents.length : end);
    const match = FENCE.exec(line);
    if (fence === null) {
      // A backtick fence's info can't hold a backtick; such a line is inline code, not a fence.
      const marks = match?.[1];
      const info = match?.[2] ?? "";
      if (marks !== undefined && !(marks.startsWith("`") && info.includes("`"))) {
        pushText(next);
        textStart = next;
        fence = { marks, language: fenceInfoLanguage(info), body: next };
      }
    } else {
      const marks = match?.[1];
      if (
        marks !== undefined &&
        marks[0] === fence.marks[0] &&
        marks.length >= fence.marks.length &&
        line.trim() === marks
      ) {
        // The newline before the closing fence stays with the text, so the code ends on its last line.
        pushCode(Math.max(fence.body, at - 1));
        textStart = Math.max(fence.body, at - 1);
        fence = null;
      }
    }
    at = next;
  }
  if (fence === null) pushText(contents.length);
  else pushCode(contents.length);
  return pieces;
};

/** A skill's file, cut for the skill panel: a Markdown file by its fences, any other as one piece of code. */
export const filePieces = (path: string, contents: string): ReadonlyArray<FilePiece> => {
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (extension === "" || MARKDOWN.has(extension)) return fencedPieces(contents);
  if (contents === "") return [];
  return [{ start: 0, kind: "code", language: extension, text: contents }];
};
