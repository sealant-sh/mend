import {
  BudgetExceeded,
  HarnessLayoutRefused,
  LaunchRequest,
  NotFound,
  StoreFailure,
} from "@mend/api-contracts";
import {
  AgentConversationRepo,
  HarnessModelsRepo,
  ProjectsRepo,
  SessionsRepo,
  SettingsRepo,
} from "@mend/db";
import type { ProjectId } from "@mend/domain";
import {
  composeLaunchArgv,
  PROMPTABLE_HARNESSES,
  resolveAutoLand,
  resolveAutomation,
  resolveLaunchOptions,
  withLandingGuard,
  type HarnessLayout,
  type Session,
  type SessionOrigin,
} from "@mend/domain/workbench";
import { JobRunner } from "@mend/jobs";
import { SessionEngine } from "@mend/sessions";
import { Duration, Effect, Fiber, Layer, Option } from "effect";
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
  /**
   * The session's own "Land when a turn completes" (docs/adr/0007-landing.md): `--land` /
   * `--no-land`, or a Slack request's `autopr=`. Absent or null follows the project.
   */
  readonly autoLand?: boolean | null;
  /**
   * The instance operator's layout for a worktree this start creates (docs/adr/0016, decision
   * 14). Refused for anyone else, and on an existing worktree whose layout differs.
   */
  readonly harnessLayout?: HarnessLayout;
}

/**
 * How long `POST /sessions/:id/launch` waits for the launch before it answers with the session as
 * it stands (docs/adr/0002, "A launch answers promptly"). A launch that has not reached its agent
 * by then goes on in the background: the session reads `starting`, its summary says where the
 * launch stands (`waiting · the previous session in this worktree is saving`, `building the
 * workspace image …`, `booting`), and it moves to `running` or settles `failed` with the reason.
 */
export const LAUNCH_ANSWER_WINDOW = Duration.seconds(30);

/** How a caller of `launchAs` waits. */
export interface LaunchAnswer {
  /**
   * Answer with the session as it stands once this has passed; the launch goes on. Absent: wait
   * for the launch to end, whatever it takes (Slack, which reports through its own messages).
   */
  readonly within?: Duration.Duration;
}

/** Provision, then launch: what Slack asks for in one step. */
export interface StartSessionInput {
  readonly projectId: ProjectId;
  readonly session: CreateSessionInput;
  readonly launch: LaunchRequest;
}

