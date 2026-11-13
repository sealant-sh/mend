import { BriefCommentsRepo } from "@mend/db";
import { BriefCommentId, ChangeId, IssueId, RunId, type BriefComment } from "@mend/domain";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { InferenceError, InferenceProvider } from "./provider.ts";
import {
  ReadBrief,
  ReadChange,
  ReadIssue,
  ReadRecording,
  ReplyOnBrief,
  StartRun,
} from "./tools.ts";
import { commentRoutingTools, type RoutedActionCollector } from "./toolset.ts";

/** The `route-comment` job's payload — enqueued when a reviewer comments. */
export class RouteCommentJob extends Schema.Class<RouteCommentJob>("RouteCommentJob")({
  commentId: BriefCommentId,
  changeId: ChangeId,
  issueId: IssueId,
}) {}

/**
 * The routing rules (docs/archive/PRODUCT.md, Iteration + "Inference in the interface"),
 * addressed to the model. Interface inference routes; a harness executes.
 */
const SYSTEM = `You read a reviewer's comment on the brief — the review of a code change — and route it to the next action. You are Mend's interface inference: you write language and route actions; you never edit code, never approve, never merge, and never judge whether the change should merge.

The three actions, exactly one of which you take:
- start_run with kind "follow-up" — the comment asks for a code change. The harness runs on the change's existing branch; write a self-contained instruction (the harness sees only it and the repository — carry over every detail it needs from the comment and the brief).
- start_run with kind "verification" — the comment asks to see something exercised or proven, with no code change: typically an amber "not executed" question the reviewer wants run. The instruction states the exact scenario to execute.
- reply_on_brief — the comment is a question the recording already answers (reply with what you read, citing run and sequence in plain words), or it is too ambiguous to act on (ask one precise question back). Asking is cheaper and safer than guessing at a run.

Method: read_brief for the document and the question the thread anchors to; read the recording or the change only as far as deciding requires. Then act exactly once. Do not reply AND start a run — the routed action itself is shown to the reviewer.`;

const prompt = (job: RouteCommentJob, comment: BriefComment) =>
  `A reviewer commented on the brief for change ${job.changeId} (issue ${job.issueId}).\n\n` +
  `Thread: ${comment.thread === "general" ? "the brief as a whole" : `review question ${comment.thread.slice(1)}`} (thread key "${comment.thread}")\n` +
  `Reviewer: ${comment.authorName}\n` +
  `Comment:\n${comment.body}\n\n` +
  `Route it: exactly one of start_run or reply_on_brief.`;

/**
 * Routes one reviewer comment — the `route-comment` job's worker body. Judged
 * by its side effect: an action happened and is recorded on the comment, or
 * the job fails into the engine's retry.
 */
export class CommentRouter extends Context.Service<
  CommentRouter,
  {
    readonly route: (job: RouteCommentJob) => Effect.Effect<void, InferenceError>;
  }
>()("@mend/inference/CommentRouter") {
  static readonly layer = Layer.effect(
    CommentRouter,
    Effect.gen(function* () {
      const provider = yield* InferenceProvider;
      const comments = yield* BriefCommentsRepo;
      const toolServices = yield* Effect.context<
        ReadRecording | ReadIssue | ReadChange | ReadBrief | ReplyOnBrief | StartRun
      >();

      const route = Effect.fn("CommentRouter.route")(function* (job: RouteCommentJob) {
        const comment = yield* comments
          .byId(job.commentId)
          .pipe(
            Effect.mapError(
              () => new InferenceError({ message: `no comment ${job.commentId}`, cause: null }),
            ),
          );

        // Already routed — a retried job never routes twice.
        if (comment.routedAction !== null) return;

        const actions: Array<
          | { readonly kind: "replied" }
          | { readonly kind: "run-started"; readonly runKind: string; readonly runId: string }
        > = [];
        const collector: RoutedActionCollector = {
          record: (action) => {
            actions.push(action);
          },
        };
        const tools = yield* commentRoutingTools(collector).pipe(
          Effect.provideContext(toolServices),
        );

        yield* provider.respond({
          context: "comment-routing",
          system: SYSTEM,
          prompt: prompt(job, comment),
          tools,
        });

        const run = actions.find((action) => action.kind === "run-started");
        const replied = actions.some((action) => action.kind === "replied");
        if (run !== undefined && run.kind === "run-started") {
          yield* comments.setRouted(
            comment.id,
            run.runKind === "verification" ? "verification-run" : "follow-up-run",
            RunId.make(run.runId),
          );
          return;
        }
        if (replied) {
          yield* comments.setRouted(comment.id, "question-back", null);
          return;
        }
        return yield* new InferenceError({
          message: "the routing finished without acting (no run started, no reply posted)",
          cause: null,
        });
      });

      return { route };
    }),
  );
}
