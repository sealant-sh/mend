/* oxlint-disable -- Generated verbatim functions from t3code v0.1.2; regenerate with sync.mjs. */
/*
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
function deriveRevertTurnCountByUserMessageId(input) {
  const readyTurnCountByRunId = /* @__PURE__ */ new Map();
  for (const checkpoint of input.checkpoints) {
    if (checkpoint.status === "ready") {
      readyTurnCountByRunId.set(checkpoint.runId, checkpoint.checkpointTurnCount);
    }
  }
  const targetByRunId = /* @__PURE__ */ new Map();
  const byUserMessageId = /* @__PURE__ */ new Map();
  let previousRunId = null;
  for (const entry of input.timelineEntries) {
    if (entry.kind !== "message" && entry.kind !== "work") continue;
    const projectedItem =
      entry.kind === "message" ? entry.projectedItem : entry.entry.projectedItem;
    if (projectedItem?.visibility === "inherited") continue;
    const runId =
      entry.kind === "message"
        ? entry.message.runId
        : entry.entry.itemType === "notification"
          ? entry.entry.runId
          : null;
    if (runId == null) continue;
    if (!targetByRunId.has(runId)) {
      targetByRunId.set(
        runId,
        previousRunId === null
          ? input.threadStartCheckpointReady
            ? 0
            : void 0
          : readyTurnCountByRunId.get(previousRunId),
      );
      previousRunId = runId;
    }
    if (entry.kind !== "message") continue;
    const { message } = entry;
    if (message.role !== "user" || message.runId === input.unsettledRunId) continue;
    if (message.inputIntent !== "turn_start" && message.inputIntent !== "queued_turn") continue;
    const target = targetByRunId.get(runId);
    if (
      target !== void 0 &&
      (input.availableRevertTurnCounts === void 0 || input.availableRevertTurnCounts.has(target))
    )
      byUserMessageId.set(message.id, target);
  }
  return byUserMessageId;
}
function findRevertCheckpoint(checkpoints, turnCount) {
  return checkpoints.findLast(
    (checkpoint) =>
      checkpoint.status === "ready" &&
      (turnCount === 0
        ? checkpoint.ordinalWithinScope === 0 && checkpoint.appRunOrdinal === null
        : checkpoint.appRunOrdinal === turnCount),
  );
}
function rollbackWaiter({ environmentThreadDetails, appAtomRegistry, Option }) {
  async function waitForRevertedMessage(threadRef, turnCount, requestId, revert, timeoutMs = 12e4) {
    const threadAtom = environmentThreadDetails.stateAtom(threadRef);
    const readProjection = () => Option.getOrNull(appAtomRegistry.get(threadAtom).data);
    const initial = readProjection();
    const providerThreadId = initial?.thread.activeProviderThreadId;
    const initialProviderThread = initial?.providerThreads.find(
      (providerThread) => providerThread.id === providerThreadId,
    );
    const initialProviderThreadIds = new Set(initial?.providerThreads.map((thread) => thread.id));
    const witness = initial?.runs.reduce(
      (latest, run) => {
        if (
          run.ordinal <= turnCount ||
          (run.status !== "completed" &&
            run.status !== "interrupted" &&
            run.status !== "failed" &&
            run.status !== "cancelled")
        )
          return latest;
        return latest === void 0 || run.ordinal > latest.ordinal ? run : latest;
      },
      void 0,
    );
    if (witness === void 0) {
      throw new Error("The thread has changed. Select a message to rewind again.");
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let accepted = false;
      let unsubscribe = () => {};
      let timeout;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (timeout !== void 0) globalThis.clearTimeout(timeout);
        unsubscribe();
        if (error !== void 0) reject(error);
        else resolve();
      };
      const inspect = () => {
        const thread = readProjection();
        if (!thread) return;
        const failure = thread.thread.rollbackFailure;
        if (failure?.requestId === requestId) {
          finish(new Error(failure.message));
          return;
        }
        if (
          accepted &&
          thread.providerThreads.some(
            (providerThread) =>
              (providerThread.id === providerThreadId || // Claude resets to a fresh root session when rewinding to thread start.
                (turnCount === 0 &&
                  providerThread.ownerNodeId === null &&
                  providerThread.appThreadId === initial?.thread.id &&
                  providerThread.providerInstanceId === initialProviderThread?.providerInstanceId &&
                  !initialProviderThreadIds.has(providerThread.id))) &&
              providerThread.lastRunOrdinal === (turnCount === 0 ? null : turnCount),
          ) &&
          thread.runs.some((run) => run.id === witness.id && run.status === "rolled_back")
        )
          finish();
      };
      unsubscribe = appAtomRegistry.subscribe(threadAtom, inspect);
      timeout = globalThis.setTimeout(() => {
        finish(new Error("Timed out waiting for the thread to rewind."));
      }, timeoutMs);
      Promise.resolve()
        .then(revert)
        .then(() => {
          accepted = true;
          inspect();
        }, finish);
    });
  }
  return waitForRevertedMessage;
}
export { deriveRevertTurnCountByUserMessageId, findRevertCheckpoint, rollbackWaiter };
