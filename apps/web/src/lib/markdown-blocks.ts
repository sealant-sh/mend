// What the agent wrote, cut into the Markdown blocks it is made of, so a reply that grows re-reads
// only its last block (SLNT-1231). A block ends at a blank line outside a code fence, before a
// line that starts a block of its own. Cutting anywhere else would change what the text means: an
// indented line after a blank one continues a list item (or is code, which reads the same either
// way), and a list item after a blank one continues its loose list. Keeping two blocks together
// is always safe; cutting is what has to be right.

/** The opening of a fenced code block: up to three spaces, then three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** A list item's first line. */
const ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/** The end of a text that could still become a list item's first line as more of it arrives. */
const ITEM_SO_FAR = /^ {0,3}(?:[-*+]|\d{1,9}[.)]?)$/;

/**
 * A link reference definition (`[name]: url`) or a footnote's (`[^1]: …`). Either is read across
 * the whole text, so a text holding one is read as one block.
 */
const DEFINITION = /^ {0,3}\[[^\]]+\]:/m;

/**
 * `text` as consecutive blocks whose concatenation is `text`. Each block but the last ends with
 * the blank line that closed it, and keeps the same string as the text grows after it.
 */
export const markdownBlocks = (text: string): ReadonlyArray<string> => {
  if (DEFINITION.test(text)) return [text];
  const blocks: Array<string> = [];
  let start = 0;
  let fence: string | null = null;
  let blank = false;
  // Whether the block's latest line at the left edge was a list item: a blank line then doesn't
  // end the list.
  let inList = false;
  let at = 0;
  while (at < text.length) {
    const end = text.indexOf("\n", at);
    const next = end === -1 ? text.length : end + 1;
    const line = text.slice(at, end === -1 ? text.length : end);
    if (fence !== null) {
      // A fence closes on a line of at least as many of its own marks and nothing after them.
      const close = FENCE.exec(line)?.[1];
      if (
        close !== undefined &&
        close[0] === fence[0] &&
        close.length >= fence.length &&
        line.trim() === close
      )
        fence = null;
      blank = false;
    } else if (line.trim() === "") {
      blank = true;
    } else {
      const indented = /^[ \t]/.test(line) && !ITEM.test(line);
      const item = ITEM.test(line) || (end === -1 && ITEM_SO_FAR.test(line));
      const continues = indented || (inList && item);
      if (blank && at > start && !continues) {
        blocks.push(text.slice(start, at));
        start = at;
      }
      if (!indented) inList = item;
      blank = false;
      fence = FENCE.exec(line)?.[1] ?? null;
    }
    at = next;
  }
  if (start < text.length || blocks.length === 0) blocks.push(text.slice(start));
  return blocks;
};
