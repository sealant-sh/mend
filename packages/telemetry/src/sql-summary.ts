/**
 * A database span's query as a person reads it in a trace (SLNT-1375): one line, the select list,
 * the inserted columns and values, an update's assignments, a `returning` list and an `in (…)`
 * list folded to `..`, identifiers unquoted, at most `MAX_TEXT` long. What is left names what the
 * query did and to which table, and never a value: Mend's queries carry their values as `$n`
 * parameters, and the text is scrubbed again on its way out (`scrub.ts`).
 */

const MAX_TEXT = 300;

export interface SqlSummary {
  /** `SELECT`, `INSERT`, `UPDATE`, `DELETE`, or the first keyword of anything else. */
  readonly operation: string;
  /** The table the statement reads or writes first. */
  readonly collection: string | undefined;
  /** `SELECT agent_sessions`, or `SELECT pg_notify` for a bare call of a function. */
  readonly summary: string;
  /** The folded query: `select .. from agent_sessions where agent_sessions.id = $1 limit $2`. */
  readonly text: string;
}

interface Folded {
  readonly text: string;
  readonly end: number;
}

const isWordChar = (char: string | undefined) => char !== undefined && /[A-Za-z0-9_$]/.test(char);

/**
 * The index of `keyword` at paren depth zero, outside quotes, at or after `from`, as a whole word;
 * -1 when there is none.
 */
const topLevel = (sql: string, keywords: ReadonlyArray<string>, from: number): number => {
  let depth = 0;
  let quote: string | null = null;
  const lower = sql.toLowerCase();
  for (let index = from; index < sql.length; index++) {
    const char = sql[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && !isWordChar(sql[index - 1])) {
      for (const keyword of keywords) {
        if (lower.startsWith(keyword, index) && !isWordChar(sql[index + keyword.length]))
          return index;
      }
    }
  }
  return -1;
};

/** The index just past the paren group that opens at `open`, or -1 when it never closes. */
const closeOf = (sql: string, open: number): number => {
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < sql.length; index++) {
    const char = sql[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return index + 1;
  }
  return -1;
};

/** Whether `text` holds a comma at paren depth zero, outside quotes: a list of more than one. */
const hasTopLevelComma = (text: string): boolean => {
  let depth = 0;
  let quote: string | null = null;
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) return true;
  }
  return false;
};

/** The text from `start` to `end` folded to ` .. ` when it is a list, else left as it is. */
const foldBetween = (sql: string, start: number, end: number): Folded => {
  const inner = sql.slice(start, end);
  return hasTopLevelComma(inner) ? { text: " .. ", end } : { text: inner, end };
};

const FOLDED_KEYWORDS = ["select", "set", "returning", "values", "into", "in"] as const;

const fold = (sql: string): string => {
  let out = "";
  let cursor = 0;
  const lower = sql.toLowerCase();
  const emitUntil = (index: number) => {
    out += sql.slice(cursor, index);
    cursor = index;
  };
  while (cursor < sql.length) {
    const next = topLevel(sql, FOLDED_KEYWORDS, cursor);
    if (next === -1) break;
    const keyword = FOLDED_KEYWORDS.find(
      (candidate) => lower.startsWith(candidate, next) && !isWordChar(sql[next + candidate.length]),
    );
    if (keyword === undefined) break;
    const after = next + keyword.length;
    emitUntil(after);
    if (keyword === "select") {
      const distinct = /^\s+distinct(?:\s+on\s*\([^)]*\))?/i.exec(sql.slice(after))?.[0] ?? "";
      const listStart = after + distinct.length;
      const end = topLevel(sql, ["from"], listStart);
      if (end === -1) continue;
      emitUntil(listStart);
      const folded = foldBetween(sql, listStart, end);
      out += folded.text;
      cursor = folded.end;
    } else if (keyword === "set") {
      const end = topLevel(sql, ["where", "returning", "from"], after);
      const folded = foldBetween(sql, after, end === -1 ? sql.length : end);
      out += folded.text;
      cursor = folded.end;
    } else if (keyword === "returning") {
      out += " ..";
      cursor = sql.length;
    } else if (keyword === "values") {
      const end = topLevel(sql, ["on conflict", "returning"], after);
      out += " (..)";
      cursor = end === -1 ? sql.length : end;
      if (end !== -1) out += " ";
    } else if (keyword === "into") {
      // `insert into t (a, b, …)`: the column list folds; `select … into` is left alone.
      const head = /^\s+("[^"]+"|[\w.]+)\s*\(/.exec(sql.slice(after));
      if (head === null) continue;
      const open = after + head[0].length - 1;
      const close = closeOf(sql, open);
      if (close === -1) continue;
      emitUntil(open);
      out += "(..)";
      cursor = close;
    } else {
      // `in ($1, $2, …)`: as many parameters as the caller had ids.
      const list = /^\s*\((?:\s*\$\d+\s*,?)+\)/.exec(sql.slice(after));
      if (list === null) continue;
      out += " (..)";
      cursor = after + list[0].length;
    }
  }
  out += sql.slice(cursor);
  return out;
};

const unquote = (sql: string): string => sql.replace(/"([a-z_][a-z0-9_]*)"/g, "$1");

const IDENTIFIER = String.raw`("(?:[^"]+)"|[A-Za-z_][\w$]*)(?:\s*\.\s*("(?:[^"]+)"|[A-Za-z_][\w$]*))?`;

const identifierAt = (sql: string, pattern: RegExp): string | undefined => {
  const match = pattern.exec(sql);
  if (match === null) return undefined;
  const name = match[2] ?? match[1];
  return name?.replace(/"/g, "");
};

const collectionOf = (sql: string, operation: string): string | undefined => {
  switch (operation) {
    case "INSERT":
      return identifierAt(sql, new RegExp(String.raw`\binsert\s+into\s+${IDENTIFIER}`, "i"));
    case "UPDATE":
      return identifierAt(sql, new RegExp(String.raw`\bupdate\s+(?:only\s+)?${IDENTIFIER}`, "i"));
    case "DELETE":
      return identifierAt(sql, new RegExp(String.raw`\bdelete\s+from\s+${IDENTIFIER}`, "i"));
    default: {
      const from = topLevel(sql, ["from"], 0);
      if (from !== -1)
        return identifierAt(sql.slice(from), new RegExp(String.raw`^from\s+${IDENTIFIER}`, "i"));
      return undefined;
    }
  }
};

const operationOf = (sql: string): string => {
  const first = /^[A-Za-z]+/.exec(sql)?.[0]?.toUpperCase() ?? "QUERY";
  if (first !== "WITH") return first;
  // A CTE: the statement that follows the last `name as (…)` is the one that runs.
  const main = topLevel(sql, ["select", "insert", "update", "delete"], 0);
  return main === -1 ? "WITH" : (/^[A-Za-z]+/.exec(sql.slice(main))?.[0]?.toUpperCase() ?? "WITH");
};

export const summarizeSql = (query: string): SqlSummary => {
  const flat = query.replace(/\s+/g, " ").trim();
  const operation = operationOf(flat);
  const collection = collectionOf(flat, operation);
  const folded = unquote(fold(flat)).replace(/\s+/g, " ").trim();
  const text = folded.length > MAX_TEXT ? `${folded.slice(0, MAX_TEXT - 1)}…` : folded;
  const target = collection ?? /^select\s+([a-z_][\w]*)\s*\(/i.exec(flat)?.[1];
  return {
    operation,
    collection,
    summary: target === undefined ? operation : `${operation} ${target}`,
    text,
  };
};
