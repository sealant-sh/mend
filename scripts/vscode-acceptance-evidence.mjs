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
    ...(remoteSsh ? ["remoteSsh", "remoteEditor", "carriedEditor", "sessionSeesEdit"] : []),
  ]) {
    assert.ok(result[step] && typeof result[step] === "object", `Missing editor step: ${step}`);
  }
  assert.ok(
    result.errorsShown === undefined ||
      (Array.isArray(result.errorsShown) && result.errorsShown.length === 0),
    "The editor displayed an unexpected error",
  );
}

/**
 * The Mend server container's state on one line, from `docker inspect`'s State and RestartCount,
 * for a failed run's log. Docker reads a container it has stopped probing as unhealthy, so a
 * bundle that exited and is restarting looks like one that failed its probes; the exit code and
 * restart count tell the two apart.
 */
export function describeServerState(name, state, restartCount) {
  if (!state || typeof state !== "object") return `${name}: no state (no container was found)`;
  const parts = [
    state.Status ?? "unknown status",
    `exit code ${String(state.ExitCode ?? "unknown")}`,
    `restarts ${String(restartCount ?? "unknown")}`,
  ];
  if (state.OOMKilled === true) parts.push("killed for memory");
  if (typeof state.Error === "string" && state.Error !== "") parts.push(`error: ${state.Error}`);
  const health = state.Health;
  parts.push(
    health && typeof health === "object"
      ? `health ${String(health.Status)} (failing streak ${String(health.FailingStreak ?? 0)})`
      : "no healthcheck",
  );
  return `${name}: ${parts.join(", ")}`;
}

/** The healthcheck's recorded probes, oldest first: when each ran, its exit code and output. */
export function describeHealthProbes(state) {
  const probes = Array.isArray(state?.Health?.Log) ? state.Health.Log : [];
  return probes.map(
    (probe) =>
      `${String(probe.Start)} exit ${String(probe.ExitCode)}: ${String(probe.Output ?? "").trim() || "(no output)"}`,
  );
}
