// Split from screen-workers.test.ts, whose other cases take a few seconds, so neither file runs
// near CI's per-file limit (SLNT-1040).
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { it } from "@mend/test-ci/effect-vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

const STOPS_MID_DECODE = fileURLToPath(
  new URL("../../test/screen-worker-stops.ts", import.meta.url),
);

describe("screen frames off the server's thread", () => {
  // SLNT-759: terminating a thread inside a zlib call aborts the whole process, the server in production.
  it.live(
    "survive hundreds of decoders stopped mid-decode, as viewers leaving a busy screen stop them",
    () =>
      Effect.gen(function* () {
        const { stdout } = yield* Effect.promise(() =>
          promisify(execFile)(process.execPath, [STOPS_MID_DECODE, "200"]),
        );
        expect(stdout).toContain("stopped 200 decoders mid-decode");
      }),
    { timeout: 120_000 },
  );
});
