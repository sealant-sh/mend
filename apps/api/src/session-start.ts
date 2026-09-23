import { BudgetExceeded, LaunchRequest, NotFound, StoreFailure } from "@mend/api-contracts";
import { ProjectsRepo, SessionsRepo, SettingsRepo } from "@mend/db";
import type { ProjectId } from "@mend/domain";
import {
  composeLaunchArgv,
  PROMPTABLE_HARNESSES,
  resolveAutomation,
  type Session,
  type SessionOrigin,
} from "@mend/domain/workbench";
import { JobRunner } from "@mend/jobs";
import { SessionEngine } from "@mend/sessions";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { ProjectAccess } from "./access.ts";
import { Budgets } from "./budgets.ts";
import { budgetExceeded, requireSessionRoom } from "./session-budgets.ts";

/** The worktree and conversation to provision: the create route's payload, plus its origin. */
export interface CreateSessionInput {
  readonly harness: string;
  readonly label: string | null;
  /** An existing worktree name joins it; an unused one creates it; null derives one. */
  readonly name: string | null;
  /** Branch or sha to base the worktree on; null = the project's default branch. */
  readonly base: string | null;
  /** `mend` for the HTTP API, `slack` for a mention. Stamped on the session at provision. */
  readonly origin: SessionOrigin;
}

/** Provision, then launch: what Slack asks for in one step. */
export interface StartSessionInput {
  readonly projectId: ProjectId;
  readonly session: CreateSessionInput;
  readonly launch: LaunchRequest;
}

type StartError = NotFound | StoreFailure | BudgetExceeded;

/**
 * Starting a session, as a given account (docs/adr/0006-slack.md, "Slack starts sessions through
 * the same path as everyone else"). The HTTP routes call the two halves with the caller's id;
 * Slack calls `startAs` with the linked user's id. One implementation, one set of checks.
 *
 * `createAs` authorizes the project and the session budget before the worktree exists, so a
 * refusal leaves nothing behind. `launchAs` takes a session its caller already authorized to
 * steer: the HTTP route resolves it through `SessionSteering`, and `startAs` launches the session
 * it just provisioned for the same account, which owns it.
 */
export class SessionStart extends Context.Service<
  SessionStart,
  {
    readonly createAs: (
      userId: string,
      projectId: ProjectId,
      input: CreateSessionInput,
    ) => Effect.Effect<Session, StartError>;
    readonly launchAs: (
      userId: string,
      session: Session,
      input: LaunchRequest,
    ) => Effect.Effect<Session, StartError>;
    /** Project access, the session budget, provision, the launch slot, launch, the auto-namer. */
    readonly startAs: (
      userId: string,
      input: StartSessionInput,
    ) => Effect.Effect<Session, StartError>;
  }
>()("@mend/api/SessionStart") {}

/**
 * The implementation, over the services it reads. The HTTP handlers build it per request from
 * the services they are already given, so the routes need nothing they did not need before.
 */
