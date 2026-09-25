import {
  AgentConversationRepo,
  AuditEventsRepo,
  ChangeLandingsRepo,
  SessionGitOpsRepo,
  SessionsRepo,
  type SessionGitOpRow,
} from "@mend/db";
import type { OrganizationId, WorktreeId } from "@mend/domain";
import {
  agentPushedBranches,
  type AgentTurn,
  type Change,
  type ChangeLanding,
  changeOwnerOf,
  type LandingFact,
  landingFacts,
  latestDecidedTurn as latestDecidedTurnOf,
  nextLandingBranch,
  type Project,
  type Worktree,
} from "@mend/domain/workbench";
import { LandingGit, LandingStepError, pullRequestBase } from "@mend/landing";
import { WorktreeReads } from "@mend/sessions";
import {
  AgentBridge,
  type ChangedFile,
  MendKeys,
  type RemoteBranchState,
  resolveRemoteEnv,
  SourcePolicy,
} from "@mend/store";
import { Clock, Effect, Result } from "effect";

import { ProjectAccess } from "./access.ts";

/**
 * What the API knows about a change's landings (docs/adr/0007-landing.md, "What Mend records and
 * shows", "Worktree removal"): the record, what moved since, the agent's own pushes, and origin's
 * branch when a fetch is asked for. Every answer is an observation; none is a verdict.
 */

/**
 * The change's owner (docs/adr/0007-landing.md, "Who lands"): the owner of the worktree's first
 * session. Null when there is none, and then nobody lands the change.
 */
export const changeOwnerOfWorktree = (worktreeId: WorktreeId) =>
  Effect.gen(function* () {
    return changeOwnerOf(yield* (yield* SessionsRepo).listForWorktree(worktreeId));
  });

/**
 * The env a push or a fetch authenticates with: the project's `gitAuthMode` for `userId`, pinned
 * to the address the caller's source policy cleared (docs/adr/0003, "Multi mode gate"). The
 * services are read now; the policy check and the key or signer are resolved only when the
 * returned effect runs, so a landing that never reaches its push resolves nothing.
 */
export const remoteEnvFor = (project: Project, userId: string, step: LandingStepError["step"]) =>
  Effect.gen(function* () {
    const policy = yield* SourcePolicy;
    const isOperator = yield* (yield* ProjectAccess).isOperator(userId);
    const signers = yield* Effect.context<MendKeys | AgentBridge>();
    const origin = project.originUrl;
    const failed = (message: string) => new LandingStepError({ step, message });
    return Effect.gen(function* () {
      if (origin === null) return yield* failed("the project has no origin");
      const clearance = yield* policy
        .check(origin, { isOperator })
        .pipe(Effect.mapError((refused) => failed(refused.message)));
      const env = yield* resolveRemoteEnv(project.gitAuthMode, userId).pipe(
        Effect.provide(signers),
        Effect.mapError((error) =>
          failed(
            error._tag === "NoSignerError"
              ? error.message
              : `Could not create the Mend key: ${error.stderr}`,
          ),
        ),
      );
      return policy.pinnedEnv(clearance, env);
    });
  });

/** Audit a landing, whatever its outcome and trigger: it acted with the owner's credentials. */
export const auditLanding = (
  landing: ChangeLanding,
  organizationId: OrganizationId,
  actorUserId: string,
) =>
  Effect.gen(function* () {
    yield* (yield* AuditEventsRepo).record({
      organizationId,
      actorUserId,
      action: "change.landed",
      subjectType: "change",
      subjectId: landing.changeId,
      data: {
        sessionId: landing.sessionId,
        landingId: landing.id,
        outcome: landing.outcome,
        trigger: landing.trigger,
        remoteBranch: landing.remoteBranch,
        pushedSha: landing.pushedSha,
        pullRequest: landing.pullRequest?.number ?? null,
      },
    });
  });

/**
 * Audit an adopted pull request: the owner's `gh` read it, and it is now the change's (docs/adr/
 * 0007-landing.md, "Pull requests opened outside Mend"). The actor is the owner it was read as.
 */
