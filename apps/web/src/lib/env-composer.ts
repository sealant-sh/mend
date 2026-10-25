import {
  formatProjectEnvironmentIssue,
  parseDotenv,
  PROJECT_ENV_NAME_PATTERN,
  routeDotenvName,
} from "@mend/domain/workbench";

/**
 * The Vercel-style variables composer: Key/Value rows, "Add another", a Sensitive toggle, and —
 * the load-bearing part — pasting a whole `.env` into ANY field expands it into rows (comments,
 * blank lines, and malformed lines dropped). Pure state; the component renders and posts.
 */

export interface ComposerRow {
  readonly id: number;
  readonly key: string;
  readonly value: string;
  /** Values are censored by default — typed or pasted — until the user reveals this row. */
  readonly revealed: boolean;
}

export interface ComposerState {
  readonly rows: ReadonlyArray<ComposerRow>;
  /** "Sensitive": every entry goes to Secrets regardless of name. */
  readonly allSecret: boolean;
  readonly nextId: number;
  /** Lines the last paste/import could not read as `NAME=value` — nothing was created from them. */
  readonly skippedLines: number;
}

export type ComposerAction =
  | { readonly type: "key-changed"; readonly id: number; readonly key: string }
  | { readonly type: "value-changed"; readonly id: number; readonly value: string }
  | { readonly type: "row-added" }
  | { readonly type: "row-removed"; readonly id: number }
  | { readonly type: "all-secret-toggled" }
  | { readonly type: "reveal-toggled"; readonly id: number }
  | { readonly type: "reveal-all-set"; readonly revealed: boolean }
  /** Text arrived by paste or file import; `intoId` is the row whose field received it. */
  | { readonly type: "text-expanded"; readonly intoId: number | null; readonly text: string }
  | { readonly type: "rows-cleared"; readonly ids: ReadonlyArray<number> }
  | { readonly type: "reset" };

export const initialComposer: ComposerState = {
  rows: [{ id: 1, key: "", value: "", revealed: false }],
  // Sensitive ON by default: a pasted .env is presumed secret; opting into plaintext is deliberate.
  allSecret: true,
  nextId: 2,
  skippedLines: 0,
};

/** Dotenv-shaped text: at least one `NAME=` line (an `export` prefix allowed). */
export const looksLikeDotenv = (text: string): boolean =>
  /(^|\n)\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(text) &&
  (text.includes("\n") || /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(text));

const isBlank = (row: ComposerRow): boolean => row.key === "" && row.value === "";