export const makeSessionStart = Effect.gen(function* () {
  const access = yield* ProjectAccess;
  const engine = yield* SessionEngine;
  const budgets = yield* Budgets;
  const sessions = yield* SessionsRepo;
  const projects = yield* ProjectsRepo;
  const settingsRepo = yield* SettingsRepo;
  const jobs = yield* JobRunner;

  const createAs = Effect.fn("SessionStart.createAs")(function* (
    userId: string,
    projectId: ProjectId,
    input: CreateSessionInput,
  ) {
    const project = yield* access.projectAs(userId, projectId);
    // After authorization, before the worktree exists: a refusal leaves nothing behind.
    yield* requireSessionRoom(userId, project.organizationId).pipe(
      Effect.provideService(Budgets, budgets),
      Effect.provideService(SessionsRepo, sessions),
    );
    // Ownership is stamped at provision: launches apply the OWNER's dotfiles.
    return yield* engine
      .provision({
        projectId,
        harness: input.harness,
        label: input.label,
        name: input.name,
        base: input.base,
        ownerUserId: userId,
        origin: input.origin,
      })
      .pipe(
        Effect.catchTag("ProjectNotFoundError", () => Effect.fail(new NotFound({ id: projectId }))),
        Effect.catchTag("GitError", (error) =>
          Effect.fail(new StoreFailure({ message: error.stderr })),
        ),
        Effect.catchTag("WorktreeBaseConflictError", (error) =>
          Effect.fail(
            new StoreFailure({
              message: `worktree "${error.name}" is based on ${error.baseRef ?? "its pinned commit"} — joining with base "${error.requestedBase}" would silently re-base it; drop the base to join as it stands`,
            }),
          ),
        ),
      );
  });

  const launchAs = Effect.fn("SessionStart.launchAs")(function* (
    userId: string,
    session: Session,
    input: LaunchRequest,
  ) {
    if (input.mode === "protocol" && input.argv !== undefined) {
      return yield* new StoreFailure({
        message: "Protocol launches use the supported harness adapter and cannot take argv.",
      });
    }
    // Verbatim argv wins only for PTY mode. Protocol flags and turn settings are split by the
    // server because model and effort ride on provider turns, not the long-lived process argv.
    const argv = input.argv ?? composeLaunchArgv(session.harness, input);
    const prompt = input.prompt?.trim() ?? "";
    const inlineNamePrompt =
      input.argv === undefined && prompt !== "" && PROMPTABLE_HARNESSES.has(session.harness)
        ? prompt
        : null;
    // Session auto-naming: queue the namer at launch so a label appears in
    // lists while the session still runs. A composed start knows the first
    // prompt already, so the namer runs immediately on it; a bare launch
    // keeps the delayed first attempt + spaced retries that cover "the
    // user hasn't typed the first prompt yet". The worker re-checks
    // label/setting and no-ops when either changed. Best-effort — a
    // launch never fails because naming could not queue.
    const queueAutoName = Effect.gen(function* () {
      if (session.label !== null) return;
      const project = yield* projects.byId(session.projectId);
      const settings = yield* settingsRepo.get();
      if (!resolveAutomation(project.autoName, settings.autoName)) return;
      yield* jobs.enqueue({
        name: "name-session",
        payload:
          inlineNamePrompt === null
            ? { sessionId: session.id }
            : { sessionId: session.id, firstUserTurn: inlineNamePrompt },
        idempotencyKey: `name-session:${session.id}`,
        startAfterSeconds: inlineNamePrompt === null ? 45 : 0,
        retryDelaySeconds: 30,
        retryLimit: 6,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.annotateLogs(Effect.logWarning("auto-name enqueue failed; continuing"), {
          sessionId: session.id,
          cause: String(cause),
        }),
      ),
      Effect.asVoid,
    );
    // Inline naming has no transcript dependency and a first launch can
    // take minutes — enqueue before the launch so the label lands while
    // the workspace still provisions.
    if (inlineNamePrompt !== null) yield* queueAutoName;
    const launch =
      input.mode === "protocol"
        ? engine.launchProtocol(session.id, input, userId)
        : engine.launch(session.id, argv);
    // A launch holds a platform workspace build for minutes. One account starts a bounded
    // number at once; a launch already under way is never touched.
    const launched = yield* budgets.withLaunchSlot(
      userId,
      launch.pipe(
        Effect.tap(() => (inlineNamePrompt === null ? queueAutoName : Effect.void)),
        Effect.catchTag("SessionNotFoundError", () =>
          Effect.fail(new NotFound({ id: session.id })),
        ),
        Effect.catchTag("LegacyBenchReadOnlyError", () =>
          Effect.fail(new StoreFailure({ message: "Legacy bench sessions are review-only." })),
        ),
        Effect.catchTag("ProjectNotFoundError", () =>
          Effect.fail(new NotFound({ id: session.id })),
        ),
        Effect.catchTag("SealantPlatformError", (error) =>
          Effect.fail(new StoreFailure({ message: error.message })),
        ),
        Effect.catchTag("ProtocolHarnessUnsupportedError", (error) =>
          Effect.fail(new StoreFailure({ message: error.message })),
        ),
        Effect.catchTags({
          HarnessStateNotFoundError: (error) =>
            Effect.fail(new StoreFailure({ message: error.message })),
          HarnessStateIOError: (error) => Effect.fail(new StoreFailure({ message: error.message })),
          HarnessStateInvalidError: (error) =>
            Effect.fail(new StoreFailure({ message: error.message })),
          HarnessStateCommandError: (error) =>
            Effect.fail(new StoreFailure({ message: error.message })),
          SessionLaunchSetupError: (error) =>
            Effect.fail(new StoreFailure({ message: error.message })),
          DotfilesResolveError: (error) =>
            Effect.fail(new StoreFailure({ message: error.message })),
        }),
      ),
    );
    if (launched === null) {
      return yield* budgetExceeded("accountLaunchesInFlight", budgets.limits);
    }
    return launched;
  });

  const startAs = Effect.fn("SessionStart.startAs")(function* (
    userId: string,
    input: StartSessionInput,
  ) {
    const session = yield* createAs(userId, input.projectId, input.session);
    return yield* launchAs(userId, session, input.launch);
  });

  return { createAs, launchAs, startAs };
});

export const SessionStartLive: Layer.Layer<
  SessionStart,
  never,
  Budgets | JobRunner | ProjectAccess | ProjectsRepo | SessionEngine | SessionsRepo | SettingsRepo
> = Layer.effect(SessionStart, makeSessionStart);
