import {
  GitCommandError,
  GitManagerError,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsRef,
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
 * - Mend's change is the worktree against its base, committed or not, which is t3code's
 *   `branchChanges`: those totals.
 * - Mend has no read of the worktree's HEAD, index or uncommitted files, so nothing is claimed
 *   about them: `hasWorkingTreeChanges` is false and `workingTree` empty, rather than base-diff
 *   totals presented as uncommitted work.
 * - Mend tracks no upstream for a session's branch (landing is its own step, ADR 0007), so the
 *   remote half is null: nothing ahead, behind or in review is claimed.
 *
 * The stream sends a snapshot, then the local half again whenever any thread in the worktree
 * changes in the shell (every session there adds to its one change), or a thread goes, and every
 * fifteen seconds besides, as a change can move without its threads changing. Reads come at most
 * once a second, however busy the worktree: a burst is one read at the end of its second, never
 * put off while the burst lasts.
 */

/** At most one read of a worktree's status this often while it keeps changing. */
export const VCS_REFRESH_MS = 1_000;
/** How often a watched status is read with nothing in the shell to say it moved. */
export const VCS_POLL = "15 seconds";

const EMPTY_TREE = { files: [], insertions: 0, deletions: 0 } as const;

export const localStatusOf = (
  location: CwdLocation,
  stats: { readonly files: number; readonly additions: number; readonly deletions: number } | null,
): VcsStatusLocalResult => ({
  isRepo: true,
  hasPrimaryRemote: location.hasOrigin,
  isDefaultRef: location.branch === location.defaultBranch,
  refName: location.branch.trim().length > 0 ? location.branch : null,
  hasWorkingTreeChanges: false,
  workingTree: EMPTY_TREE,
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

/**
 * The refs Mend knows at `cwd`, for t3code's branch picker: the project's default branch, and the
 * thread's own branch in its worktree. Mend lists no other branch of the project and no remote
 * one, so nothing else is claimed. t3code picks the default as a new worktree's base from this.
 */
export const refsAt = (
  location: CwdLocation,
  cwd: string,
  request: Pick<VcsListRefsInput, "query" | "refKind">,
): ReadonlyArray<VcsRef> => {
  if (request.refKind === "remote") return [];
  const refs: Array<VcsRef> = [
    {
      name: location.defaultBranch,
      current: location.branch === location.defaultBranch,
      isDefault: true,
      // The project's root is Mend's bare store, which t3code must never take for a checkout.
      worktreePath: null,
    },
  ];
  if (location.sessionId !== null && location.branch !== location.defaultBranch) {
    refs.push({ name: location.branch, current: true, isDefault: false, worktreePath: cwd });
  }
  const query = request.query?.toLowerCase();
  return refs.filter(
    (ref) =>
      ref.name.trim().length > 0 && (query === undefined || ref.name.toLowerCase().includes(query)),
  );
};

/** `vcs.listRefs` fails as t3code's git commands do; Mend runs no git command for it. */
const refsFailed = (cwd: string) => (detail: string) =>
  new GitCommandError({ operation: "vcs.listRefs", command: "", cwd, detail });

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
        if (first.location.sessionId === null) {
          return Stream.make(snapshot).pipe(Stream.concat(Stream.never));
        }
        let last = JSON.stringify(first.local);
        // Any session of the worktree moving its one change, or a thread going (the one the
        // first read found may be gone, and another in the worktree read instead).
        const moved = shell.changes.pipe(
          Stream.filter(
            (delta) =>
              (delta.kind === "thread.updated" && delta.thread.worktreePath === request.cwd) ||
              delta.kind === "thread.removed",
          ),
          Stream.map(() => undefined),
        );
        const updates = Stream.merge(moved, Stream.tick(VCS_POLL).pipe(Stream.drop(1))).pipe(
          Stream.groupedWithin(Number.MAX_SAFE_INTEGER, VCS_REFRESH_MS),
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

  const listRefs = (request: VcsListRefsInput) =>
    Effect.gen(function* () {
      const location = yield* hub
        .locationOf(request.cwd)
        .pipe(Effect.mapError((error) => refsFailed(request.cwd)(error.message)));
      if (location === null) {
        return yield* refsFailed(request.cwd)("No Mend thread or project of yours works there.");
      }
      const refs = refsAt(location, request.cwd, request);
      return {
        refs,
        isRepo: true,
        hasPrimaryRemote: location.hasOrigin,
        nextCursor: null,
        totalCount: refs.length,
      } satisfies VcsListRefsResult;
    });

  return { listRefs, refreshStatus, subscribeStatus };
};
