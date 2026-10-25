/**
 * Summarises `forward-dial.ts` output: per series, the dials (ready and failed apart) and the
 * requests, each phase as N, median, p90 and worst, in milliseconds.
 *
 *   node packages/sessions/bench/forward-dial-summary.ts <file.jsonl>...
 */
import { readFileSync } from "node:fs";

interface Line {
  readonly series?: unknown;
  readonly kind?: unknown;
  readonly lookupMs?: unknown;
  readonly totalMs?: unknown;
  readonly ttfbMs?: unknown;
  readonly dialled?: unknown;
  readonly attempts?: unknown;
  readonly issue?: unknown;
}

const isLine = (value: unknown): value is Line => typeof value === "object" && value !== null;

const numbers = new Map<string, number[]>();
const add = (key: string, value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  const list = numbers.get(key) ?? [];
  list.push(value);
  numbers.set(key, list);
};

const reasonOf = (issue: unknown): string =>
  typeof issue === "object" &&
  issue !== null &&
  "reason" in issue &&
  typeof issue.reason === "string"
    ? issue.reason
    : "unknown";

for (const file of process.argv.slice(2)) {
  for (const text of readFileSync(file, "utf8").split("\n")) {
    if (text.trim() === "") continue;
    const line: unknown = JSON.parse(text);
    if (!isLine(line)) continue;
    const series = String(line.series ?? file);
    if (line.kind === "request") {
      const group = `${series} · request${line.dialled === true ? " (dialled)" : " (reused)"}`;
      add(`${group} · ttfb`, line.ttfbMs);
      add(`${group} · total`, line.totalMs);
      continue;
    }
    const group =
      line.kind === "ready" ? `${series} · dial ready` : `${series} · dial ${reasonOf(line.issue)}`;
    add(`${group} · lookup`, line.lookupMs);
    if (Array.isArray(line.attempts)) {
      for (const attempt of line.attempts) {
        if (
          typeof attempt === "object" &&
          attempt !== null &&
          "route" in attempt &&
          "openMs" in attempt
        ) {
          add(`${group} · open ${String(attempt.route)}`, attempt.openMs);
        }
      }
    }
    add(`${group} · total`, line.totalMs);
  }
}

const quantile = (sorted: ReadonlyArray<number>, q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;

const rows = [...numbers.entries()].map(([key, values]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return [
    key,
    String(sorted.length),
    quantile(sorted, 0.5).toFixed(1),
    quantile(sorted, 0.9).toFixed(1),
    (sorted.at(-1) ?? Number.NaN).toFixed(1),
  ];
});
const header = ["measure", "N", "median", "p90", "worst"];
const widths = header.map((_, column) =>
  Math.max(header[column]?.length ?? 0, ...rows.map((row) => row[column]?.length ?? 0)),
);
const format = (row: ReadonlyArray<string>) =>
  row
    .map((cell, column) =>
      column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0),
    )
    .join("  ");
console.log(format(header));
for (const row of rows) console.log(format(row));
