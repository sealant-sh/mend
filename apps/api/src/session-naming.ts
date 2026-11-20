import { AgentConversationRepo, ProjectsRepo, SessionsRepo, SettingsRepo } from "@mend/db";
import type { SessionId } from "@mend/domain";
import { requestOfTurn, resolveAutomation } from "@mend/domain/workbench";
import { type NameSessionJob, SessionNamer, withoutFirstPrompt } from "@mend/inference";
import { JobRunner } from "@mend/jobs";
import { SessionEngine } from "@mend/sessions";
import { Cause, Effect } from "effect";

/** Harnesses whose native transcript the engine can parse for the first prompt. */
const NAMEABLE_HARNESSES: ReadonlySet<string> = new Set(["claude", "codex"]);

/**
 * The first message the session was sent, as Mend recorded it: the first turn Mend sent it, without
 * what Mend added (the landing guard). Null for a session nobody sent a message through Mend (a
 * terminal session typed into), whose first prompt only its transcript holds.
 */
const firstPromptFromRecord = Effect.fn("firstPromptFromRecord")(function* (sessionId: SessionId) {
  const [first] = yield* (yield* AgentConversationRepo).firstMessages([sessionId]);
  const text = first === undefined ? "" : requestOfTurn(first.input).trim();
  return text === "" ? null : text;
});

/**
 * The first prompt from the harness's own transcript, for a session Mend sent nothing: retried
 * (the job dies into its retry) until the person types it, and given up once the session settled
 * without one.
 */
const firstPromptFromTranscript = Effect.fn("firstPromptFromTranscript")(function* (
  job: NameSessionJob,
  session: { readonly settledAt: Date | null },
) {
  const transcript = yield* (yield* SessionEngine)
    .transcript(job.sessionId)
    .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
  const events = transcript?.events ?? [];
  const firstUserAt = events.findIndex((event) => event.kind === "user");
  const firstUser = firstUserAt === -1 ? undefined : events[firstUserAt];
  if (firstUser === undefined || firstUser.kind !== "user") {
    // A settled session gets no first prompt any more: it stays unnamed, and the job ends
    // here instead of retrying for an hour into the dead letter.
    if (withoutFirstPrompt(session) === "leave-unnamed") return null;
    // Retryable by design: the user has not typed the first prompt yet.
    return yield* Effect.die(new Error("no first prompt in the transcript yet — retrying"));
  }
  const reply = events
    .slice(firstUserAt + 1)
    .find((event): event is typeof event & { kind: "assistant" } => event.kind === "assistant");
  return {
    firstUserTurn: firstUser.text,
    ...(reply === undefined ? {} : { assistantReply: reply.text }),
  };
});

/**
 * The `name-session` job's pass. The first prompt comes from the job (a composed start), else from
 * Mend's own record of the first message sent (a session started bare, then sent a message from a
 * composer, the CLI or VS Code), else from the harness's transcript (a terminal session typed
 * into). Every no-name outcome besides "no prompt yet" is a quiet success: a renamed or deleted
 * session, a switched-off cascade, an unparseable harness on the transcript path.
 */
export const nameSession = Effect.fn("nameSession")(function* (job: NameSessionJob) {
  const sessions = yield* SessionsRepo;
  const session = yield* sessions
    .byId(job.sessionId)
    .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
  if (session === null || session.label !== null) return;
  const inlinePrompt = job.firstUserTurn?.trim() ?? "";
  const firstPrompt =
    inlinePrompt === "" ? yield* firstPromptFromRecord(job.sessionId) : inlinePrompt;
  // The harness gate guards only transcript parsing: a prompt Mend saw names any harness,
  // opencode and shell included.
  if (firstPrompt === null && !NAMEABLE_HARNESSES.has(session.harness)) return;
  const project = yield* (yield* ProjectsRepo)
    .byId(session.projectId)
    .pipe(Effect.catchTag("ProjectNotFoundError", () => Effect.succeed(null)));
  if (project === null) return;
  // The project's choice, else the session owner's own, else their organization's.
  const settings = yield* (yield* SettingsRepo).forPerson(
    project.organizationId,
    session.ownerUserId,
  );
  if (!resolveAutomation(project.autoName, settings.autoName)) return;

  const turns =
    firstPrompt === null
      ? yield* firstPromptFromTranscript(job, session)
      : { firstUserTurn: firstPrompt };
  if (turns === null) {
    yield* Effect.logInfo("session left unnamed · it settled without a first prompt").pipe(
      Effect.annotateLogs({ sessionId: job.sessionId, status: session.status }),
    );
    return;
  }

  const label = yield* (yield* SessionNamer).name({
    harness: session.harness,
    projectName: project.name,
    ...turns,
  });
  const wrote = yield* sessions.setLabelIfUnset(job.sessionId, label);
  yield* Effect.annotateLogs(Effect.logInfo("session named"), {
    sessionId: job.sessionId,
    label,
    wrote,
  });
});

/**
 * A message reached an unnamed session: queue its namer now, as a composed start does, so it is
 * named from the message (`nameSession` reads it from Mend's record) instead of waiting on the
 * launch's job, which starts late and stops retrying after a few minutes. Its own key, so the
 * launch's job, still waiting, doesn't absorb it; whichever runs second finds the label set and
 * does nothing. Best-effort: a send never fails because naming could not queue.
 */
export const nameOnMessage = (session: {
  readonly id: SessionId;
  readonly label: string | null;
}): Effect.Effect<void, never, JobRunner> =>
  session.label !== null
    ? Effect.void
    : Effect.gen(function* () {
        yield* (yield* JobRunner).enqueue({
          name: "name-session",
          payload: { sessionId: session.id },
          idempotencyKey: `name-session:${session.id}:message`,
          retryDelaySeconds: 30,
          retryLimit: 3,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("auto-name enqueue on a message failed; continuing").pipe(
            Effect.annotateLogs({ sessionId: session.id, cause: Cause.pretty(cause) }),
          ),
        ),
      );
