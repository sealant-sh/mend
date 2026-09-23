import type { SessionId } from "@mend/domain";
import type { LandedPullRequest } from "@mend/domain/workbench";
import { Clock, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { mergeDescription } from "./description.ts";
import {
  createArgv,
  createdUrl,
  editArgv,
  ghWords,
  openForBranchArgv,
  parseFirstPullRequest,
  parsePullRequest,
  type PullRequestView,
  removeFileArgv,
  viewArgv,
  writeFileArgv,
} from "./gh.ts";
import type { GitHubRepository } from "./github.ts";

/**
 * Step 4 of a landing (docs/adr/0007-landing.md, "Where each step runs"): open or update the
 * pull request with `gh`, as the session's owner. The owner's GitHub token exists only on the
 * platform and in the workspaces it builds, so the calls run in a workspace through the SDK's
 * `exec`, and the token never reaches Mend's process or database.
 */

/** The pull request step did not finish: `gh`'s or the platform's own words. */
export class PullRequestStepError extends Schema.TaggedErrorClass<PullRequestStepError>()(
  "PullRequestStepError",
  { message: Schema.String },
) {}

/** What one command in the workspace printed. A nonzero exit is a fact, not an error. */
export interface ExecOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A workspace the pull request step runs `gh` in. */
export interface PullRequestWorkspace {
  /** The session's own live workspace, or a short-lived one made for this call. */
  readonly kind: "session" | "short-lived";
  readonly exec: (argv: ReadonlyArray<string>) => Effect.Effect<ExecOutput, PullRequestStepError>;
}

/** Whose GitHub account speaks, and the session whose live workspace to use when it has one. */
export interface PullRequestWorkspaceTarget {
  readonly ownerUserId: string;
  /** Null asks for a short-lived workspace outright. */
  readonly sessionId: SessionId | null;
}

/**
 * Where `gh` runs: in the session's workspace when it is live, otherwise in a short-lived
 * workspace for the owner with the GitHub credential and nothing else, destroyed when `use`
 * returns.
 */
export class PullRequestWorkspaces extends Context.Service<
  PullRequestWorkspaces,
  {
    readonly within: <A, E>(
      target: PullRequestWorkspaceTarget,
      use: (workspace: PullRequestWorkspace) => Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | PullRequestStepError>;
  }
>()("@mend/landing/PullRequestWorkspaces") {}

export interface PublishInput {
  readonly target: PullRequestWorkspaceTarget;
  readonly repository: GitHubRepository;
  /** The pushed branch, without `refs/heads/`. */
  readonly head: string;
  /** The branch the pull request merges into. */
  readonly base: string;
  /** The title a new pull request opens with. */
  readonly title: string;
  /** Whether the owner gave `title` for this landing; only then does an update send it. */
  readonly titleGiven: boolean;
  /** Mend's section of the description, markers included. */
  readonly section: string;
  /** The pull request an earlier landing of this change opened, as recorded. */
  readonly previous: number | null;
}

export interface Published {
  readonly action: "opened" | "updated";
  readonly pullRequest: LandedPullRequest;
  readonly workspace: PullRequestWorkspace["kind"];
}

export class PullRequests extends Context.Service<
  PullRequests,
  {
    /**
     * Open the pull request, or update the open one: the one an earlier landing opened, else one
     * already open from the branch. Only Mend's marked section of the body is replaced.
     */
    readonly publish: (input: PublishInput) => Effect.Effect<Published, PullRequestStepError>;
    /** The pull request's number, URL and state as `gh` reports them now. */
    readonly observe: (input: {
      readonly target: PullRequestWorkspaceTarget;
      readonly repository: GitHubRepository;
      readonly number: number;
    }) => Effect.Effect<LandedPullRequest, PullRequestStepError>;
  }
>()("@mend/landing/PullRequests") {}

// ─── Live ───────────────────────────────────────────────────────────────────

const failure = (message: string) => new PullRequestStepError({ message });

/** Run one `gh` call, failing with its words, prefixed with what it was doing, when it exits nonzero. */
const ghOk = (
  workspace: PullRequestWorkspace,
  argv: ReadonlyArray<string>,
  doing: string,
): Effect.Effect<ExecOutput, PullRequestStepError> =>
  workspace
    .exec(argv)
    .pipe(
      Effect.flatMap((output) =>
        output.exitCode === 0
          ? Effect.succeed(output)
          : Effect.fail(failure(`${doing} · ${ghWords(output)}`)),
      ),
    );

const view = (
  workspace: PullRequestWorkspace,
  repository: GitHubRepository,
  ref: number | string,
) =>
  ghOk(workspace, viewArgv(repository, ref), "gh pr view").pipe(
    Effect.flatMap((output) => {
      const parsed = parsePullRequest(output.stdout);
      return parsed === null
        ? Effect.fail(failure("gh pr view · the answer was not the pull request's JSON"))
        : Effect.succeed(parsed);
    }),
  );

const observedAt = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis));

