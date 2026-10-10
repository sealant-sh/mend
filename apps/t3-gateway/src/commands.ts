import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  OrchestrationV2DispatchCommandError,
  type OrchestrationV2Command,
  type OrchestrationV2DispatchCommandResult,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";

import type { PersonHub, ThreadCommandFailure } from "./hub.ts";
import type { MendRequestResponse } from "./mend-client.ts";
import type { BearerSession } from "./state.ts";

/**
 * `orchestration.dispatchCommand` (ADR 0012, "The surface", phase 1): the commands Mend can back,
 * each through the person's hub, and every other command refused with the method's own typed
 * error, naming the command.
 *
 * - `message.dispatch`: queued by the gateway and sent as a turn once nothing is open, or as the
 *   opening turn of a relaunch when the session's agent has stopped.
 * - `run.interrupt`, `queued-run.cancel`, `queue.resume`: Mend's interrupt and the gateway's queue.
 * - `queued-run.edit`, `queued-run.reorder`: a message still waiting in the gateway's queue; one on
 *   its way to Mend is never rewritten.
 * - `runtime-request.respond`, `thread.user-input.dismiss`: Mend's request answers; a dismissal
 *   answers `cancel`.
 * - `thread.metadata.update` with only a title: the session's name in Mend (its owner's to set).
 * - `provider-session.detach`: Mend's stop. t3code sends it before deleting a thread with a live
 *   agent; what is still queued is held.
 * - `thread.delete`: Mend's delete, after a stop when Mend says the session is live. The worktree
 *   and its change stay in Mend.
 */

/** t3code's approval decisions as Mend's; Mend has no "always", so it is "for this session". */
export const mendDecisionOf = (
  decision: ProviderApprovalDecision,
): "accept" | "accept-for-session" | "decline" | "cancel" => {
  switch (decision) {
    case "accept":
      return "accept";
    case "acceptForSession":
    case "acceptAlways":
      return "accept-for-session";
    case "decline":
      return "decline";
    case "cancel":
      return "cancel";
  }
};

const answerValues = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return value.length === 0 ? [] : [value];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => (typeof entry === "string" ? [entry] : answerValues(entry)));
  }
  if (typeof value === "object" && value !== null) {
    if ("answers" in value) return answerValues(value.answers);
    if ("value" in value) return answerValues(value.value);
    if ("label" in value) return answerValues(value.label);
  }
  return typeof value === "number" || typeof value === "boolean" ? [String(value)] : [];
};

/** t3code's answers (a string, a list, or an object per question) as Mend's lists of strings. */
export const mendAnswersOf = (
  answers: ProviderUserInputAnswers,
): Readonly<Record<string, ReadonlyArray<string>>> =>
  Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => [questionId, answerValues(value)]),
  );

type DispatchFailure = OrchestrationV2DispatchCommandError | EnvironmentAuthorizationError;

