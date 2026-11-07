// Parses stdin with the real find worker on half the default heap, and says whether it was read as
// written. A process of its own: a heap Node fails to keep to the worker aborts only this one.
import { text as readAll } from "node:stream/consumers";

import * as Effect from "effect/Effect";

import { DEFAULT_FIND_PARSER_POOL, FindParser, findParserLayer } from "../../src/find-parser.ts";

const text = await readAll(process.stdin);
// The pool unrefs its workers, and nothing else here keeps the process up until the parse answers.
const alive = setInterval(() => undefined, 60_000);
const segments = await Effect.runPromise(
  Effect.gen(function* () {
    const parser = yield* FindParser;
    return yield* parser.segments({
      role: "assistant",
      text,
      streaming: false,
      hasContext: false,
      cwd: undefined,
      skills: [],
    });
  }).pipe(
    Effect.provide(
      findParserLayer({
        ...DEFAULT_FIND_PARSER_POOL,
        heapMiB: DEFAULT_FIND_PARSER_POOL.heapMiB / 2,
      }),
    ),
  ),
);
clearInterval(alive);
process.stdout.write(
  `${JSON.stringify({ asWritten: segments.length === 1 && segments[0] === text })}\n`,
);
