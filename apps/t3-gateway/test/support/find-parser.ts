import * as Effect from "effect/Effect";

import { parseSegments, type ParseRequest } from "../../src/find-parse.ts";
import type { FindParser } from "../../src/find-parser.ts";

export const inlineFindParser: FindParser["Service"] = {
  segments: (request) => Effect.sync(() => parseSegments(request)),
};

export const recordingFindParser = (inner: FindParser["Service"] = inlineFindParser) => {
  const asked: Array<ParseRequest> = [];
  const parser: FindParser["Service"] = {
    segments: (request) =>
      Effect.suspend(() => {
        asked.push(request);
        return inner.segments(request);
      }),
  };
  return { parser, asked };
};
