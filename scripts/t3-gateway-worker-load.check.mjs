import assert from "node:assert/strict";
import { getHeapStatistics } from "node:v8";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { GatewayConfigFromEnv } from "../apps/t3-gateway/src/config.ts";
import { FindParser, findParserLayer } from "../apps/t3-gateway/src/find-parser.ts";
import { highlightLines } from "../apps/t3-gateway/src/highlight.ts";
import { GatewayServerLive } from "../apps/t3-gateway/src/server.ts";

const bufferMiB = Number(process.argv[2] ?? "256");
assert.ok(bufferMiB === 0 || bufferMiB === 256);
const bufferBytes = bufferMiB * 1024 * 1024;
const load = Array.from({ length: bufferMiB / 64 }, () => Buffer.alloc(64 * 1024 * 1024, 0xa5));
console.log(JSON.stringify({ phase: "loaded", bufferBytes }));

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const parser = yield* FindParser;
    const results = yield* Effect.all(
      {
        find: parser.segments({
          role: "assistant",
          text: "**needle**",
          streaming: false,
          hasContext: false,
          cwd: undefined,
          skills: [],
        }),
        highlight: highlightLines(["a needle"], {
          query: "n[e]+dle",
          caseSensitive: true,
          wholeWord: false,
          useRegex: true,
        }),
      },
      { concurrency: "unbounded" },
    );
    return results;
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        findParserLayer(),
        GatewayServerLive.pipe(Layer.provide(GatewayConfigFromEnv)),
      ),
    ),
  ),
);

assert.deepEqual(result.find, ["needle"]);
assert.deepEqual(result.highlight, [[{ start: 2, end: 8 }]]);
assert.equal(
  load.reduce((bytes, buffer) => bytes + buffer.byteLength, 0),
  bufferBytes,
);
for (const buffer of load) assert.equal(buffer.at(-1), 0xa5);
assert.ok(getHeapStatistics().external_memory >= bufferBytes);
console.log(
  JSON.stringify({
    phase: "completed",
    bufferBytes,
    ...result,
    maxRssKiB: process.resourceUsage().maxRSS,
  }),
);
