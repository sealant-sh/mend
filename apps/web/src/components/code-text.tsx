import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";

import type { GrammarState, Token, Tokenizer } from "#/lib/code-highlighter";

// Code coloured by its language with the review's highlighter and colours (SLNT-1260). The
// highlighter loads through `import()` the first time a block with a language shows, so no page
// carries it on its first load; until it arrives, and for a language it doesn't know, the code
// is plain.

/** Each language's tokenizer once it has loaded (null: stays plain), for every block after it. */
const loaded = new Map<string, Tokenizer | null>();
const loading = new Map<string, Promise<Tokenizer | null>>();

const load = (language: string): Promise<Tokenizer | null> => {
  const pending =
    loading.get(language) ??
    import("#/lib/code-highlighter")
      .then(({ loadTokenizer }) => loadTokenizer(language))
      .catch(() => null)
      .then((tokenizer) => {
        loaded.set(language, tokenizer);
        return tokenizer;
      });
  loading.set(language, pending);
  return pending;
};

/** One line, keyed by where it starts in the code, after a newline unless it is the first. */
const line = (tokens: ReadonlyArray<Token>, start: number): ReactNode => (
  <Fragment key={start}>
    {start === 0 ? null : "\n"}
    {tokens.map((token) =>
      token.color === undefined ? (
        <Fragment key={token.offset}>{token.content}</Fragment>
      ) : (
        <span key={token.offset} style={{ color: token.color }}>
          {token.content}
        </span>
      ),
    )}
  </Fragment>
);

/** Coloured lines as nodes, the first starting at `start` in the code. */
const lineNodes = (lines: ReadonlyArray<ReadonlyArray<Token>>, start: number) => {
  let at = start;
  return lines.map((tokens) => {
    const node = line(tokens, at);
    at += tokens.reduce((length, token) => length + token.content.length, 0) + 1;
    return node;
  });
};

/** The lines already coloured, and the text they were coloured from. */
interface Done {
  readonly tokenizer: Tokenizer | null | undefined;
  readonly text: string;
  readonly lines: ReadonlyArray<ReactNode>;
  readonly after: GrammarState | undefined;
}

/**
 * `code` as one node per line (each after its newline), coloured by `language`, or null while it is plain. As the code
 * grows (a reply streaming), only its new complete lines are coloured, continuing from where the
 * grammar was at the line before, and the unfinished last line on its own: each finished line
 * keeps the same node, so React leaves it alone.
 */
const useCodeLines = (code: string, language: string): ReadonlyArray<ReactNode> | null => {
  const [arrived, setArrived] = useState<{
    readonly language: string;
    readonly tokenizer: Tokenizer | null;
  } | null>(null);
  const tokenizer = loaded.has(language)
    ? loaded.get(language)
    : arrived?.language === language
      ? arrived.tokenizer
      : undefined;

  useEffect(() => {
    if (loaded.has(language)) return;
    let current = true;
    const arrive = async () => {
      const next = await load(language);
      if (current) setArrived({ language, tokenizer: next });
    };
    void arrive();
    return () => {
      current = false;
    };
  }, [language]);

  const [done, setDone] = useState<Done>({
    tokenizer: undefined,
    text: "",
    lines: [],
    after: undefined,
  });
  let next = done;
  if (next.tokenizer !== tokenizer || !code.startsWith(next.text))
    next = { tokenizer, text: "", lines: [], after: undefined };
  const end = code.lastIndexOf("\n") + 1;
  if (tokenizer && end > next.text.length) {
    const result = tokenizer(code.slice(next.text.length, end - 1), next.after);
    next = {
      tokenizer,
      text: code.slice(0, end),
      lines: [...next.lines, ...lineNodes(result.lines, next.text.length)],
      after: result.after,
    };
  }
  // Kept from render to render, so the next one starts where this one ended.
  if (next !== done) setDone(next);

  const tail = code.slice(end);
  return useMemo(() => {
    if (!tokenizer) return null;
    const last = tokenizer(tail, next.after).lines[0] ?? [];
    return [...next.lines, line(last, end)];
  }, [tokenizer, next, tail, end]);
};

/** Code coloured by `language` (a fence's info word: `ts`, `bash`, …), as it is otherwise plain. */
export function CodeText({ code, language }: { readonly code: string; readonly language: string }) {
  return useCodeLines(code, language) ?? code;
}
