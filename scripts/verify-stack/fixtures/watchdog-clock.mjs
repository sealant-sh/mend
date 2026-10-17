// A clock controlled by lifecycle.e2e.test.mjs, preloaded only into its exact watchdog
// entrypoint. Docker commands, the supervisor, and teardown keep their native clocks.
import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mock } from "node:test";
import { setImmediate, setInterval } from "node:timers";
import { fileURLToPath } from "node:url";

const stack = fileURLToPath(new URL("../stack.mjs", import.meta.url));
if (process.argv[1] === stack && process.argv[2] === "watchdog") {
  const directory = process.env.MEND_VERIFY_STACK_TEST_CLOCK;
  assert.equal(typeof directory, "string", "the watchdog clock needs its control directory");
  const requestFile = join(directory, "request.json");
  const acknowledgmentFile = join(directory, "acknowledgment.json");
  // Capture the native controls before enabling the clock. Acknowledgment runs after the
  // timer's promise continuations, including any premature claim-settlement outcome.
  const poll = setInterval;
  const acknowledge = setImmediate;
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let seen = 0;
  const controller = poll(() => {
    if (!existsSync(requestFile)) return;
    const request = JSON.parse(readFileSync(requestFile, "utf8"));
    assert.ok(Number.isSafeInteger(request.sequence) && request.sequence > 0);
    assert.ok(Number.isSafeInteger(request.elapsedMs) && request.elapsedMs >= 0);
    if (request.sequence <= seen) return;
    seen = request.sequence;
    mock.timers.tick(request.elapsedMs);
    acknowledge(() => {
      writeFileSync(
        `${acknowledgmentFile}.next`,
        JSON.stringify({ sequence: request.sequence, now: Date.now() }),
      );
      renameSync(`${acknowledgmentFile}.next`, acknowledgmentFile);
    });
  }, 25);
  // A native timer keeps its process alive until it fires or is cleared; a virtual one has no
  // handle. The controller stands in for every pending virtual timer, and only for those.
  const pending = new Set();
  const virtualTimeout = globalThis.setTimeout;
  const virtualClear = globalThis.clearTimeout;
  const holdWhilePending = () => (pending.size > 0 ? controller.ref() : controller.unref());
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = virtualTimeout(
      (...values) => {
        pending.delete(timer);
        holdWhilePending();
        callback(...values);
      },
      delay,
      ...args,
    );
    pending.add(timer);
    holdWhilePending();
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    pending.delete(timer);
    holdWhilePending();
    virtualClear(timer);
  };
  holdWhilePending();
}
