import { randomUUID } from "node:crypto";

import {
  CommandId,
  SourceControlProviderKind,
  PullRequestOperationError,
  PullRequestDetail,
  PullRequestSummary,
  PullRequestPreview,
  PullRequestListResult,
  type PullRequestListInput,
  type PullRequestRef,
  type PullRequestActionInput,
  type PullRequestListStatsInput,
  type PullRequestRoutingIdentityInput,
  type PullRequestInvalidateInput,
  type PullRequestReportStateInput,
  type PullRequestChecksState,
} from "@mend/t3-contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import type { GatedMend } from "./device-gate.ts";
import type { PersonHub } from "./hub.ts";
import type { MendRead } from "./mend-client.ts";
import type { MendPullRequestDetail, MendPullRequest } from "./mend-pull-requests.ts";
import { samePullRequest } from "./pull-request-links.ts";
import { makePullRequestMergeHandlers, type PullRequestMergeAccess } from "./pull-request-merge.ts";
import { makePullRequestReviewGuide } from "./pull-request-review-guide.ts";
import type { BearerSession } from "./state.ts";

const failure = (operation: string, detail: string) =>
  new PullRequestOperationError({ operation, detail });
const HOST = "github.com";
const quoteQualifier = (value: string) => JSON.stringify(value);

/** GitHub's aggregate check state; no checks is unknown, rather than passing. */
export const checksStateOf = (
  pr: Pick<MendPullRequest, "checks">,
): PullRequestChecksState | undefined =>
  pr.checks.length === 0
    ? undefined
    : pr.checks.some((check) => ["failure", "cancelled", "action-required"].includes(check.status))
      ? "failing"
      : pr.checks.some((check) => check.status === "pending")
        ? "pending"
        : "passing";

