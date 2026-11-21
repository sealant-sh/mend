import { type DiffsHighlighter, getSharedHighlighter } from "@pierre/diffs";

import { CODE_THEME } from "./code-theme";

// The review's highlighter (@pierre/diffs's shared Shiki) for a code block. Only `code-colours`
// imports this, and only through `import()`, so the highlighter and its grammars load the first
// time a code block shows, never with a page.

/** One piece of a line and its colour: a CSS colour built on the kit's syntax tokens. */
export interface Token {
  readonly content: string;
  /** Where it starts in the piece of code that was coloured. */
  readonly offset: number;
  readonly color: string | undefined;
}

/** Where the grammar was at the end of a piece of code. */
export type GrammarState = NonNullable<
  NonNullable<Parameters<DiffsHighlighter["codeToTokens"]>[1]>["grammarState"]
>;

/**
 * Lines of code as tokens, and where the grammar was at their end. Passing that back as `after`
 * colours the next lines as if they had come in the same piece, so a growing block only reads its
 * new lines.
 */
export type Tokenizer = (
  code: string,
  after?: GrammarState,
) => {
  readonly lines: ReadonlyArray<ReadonlyArray<Token>>;
  readonly after: GrammarState | undefined;
};

/** Names that mean plain text: nothing to colour. */
const PLAIN = new Set(["text", "txt", "plain", "plaintext", "ansi", "output", "console"]);

/**
 * The tokenizer for a fence's language, or null for one the highlighter doesn't know (it stays
 * plain). Shiki's own names and aliases are accepted (`ts`, `sh`, `yml`, …).
 */
export const loadTokenizer = async (language: string): Promise<Tokenizer | null> => {
  const lang = language.toLowerCase();
  if (lang === "" || PLAIN.has(lang)) return null;
  const shiki = await getSharedHighlighter({ themes: [CODE_THEME], langs: [lang] }).catch(
    () => null,
  );
  if (shiki === null) return null;
  return (code, after) => {
    try {
      const { tokens } = shiki.codeToTokens(code, {
        lang,
        theme: CODE_THEME,
        ...(after === undefined ? {} : { grammarState: after }),
      });
      return {
        lines: tokens.map((line) =>
          line.map((token) => ({
            content: token.content,
            offset: token.offset,
            color: token.color,
          })),
        ),
        after: shiki.getLastGrammarState(tokens),
      };
    } catch {
      // A grammar that fails on this text leaves it plain.
      return {
        lines: code.split("\n").map((line) => [{ content: line, offset: 0, color: undefined }]),
        after,
      };
    }
  };
};
