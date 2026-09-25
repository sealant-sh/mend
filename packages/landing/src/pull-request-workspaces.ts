import * as fs from "node:fs";
import * as path from "node:path";

import { SessionProcessesRepo } from "@mend/db";
import type { SessionId } from "@mend/domain";
import { isLiveProcess } from "@mend/domain/workbench";
import { SealantClients, type SealantClientShape, type SealantPlatformError } from "@mend/sealant";
import { StoreConfig } from "@mend/store";
import { opencode, type Workspace } from "@sealant/sdk";
import { Effect, Layer } from "effect";

import {
  type PullRequestWorkspace,
  PullRequestStepError,
  type PullRequestWorkspaceTarget,
  PullRequestWorkspaces,
} from "./pull-requests.ts";

/**
 * The live `PullRequestWorkspaces` (docs/adr/0007-landing.md, "Where each step runs"): the
 * session's own workspace when one of its processes is live, otherwise a short-lived workspace
 * for the owner.
 *
 * The short-lived workspace carries the owner's GitHub account and nothing else: no dotfiles, no
 * environment, no secrets and no worktree. The SDK cannot make it smaller (PLATFORM-FEEDBACK.md,
 * 2026-09-24): every workspace needs a source and a harness. So its source is an empty directory
 * Mend makes under the store root, which the platform already accepts as a mount, and its harness
 * is named and never started. It is stopped, and the directory removed, when the call returns;
 * the TTL is the platform's backstop if Mend dies first.
 */

/** How long the platform keeps a short-lived workspace if Mend never stops it. */
export const SHORT_LIVED_WORKSPACE_TTL = "10m";

/** The image a short-lived workspace builds: the default family, with `gh` and nothing else. */
const SHORT_LIVED_IMAGE = { os: "arch", packages: ["github-cli"] } as const;

/** Where the empty directories short-lived workspaces mount live, under the store root. */
export const shortLivedMountRoot = (storeRoot: string): string => path.join(storeRoot, "_landing");

const platformFailure = (doing: string) => (error: SealantPlatformError) =>
  new PullRequestStepError({ message: `${doing} · ${error.message}` });

/** A create that names a GitHub account the owner never connected says so first. */
const createFailure = (error: SealantPlatformError) =>
  new PullRequestStepError({
    message: error.message.toLowerCase().includes("connected account")
      ? `no GitHub account connected for the owner · ${error.message}`
      : `short-lived workspace · ${error.message}`,
  });

const removeBestEffort = (directory: string) =>
  Effect.sync(() => {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // A file the workspace wrote as another uid; the next sweep of `_landing` is the operator's.
    }
  });

export const PullRequestWorkspacesLive: Layer.Layer<
  PullRequestWorkspaces,
  never,
  SealantClients | SessionProcessesRepo | StoreConfig
> = Layer.effect(
  PullRequestWorkspaces,
  Effect.gen(function* () {
    const clients = yield* SealantClients;
    const processes = yield* SessionProcessesRepo;
    const config = yield* StoreConfig;

    const execIn =
      (client: SealantClientShape, workspace: Workspace): PullRequestWorkspace["exec"] =>
      (argv) =>
        client.exec(workspace, argv).pipe(
          Effect.map(({ exitCode, stdout, stderr }) => ({ exitCode, stdout, stderr })),
          Effect.mapError(platformFailure("workspace exec")),
        );

    /** The newest live process's workspace, when the session has one the platform still knows. */
    const liveWorkspace = (client: SealantClientShape, sessionId: SessionId | null) =>
      Effect.gen(function* () {
        if (sessionId === null) return null;
        const live = (yield* processes.listForSession(sessionId))
          .filter(isLiveProcess)
          .toSorted((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
          .at(-1);
        if (live === undefined) return null;
        return yield* client
          .getWorkspace(live.sealantWorkspaceId)
          .pipe(
            Effect.catch((error) =>
              Effect.logInfo(
                "landing: the session's workspace could not be reached · using a short-lived one",
              ).pipe(Effect.annotateLogs({ sessionId, error: error.message }), Effect.as(null)),
            ),
          );
      });

    const shortLived = <A, E>(
      client: SealantClientShape,
      use: (workspace: PullRequestWorkspace) => Effect.Effect<A, E>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const id = crypto.randomUUID();
          const mount = path.join(shortLivedMountRoot(config.root), id);
          yield* Effect.acquireRelease(
            Effect.sync(() => fs.mkdirSync(mount, { recursive: true })),
            () => removeBestEffort(mount),
          );
          const workspace = yield* Effect.acquireRelease(
            client
              .createWorkspace({
                source: { kind: "mount", path: mount },
                harness: opencode(),
                name: `mend-pr-${id.slice(0, 8)}`,
                os: SHORT_LIVED_IMAGE.os,
                packages: SHORT_LIVED_IMAGE.packages,
                credentials: { github: true },
                ttl: SHORT_LIVED_WORKSPACE_TTL,
              })
              .pipe(Effect.mapError(createFailure)),
            (created) =>
              client
                .stopWorkspace(created)
                .pipe(
                  Effect.catch((error) =>
                    Effect.logWarning(
                      "landing: the short-lived workspace did not stop · its TTL will",
                    ).pipe(Effect.annotateLogs({ workspaceId: created.id, error: error.message })),
                  ),
                ),
          );
          return yield* use({ kind: "short-lived", exec: execIn(client, workspace) });
        }),
      );

    const within = <A, E>(
      target: PullRequestWorkspaceTarget,
      use: (workspace: PullRequestWorkspace) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | PullRequestStepError> =>
      Effect.gen(function* () {
        const client = yield* clients
          .forUser(target.ownerUserId)
          .pipe(Effect.mapError(platformFailure("the owner's platform account")));
        const live = yield* liveWorkspace(client, target.sessionId);
        if (live !== null) return yield* use({ kind: "session", exec: execIn(client, live) });
        if (target.liveOnly === true) {
          return yield* new PullRequestStepError({
            message: "the session has no live workspace to ask gh in",
          });
        }
        return yield* shortLived(client, use);
      });

    return { within };
  }),
);
