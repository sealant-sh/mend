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
  // The initial virtual supervisor poll has no native handle. Keep the controller alive
  // until the claim request creates a real child handle, then let normal completion exit.
  process.on("message", (message) => {
    if (message?.claim === true) acknowledge(() => controller.unref());
  });
}
