import type { SessionId, WorktreeId } from "@mend/domain";
import { Effect, Layer, Ref } from "effect";
import * as Context from "effect/Context";

/** Which session, in which worktree, an event is about. */
export interface WorkspaceGitEvent {
  readonly sessionId: SessionId;
  readonly worktreeId: WorktreeId;
}

/**
 * A turn ended that ran `gh pr create`: the pull request URLs the turn named, and when it started.
 */
export interface PullRequestOpenedEvent extends WorkspaceGitEvent {
  readonly urls: ReadonlyArray<string>;
  readonly since: Date;
}

/** What runs when the engine reports an event; the worker registers them. */
export interface WorkspaceGitHandlers {
  readonly branchesPushed: (event: WorkspaceGitEvent) => Effect.Effect<void>;
  readonly agentEnded: (event: WorkspaceGitEvent) => Effect.Effect<void>;
  readonly pullRequestOpened: (event: PullRequestOpenedEvent) => Effect.Effect<void>;
}

/**
 * What `mend land` inside a workspace came to, as the helper prints it: the landing's lines, or
 * why it did not land. `landed` is false for a refusal or a landing that did not finish.
 */
export interface WorkspaceLandOutcome {
  readonly landed: boolean;
  readonly lines: ReadonlyArray<string>;
}

/** What answers `mend land`; the landing worker registers it. */
export type WorkspaceLandHandler = (sessionId: SessionId) => Effect.Effect<WorkspaceLandOutcome>;

const NO_LANDING: WorkspaceLandOutcome = {
  landed: false,
  lines: ["not landed · this Mend server does not land from a workspace"],
};

/**
 * Moments in a workspace's git life that other parts of Mend act on without the engine knowing
 * them (docs/adr/0007-landing.md, "Pull requests opened outside Mend"): the agent pushed branches
 * through the transport, an agent ended while its workspace is still up, the last moment `gh`
 * can run in it, and a turn ended that ran `gh pr create`. The engine reports; whoever registered handlers acts (the landing worker, which
 * depends on the engine and so cannot be one of its dependencies). With nothing registered, a
 * report does nothing.
 */
export class WorkspaceGitHooks extends Context.Service<
  WorkspaceGitHooks,
  {
    readonly branchesPushed: (event: WorkspaceGitEvent) => Effect.Effect<void>;
    readonly agentEnded: (event: WorkspaceGitEvent) => Effect.Effect<void>;
    readonly pullRequestOpened: (event: PullRequestOpenedEvent) => Effect.Effect<void>;
    /** Replaces whatever was registered before. */
    readonly register: (handlers: WorkspaceGitHandlers) => Effect.Effect<void>;
    /**
     * The agent ran `mend land` in the session's workspace (docs/adr/0007-landing.md,
     * "Surfaces"): land the change as its owner, as the Land panel does, and say how it ended.
     * With nothing registered, it lands nothing and says so.
     */
    readonly landRequested: (sessionId: SessionId) => Effect.Effect<WorkspaceLandOutcome>;
    /** Replaces whatever answered `mend land` before. */
    readonly registerLanding: (handler: WorkspaceLandHandler) => Effect.Effect<void>;
  }
>()("@mend/sessions/WorkspaceGitHooks") {}

export const WorkspaceGitHooksLive: Layer.Layer<WorkspaceGitHooks> = Layer.effect(
  WorkspaceGitHooks,
  Effect.gen(function* () {
    const registered = yield* Ref.make<WorkspaceGitHandlers | null>(null);
    const landing = yield* Ref.make<WorkspaceLandHandler | null>(null);
    return {
      branchesPushed: (event) =>
        Effect.flatMap(Ref.get(registered), (handlers) =>
          handlers === null ? Effect.void : handlers.branchesPushed(event),
        ),
      agentEnded: (event) =>
        Effect.flatMap(Ref.get(registered), (handlers) =>
          handlers === null ? Effect.void : handlers.agentEnded(event),
        ),
      pullRequestOpened: (event) =>
        Effect.flatMap(Ref.get(registered), (handlers) =>
          handlers === null ? Effect.void : handlers.pullRequestOpened(event),
        ),
      register: (handlers) => Ref.set(registered, handlers),
      landRequested: (sessionId) =>
        Effect.flatMap(Ref.get(landing), (handler) =>
          handler === null ? Effect.succeed(NO_LANDING) : handler(sessionId),
        ),
      registerLanding: (handler) => Ref.set(landing, handler),
    };
  }),
);
