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

/** The editor's own gallery hosts: the Marketplace, its CDNs and the extension resource host. */
export const GALLERY_HOSTS =
  /(^|\.)(marketplace\.visualstudio\.com|vscode-unpkg\.net|vsassets\.io|vscode-cdn\.net)$/;

/**
 * Each request Chromium made to a host `hosts` matches, from the NetLog that `--log-net-log`
 * writes: its method, URL, wall-clock start, HTTP status line, `Retry-After`, whether the response
 * allowed a cross-origin read, and the network error it ended with. In the workbench every gallery
 * failure reads `Failed to fetch` (a DNS or connect failure, a reset, and a response without CORS
 * headers alike); the NetLog tells them apart. A VS Code that is killed leaves the log truncated
 * mid-event, so it is read line by line, as Chromium writes it, and a request with no end is
 * `unfinished`. Returns null when the text is not a NetLog.
 */
export function summarizeNetLog(text, hosts = GALLERY_HOSTS) {
  const [head = "", , ...rest] = text.split("\n");
  let constants;
  try {
    constants = JSON.parse(`${head.replace(/,\s*$/, "")}}`).constants;
  } catch {
    return null;
  }
  if (!constants?.logEventTypes || !constants.logSourceType) return null;
  const type = Object.fromEntries(
    Object.entries(constants.logEventTypes).map(([name, id]) => [id, name]),
  );
  const errorName = Object.fromEntries(
    Object.entries(constants.netError ?? {}).map(([name, code]) => [code, name]),
  );
  const offset = Number(constants.timeTickOffset ?? 0);
  const requests = new Map();
  for (const line of rest) {
    const trimmed = line.trim().replace(/,$/, "");
    if (!trimmed.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.source?.type !== constants.logSourceType.URL_REQUEST) continue;
    const name = type[event.type];
    const params = event.params ?? {};
    let request = requests.get(event.source.id);
    if (name === "REQUEST_ALIVE" && event.phase === constants.logEventPhase.PHASE_BEGIN) {
      request = { unfinished: true };
      requests.set(event.source.id, request);
    }
    if (request === undefined) continue;
    if (name === "URL_REQUEST_START_JOB" && typeof params.url === "string" && !request.url) {
      request.url = params.url;
      request.method = params.method;
      request.at = new Date(offset + Number(event.time)).toISOString();
    }
    if (name === "HTTP_TRANSACTION_READ_RESPONSE_HEADERS" && Array.isArray(params.headers)) {
      const [status, ...headers] = params.headers.map(String);
      const header = (key) =>
        headers.find((line) => line.toLowerCase().startsWith(`${key}:`))?.slice(key.length + 1);
      request.status = status;
      const retryAfter = header("retry-after")?.trim();
      if (retryAfter !== undefined) request.retryAfter = retryAfter;
      request.allowsCrossOrigin = header("access-control-allow-origin") !== undefined;
    }
    if (typeof params.net_error === "number" && params.net_error !== 0) {
      request.error = errorName[params.net_error] ?? String(params.net_error);
    }
    if (name === "REQUEST_ALIVE" && event.phase === constants.logEventPhase.PHASE_END) {
      request.unfinished = false;
    }
  }
  return [...requests.values()]
    .filter((request) => {
      try {
        return request.url !== undefined && hosts.test(new URL(request.url).hostname);
      } catch {
        return false;
      }
    })
    .map(({ unfinished, ...request }) => (unfinished ? { ...request, unfinished } : request));
}

/**
 * A summarized request that ended in a network error, never ended, or got no 2xx or 3xx answer.
 * A 2xx without `Access-Control-Allow-Origin` is not counted: the main process reads those without
 * CORS, so only the workbench's own requests would fail on it, and `allowsCrossOrigin` shows it.
 */
export function isFailedRequest(request) {
  const code = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(request.status ?? "")?.[1]);
  return request.error !== undefined || request.unfinished === true || !(code >= 200 && code < 400);
}
