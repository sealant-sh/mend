import { ProjectsRepo } from "@mend/db";
import type { ProjectId } from "@mend/domain";
import { redactUrlCredentials } from "@mend/domain/workbench";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

/**
 * The remotes of a captured workspace's repository. A session in capture mode works in a
 * repository sealantd builds itself — `git init`, then the head capture's packs — and a remote is
 * configuration of Mend's own store, which never travels in a capture. Without this the
 * repository has no `origin`, and `git push origin` inside a session fails before it reaches the
 * git transport. `plan.get` names them and sealantd sets them (sealantd ADR-0015, "Remotes of
 * the worktree"), at boot and at every re-plan.
 *
 * Only the name and the URL travel. The credential stays here: git's ssh inside the workspace is
 * the transport shim, and Mend signs on this machine (docs/GIT-ACCESS.md).
 */
export interface PlanRemote {
  readonly name: string;
  readonly url: string;
}

export class CaptureRemotes extends Context.Service<
  CaptureRemotes,
  {
    /** The project's remotes. Never fails: a project that cannot be read names none. */
    readonly forProject: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<PlanRemote>>;
  }
>()("@mend/sessions/CaptureRemotes") {}

/** No remotes travel (tests of the routes alone). */
export const CaptureRemotesOff: Layer.Layer<CaptureRemotes> = Layer.succeed(CaptureRemotes, {
  forProject: () => Effect.succeed([]),
});

/**
 * The URL as the workspace may hold it, and as an exec's argv or a log line may carry it. An
 * adopted origin from before 0.36 can hold a credential in its user part: `https://user:token@host/…`,
 * `https://x-access-token:ghs_…@host/…`, `https://oauth2:glpat-…@host/…`, or a token alone as the
 * user name, `https://ghp_…@github.com/…` (review of mend#555, P2-2). Nothing secret enters a
 * workspace: the rule is `redactUrlCredentials`, the one every project read applies.
 */
export const workspaceRemoteUrl = (originUrl: string): string => redactUrlCredentials(originUrl);

export const CaptureRemotesLive: Layer.Layer<CaptureRemotes, never, ProjectsRepo> = Layer.effect(
  CaptureRemotes,
  Effect.gen(function* () {
    const projects = yield* ProjectsRepo;
    return {
      forProject: (projectId) =>
        projects.byId(projectId).pipe(
          Effect.map((project) =>
            project.originUrl === null
              ? []
              : [{ name: "origin", url: workspaceRemoteUrl(project.originUrl) }],
          ),
          Effect.catch(() =>
            Effect.logWarning("capture remotes: the project could not be read").pipe(
              Effect.annotateLogs({ projectId }),
              Effect.as([]),
            ),
          ),
        ),
    };
  }),
);
