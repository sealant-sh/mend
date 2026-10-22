import { Readable } from "node:stream";

import type { CaptureSummary } from "@mend/local-git/handoff";
import { Schema } from "effect";

import type {
  HandoffClient,
  HandoffReceipt,
  HandoffTerms,
  ReceiveOutcome,
} from "./handoff-client.js";
import type { AcceptedHandoff } from "./handoff-draft.js";
import type { CheckoutWorker, HandoffBundle } from "./handoff-worker.js";
import {
  HandoffProvenance,
  type Project,
  type SessionDetail,
  type SessionStatus,
} from "./types.js";

export const project: Project = {
  id: "p1",
  name: "newsroom-api",
  originUrl: "https://github.com/acme/newsroom-api.git",
  defaultBranch: "main",
  storePath: "/store/p1/repo.git",
};
export const summary: CaptureSummary = {
  head: "1".repeat(40),
  index: "2".repeat(40),
  worktree: "3".repeat(40),
  mergeBase: "4".repeat(40),
  defaultTip: "5".repeat(40),
  defaultBranch: "main",
  localBranch: "fix/login",
  facts: { commitsAhead: 2, uncommitted: 3, untracked: 1 },
  leftOut: [
    { path: ".env.local", reason: "env" },
    { path: ".env.ignored", reason: "ignored-env" },
    { path: "big.bin", reason: "over-limit", bytes: 9000 },
    { path: "lfs.dat", reason: "filter", filter: "lfs" },
  ],
  committedEnv: [{ path: ".env.example", commit: "abcdef0" }],
  hidden: [],
  cutAt: "2026-10-22T10:42:05.000Z",
  envFiles: "exclude",
};
export const checkout = {
  top: "/checkout",
  gitDir: "/checkout/.git",
  commonDir: "/checkout/.git",
  originUrl: project.originUrl,
};
export const terms: HandoffTerms = { bundleBytes: 100_000, fileBytes: 8192 };
export const receipt = (status: SessionStatus = "idle"): HandoffReceipt => ({
  replayed: false,
  previous: null,
  session: {
    id: "s1",
    projectId: project.id,
    worktreeId: "w1",
    harness: "claude",
    model: null,
    label: null,
    worktree: "fix-login",
    branch: "mend/fix-login",
    status,
    sealantWorkspaceId: "workspace1",
    summary: null,
    createdAt: summary.cutAt,
    settledAt: null,
    ownerUserId: "dana",
    livePeople: [],
    sharedControlEnabledAt: null,
    workspaceRetirement: null,
    workspaceLauncherUserId: "dana",
  },
  worktree: {
    id: "w1",
    name: "fix-login",
    directory: "fix-login",
    branch: "mend/fix-login",
    baseSha: summary.mergeBase,
    baseRef: "main",
    createdAt: summary.cutAt,
    handoff: Schema.decodeUnknownSync(HandoffProvenance)({
      machine: "dana-mbp",
      cutAt: summary.cutAt,
      checkpoint: summary.worktree,
    }),
  },
});
export const detail = (status: SessionStatus = "idle"): SessionDetail => ({
  session: receipt(status).session,
  processes: [],
  currentAgent: null,
  changeId: "change1",
});
export const bundle = (body = "immutable git bundle"): HandoffBundle => ({
  bytes: Buffer.byteLength(body),
  open: () => Readable.from([body]),
});
export const fakeHandoff = () => {
  const calls: string[] = [];
  const uploads: HandoffBundle[] = [];
  let current = true;
  let read = detail();
  const answers: ReceiveOutcome[] = [];
  const client: HandoffClient = {
    label: "mend.local",
    account: "mend.local dana",
    isCurrent: async () => current,
    support: async () => "supported",
    listProjects: async () => {
      calls.push("projects");
      return [project];
    },
    adoptProject: async () => {
      calls.push("adopt");
      return project;
    },
    handoffTerms: async () => {
      calls.push("terms");
      return { kind: "terms", terms };
    },
    receiveBranchHandoff: async (_id, bytes, finished) => {
      calls.push("receive");
      uploads.push(bytes);
      finished();
      return answers.shift() ?? { kind: "received", receipt: receipt() };
    },
    gitAccess: async () => "server",
    shareAgent: async () => null,
    sessionDetail: async () => {
      calls.push("detail");
      return read;
    },
    launchSession: async () => {
      calls.push("launch");
      return read.session;
    },
  };
  const worker: CheckoutWorker = {
    discover: async () => {
      calls.push("discover");
      return { kind: "ok", value: checkout };
    },
    capture: async () => {
      calls.push("capture");
      return { kind: "ok", value: summary };
    },
    pack: async () => {
      calls.push("pack");
      return { kind: "ok", value: bundle() };
    },
    dispose: async () => {
      calls.push("dispose");
    },
  };
  const accepted: AcceptedHandoff = {
    checkout,
    client,
    worker,
    target: { kind: "project", project },
    terms,
    summary,
    continuation: { kind: "hold" },
    projectsBefore: [project],
    gitAccess: "server",
  };
  return {
    calls,
    uploads,
    answers,
    accepted,
    client,
    worker,
    move: () => {
      current = false;
    },
    read: (next: SessionDetail) => {
      read = next;
    },
  };
};