export const dispatchCommand = (
  hub: PersonHub,
  session: BearerSession,
  command: OrchestrationV2Command,
): Effect.Effect<OrchestrationV2DispatchCommandResult, DispatchFailure> => {
  const refuse = (message: string) =>
    Effect.fail(
      new OrchestrationV2DispatchCommandError({
        commandId: command.commandId,
        commandType: command.type,
        message,
      }),
    );

  /** Not theirs to steer is t3code's authorization error; anything else is the command's. */
  const failed = (error: ThreadCommandFailure): DispatchFailure =>
    (error._tag === "ThreadCommandRefused" && error.authorization) ||
    error._tag === "MendDeviceRefused"
      ? new EnvironmentAuthorizationError({
          message: error.message,
          requiredScope: AuthOrchestrationOperateScope,
        })
      : new OrchestrationV2DispatchCommandError({
          commandId: command.commandId,
          commandType: command.type,
          message: error.message,
          cause: error,
        });

  const answered = (effect: Effect.Effect<number, ThreadCommandFailure>) =>
    effect.pipe(
      Effect.map((sequence) => ({ sequence })),
      Effect.mapError(failed),
    );

  const respond = (threadId: string, requestId: string, response: MendRequestResponse) =>
    answered(hub.commands.respond({ session, threadId, requestId, response }));

  // The socket's own device token, checked on every command: a revoked device steers nothing.
  if (hub.isRefused(session.deviceToken)) {
    return Effect.fail(
      new EnvironmentAuthorizationError({
        message: "Mend no longer accepts this device. Pair again from Mend.",
        requiredScope: AuthOrchestrationOperateScope,
      }),
    );
  }
  if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
    return Effect.fail(
      new EnvironmentAuthorizationError({
        message: `The authenticated token is missing required scope: ${AuthOrchestrationOperateScope}.`,
        requiredScope: AuthOrchestrationOperateScope,
      }),
    );
  }

  switch (command.type) {
    case "message.dispatch": {
      if (command.attachments.length > 0) {
        return refuse("Mend's t3code gateway does not send images or files yet.");
      }
      const mode = command.dispatchMode.type;
      if (mode === "steer_active" || mode === "restart_active") {
        return refuse(
          "Mend cannot steer a turn while it runs. Send the message to run after it instead.",
        );
      }
      if (mode === "defer_start") {
        return refuse("Mend's t3code gateway does not hold a message back for later.");
      }
      if (command.text.trim().length === 0) return refuse("The message is empty.");
      return answered(
        hub.commands.send({
          session,
          threadId: command.threadId,
          commandId: command.commandId,
          messageId: command.messageId,
          text: command.text,
        }),
      );
    }
    case "run.interrupt":
      return answered(
        hub.commands.interrupt({
          session,
          threadId: command.threadId,
          runId: command.runId,
          holdQueue: command.holdQueue === true,
        }),
      );
    case "queued-run.cancel":
      return answered(hub.commands.cancelQueued(command.threadId, command.runId));
    case "queue.resume":
      return answered(hub.commands.resumeQueue(command.threadId));
    case "queued-run.edit":
      if (command.attachments !== undefined && command.attachments.length > 0) {
        return refuse("Mend's t3code gateway does not send images or files yet.");
      }
      if (command.text.trim().length === 0) return refuse("The message is empty.");
      return answered(hub.commands.editQueued(command.threadId, command.runId, command.text));
    case "queued-run.reorder":
      return answered(
        hub.commands.reorderQueued(command.threadId, command.runId, command.beforeRunId),
      );
    case "runtime-request.respond":
      if (command.decision !== undefined) {
        return respond(command.threadId, command.requestId, {
          decision: mendDecisionOf(command.decision),
        });
      }
      if (command.answers !== undefined) {
        return respond(command.threadId, command.requestId, {
          answers: mendAnswersOf(command.answers),
        });
      }
      return refuse("An answer needs a decision or answers.");
    case "thread.user-input.dismiss":
      return respond(command.threadId, command.requestId, { decision: "cancel" });
    case "thread.metadata.update": {
      // Only the name moves through Mend; the branch and worktree are Mend's, and so are titles.
      const { threadId, title } = command;
      const others = [
        command.regenerateTitle === true ? true : undefined,
        command.branch,
        command.worktreePath,
        command.expectedWorktreePath,
        command.expectedEmpty,
        command.limitRecovery,
        command.linkedPullRequest,
      ];
      if (title === undefined || others.some((value) => value !== undefined)) {
        return refuse(
          "Mend's t3code gateway renames a thread and nothing else: its branch, worktree and pull request are Mend's.",
        );
      }
      return answered(hub.commands.rename({ session, threadId, title }));
    }
    case "provider-session.detach":
      return answered(hub.commands.stop({ session, threadId: command.threadId }));
    case "thread.delete":
      return answered(hub.commands.remove({ session, threadId: command.threadId }));
    default:
      return refuse(`Mend's t3code gateway does not accept ${command.type}.`);
  }
};
