import type { Run, Workspace, WorkspaceExecResult } from "@sealant/sdk";

/**
 * A workspace handle for tests that pass one through to a faked platform: every call that would
 * reach Core throws or waits forever, so a test that does reach one fails loudly.
 */
const never = () => new Promise<never>(() => {});
const notInTest = async (): Promise<never> => {
  throw new Error("not in test");
};

/** What an exec's result names as its run: nothing reads it. */
export const fakeExecRun: Run = {
  id: "run-exec",
  result: { status: "completed", outcome: "completed", exitCode: 0 },
  changes: { files: [], diff: async () => "" },
  artifacts: { list: async () => [], get: async () => new Uint8Array() },
  record: {
    runId: "run-exec",
    replay: notInTest,
    commands: async () => [],
    transcript: async () => "",
    stream: async function* () {},
    timeline: async function* () {},
    scrollback: async function* () {},
    loss: notInTest,
    summary: notInTest,
    fileTreeAt: notInTest,
    processTreeAt: notInTest,
  },
  wait: async function () {
    return this;
  },
};

/** An exec's answer, as the SDK gives it. */
export const execAnswer = (stdout: string, exitCode = 0, stderr = ""): WorkspaceExecResult => ({
  exitCode,
  stdout,
  stderr,
  run: fakeExecRun,
});

export const fakeWorkspace = (id = "workspace-1"): Workspace => ({
  id,
  name: "fake",
  status: async () => "ready",
  runtimeDeadline: async () => null,
  runtime: async () => null,
  launch: undefined,
  recover: never,
  captureDrain: async () => null,
  ready: async function () {
    return this;
  },
  harness: { run: never, start: never, session: never },
  exec: never,
  bind: async () => [],
  capture: { flush: never, status: never, replan: never },
  sessions: { open: never, get: never, list: async () => [] },
  events: async function* () {},
  forward: never,
  stop: async () => ({ state: "stopped" }),
  restart: async function () {
    return this;
  },
  expire: async () => undefined,
  image: async () => null,
  credentials: { put: never, release: never, list: async () => [] },
  dotfiles: { apply: never },
});
