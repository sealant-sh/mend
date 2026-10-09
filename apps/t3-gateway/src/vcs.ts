import {
  GitManagerError,
  type VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusResult,
  type VcsStatusStreamEvent,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { GatedMend } from "./device-gate.ts";
import type { CwdLocation, PersonHub } from "./hub.ts";
import type { BearerSession } from "./state.ts";

/**
 * A thread's VCS status for t3code's branch toolbar and git menu (ADR 0012, phase 2: VCS status),
 * from the change Mend keeps for the thread's worktree (`GET /api/changes/:id/stats`), read as the
 * person.
 *
 * - The ref is the session's branch; the project's root is its default branch.
 * - Mend's change is the worktree against its base, which is t3code's `branchChanges`: those
 *   totals, and `hasWorkingTreeChanges` when it holds any file. Mend's stats carry no per-file
 *   lines, so `workingTree.files` stays empty: the changes panel lists the files.
 * - Mend tracks no upstream for a session's branch (landing is its own step, ADR 0007), so the
 *   remote half is null: nothing ahead, behind or in review is claimed.
 *
 * The stream sends a snapshot, then the local half again whenever the thread changes in the shell
 * (a turn ended, a file moved), at most once a second.
 */

/** How often a thread's status is read again while its shell keeps changing. */
export const VCS_REFRESH_MS = 1_000;

const EMPTY_TREE = { files: [], insertions: 0, deletions: 0 } as const;

export const localStatusOf = (
  location: CwdLocation,
  stats: { readonly files: number; readonly additions: number; readonly deletions: number } | null,
): VcsStatusLocalResult => ({
  isRepo: true,
  hasPrimaryRemote: location.hasOrigin,
  isDefaultRef: location.branch === location.defaultBranch,
  refName: location.branch.trim().length > 0 ? location.branch : null,
  hasWorkingTreeChanges: (stats?.files ?? 0) > 0,
  workingTree: {
    ...EMPTY_TREE,
    insertions: stats?.additions ?? 0,
    deletions: stats?.deletions ?? 0,
  },
  ...(location.sessionId === null
    ? {}
    : {
        branchChanges: {
          baseRef:
            location.baseRef !== null && location.baseRef.trim().length > 0
              ? location.baseRef
              : null,
          insertions: stats?.additions ?? 0,
          deletions: stats?.deletions ?? 0,
        },
      }),
});

const failed = (operation: string, cwd: string) => (detail: string) =>
  new GitManagerError({ operation, cwd, detail });

export const makeVcsHandlers = (input: {
  readonly hub: PersonHub;
  readonly mend: GatedMend;
  readonly session: BearerSession;
}) => {
  const { hub, mend, session } = input;

  /** Where `cwd` is, and its status now. */
  const statusAt = (operation: string, cwd: string) =>
    Effect.gen(function* () {
      const location = yield* hub
        .locationOf(cwd)
        .pipe(Effect.mapError((error) => failed(operation, cwd)(error.message)));
      if (location === null) {
        return yield* failed(operation, cwd)("No Mend thread or project of yours works there.");
      }
      const stats =
        location.changeId === null
          ? null
          : yield* mend
              .changeStats(session.deviceToken, location.changeId)
              .pipe(Effect.mapError((error) => failed(operation, cwd)(error.message)));
      return { location, local: localStatusOf(location, stats) };
    });

  const refreshStatus = (request: VcsStatusInput) =>
    statusAt("vcs.refreshStatus", request.cwd).pipe(
      Effect.map(
        ({ local }): VcsStatusResult => ({
          ...local,
          hasUpstream: false,
          aheadCount: 0,
          behindCount: 0,
          pr: null,
        }),
      ),
    );

  const subscribeStatus = (
    request: VcsStatusInput,
  ): Stream.Stream<VcsStatusStreamEvent, GitManagerError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const operation = "subscribeVcsStatus";
        // Subscribed before the first read: a change while it reads is not missed.
        const shell = yield* hub
          .subscribeShell(undefined)
          .pipe(Effect.mapError((error) => failed(operation, request.cwd)(error.message)));
        const first = yield* statusAt(operation, request.cwd);
        const snapshot: VcsStatusStreamEvent = {
          _tag: "snapshot",
          local: first.local,
          remote: null,
        };
        const threadId = first.location.threadId;
        if (threadId === null) return Stream.make(snapshot).pipe(Stream.concat(Stream.never));
        let last = JSON.stringify(first.local);
        const updates = shell.changes.pipe(
          Stream.filter((delta) => delta.kind === "thread.updated" && delta.thread.id === threadId),
          Stream.debounce(VCS_REFRESH_MS),
          Stream.mapEffect(() =>
            statusAt(operation, request.cwd).pipe(
              Effect.map(({ local }) => local),
              // A read that fails leaves the last status standing; the next change reads again.
              Effect.orElseSucceed(() => null),
            ),
          ),
          Stream.filter((local): local is VcsStatusLocalResult => {
            if (local === null) return false;
            const print = JSON.stringify(local);
            if (print === last) return false;
            last = print;
            return true;
          }),
          Stream.map((local): VcsStatusStreamEvent => ({ _tag: "localUpdated", local })),
          Stream.mapError((error) => failed(operation, request.cwd)(error.message)),
        );
        return Stream.make(snapshot).pipe(Stream.concat(updates));
      }),
    );

  return { refreshStatus, subscribeStatus };
};
