import type { SessionId, WorktreeId } from "@mend/domain";
import { Effect, Layer, Ref } from "effect";
import * as Context from "effect/Context";

/** Which session, in which worktree, an event is about. */
export interface WorkspaceGitEvent {
  readonly sessionId: SessionId;
  readonly worktreeId: WorktreeId;
}

/** What runs when the engine reports an event; the worker registers them. */
export interface WorkspaceGitHandlers {
  readonly branchesPushed: (event: WorkspaceGitEvent) => Effect.Effect<void>;
  readonly agentEnded: (event: WorkspaceGitEvent) => Effect.Effect<void>;
}

/**
 * Moments in a workspace's git life that other parts of Mend act on without the engine knowing
 * them (docs/adr/0007-landing.md, "Pull requests opened outside Mend"): the agent pushed branches
 * through the transport, and an agent ended while its workspace is still up, the last moment `gh`
 * can run in it. The engine reports; whoever registered handlers acts (the landing worker, which
 * depends on the engine and so cannot be one of its dependencies). With nothing registered, a
 * report does nothing.
 */
export class WorkspaceGitHooks extends Context.Service<
  WorkspaceGitHooks,
  {
    readonly branchesPushed: (event: WorkspaceGitEvent) => Effect.Effect<void>;
    readonly agentEnded: (event: WorkspaceGitEvent) => Effect.Effect<void>;
    /** Replaces whatever was registered before. */
    readonly register: (handlers: WorkspaceGitHandlers) => Effect.Effect<void>;
  }
>()("@mend/sessions/WorkspaceGitHooks") {}

export const WorkspaceGitHooksLive: Layer.Layer<WorkspaceGitHooks> = Layer.effect(
  WorkspaceGitHooks,
  Effect.gen(function* () {
    const registered = yield* Ref.make<WorkspaceGitHandlers | null>(null);
    return {
      branchesPushed: (event) =>
        Effect.flatMap(Ref.get(registered), (handlers) =>
          handlers === null ? Effect.void : handlers.branchesPushed(event),
        ),
      agentEnded: (event) =>
        Effect.flatMap(Ref.get(registered), (handlers) =>
          handlers === null ? Effect.void : handlers.agentEnded(event),
        ),
      register: (handlers) => Ref.set(registered, handlers),
    };
  }),
);
