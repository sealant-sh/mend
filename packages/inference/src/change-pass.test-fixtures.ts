import { createHash } from "node:crypto";

import {
  ChangeToursRepo,
  ProjectsRepo,
  ReviewCommentsRepo,
  SessionsRepo,
  WorktreeChangesRepo,
  type NewChangeTour,
  type NewReviewComment,
} from "@mend/db";
import {
  ChangeId,
  OrganizationId,
  ProjectId,
  ReviewCommentId,
  SealantRunId,
  SessionId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { Change, ChangeTour, Project, ReviewComment, Session } from "@mend/domain/workbench";
import { SealantClient, SealantPlatformError } from "@mend/sealant";
import { WORKTREE_STAMP, WorktreeReads } from "@mend/sessions";
import type { Run as SdkRun, RunCommand, TimelineEntry } from "@sealant/sdk";
import { Effect, Layer, Stream } from "effect";

import {
  InferenceProvider,
  type InferenceError,
  type InferenceRequest,
  type InferenceToolError,
} from "./provider.ts";
const NOW = new Date("2026-09-25T10:00:00.000Z");
const CHANGE = ChangeId.make("change-1");
const PROJECT = ProjectId.make("project-1");
const WORKTREE = WorktreeId.make("wt-1");
const SESSION = SessionId.make("session-1");
const DIFF = "diff --git a/src/login.ts b/src/login.ts\n+retry once\n";

const change = new Change({
  id: CHANGE,
  projectId: PROJECT,
  worktreeId: WORKTREE,
  sessionId: SESSION,
  branch: "mend/fix-login",
  baseSha: Sha.make("a".repeat(40)),
  headSha: Sha.make("b".repeat(40)),
  createdAt: NOW,
  updatedAt: NOW,
});

const project = new Project({
  id: PROJECT,
  name: "web",
  organizationId: OrganizationId.make("org-1"),
  visibility: "shared",
  createdByUserId: null,
  originUrl: null,
  storePath: "/store/web/repo.git",
  defaultBranch: "main",
  adoptedSha: Sha.make("a".repeat(40)),
  autoTour: "inherit",
  autoSuggest: "inherit",
  autoName: "inherit",
  autoLand: "inherit",
  backgroundSessions: "inherit",
  gitAuthMode: "mend-key",
  workspaceImage: null,
  applyDotfiles: true,
  defaultShellProfile: true,
  inheritUserSkills: true,
  hotSessions: 0,
  installCommand: null,
  installEnabled: true,
  createdAt: NOW,
  updatedAt: NOW,
});

const session = new Session({
  id: SESSION,
  projectId: PROJECT,
  worktreeId: WORKTREE,
  harness: "claude",
  providerSessionId: null,
  label: null,
  worktree: "fix-login",
  branch: "mend/fix-login",
  baseSha: Sha.make("a".repeat(40)),
  baseRef: "main",
  contextSnapshotId: null,
  referenceMounts: [],
  extraMounts: [],
  sealantRunId: SealantRunId.make("run-1"),
  sealantWorkspaceId: null,
  sealantSessionId: null,
  workspaceExpiresAt: null,
  workspaceTtlRenewedAt: null,
  workspaceTtlRenewalFailedAt: null,
  workspaceTtlRenewalError: null,
  workspaceImage: null,
  dotfiles: null,
  ownerUserId: "alice",
  hasTranscript: true,
  status: "completed",
  summary: null,
  lastSeenSequence: 10n,
  recordHistoryComplete: true,
  startedAt: NOW,
  settledAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
});

/** Parsed identities used by both the service and independently specified expected records. */
export interface PassFixture {
  readonly change: Change;
  readonly project: Project;
  readonly session: Session;
}

/** Distinct jobs have distinct project, worktree, session and platform-run identities. */
export const fixtureFor = (label = "one"): PassFixture => {
  const projectId = ProjectId.make(`project-${label}`);
  const worktreeId = WorktreeId.make(`worktree-${label}`);
  const sessionId = SessionId.make(`session-${label}`);
  return {
    project: new Project({ ...project, id: projectId }),
    change: new Change({
      ...change,
      id: ChangeId.make(`change-${label}`),
      projectId,
      worktreeId,
      sessionId,
      baseSha: Sha.make(createHash("sha1").update(`base:${label}`).digest("hex")),
      branch: `mend/review-${label}`,
    }),
    session: new Session({
      ...session,
      id: sessionId,
      projectId,
      worktreeId,
      sealantRunId: SealantRunId.make(`run-${label}`),
    }),
  };
};

/** A public SDK timeline entry with an actual process identity for terminal reads. */
export const startedEvent = (sequence = 1n, processId = "harness"): TimelineEntry => ({
  sequence,
  processId,
  occurredAt: NOW.toISOString(),
  summary: "claude started",
  kind: "processStarted",
  data: {
    pid: 1,
    pgid: 1,
    pidfd: true,
    executable: "claude",
    args: [],
    cwd: "/worktree",
    startedAt: "0",
  },
});

/** A public SDK exit event, not an invented event representation. */
export const exitedEvent = (sequence = 3n): TimelineEntry => ({
  sequence,
  processId: "harness",
  occurredAt: NOW.toISOString(),
  summary: "check exited 0",
  kind: "processExited",
  data: { exitCode: 0, reason: 1, durationMicros: "1000" },
});

const unusedSdk = async (): Promise<never> => {
  throw new Error("unexpected public SDK operation");
};
const sdkRun = (id: string): SdkRun => ({
  id,
  result: { status: "completed", outcome: "completed", exitCode: 0 },
  changes: { files: [], diff: unusedSdk },
  artifacts: { list: unusedSdk, get: unusedSdk },
  record: {
    runId: id,
    replay: unusedSdk,
    commands: unusedSdk,
    transcript: unusedSdk,
    stream: () => {
      throw new Error("unexpected SDK stream");
    },
    timeline: () => {
      throw new Error("use SealantClient.recordTimeline");
    },
    scrollback: () => {
      throw new Error("use SealantClient.recordScrollback");
    },
    loss: unusedSdk,
    summary: unusedSdk,
    fileTreeAt: unusedSdk,
    processTreeAt: unusedSdk,
  },
  wait: unusedSdk,
});

/** A provider script exercises the real tool handlers supplied by the service. */
export type ProviderScript = (request: InferenceRequest) => Effect.Effect<unknown, InferenceError>;
/** Existing seams used by the three services and their shared read tools. */
export type FixtureServices =
  | InferenceProvider
  | WorktreeChangesRepo
  | SessionsRepo
  | ProjectsRepo
  | ChangeToursRepo
  | ReviewCommentsRepo
  | WorktreeReads
  | SealantClient;

/** Recording stores represent the service boundary, not SQL serialization or notifications. */
export interface PassHarness {
  readonly layer: Layer.Layer<FixtureServices>;
  readonly fixtures: Array<PassFixture>;
  readonly requests: Array<InferenceRequest>;
  readonly tourWrites: Array<NewChangeTour>;
  readonly commentWrites: Array<NewReviewComment>;
  readonly tours: Map<ChangeId, ChangeTour>;
  readonly comments: Array<ReviewComment>;
  readonly reads: Array<{
    readonly kind: string;
    readonly projectId: ProjectId;
    readonly worktreeId: WorktreeId;
    readonly baseSha: string;
  }>;
  readonly recordCalls: Array<{
    readonly kind: string;
    readonly runId: string;
    readonly from?: bigint;
    readonly processId?: string;
    readonly stream?: string;
  }>;
  readonly state: {
    diff: string;
    files: Array<{ path: string; additions: number; deletions: number }>;
    events: Array<TimelineEntry>;
    eventsByRun: Map<string, ReadonlyArray<TimelineEntry>>;
    commands: Array<RunCommand>;
    pty: Uint8Array;
    stdout: Uint8Array;
    failTimeline: boolean;
    failRun: boolean;
  };
}

/** Shared recorded dependencies keep current-run identity and repository writes observable. */
export const makeHarness = (script: ProviderScript, fixture = fixtureFor()): PassHarness => {
  const fixtures = [fixture];
  const requests: PassHarness["requests"] = [];
  const tourWrites: PassHarness["tourWrites"] = [];
  const commentWrites: PassHarness["commentWrites"] = [];
  const tours: PassHarness["tours"] = new Map();
  const comments: PassHarness["comments"] = [];
  const reads: PassHarness["reads"] = [];
  const recordCalls: PassHarness["recordCalls"] = [];
  const runs = new Map<string, SdkRun>();
  const state: PassHarness["state"] = {
    diff: DIFF,
    files: [{ path: "src/login.ts", additions: 1, deletions: 0 }],
    events: [startedEvent(), exitedEvent()],
    eventsByRun: new Map(),
    commands: [
      {
        executable: "claude",
        args: [],
        argCount: 2,
        command: "claude (2 arguments not recorded)",
        cwd: "/worktree",
        exitCode: 0,
        stdoutBytes: 4,
        stderrBytes: 0,
      },
    ],
    pty: new TextEncoder().encode("check passed\n"),
    stdout: new Uint8Array(),
    failTimeline: false,
    failRun: false,
  };
  const assertRead = (projectId: ProjectId, worktreeId: WorktreeId, baseSha: string) => {
    if (
      !fixtures.some(
        (f) =>
          f.project.id === projectId &&
          f.change.worktreeId === worktreeId &&
          f.change.baseSha === baseSha,
      )
    )
      throw new Error("read crossed the job's project/worktree/base identity");
  };
  const assertRun = (run: SdkRun) => {
    if (runs.get(run.id) !== run) throw new Error("record read used a foreign SDK run object");
  };
  const providerLayer: Layer.Layer<InferenceProvider> = Layer.succeed(InferenceProvider, {
    respond: (request) =>
      Effect.suspend(() => {
        requests.push(request);
        return script(request);
      }),
  });
  const layer: Layer.Layer<FixtureServices> = Layer.mergeAll(
    providerLayer,
    Layer.mock(WorktreeChangesRepo, {
      byId: (id) =>
        Effect.sync(() => {
          const value = fixtures.find((f) => f.change.id === id)?.change;
          if (!value) throw new Error("unexpected change");
          return value;
        }),
    }),
    Layer.mock(SessionsRepo, {
      byId: (id) =>
        Effect.sync(() => {
          const value = fixtures.find((f) => f.session.id === id)?.session;
          if (!value) throw new Error("unexpected session");
          return value;
        }),
    }),
    Layer.mock(ProjectsRepo, {
      byId: (id) =>
        Effect.sync(() => {
          const value = fixtures.find((f) => f.project.id === id)?.project;
          if (!value) throw new Error("unexpected project");
          return value;
        }),
    }),
    Layer.mock(ChangeToursRepo, {
      byChange: (id) => Effect.sync(() => tours.get(id) ?? null),
      upsert: (input) =>
        Effect.sync(() => {
          tourWrites.push(input);
          const existing = tours.get(input.changeId);
          const row = new ChangeTour({
            ...input,
            id: existing?.id ?? `tour-${tourWrites.length}`,
            sessionId: existing === undefined ? input.sessionId : existing.sessionId,
            createdAt: NOW,
          });
          tours.set(input.changeId, row);
          return row;
        }),
    }),
    Layer.mock(ReviewCommentsRepo, {
      listForChange: (id) => Effect.sync(() => comments.filter((row) => row.changeId === id)),
      create: (input) =>
        Effect.sync(() => {
          commentWrites.push(input);
          const row = new ReviewComment({
            ...input,
            id: ReviewCommentId.make(`comment-${commentWrites.length}`),
            anchor: input.anchor ?? null,
            kind: input.kind ?? "note",
            suggestion: input.suggestion ?? null,
            evidence: [...(input.evidence ?? [])],
            sentToSessionId: null,
            createdAt: NOW,
            updatedAt: NOW,
          });
          comments.push(row);
          return row;
        }),
    }),
    Layer.mock(WorktreeReads, {
      diffWorktree: (projectId, worktreeId, baseSha) =>
        Effect.sync(() => {
          assertRead(projectId, worktreeId, baseSha);
          reads.push({ kind: "diff", projectId, worktreeId, baseSha });
          return { value: state.diff, stamp: WORKTREE_STAMP };
        }),
      changedFiles: (projectId, worktreeId, baseSha) =>
        Effect.sync(() => {
          assertRead(projectId, worktreeId, baseSha);
          reads.push({ kind: "files", projectId, worktreeId, baseSha });
          return { value: [...state.files], stamp: WORKTREE_STAMP };
        }),
    }),
    Layer.mock(SealantClient, {
      getRun: (id) =>
        Effect.suspend(() => {
          if (!fixtures.some((f) => f.session.sealantRunId === id))
            return Effect.die("opened foreign platform run");
          recordCalls.push({ kind: "get", runId: id });
          if (state.failRun) {
            return Effect.fail(
              new SealantPlatformError({
                code: "record-failed",
                status: null,
                message: "record unavailable",
                cause: null,
              }),
            );
          }
          const run = runs.get(id) ?? sdkRun(id);
          runs.set(id, run);
          return Effect.succeed(run);
        }),
      recordTimeline: (run, options) =>
        Stream.suspend(() => {
          assertRun(run);
          recordCalls.push({ kind: "timeline", runId: run.id, from: options?.from ?? 0n });
          const events = state.eventsByRun.get(run.id) ?? state.events;
          const entries = Stream.fromIterable(
            events.filter((entry) => entry.sequence >= (options?.from ?? 0n)),
          );
          return state.failTimeline
            ? entries.pipe(
                Stream.concat(
                  Stream.fail(
                    new SealantPlatformError({
                      code: "record-failed",
                      status: null,
                      message: "record unavailable",
                      cause: null,
                    }),
                  ),
                ),
              )
            : entries;
        }),
      recordCommands: (run) =>
        Effect.sync(() => {
          assertRun(run);
          recordCalls.push({ kind: "commands", runId: run.id });
          return [...state.commands];
        }),
      recordScrollback: (run, processId, stream) =>
        Effect.sync(() => {
          assertRun(run);
          recordCalls.push({ kind: "scrollback", runId: run.id, processId, stream });
          return stream === "pty" ? state.pty : state.stdout;
        }),
    }),
  );
  return {
    layer,
    fixtures,
    requests,
    tourWrites,
    commentWrites,
    tours,
    comments,
    reads,
    recordCalls,
    state,
  };
};

const tool = (request: InferenceRequest, name: string) => {
  const found = request.tools?.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing real tool ${name}`);
  return found;
};
/** A successful scripted call must run the actual supplied schema and handler. */
export const callTool = (
  request: InferenceRequest,
  name: string,
  input: unknown = {},
): Effect.Effect<unknown> => tool(request, name).handle(input).pipe(Effect.orDie);
/** Unexpected acceptance is a defect, so a weakened policy cannot satisfy a refusal test. */
export const refuseTool = (
  request: InferenceRequest,
  name: string,
  input: unknown,
): Effect.Effect<InferenceToolError> =>
  tool(request, name).handle(input).pipe(Effect.flip, Effect.orDie);
