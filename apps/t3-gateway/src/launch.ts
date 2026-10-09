import { randomUUID } from "node:crypto";

import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  OrchestrationV2ThreadLaunchError,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadLaunchResult,
  ThreadId,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";

import type { PersonHub, ThreadCommandFailure, ThreadLaunch } from "./hub.ts";
import { FAST_SERVICE_TIER, harnessOfInstance, SERVICE_TIER_OPTION_ID } from "./server-config.ts";
import type { BearerSession, ThreadLaunchOptions } from "./state.ts";

/**
 * `orchestration.launchThread` (ADR 0012, "The surface", phase 2): a new Mend session the person
 * owns, launched in protocol mode. t3code calls it for the first message of a new thread.
 *
 * - The session is created as the person who paired (`POST /api/projects/:id/sessions`), so Mend
 *   records them as its owner and origin `mend`, and its agent runs as them (docs/adr/0016).
 * - `worktree` starts a new worktree from `baseRef`; `existing_worktree` joins the worktree of a
 *   session of the project, by its name. `root` is refused: every Mend session has a worktree.
 * - The model, its reasoning effort and service tier, and the runtime mode (`full-access` is
 *   `bypass`, `approval-required` is `ask`) are what every launch of the thread names.
 * - The opening message is queued by the gateway like a follow-up: the run is `preparing` while the
 *   session launches, and the message is sent as an exact turn once the agent runs.
 * - A retry of the same command is the same thread (`resumed`).
 */

/** The reasoning efforts Mend's launch takes (`LaunchRequest.effort` in @mend/api-contracts). */
const MEND_EFFORTS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

/** A name Mend accepts for a worktree (`WorktreeName` in @mend/api-contracts). */
const WORKTREE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The worktree name a t3code branch suggests: its last segment, lower-cased, with anything Mend
 * does not take as a dash. Null when nothing usable is left; Mend then names the worktree.
 */
export const worktreeNameOf = (branch: string | undefined): string | null => {
  if (branch === undefined) return null;
  const last = branch.split("/").at(-1) ?? "";
  const name = last
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64)
    .replace(/[-.]+$/, "");
  return WORKTREE_NAME.test(name) ? name : null;
};

export type LaunchPlan =
  | { readonly kind: "launch"; readonly launch: Omit<ThreadLaunch, "session"> }
  | { readonly kind: "refused"; readonly message: string };

const refusedPlan = (message: string): LaunchPlan => ({ kind: "refused", message });

/** Mend's own longest session name (the namer's `MAX_LABEL_LENGTH`). */
export const MEND_LABEL_LIMIT = 60;
/** The name of a launched thread with neither a title nor words. */
const UNNAMED_LABEL = "t3code thread";

/**
 * A session label from text: its first line with words, whitespace collapsed, cut to Mend's limit
 * on its own; null when the text has no words.
 */
export const labelOf = (text: string): string | null => {
  const line = text
    .split("\n")
    .map((candidate) => candidate.replace(/\s+/g, " ").trim())
    .find((candidate) => candidate.length > 0);
  if (line === undefined) return null;
  return line.length <= MEND_LABEL_LIMIT ? line : line.slice(0, MEND_LABEL_LIMIT).trimEnd();
};

