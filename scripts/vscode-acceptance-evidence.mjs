import assert from "node:assert/strict";

/** Refuse partial or stale editor evidence, even when the editor process exits successfully. */
export function assertEditorEvidence(result, { runId, remoteSsh }) {
  assert.ok(result && typeof result === "object", "The editor suite recorded no evidence");
  assert.equal(result.completed?.runId, runId, "The editor suite did not complete this run");
  assert.equal(
    result.completed?.remoteSsh,
    remoteSsh,
    "The editor suite did not complete the requested Remote-SSH mode",
  );
  for (const step of [
    "signedOut",
    "signIn",
    "liveEvents",
    "startSession",
    "ssh",
    "terminal",
    "review",
    "stopped",
    ...(remoteSsh ? ["remoteSsh", "remoteEditor", "sessionSeesEdit"] : []),
  ]) {
    assert.ok(result[step] && typeof result[step] === "object", `Missing editor step: ${step}`);
  }
  assert.ok(
    result.errorsShown === undefined ||
      (Array.isArray(result.errorsShown) && result.errorsShown.length === 0),
    "The editor displayed an unexpected error",
  );
}