/** Build GitHub search qualifiers without changing the person's free-text search. */
export const pullRequestQueryOf = (input: PullRequestListInput): string => {
  const parts = ["sort:updated-desc"];
  if (input.state !== "all") parts.push(`is:${input.state}`);
  if (input.involvement === "authored") parts.push("author:@me");
  if (input.involvement === "reviewing") parts.push("review-requested:@me");
  const filters = input.filters;
  if (filters?.draft !== undefined)
    parts.push(`draft:${filters.draft === "only" ? "true" : "false"}`);
  if (filters?.review !== undefined) parts.push(`review:${filters.review}`);
  if (filters?.checks !== undefined)
    parts.push(`status:${filters.checks === "passing" ? "success" : "failure"}`);
  for (const group of filters?.labels ?? [])
    parts.push(`label:${group.map(quoteQualifier).join(",")}`);
  for (const label of filters?.excludedLabels ?? []) parts.push(`-label:${quoteQualifier(label)}`);
  if (filters?.author !== undefined) parts.push(`author:${quoteQualifier(filters.author)}`);
  if (input.query !== undefined) parts.push(input.query.replace(/^#(?=\d+$)/u, ""));
  return parts.join(" ");
};

/** Native PR browsing over Mend's visibility checks and caller-owned GitHub reads. */
export const makePullRequestHandlers = ({
  hub,
  mend,
  session,
}: {
  readonly hub: PersonHub;
  readonly mend: GatedMend;
  readonly session: BearerSession;
}) => {
  // Detail, summary, preview and checks mount together. Share their in-flight read, keep a
  // success for ten seconds and never retain a failed read. This cache belongs to one socket.
  const guide = makePullRequestReviewGuide({ hub, mend, session });
  const merge = makePullRequestMergeHandlers({ hub, mend, session });
  const reads = new Map<string, MendRead<MendPullRequestDetail>>();
  const decode = <S extends Schema.Decoder<unknown>>(schema: S, value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(() => failure("read", "Mend returned incomplete pull request data.")),
    );
  const host = (value: string | undefined) =>
    value === undefined || value.toLowerCase() === HOST
      ? Effect.void
      : Effect.fail(failure("routing", "This Mend adapter supports github.com pull requests."));
  const projectOf = (id: string) =>
    Effect.gen(function* () {
      const shell = yield* hub.shellSnapshot;
      const project = shell.projects.find((candidate) => candidate.id === id);
      if (project === undefined)
        return yield* failure("routing", "This project is not visible in this environment.");
      return project;
    });
  const observe = (ref: PullRequestRef, pr: MendPullRequest) =>
    Effect.gen(function* () {
      const shell = yield* hub.shellSnapshot;
      for (const thread of shell.threads) {
        if (
          !(thread.pullRequests ?? []).some((link) => samePullRequest(link, { ...ref, host: HOST }))
        )
          continue;
        yield* hub.commands.pullRequestLink({
          type: "thread.pull-request-link.sync",
          commandId: CommandId.make(randomUUID()),
          threadId: thread.id,
          host: HOST,
          repository: ref.repository,
          number: ref.number,
          stack:
            (thread.pullRequests ?? []).find((link) =>
              samePullRequest(link, { ...ref, host: HOST }),
            )?.stack ?? null,
          snapshot: {
            state: pr.state,
            title: pr.title,
            headBranch: pr.headBranch,
            baseBranch: pr.baseBranch,
            isDraft: pr.isDraft,
            updatedAt: pr.updatedAt,
            syncedAt: new Date(pr.observedAt).toISOString(),
            closedAt: pr.closedAt,
            mergedAt: pr.mergedAt,
            author: pr.author,
            additions: pr.additions,
            deletions: pr.deletions,
            changedFiles: pr.changedFiles,
            reviewDecision: pr.reviewDecision,
            checksState: checksStateOf(pr) ?? null,
            mergeability: pr.mergeability,
          },
        });
      }
    });
  const read = (ref: PullRequestRef) =>
    Effect.gen(function* () {
      yield* host(ref.host);
      const project = yield* projectOf(ref.projectId);
      const key = `${ref.projectId}:${ref.repository.toLowerCase()}:${ref.number}`;
      let kept = reads.get(key);
      if (kept === undefined) {
        kept = yield* mend
          .pullRequestDetail(session.deviceToken, ref.projectId, ref.repository, ref.number)
          .pipe(
            Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? "10 seconds" : "0 seconds")),
          );
        reads.set(key, kept);
      }
      const result = yield* kept;
      if (
        ref.expectedAccountId !== undefined &&
        ref.expectedAccountId !== result.viewer.toLowerCase()
      )
        return yield* failure(
          "routing",
          "Your GitHub account changed. Open the pull request again.",
        );
      yield* observe(ref, result.pullRequest);
      return { ...result, project };
    });
  const wrapped = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((error) =>
        error instanceof PullRequestOperationError
          ? error
          : failure(
              operation,
              error !== null &&
                typeof error === "object" &&
                "_tag" in error &&
                error._tag === "MendDeviceRefused"
                ? "Mend no longer accepts this device. Pair again from Mend."
                : error !== null &&
                    typeof error === "object" &&
                    "detail" in error &&
                    typeof error.detail === "string"
                  ? error.detail
                  : "Mend could not read this pull request using your GitHub account.",
            ),
      ),
    );
  const summary = (ref: PullRequestRef) =>
    wrapped(
      "summary",
      Effect.gen(function* () {
        const { pullRequest: pr } = yield* read(ref);
        return yield* decode(PullRequestSummary, {
          ...pr,
          provider: "github",
          projectId: ref.projectId,
          repository: ref.repository,
          checksState: checksStateOf(pr) ?? null,
        });
      }),
    );
  const detail = (ref: PullRequestRef) =>
    wrapped(
      "detail",
      Effect.gen(function* () {
        const { pullRequest: pr, viewer, project } = yield* read(ref);
        // Read rights fresh, outside the detail cache, and bind them to the displayed account.
        // A merge-access outage must not prevent browsing. Device revocation still refuses.
        const access = yield* merge.mergeAccess({ ...ref, expectedAccountId: viewer }).pipe(
          Effect.catch((error) =>
            hub.isRefused(session.deviceToken)
              ? Effect.fail(error)
              : Effect.succeed<PullRequestMergeAccess>({
                  capabilities: { actions: [], mergeMethods: [] },
                  viewerPermissions: { actions: [] },
                  mergeCapabilities: { merge: false, squash: false, rebase: false },
                }),
          ),
        );
        return yield* decode(PullRequestDetail, {
          ...pr,
          provider: "github",
          projectId: project.id,
          projectTitle: project.title,
          workspaceRoot: project.workspaceRoot,
          repository: ref.repository,
          headRepositoryNameWithOwner: pr.headRepository,
          reviewers: [],
          viewer,
          capabilities: {
            diff: false,
            comment: false,
            ...access.capabilities,
            search: true,
            review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
            reviewers: { request: false, listCandidates: false },
            labels: false,
          },
          viewerPermissions: {
            ...access.viewerPermissions,
            comment: false,
            resolve: false,
            verdicts: [],
            requestReviewers: false,
            labels: false,
          },
          mergeCapabilities: access.mergeCapabilities,
        });
      }),
    );
  const list = (input: PullRequestListInput) =>
    wrapped(
      "list",
      Effect.gen(function* () {
        yield* host(input.host);
        const shell = yield* hub.shellSnapshot;
        const projects = shell.projects.filter(
          (project) =>
            (input.projectId === undefined || project.id === input.projectId) &&
            (input.projectIds === undefined || input.projectIds.includes(project.id)),
        );
        const seen = new Set<string>();
        const entries: Array<unknown> = [];
        const errors: Array<unknown> = [];
        const viewers: Record<string, string> = {};
        const nextCursors: Record<string, string> = {};
        let projectCount = 0;
        for (const project of projects) {
          const attempt = yield* Effect.gen(function* () {
            const { project: original } = yield* mend.projectDetail(
              session.deviceToken,
              project.id,
            );
            const match =
              /^(?:https?:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(
                original.originUrl ?? "",
              );
            const repository = match?.[1];
            if (repository === undefined) return;
            const key = `${HOST} ${repository.toLowerCase()}`;
            if (seen.has(key)) return;
            seen.add(key);
            projectCount++;
            if (input.cursors !== undefined && input.cursors[key] === undefined) return;
            const page = yield* mend.pullRequestList(session.deviceToken, project.id, {
              query: pullRequestQueryOf(input),
              limit: Math.min(input.limit ?? 50, 100),
              cursor: input.cursors?.[key] ?? null,
            });
            viewers[HOST] = page.viewer;
            if (page.cursor !== null) nextCursors[key] = page.cursor;
            for (const pr of page.entries) {
              entries.push({
                ...pr,
                provider: "github",
                host: HOST,
                projectId: project.id,
                projectTitle: project.title,
                repository,
                viewerReviewRequested: input.involvement === "reviewing",
                reviewDecision: pr.reviewDecision ?? undefined,
                checksState: checksStateOf(pr),
              });
              yield* observe({ projectId: project.id, repository, number: pr.number }, pr);
            }
          }).pipe(Effect.result);
          if (attempt._tag === "Failure") {
            if (attempt.failure._tag === "MendDeviceRefused") return yield* attempt.failure;
            errors.push({
              projectId: project.id,
              projectTitle: project.title,
              message: "Could not read this project's PRs using your GitHub account.",
            });
          }
        }
        const result = yield* decode(PullRequestListResult, {
          viewers,
          entries,
          errors,
          nextCursors,
          truncated: Object.keys(nextCursors).length > 0,
          providers:
            projectCount === 0
              ? []
              : [
                  {
                    host: HOST,
                    kind: "github",
                    searchesOnHost: true,
                    projectCount,
                    configured: viewers[HOST] !== undefined,
                    detail: null,
                    actions: [],
                  },
                ],
        });
        return {
          ...result,
          entries: result.entries.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        };
      }),
    );
  return {
    list,
    runAction: (input: PullRequestActionInput) =>
      merge.runAction(input).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            reads.delete(`${input.projectId}:${input.repository.toLowerCase()}:${input.number}`);
          }),
        ),
      ),
    summary,
    detail,
    reviewGuide: (ref: PullRequestRef) =>
      wrapped(
        "reviewGuide",
        read(ref).pipe(Effect.flatMap(({ pullRequest: pr }) => guide.resultOf(ref, pr, false))),
      ),
    generateReviewGuide: (ref: PullRequestRef) =>
      wrapped(
        "generateReviewGuide",
        read(ref).pipe(Effect.flatMap(({ pullRequest: pr }) => guide.resultOf(ref, pr, true))),
      ),
    preview: (ref: PullRequestRef) =>
      wrapped(
        "preview",
        Effect.gen(function* () {
          const { pullRequest: pr } = yield* read(ref);
          return yield* decode(PullRequestPreview, {
            ...pr,
            projectId: ref.projectId,
            repository: ref.repository,
          });
        }),
      ),
    checks: (ref: PullRequestRef) =>
      wrapped(
        "checks",
        read(ref).pipe(
          Effect.map(({ pullRequest: pr }) => ({ state: pr.state, checks: pr.checks })),
        ),
      ),
    listStats: (input: PullRequestListStatsInput) =>
      wrapped(
        "listStats",
        Effect.forEach(input.refs, (ref) => summary(ref)).pipe(
          Effect.map((stats) => ({
            stats: stats.map((pr) => ({
              projectId: pr.projectId,
              repository: pr.repository,
              number: pr.number,
              additions: pr.additions ?? 0,
              deletions: pr.deletions ?? 0,
            })),
          })),
        ),
      ),
    linkedThreads: (ref: PullRequestRef) =>
      wrapped(
        "linkedThreads",
        Effect.gen(function* () {
          yield* host(ref.host);
          yield* projectOf(ref.projectId);
          const shell = yield* hub.shellSnapshot;
          return {
            threads: shell.threads
              .filter((thread) =>
                (thread.pullRequests ?? []).some(
                  (link) =>
                    link.source !== "stack-dismissed" &&
                    samePullRequest(link, { ...ref, host: HOST }),
                ),
              )
              .map((thread) => ({
                id: thread.id,
                projectId: thread.projectId,
                title: thread.title,
                archivedAt:
                  thread.archivedAt === null ? null : DateTime.formatIso(thread.archivedAt),
              })),
          };
        }),
      ),
    routing: (ref: PullRequestRef) =>
      wrapped(
        "routing",
        read(ref).pipe(
          Effect.map(({ viewer, project }) => ({
            accountId: viewer.toLowerCase(),
            host: HOST,
            provider: SourceControlProviderKind.make("github"),
            viewer,
            projectTitle: project.title,
            workspaceRoot: project.workspaceRoot,
          })),
        ),
      ),
    routingIdentity: (input: PullRequestRoutingIdentityInput) =>
      wrapped(
        "routingIdentity",
        Effect.gen(function* () {
          yield* host(input.host);
          const { viewer } = yield* mend.pullRequestIdentity(session.deviceToken);
          return {
            accountId: viewer.toLowerCase(),
            host: HOST,
            provider: "github" as const,
            viewer,
          };
        }),
      ),
    invalidate: (_input: PullRequestInvalidateInput) =>
      Effect.sync(() => {
        reads.clear();
      }),
    reportState: (input: PullRequestReportStateInput) =>
      wrapped(
        "reportState",
        Effect.gen(function* () {
          // A client-reported transition is a refresh hint, never a terminal timestamp.
          reads.clear();
          yield* read(input.reference);
        }),
      ),
  };
};