export const auditAdoption = (landing: ChangeLanding, organizationId: OrganizationId) =>
  Effect.gen(function* () {
    yield* (yield* AuditEventsRepo).record({
      organizationId,
      actorUserId: landing.userId,
      action: "change.pull_request_adopted",
      subjectType: "change",
      subjectId: landing.changeId,
      data: {
        landingId: landing.id,
        pullRequest: landing.pullRequest?.number ?? null,
        state: landing.pullRequest?.state ?? null,
        branch: landing.remoteBranch,
        fork: landing.pullRequestCrossRepository ? (landing.pullRequestHeadOwner ?? "") : null,
      },
    });
  });

/** The latest turn automatic landing decided about, among a worktree's sessions. */
export const latestDecidedTurn = (turns: ReadonlyArray<AgentTurn>): AgentTurn | null =>
  latestDecidedTurnOf(turns);

/** Origin's branch against the last landed commit, and when it was looked at. */
export interface ObservedRemote extends RemoteBranchState {
  readonly observedAt: Date;
}

export interface LandingObservation {
  readonly landings: ReadonlyArray<ChangeLanding>;
  readonly facts: ReadonlyArray<LandingFact>;
  readonly remote: ObservedRemote | null;
  /** Why the fetch could not run, in git's or the remote's words. */
  readonly remoteFailure: string | null;
  /** The branch the next landing pushes when the owner names none. */
  readonly nextBranch: string;
}

/** The ref commands of every push the worktree's sessions made through the transport. */
const agentRefUpdates = (ops: ReadonlyArray<SessionGitOpRow>): ReadonlyArray<string> =>
  ops.filter((op) => op.kind === "push").flatMap((op) => op.refUpdates ?? []);

/**
 * A change's landings with the facts observed about them. `probeAs` runs one fetch of origin's
 * branch as that account; null reads the record and the worktree only.
 */
export const observeLandings = Effect.fn("observeLandings")(function* (input: {
  readonly change: Change;
  readonly project: Project;
  readonly worktree: Worktree;
  readonly probeAs: string | null;
}) {
  const { change, project, worktree } = input;
  const landings = yield* (yield* ChangeLandingsRepo).listForChange(change.id);
  const reads = yield* WorktreeReads;
  const lastPush = landings.find((landing) => landing.pushedSha !== null);
  const landedAt = lastPush?.checkpointSha ?? lastPush?.pushedSha ?? null;
  // A read that cannot be served leaves the fact out rather than stating a guess.
  const since =
    landedAt === null
      ? null
      : yield* reads.changedFiles(project.id, worktree.id, landedAt).pipe(
          Effect.map((read) => read.value.length),
          Effect.orElseSucceed(() => null),
        );
  const sessions = yield* (yield* SessionsRepo).listForWorktree(worktree.id);
  const gitOps = yield* SessionGitOpsRepo;
  const ops = yield* Effect.forEach(sessions, (session) => gitOps.listForSession(session.id));
  const conversations = yield* AgentConversationRepo;
  const turns = yield* Effect.forEach(sessions, (session) => conversations.listTurns(session.id));

  let remote: ObservedRemote | null = null;
  let remoteFailure: string | null = null;
  if (input.probeAs !== null && lastPush !== undefined && lastPush.pushedSha !== null) {
    const sha = lastPush.pushedSha;
    const git = yield* LandingGit;
    const env = yield* remoteEnvFor(project, input.probeAs, "probe");
    const probed = yield* env.pipe(
      Effect.flatMap((remoteEnv) =>
        git.probe({ project, worktree }, { sha, remoteBranch: lastPush.remoteBranch, remoteEnv }),
      ),
      Effect.result,
    );
    if (Result.isSuccess(probed)) {
      remote = { ...probed.success, observedAt: new Date(yield* Clock.currentTimeMillis) };
    } else {
      remoteFailure = probed.failure.message;
    }
  }

  // Newest push first, as the branch choice reads them; a push that failed moved nothing.
  const pushes = ops
    .flat()
    .filter((op) => op.kind === "push" && op.exitCode === 0)
    .toSorted((left, right) => right.startedAt.getTime() - left.startedAt.getTime());
  const nextBranch = nextLandingBranch({
    requested: null,
    landings,
    agentBranches: agentPushedBranches(pushes.flatMap((op) => op.refUpdates ?? [])),
    worktreeBranch: worktree.branch,
    protectedBranches: [
      project.defaultBranch,
      pullRequestBase(worktree.baseRef, project.defaultBranch),
    ],
  });

  return {
    landings,
    nextBranch,
    facts: landingFacts({
      landings,
      originCommitsUnseen: remote?.unseen ?? null,
      filesChangedSinceLanding: since,
      agentRefUpdates: agentRefUpdates(ops.flat()),
      latestTurn: latestDecidedTurn(turns.flat()),
    }),
    remote,
    remoteFailure,
  } satisfies LandingObservation;
});

