import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertEditorEvidence,
  describeHealthProbes,
  describeServerState,
  isFailedRequest,
  summarizeNetLog,
} from "./vscode-acceptance-evidence.mjs";

const complete = {
  signedOut: { projects: 0 },
  signIn: { projectId: "project-1" },
  liveEvents: { sessionId: "session-1" },
  startSession: { sessionId: "session-2" },
  ssh: { stdout: ["mend"] },
  terminal: { answered: "typed-42" },
  review: { pageStatus: 200 },
  stopped: { sessions: ["session-1", "session-2"] },
  remoteSsh: { window: {} },
  remoteEditor: { uid: 40001, settled: { kind: "inSync" }, picked: { carried: ["a.one"] } },
  carriedEditor: { uid: 40002, settled: { kind: "inSync" }, planned: ["a.one"] },
  sessionSeesEdit: { terminal: "edited in VS Code over Remote-SSH" },
  completed: { runId: "run-current", remoteSsh: true },
};
const requested = { runId: "run-current", remoteSsh: true };

test("accepts complete evidence for this run and selected mode", () => {
  assert.doesNotThrow(() => assertEditorEvidence(complete, requested));
});

test("an early editor exit cannot turn intermediate evidence into success", () => {
  for (const partial of [
    {},
    { signedOut: { projects: 0 } },
    { ...complete, completed: undefined },
  ]) {
    assert.throws(() => assertEditorEvidence(partial, requested), /did not complete this run/);
  }
});

test("requires each observed step independently of the completion marker", () => {
  for (const step of [
    "signedOut",
    "signIn",
    "liveEvents",
    "startSession",
    "ssh",
    "terminal",
    "review",
    "stopped",
    "remoteSsh",
    "remoteEditor",
    "carriedEditor",
    "sessionSeesEdit",
  ]) {
    const partial = { ...complete };
    delete partial[step];
    assert.throws(() => assertEditorEvidence(partial, requested), /Missing editor step/);
  }
});

test("rejects another run, a skipped required mode and swallowed editor errors", () => {
  assert.throws(
    () => assertEditorEvidence(complete, { ...requested, runId: "run-new" }),
    /this run/,
  );
  assert.throws(
    () =>
      assertEditorEvidence(
        { ...complete, completed: { ...complete.completed, remoteSsh: false } },
        requested,
      ),
    /requested Remote-SSH mode/,
  );
  assert.throws(
    () => assertEditorEvidence({ ...complete, errorsShown: ["stop refused"] }, requested),
    /unexpected error/,
  );
});

test("explicitly disabled Remote-SSH does not require its optional steps", () => {
  const {
    remoteSsh: _remote,
    remoteEditor: _editor,
    carriedEditor: _carried,
    sessionSeesEdit: _edit,
    ...core
  } = complete;
  assert.doesNotThrow(() =>
    assertEditorEvidence(
      { ...core, completed: { runId: "run-current", remoteSsh: false } },
      { ...requested, remoteSsh: false },
    ),
  );
});

test("a bundle that exited and is restarting reads as exited, not only as unhealthy", () => {
  const state = {
    Status: "restarting",
    ExitCode: 1,
    OOMKilled: false,
    Error: "",
    Health: {
      Status: "unhealthy",
      FailingStreak: 0,
      Log: [{ Start: "2026-11-16T14:36:50Z", ExitCode: 1, Output: "[health] fetch failed\n" }],
    },
  };
  assert.equal(
    describeServerState("mend-mend-1", state, 2),
    "mend-mend-1: restarting, exit code 1, restarts 2, health unhealthy (failing streak 0)",
  );
  assert.deepEqual(describeHealthProbes(state), [
    "2026-11-16T14:36:50Z exit 1: [health] fetch failed",
  ]);
});

test("a container killed for memory, or never created, says so", () => {
  assert.equal(
    describeServerState("mend-mend-1", { Status: "exited", ExitCode: 137, OOMKilled: true }, 0),
    "mend-mend-1: exited, exit code 137, restarts 0, killed for memory, no healthcheck",
  );
  assert.equal(
    describeServerState("mend-mend-1", undefined, undefined),
    "mend-mend-1: no state (no container was found)",
  );
  assert.deepEqual(describeHealthProbes(undefined), []);
});

