import { Worker } from "node:worker_threads";

import * as Effect from "effect/Effect";

/**
 * Where a searched line matches, as t3code highlights it (`matchRanges`). A literal query is found
 * with `indexOf` on the gateway's own thread: its cost is linear in the line. A regex is the
 * client's, and JavaScript's engine can take seconds on one line (`(a+)+$`, mend#605 review), so it
 * never runs on the gateway's thread: a worker matches every line of the answer within
 * `REGEX_HIGHLIGHT_BUDGET`, and is stopped past it. Lines it did not finish are answered without
 * highlights; they still matched, in git.
 */

export interface MatchRange {
  readonly start: number;
  readonly end: number;
}

export interface HighlightQuery {
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly useRegex: boolean;
}

/** How long one search's regex highlighting may run, in a worker, before it is stopped. */
export const REGEX_HIGHLIGHT_BUDGET = "250 millis";

const isWordChar = (char: string | undefined) => char !== undefined && /\w/.test(char);

/** A literal's matches, without a regex: `indexOf`, case folded when asked, whole words when asked. */
export const literalRangesOf = (text: string, query: HighlightQuery): ReadonlyArray<MatchRange> => {
  const needle = query.caseSensitive ? query.query : query.query.toLowerCase();
  if (needle.length === 0) return [];
  const haystack = query.caseSensitive ? text : text.toLowerCase();
  const ranges: Array<MatchRange> = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    const end = at + needle.length;
    const whole = !query.wholeWord || (!isWordChar(text[at - 1]) && !isWordChar(text[end]));
    if (whole) ranges.push({ start: at, end });
    from = whole ? end : at + 1;
  }
  return ranges;
};

/** The worker: every line's matches of one pattern, posted back at once. */
const REGEX_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { source, flags, lines } = workerData;
let pattern = null;
try { pattern = new RegExp(source, flags); } catch {}
const ranges = lines.map((text) => {
  if (pattern === null) return [];
  const found = [];
  for (const match of text.matchAll(pattern)) {
    if (match[0].length === 0) break;
    found.push({ start: match.index, end: match.index + match[0].length });
  }
  return found;
});
parentPort.postMessage(ranges);
`;

const isRangeLists = (value: unknown): value is ReadonlyArray<ReadonlyArray<MatchRange>> =>
  Array.isArray(value) && value.every((ranges) => Array.isArray(ranges));

/** A regex's matches in each line, from a worker within the budget; none for a line it did not finish. */
const regexRangesOf = (
  lines: ReadonlyArray<string>,
  query: HighlightQuery,
): Effect.Effect<ReadonlyArray<ReadonlyArray<MatchRange>>> => {
  const unhighlighted = lines.map((): ReadonlyArray<MatchRange> => []);
  if (lines.length === 0) return Effect.succeed(unhighlighted);
  const source = query.wholeWord ? `\\b(?:${query.query})\\b` : query.query;
  return Effect.callback<ReadonlyArray<ReadonlyArray<MatchRange>>>((resume) => {
    const worker = new Worker(REGEX_WORKER, {
      eval: true,
      workerData: { source, flags: query.caseSensitive ? "g" : "gi", lines: [...lines] },
    });
    worker.once("message", (value: unknown) => {
      resume(Effect.succeed(isRangeLists(value) ? value : unhighlighted));
      void worker.terminate();
    });
    worker.once("error", () => resume(Effect.succeed(unhighlighted)));
    return Effect.promise(() => worker.terminate());
  }).pipe(
    Effect.timeoutOrElse({
      duration: REGEX_HIGHLIGHT_BUDGET,
      orElse: () => Effect.succeed(unhighlighted),
    }),
  );
};

/** Every line's matches for one search: literal on this thread, a regex in a bounded worker. */
export const highlightLines = (
  lines: ReadonlyArray<string>,
  query: HighlightQuery,
): Effect.Effect<ReadonlyArray<ReadonlyArray<MatchRange>>> =>
  query.useRegex
    ? regexRangesOf(lines, query)
    : Effect.succeed(lines.map((text) => literalRangesOf(text, query)));