// ─── Worktree removal ───────────────────────────────────────────────────────

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** How many files to name in a refusal before counting the rest. */
const NAMED_FILES = 5;

/** `3 files · +12 −3 · src/a.ts +10 −2, src/b.ts +2 −1, docs/c.md +0 −0` */
export const describeUnlanded = (files: ReadonlyArray<ChangedFile>): string => {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const named = files
    .slice(0, NAMED_FILES)
    .map((file) => `${file.path} +${file.additions} −${file.deletions}`)
    .join(", ");
  const more = files.length > NAMED_FILES ? `, ${files.length - NAMED_FILES} more` : "";
  return `${plural(files.length, "file", "files")} · +${additions} −${deletions} · ${named}${more}`;
};

const OVERRIDE = "or pass force=true to remove it anyway";

/**
 * Why a worktree may not be removed without `force`, or null when it may
 * (docs/adr/0007-landing.md, "Worktree removal"): it holds nothing past its base, or what it
 * holds is the last landing's checkpoint and either its pull request was last reported merged or
 * origin's branch still has that landing's commit. Anything else is refused, naming the files
 * and line counts not on origin.
 */
export const unlandedWork = Effect.fn("unlandedWork")(function* (input: {
  readonly change: Change | null;
  readonly project: Project;
  readonly worktree: Worktree;
  /** Whose credentials the fetch of origin's branch uses: the caller's. */
  readonly userId: string;
}) {
  const { project, worktree } = input;
  const reads = yield* WorktreeReads;
  const sinceBase = (yield* reads.changedFiles(project.id, worktree.id, worktree.baseSha)).value;
  if (sinceBase.length === 0) return null;
  const landings =
    input.change === null ? [] : yield* (yield* ChangeLandingsRepo).listForChange(input.change.id);
  const lastPush = landings.find((landing) => landing.pushedSha !== null);
  if (lastPush === undefined || lastPush.pushedSha === null) {
    return `This worktree holds a change that was never landed · ${describeUnlanded(sinceBase)}. Land it or discard it before removal, ${OVERRIDE}.`;
  }
  const sha = lastPush.pushedSha;
  const landed = `${lastPush.remoteBranch} · ${sha.slice(0, 7)}`;
  const sinceLanding = (yield* reads.changedFiles(
    project.id,
    worktree.id,
    lastPush.checkpointSha ?? sha,
  )).value;
  if (sinceLanding.length > 0) {
    return `This worktree changed since its last landing (${landed}) · ${describeUnlanded(sinceLanding)}. Land it again or discard it before removal, ${OVERRIDE}.`;
  }
  // A pull request GitHub last reported merged, with the last push in it, holds the change even
  // once origin's branch is deleted: a squash merge leaves no ancestry for a fetch to find.
  if (
    landings.some((landing) => landing.pushedSha === sha && landing.pullRequest?.state === "merged")
  ) {
    return null;
  }
  const git = yield* LandingGit;
  const env = yield* remoteEnvFor(project, input.userId, "probe");
  const probed = yield* env.pipe(
    Effect.flatMap((remoteEnv) =>
      git.probe({ project, worktree }, { sha, remoteBranch: lastPush.remoteBranch, remoteEnv }),
    ),
    Effect.result,
  );
  if (Result.isFailure(probed)) {
    const words = probed.failure.message.trim().replace(/\.+$/, "");
    return `origin could not be checked for the last landing (${landed}) · ${words}. Try again, ${OVERRIDE}.`;
  }
  if (!probed.success.holds) {
    const where =
      probed.success.remoteSha === null
        ? "the branch is gone"
        : `it is at ${probed.success.remoteSha.slice(0, 7)}`;
    return `origin's ${lastPush.remoteBranch} no longer holds the landed commit ${sha.slice(0, 7)} · ${where}. Land it again before removal, ${OVERRIDE}.`;
  }
  return null;
});