type StartError = NotFound | StoreFailure | BudgetExceeded | HarnessLayoutRefused;

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
      answer?: LaunchAnswer,
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
  const conversations = yield* AgentConversationRepo;
  const harnessModels = yield* HarnessModelsRepo;

  /**
   * Whether the session's opening turn carries the prompt guard (docs/adr/0007-landing.md,
   * "Questions do not open pull requests"): every Slack request, and any session that lands by
   * itself. Only the opening turn does: a resumed conversation heard it already.
   */
  const guardsLanding = Effect.fn("SessionStart.guardsLanding")(function* (session: Session) {
    if (session.origin !== "slack") {
      const project = yield* projects.byId(session.projectId);
      const settings = yield* settingsRepo.forOrganization(project.organizationId);
      const on = resolveAutoLand({
        origin: session.origin,
        project: project.autoLand,
        settings: settings.autoLand,
        session: session.autoLand,
        slack: false,
      });
      if (!on) return false;
    }
    return (yield* conversations.listTurns(session.id)).length === 0;
  });

  const createAs = Effect.fn("SessionStart.createAs")(function* (
    userId: string,
    projectId: ProjectId,
    input: CreateSessionInput,
  ) {
    const project = yield* access.projectAs(userId, projectId);
    // The harness layout is the operator's to choose, for the benchmark (docs/adr/0016).
    if (input.harnessLayout !== undefined && !(yield* access.isOperator(userId))) {
      return yield* new HarnessLayoutRefused({
        message: "harnessLayout is for the instance operator; start the session without it",
      });
    }
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
        autoLand: input.autoLand ?? null,
        ...(input.harnessLayout === undefined ? {} : { harnessLayout: input.harnessLayout }),
      })
      .pipe(
        Effect.catchTag("HarnessLayoutNotAppliedError", (error) =>
          Effect.fail(new HarnessLayoutRefused({ message: error.message })),
        ),
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

  /**
   * A launch that failed after its caller was answered, and left the session reading `starting`
   * with nothing asked of the platform (no workspace, no run, no create on record): the session
   * says why, instead of `starting` for good. Anything that did reach the platform is the engine's
   * to settle (its own failure paths, the reaper for a create whose answer was lost).
   */
  const settleUnlaunched = Effect.fn("SessionStart.settleUnlaunched")(function* (
    session: Session,
    message: string,
  ) {
    const current = yield* sessions
      .byId(session.id)
      .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
    if (
      current === null ||
      current.status !== "starting" ||
      current.settledAt !== null ||
      current.sealantWorkspaceId !== null ||
      current.sealantRunId !== null ||
      (yield* sessions.executorCreateOf(session.id)) !== null
    ) {
      return;
    }
    yield* sessions.settle(session.id, "failed", `launch failed: ${message}`);
  });

  const launchAs = Effect.fn("SessionStart.launchAs")(function* (
    userId: string,
    session: Session,
    request: LaunchRequest,
    answer: LaunchAnswer = {},
  ) {
    if (request.mode === "protocol" && request.argv !== undefined) {
      return yield* new StoreFailure({
        message: "Protocol launches use the supported harness adapter and cannot take argv.",
      });
    }
    // The model and effort the session runs on (docs/models-audit.md): the request's, else what
    // the session was started with (a Slack follow-up relaunching a settled session names none),
    // else the harness's catalog default; the effort clamped to what that model takes. A verbatim
    // argv is the person's own command and names its own model, so nothing is resolved for it.
    const resolved =
      request.argv === undefined
        ? resolveLaunchOptions(yield* harnessModels.forHarness(session.harness), {
            model: request.model ?? session.model,
            effort: request.effort ?? session.effort,
          })
        : null;
    const input: LaunchRequest =
      resolved === null
        ? request
        : new LaunchRequest({
            ...request,
            ...(resolved.model === null ? { model: undefined } : { model: resolved.model }),
            ...(resolved.effort === null ? { effort: undefined } : { effort: resolved.effort }),
          });
    // Verbatim argv wins only for PTY mode. Protocol flags and turn settings are split by the
    // server because model and effort ride on provider turns, not the long-lived process argv.
    const argv = input.argv ?? composeLaunchArgv(session.harness, input);
    const prompt = input.prompt?.trim() ?? "";
    // The protocol opening turn is the one Mend composes; a PTY argv is the person's own.
    const guarded =
      input.mode === "protocol" &&
      prompt !== "" &&
      (yield* guardsLanding(session).pipe(
        Effect.catchTag("ProjectNotFoundError", () => Effect.succeed(false)),
      ));
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
      const settings = yield* settingsRepo.forOrganization(project.organizationId);
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
    // Recorded once the launch is admitted, never for one the slot refuses. A protocol launch
    // records inside the engine, after its own live-agent check; a PTY launch here. A verbatim
    // argv names its own flags, which Mend did not resolve: the row says so with null.
    const launch =
      input.mode === "protocol"
        ? engine.launchProtocol(
            session.id,
            guarded ? { ...input, prompt: withLandingGuard(prompt) } : input,
            userId,
          )
        : sessions
            .setLaunchOptions(session.id, resolved ?? { model: null, effort: null })
            .pipe(Effect.andThen(engine.launch(session.id, argv)));
    // A launch holds a platform workspace build for minutes. One account starts a bounded
    // number at once; a launch already under way is never touched. The slot is held for the
    // launch's whole course, in the background too: it is taken and given back inside the
    // detached fiber, never by the caller's answer.
    const running = budgets.withLaunchSlot(
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
        Effect.tapError((error) =>
          error._tag === "StoreFailure"
            ? settleUnlaunched(session, error.message).pipe(Effect.ignore)
            : Effect.void,
        ),
      ),
    );
    // Detached from the caller: a client that goes away, or an answer given before the launch
    // ended, never cuts the launch short.
    const fiber = yield* engine.detach(running);
    const answered =
      answer.within === undefined
        ? Option.some(yield* Fiber.join(fiber))
        : yield* Fiber.join(fiber).pipe(Effect.timeoutOption(answer.within));
    if (Option.isNone(answered)) {
      // Still under way: the session as it stands, which says where the launch is.
      return yield* sessions
        .byId(session.id)
        .pipe(
          Effect.catchTag("SessionNotFoundError", () =>
            Effect.fail(new NotFound({ id: session.id })),
          ),
        );
    }
    if (answered.value === null) {
      return yield* budgetExceeded("accountLaunchesInFlight", budgets.limits);
    }
    return answered.value;
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
  | AgentConversationRepo
  | Budgets
  | HarnessModelsRepo
  | JobRunner
  | ProjectAccess
  | ProjectsRepo
  | SessionEngine
  | SessionsRepo
  | SettingsRepo
> = Layer.effect(SessionStart, makeSessionStart);