const landed = (pullRequest: PullRequestView, at: Date): LandedPullRequest => ({
  number: pullRequest.number,
  url: pullRequest.url,
  state: pullRequest.state,
  observedAt: at,
});

/** The open pull request an update targets, or null when the landing opens a new one. */
const openTarget = (
  workspace: PullRequestWorkspace,
  input: PublishInput,
): Effect.Effect<PullRequestView | null, PullRequestStepError> =>
  Effect.gen(function* () {
    if (input.previous !== null) {
      // A recorded pull request that is gone or unreadable is not fatal: the branch lookup below
      // finds any open one, and a create reports GitHub's words if that fails too.
      const recorded = yield* view(workspace, input.repository, input.previous).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (recorded !== null && recorded.state === "open") return recorded;
    }
    const listed = yield* ghOk(
      workspace,
      openForBranchArgv(input.repository, input.head),
      "gh pr list",
    );
    return parseFirstPullRequest(listed.stdout);
  });

export const PullRequestsLive: Layer.Layer<PullRequests, never, PullRequestWorkspaces> =
  Layer.effect(
    PullRequests,
    Effect.gen(function* () {
      const workspaces = yield* PullRequestWorkspaces;

      const publish = Effect.fn("PullRequests.publish")((input: PublishInput) =>
        workspaces.within(input.target, (workspace) =>
          Effect.gen(function* () {
            const target = yield* openTarget(workspace, input);
            const bodyFile = `/tmp/mend-pull-request-${crypto.randomUUID()}.md`;
            const body = mergeDescription(target?.body ?? null, input.section);
            const written = yield* workspace.exec(writeFileArgv(bodyFile, body));
            if (written.exitCode !== 0) {
              return yield* failure(`writing the description · ${ghWords(written)}`);
            }
            const sent = Effect.gen(function* () {
              if (target !== null) {
                yield* ghOk(
                  workspace,
                  editArgv({
                    repository: input.repository,
                    number: target.number,
                    title: input.titleGiven ? input.title : null,
                    bodyFile,
                  }),
                  "gh pr edit",
                );
                return {
                  action: "updated" as const,
                  pullRequest: landed(target, yield* observedAt),
                  workspace: workspace.kind,
                };
              }
              const created = yield* ghOk(
                workspace,
                createArgv({
                  repository: input.repository,
                  head: input.head,
                  base: input.base,
                  title: input.title,
                  bodyFile,
                }),
                "gh pr create",
              );
              const url = createdUrl(created.stdout);
              if (url === null) {
                return yield* failure("gh pr create · it printed no pull request URL");
              }
              const opened = yield* view(workspace, input.repository, url);
              return {
                action: "opened" as const,
                pullRequest: landed(opened, yield* observedAt),
                workspace: workspace.kind,
              };
            });
            // The file is removed from a live session's workspace; a short-lived one goes whole.
            return yield* sent.pipe(
              Effect.ensuring(workspace.exec(removeFileArgv(bodyFile)).pipe(Effect.ignore)),
            );
          }),
        ),
      );

      const observe = Effect.fn("PullRequests.observe")(
        (input: {
          readonly target: PullRequestWorkspaceTarget;
          readonly repository: GitHubRepository;
          readonly number: number;
        }) =>
          workspaces.within(input.target, (workspace) =>
            Effect.gen(function* () {
              const current = yield* view(workspace, input.repository, input.number);
              return landed(current, yield* observedAt);
            }),
          ),
      );

      return { publish, observe };
    }),
  );