export const composerReducer = (state: ComposerState, action: ComposerAction): ComposerState => {
  switch (action.type) {
    case "key-changed":
      return {
        ...state,
        rows: state.rows.map((row) => (row.id === action.id ? { ...row, key: action.key } : row)),
      };
    case "value-changed":
      return {
        ...state,
        rows: state.rows.map((row) =>
          row.id === action.id ? { ...row, value: action.value } : row,
        ),
      };
    case "row-added":
      return {
        ...state,
        rows: [...state.rows, { id: state.nextId, key: "", value: "", revealed: false }],
        nextId: state.nextId + 1,
      };
    case "row-removed": {
      const rows = state.rows.filter((row) => row.id !== action.id);
      // Never an empty composer: removing the last row leaves one blank row.
      return rows.length === 0
        ? {
            ...state,
            rows: [{ id: state.nextId, key: "", value: "", revealed: false }],
            nextId: state.nextId + 1,
          }
        : { ...state, rows };
    }
    case "all-secret-toggled":
      return { ...state, allSecret: !state.allSecret };
    case "reveal-toggled":
      return {
        ...state,
        rows: state.rows.map((row) =>
          row.id === action.id ? { ...row, revealed: !row.revealed } : row,
        ),
      };
    case "reveal-all-set":
      return { ...state, rows: state.rows.map((row) => ({ ...row, revealed: action.revealed })) };
    case "text-expanded": {
      const parsed = parseDotenv(action.text);
      if (parsed.entries.length === 0) return state;
      let nextId = state.nextId;
      // Pasted values arrive CENSORED: a whole .env is exactly the content you don't want on screen.
      const incoming: Array<ComposerRow> = parsed.entries.map((entry) => ({
        id: nextId++,
        key: entry.name,
        value: entry.value,
        revealed: false,
      }));
      // The receiving row is replaced when it was blank; otherwise the rows append after it. Then
      // later duplicates win over earlier keys already in the composer (the file is the intent).
      const at = state.rows.findIndex((row) => row.id === action.intoId);
      const target = at === -1 ? undefined : state.rows[at];
      const before =
        target === undefined ? state.rows : state.rows.slice(0, isBlank(target) ? at : at + 1);
      const after = target === undefined ? [] : state.rows.slice(at + 1);
      const merged = [...before, ...incoming, ...after];
      const seen = new Set<string>();
      const deduped: Array<ComposerRow> = [];
      for (const row of merged.toReversed()) {
        if (row.key !== "" && seen.has(row.key)) continue;
        if (row.key !== "") seen.add(row.key);
        deduped.unshift(row);
      }
      // Drop any remaining fully blank rows once real content exists.
      const rows = deduped.filter((row) => !isBlank(row));
      return {
        ...state,
        rows: rows.length === 0 ? deduped : rows,
        nextId,
        skippedLines: parsed.malformed.length,
      };
    }
    case "rows-cleared": {
      const rows = state.rows.filter((row) => !action.ids.includes(row.id));
      return rows.length === 0
        ? {
            ...state,
            rows: [{ id: state.nextId, key: "", value: "", revealed: false }],
            nextId: state.nextId + 1,
          }
        : { ...state, rows };
    }
    case "reset":
      return { ...initialComposer, nextId: state.nextId };
  }
};

/** Where a row will land, computed live from its key (and the Sensitive toggle). */
export type RowLane =
  | { readonly kind: "empty" }
  | { readonly kind: "configuration" }
  | { readonly kind: "secret" }
  | { readonly kind: "rejected"; readonly reason: string };

export const rowLane = (row: ComposerRow, allSecret: boolean): RowLane => {
  if (row.key === "") return { kind: "empty" };
  const route = routeDotenvName(row.key);
  if (route.lane === "rejected") {
    return { kind: "rejected", reason: formatProjectEnvironmentIssue(route.issue) };
  }
  return allSecret || route.lane === "secret" ? { kind: "secret" } : { kind: "configuration" };
};

/** Rows worth saving: a non-empty key. Blank rows are ignored, not errors. */
export const savableRows = (state: ComposerState): ReadonlyArray<ComposerRow> =>
  state.rows.filter((row) => row.key !== "");

export interface ComposerSubmission {
  /**
   * Rows Save posts: refused names go too, so the endpoint reports them beside what it loaded. A
   * key outside the dotenv grammar stays here, since it would not read back as the same name.
   */
  readonly rows: ReadonlyArray<ComposerRow>;
  /** Rows no rule refuses by name. Save needs one. */
  readonly accepted: number;
}

export const composerSubmission = (state: ComposerState): ComposerSubmission => {
  const keyed = savableRows(state);
  return {
    rows: keyed.filter((row) => PROJECT_ENV_NAME_PATTERN.test(row.key)),
    accepted: keyed.filter((row) => rowLane(row, state.allSecret).kind !== "rejected").length,
  };
};

/**
 * Serialize rows for the load endpoint — the same dotenv the server parses for `mend env load`,
 * double-quoted with escapes so any value round-trips exactly (newlines, quotes, `#`).
 */
export const serializeRows = (rows: ReadonlyArray<ComposerRow>): string =>
  rows
    .map((row) => {
      const escaped = row.value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");
      return `${row.key}="${escaped}"`;
    })
    .join("\n");