// The shape `--log-net-log` writes: constants on the first line, then one event per line. Chromium
// numbers its event and source types per build, so the fixture's numbers are its own.
const netLogOf = (events, { truncated = false } = {}) => {
  const constants = {
    logEventTypes: {
      REQUEST_ALIVE: 1,
      URL_REQUEST_START_JOB: 2,
      HTTP_TRANSACTION_READ_RESPONSE_HEADERS: 3,
    },
    logEventPhase: { PHASE_NONE: 0, PHASE_BEGIN: 1, PHASE_END: 2 },
    logSourceType: { SOCKET: 9, URL_REQUEST: 24 },
    netError: { ERR_CONNECTION_RESET: -101, ERR_NAME_NOT_RESOLVED: -105 },
    timeTickOffset: "1763448000000",
  };
  const lines = events.map((event) => `${JSON.stringify(event)},`);
  if (truncated) lines.push('{"params":{"url":"https://marketplace.visualstudio.com/_ap');
  return `{"constants":${JSON.stringify(constants)},\n"events": [\n${lines.join("\n")}\n`;
};
const request = (id, { at, method = "GET", url, status, headers = [], netError, ended = true }) => [
  { phase: 1, source: { id, type: 24 }, time: String(at), type: 1 },
  { params: { method, url }, phase: 1, source: { id, type: 24 }, time: String(at), type: 2 },
  ...(status
    ? [
        {
          params: { headers: [status, ...headers] },
          phase: 0,
          source: { id, type: 24 },
          time: String(at + 50),
          type: 3,
        },
      ]
    : []),
  ...(ended
    ? [
        {
          params: netError ? { net_error: netError } : {},
          phase: 2,
          source: { id, type: 24 },
          time: String(at + 60),
          type: 1,
        },
      ]
    : []),
];
const query = "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";

test("a truncated NetLog names each gallery request that failed, and how", () => {
  const text = netLogOf(
    [
      ...request(1, {
        at: 1000,
        method: "OPTIONS",
        url: query,
        status: "HTTP/1.1 200 OK",
        headers: ["access-control-allow-origin: *"],
      }),
      ...request(2, { at: 1100, method: "POST", url: query, netError: -101 }),
      ...request(3, {
        at: 1200,
        url: "https://www.vscode-unpkg.net/_gallery/github/vscode-pull-request-github/latest",
        status: "HTTP/1.1 429 Too Many Requests",
        headers: ["Retry-After: 30"],
      }),
      ...request(4, { at: 1300, url: "http://172.17.0.2:3105/api/health", netError: -105 }),
      { params: { net_error: -105 }, phase: 2, source: { id: 9, type: 9 }, time: "1350", type: 1 },
      ...request(5, { at: 1400, method: "POST", url: query, ended: false }),
    ],
    { truncated: true },
  );
  const requests = summarizeNetLog(text);
  assert.deepEqual(requests, [
    {
      url: query,
      method: "OPTIONS",
      at: "2025-11-18T06:40:01.000Z",
      status: "HTTP/1.1 200 OK",
      allowsCrossOrigin: true,
    },
    { url: query, method: "POST", at: "2025-11-18T06:40:01.100Z", error: "ERR_CONNECTION_RESET" },
    {
      url: "https://www.vscode-unpkg.net/_gallery/github/vscode-pull-request-github/latest",
      method: "GET",
      at: "2025-11-18T06:40:01.200Z",
      status: "HTTP/1.1 429 Too Many Requests",
      retryAfter: "30",
      allowsCrossOrigin: false,
    },
    { url: query, method: "POST", at: "2025-11-18T06:40:01.400Z", unfinished: true },
  ]);
  assert.deepEqual(
    requests.filter(isFailedRequest).map((entry) => entry.at),
    ["2025-11-18T06:40:01.100Z", "2025-11-18T06:40:01.200Z", "2025-11-18T06:40:01.400Z"],
  );
});

test("text that is not a NetLog gives no summary", () => {
  assert.equal(summarizeNetLog(""), null);
  assert.equal(summarizeNetLog('{"other":1},\n'), null);
});
