import assert from "node:assert/strict";
import { test } from "node:test";

import { assertEditorEvidence } from "./vscode-acceptance-evidence.mjs";

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
