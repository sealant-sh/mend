import {
  AgentConversationRepo,
  ProjectsRepo,
  SessionsRepo,
  SlackInstallsRepo,
  SlackThreadsRepo,
} from "@mend/db";
import type { SessionId } from "@mend/domain";
import { changeOwnerOf } from "@mend/domain/workbench";
import { workspaceLandLines, workspaceLandRefusal } from "@mend/landing";
import { NetworkConfig } from "@mend/network";
import { WorkspaceGitHooks, type WorkspaceLandOutcome } from "@mend/sessions";
import { Cause, Effect, Layer, Result } from "effect";

import { OwnerLanding } from "./owner-landing.ts";

/**
 * `mend land` inside a session's workspace (docs/adr/0007-landing.md, "Surfaces"): the agent runs
 * it when the person asks it to land, push or open a pull request. The request arrives over the
 * session's own socket or channel token, so it speaks for that session only. Mend lands the
 * change as its owner, through the same landing as the Land panel and Slack's button
 * (`OwnerLanding`: the owner's key, a fast-forward push, the pull request as them, audited), and
 * answers with what was pushed and what GitHub said, or why it did not land. It never
 * force-pushes and never moves the session's branch.
 */

const refused = (line: string): WorkspaceLandOutcome => ({ landed: false, lines: [line] });

export const makeWorkspaceLanding = Effect.gen(function* () {
  const sessions = yield* SessionsRepo;
  const projects = yield* ProjectsRepo;
  const conversations = yield* AgentConversationRepo;
  const threads = yield* SlackThreadsRepo;
  const installs = yield* SlackInstallsRepo;
  const lander = yield* OwnerLanding;
  const network = yield* NetworkConfig;

  /** Where the pull request's links point: the Slack install's origin for a Slack session. */
  const webOriginOf = (sessionId: SessionId) =>
    Effect.gen(function* () {
      const thread = yield* threads.forSession(sessionId);
      const install = thread === null ? null : yield* installs.byTeam(thread.teamId);
      return install?.webOrigin ?? network.appUrl;
    });

  const land = Effect.fn("WorkspaceLanding.land")(function* (
    sessionId: SessionId,
    requestedBy: string | null,
  ) {
    const session = yield* sessions
      .byId(sessionId)
      .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
    if (session === null) return refused("not landed · the session is gone");
    const owner = changeOwnerOf(yield* sessions.listForWorktree(session.worktreeId));
    const refusal = workspaceLandRefusal({
      session,
      changeOwnerUserId: owner,
      turns: yield* conversations.listTurns(session.id),
      requestedBy,
    });
    if (refusal !== null || owner === null) {
      return refused(refusal ?? "not landed · the change has no owner");
    }
    const project = yield* projects
      .byId(session.projectId)
      .pipe(Effect.catchTag("ProjectNotFoundError", () => Effect.succeed(null)));
    if (project === null) return refused("not landed · the project is gone");
    const landed = yield* lander
      .land({
        session,
        project,
        ownerUserId: owner,
        trigger: "manual",
        webOrigin: yield* webOriginOf(session.id),
      })
      .pipe(Effect.result);
    // A landing that did not start says why in the landing's own words.
    if (Result.isFailure(landed)) return refused(landed.failure.message);
    const outcome = workspaceLandLines(landed.success);
    yield* Effect.logInfo(`workspace landing: ${outcome.lines[0] ?? ""}`).pipe(
      Effect.annotateLogs({ sessionId, landingId: landed.success.landing.id }),
    );
    return outcome;
  });

  return {
    land: (sessionId: SessionId, requestedBy: string | null): Effect.Effect<WorkspaceLandOutcome> =>
      land(sessionId, requestedBy).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("workspace landing: failed").pipe(
            Effect.annotateLogs({ sessionId, cause: Cause.pretty(cause) }),
            Effect.as(refused("not landed · Mend could not land it · see the server log")),
          ),
        ),
      ),
  };
});

/** Registers the answer to `mend land` with the engine's workspace hooks. */
export const WorkspaceLandingLive: Layer.Layer<
  never,
  never,
  | WorkspaceGitHooks
  | AgentConversationRepo
  | NetworkConfig
  | OwnerLanding
  | ProjectsRepo
  | SessionsRepo
  | SlackInstallsRepo
  | SlackThreadsRepo
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const hooks = yield* WorkspaceGitHooks;
    const landing = yield* makeWorkspaceLanding;
    yield* hooks.registerLanding(landing.land);
  }),
);
