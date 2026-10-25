import { parseDotenv } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import {
  composerReducer,
  initialComposer,
  looksLikeDotenv,
  rowLane,
  savableRows,
  serializeRows,
  type ComposerState,
} from "./env-composer";

const reduce = (
  state: ComposerState,
  ...actions: ReadonlyArray<Parameters<typeof composerReducer>[1]>
) => actions.reduce(composerReducer, state);

describe("composerReducer", () => {
  it("starts with one blank row and never goes empty", () => {
    expect(initialComposer.rows).toHaveLength(1);
    const state = reduce(initialComposer, { type: "row-removed", id: 1 });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.key).toBe("");
  });

  it("expands a pasted .env into rows, dropping comments, blanks, and malformed lines", () => {
    const state = reduce(initialComposer, {
      type: "text-expanded",
      intoId: 1,
      text: [
        "# my dev env",
        "",
        "PORT=3000",
        "export APP_MODE=review",
        "DATABASE_URL='postgres://u:p@h/db'",
        'MULTI="a\\nb"',
        "this is not a variable",
        "STRIPE_API_KEY=sk_live_x # trailing comment",
      ].join("\n"),
    });
    expect(state.rows.map((row) => [row.key, row.value])).toEqual([
      ["PORT", "3000"],
      ["APP_MODE", "review"],
      ["DATABASE_URL", "postgres://u:p@h/db"],
      ["MULTI", "a\nb"],
      ["STRIPE_API_KEY", "sk_live_x"],
    ]);
    // The blank receiving row was replaced, not kept as an empty leftover.
    expect(state.rows.some((row) => row.key === "" && row.value === "")).toBe(false);
    expect(state.skippedLines).toBe(1);
  });

  it("appends after a non-blank receiving row and lets pasted keys win over duplicates", () => {
    const state = reduce(
      initialComposer,
      { type: "key-changed", id: 1, key: "PORT" },
      { type: "value-changed", id: 1, value: "1111" },
      { type: "row-added" }, // id 2, blank
      { type: "text-expanded", intoId: 1, text: "PORT=2222\nAPP_MODE=review" },
    );
    expect(state.rows.map((row) => [row.key, row.value])).toEqual([
      ["PORT", "2222"],
      ["APP_MODE", "review"],
    ]);
  });

  it("ignores text that holds no variables", () => {
    const state = reduce(initialComposer, {
      type: "text-expanded",
      intoId: 1,
      text: "just a value",
    });
    expect(state).toBe(initialComposer);
  });

  it("clears saved rows and keeps the rest", () => {
    const state = reduce(initialComposer, {
      type: "text-expanded",
      intoId: 1,
      text: "A=1\nB=2\nC=3",
    });
    const ids = state.rows.filter((row) => row.key !== "B").map((row) => row.id);
    const after = reduce(state, { type: "rows-cleared", ids });
    expect(after.rows.map((row) => row.key)).toEqual(["B"]);
  });
});

describe("value censoring", () => {
  it("pastes arrive censored and stay so until revealed per row or all at once", () => {
    const pasted = reduce(initialComposer, {
      type: "text-expanded",
      intoId: 1,
      text: "A=1\nB=2",
    });
    expect(pasted.rows.every((row) => !row.revealed)).toBe(true);
    const first = pasted.rows[0]?.id ?? 0;
    const one = reduce(pasted, { type: "reveal-toggled", id: first });
    expect(one.rows.map((row) => row.revealed)).toEqual([true, false]);
    const all = reduce(one, { type: "reveal-all-set", revealed: true });
    expect(all.rows.every((row) => row.revealed)).toBe(true);
    const none = reduce(all, { type: "reveal-all-set", revealed: false });
    expect(none.rows.every((row) => !row.revealed)).toBe(true);
    // A fresh row is censored too.
    expect(reduce(none, { type: "row-added" }).rows.at(-1)?.revealed).toBe(false);
  });
});

describe("looksLikeDotenv", () => {
  it("recognizes single and multi-line assignments, not plain values", () => {
    expect(looksLikeDotenv("KEY=value")).toBe(true);
    expect(looksLikeDotenv("# c\nexport KEY=value\n")).toBe(true);
    expect(looksLikeDotenv("postgres://u:p@h/db")).toBe(false);
    expect(looksLikeDotenv("hello world")).toBe(false);
  });
});

const keyOnly = (key: string) => ({ id: 1, key, value: "", revealed: false });

describe("rowLane", () => {
  it("routes by key, honors the Sensitive toggle (on by default), and names rejections", () => {
    expect(initialComposer.allSecret).toBe(true);
    expect(rowLane(keyOnly(""), false)).toEqual({ kind: "empty" });
    expect(rowLane(keyOnly("PORT"), false)).toEqual({ kind: "configuration" });
    expect(rowLane(keyOnly("PORT"), true)).toEqual({ kind: "secret" });
    expect(rowLane(keyOnly("STRIPE_API_KEY"), false)).toEqual({ kind: "secret" });
    expect(rowLane(keyOnly("GITHUB_TOKEN"), false).kind).toBe("rejected");
  });

  it("rejects a provider login row with words that point to Connected accounts", () => {
    expect(rowLane(keyOnly("ANTHROPIC_API_KEY"), true)).toEqual({
      kind: "rejected",
      reason:
        "ANTHROPIC_API_KEY is a Claude login, not a project secret. Connect your Claude login in Settings → Connected accounts.",
    });
  });
});

describe("serializeRows", () => {
  it("round-trips any value through the server parser", () => {
    const rows = [
      { id: 1, key: "PLAIN", value: "hello", revealed: false },
      { id: 2, key: "QUOTES", value: 'say "hi" # not a comment', revealed: false },
      { id: 3, key: "MULTI", value: "line1\nline2\ttab", revealed: false },
      { id: 4, key: "BACKSLASH", value: "C:\\path", revealed: false },
      { id: 5, key: "EMPTY", value: "", revealed: false },
    ];
    const parsed = parseDotenv(serializeRows(rows));
    expect(parsed.malformed).toEqual([]);
    expect(parsed.entries.map((entry) => [entry.name, entry.value])).toEqual(
      rows.map((row) => [row.key, row.value]),
    );
    expect(
      savableRows({
        ...initialComposer,
        rows: [...rows, { id: 6, key: "", value: "x", revealed: false }],
      }),
    ).toHaveLength(5);
  });
});