/** What a launch input asks of Mend, or why Mend cannot do it. */
export const planLaunch = (input: OrchestrationV2ThreadLaunchInput): LaunchPlan => {
  const strategy = input.workspaceStrategy;
  if (strategy.type === "root") {
    return refusedPlan(
      "Every Mend session works in a worktree of its own. Start the thread in a new worktree, or in one a session of this project already uses.",
    );
  }
  const provider = harnessOfInstance(input.modelSelection.instanceId);
  if (provider === null) {
    return refusedPlan(
      `Mend runs Codex and Claude sessions; it has no ${input.modelSelection.instanceId} provider.`,
    );
  }
  const permissionMode =
    input.runtimeMode === "full-access"
      ? "bypass"
      : input.runtimeMode === "approval-required"
        ? "ask"
        : null;
  if (permissionMode === null) {
    return refusedPlan(
      "Mend runs a session either asking for approval or with full access; it has nothing in between.",
    );
  }
  const message = input.initialMessage;
  if (message !== undefined && message.attachments.length > 0) {
    return refusedPlan("Mend's t3code gateway does not send images or files yet.");
  }
  const selections = input.modelSelection.options ?? [];
  const effort = selections.find((option) => option.id === provider.effortOptionId)?.value;
  const tier = selections.find((option) => option.id === SERVICE_TIER_OPTION_ID)?.value;
  const options: ThreadLaunchOptions = {
    model: input.modelSelection.model,
    ...(typeof effort === "string" && MEND_EFFORTS.has(effort) ? { effort } : {}),
    permissionMode,
    ...(tier === FAST_SERVICE_TIER ? { speed: "fast" as const } : {}),
  };
  const text = message?.text ?? "";
  return {
    kind: "launch",
    launch: {
      commandId: input.commandId,
      threadId: input.threadId ?? null,
      projectId: input.projectId,
      harness: provider.harness,
      // A launched session is never unnamed: a title t3code asks to generate starts as the first
      // line of the first message; a title the client generates later renames it (#591).
      label:
        labelOf(input.generateTitle === true ? text : input.title) ??
        labelOf(input.title) ??
        labelOf(text) ??
        UNNAMED_LABEL,
      workspace:
        strategy.type === "worktree"
          ? { kind: "new", base: strategy.baseRef, name: worktreeNameOf(strategy.branch) }
          : { kind: "join", worktreePath: strategy.worktreePath },
      options,
      message:
        message === undefined || text.trim().length === 0
          ? null
          : { messageId: message.messageId ?? `t3-message:${randomUUID()}`, text },
    },
  };
};

type LaunchFailure = OrchestrationV2ThreadLaunchError | EnvironmentAuthorizationError;

const authorization = (message: string) =>
  new EnvironmentAuthorizationError({ message, requiredScope: AuthOrchestrationOperateScope });

export const launchThread = (
  hub: PersonHub,
  session: BearerSession,
  input: OrchestrationV2ThreadLaunchInput,
): Effect.Effect<OrchestrationV2ThreadLaunchResult, LaunchFailure> => {
  const refuse = (message: string, cause?: unknown) =>
    new OrchestrationV2ThreadLaunchError({
      commandId: input.commandId,
      projectId: input.projectId,
      message,
      ...(cause === undefined ? {} : { cause }),
    });
  /** Not theirs is t3code's authorization error; anything else is the launch's. */
  const failed = (error: ThreadCommandFailure): LaunchFailure =>
    (error._tag === "ThreadCommandRefused" && error.authorization) ||
    error._tag === "MendDeviceRefused"
      ? authorization(error.message)
      : refuse(error.message, error);

  if (hub.isRefused(session.deviceToken)) {
    return Effect.fail(authorization("Mend no longer accepts this device. Pair again from Mend."));
  }
  if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
    return Effect.fail(
      authorization(
        `The authenticated token is missing required scope: ${AuthOrchestrationOperateScope}.`,
      ),
    );
  }
  const plan = planLaunch(input);
  if (plan.kind === "refused") return Effect.fail(refuse(plan.message));

  return Effect.gen(function* () {
    const launched = yield* hub.commands
      .launch({ ...plan.launch, session })
      .pipe(Effect.mapError(failed));
    const snapshot = yield* hub.threadSnapshot(launched.threadId).pipe(Effect.mapError(failed));
    if (snapshot === null) {
      return yield* refuse(
        "Mend created the session, but it is not a thread this environment shows yet.",
      );
    }
    const result: OrchestrationV2ThreadLaunchResult = {
      threadId: ThreadId.make(launched.threadId),
      projection: snapshot.projection,
      resumed: launched.resumed,
    };
    return result;
  });
};
