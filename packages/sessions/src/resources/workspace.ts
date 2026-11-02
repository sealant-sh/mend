import { SessionsRepo } from "@mend/db";
import type { WorktreeId } from "@mend/domain";
import { asSealantUser, SealantClient } from "@mend/sealant";
import { Effect } from "effect";

/** Resolve the writable workspace shared by resource reads and Add, excluding saved executors. */
export const resourceWorkspace = Effect.gen(function* () {
  const sessions = yield* SessionsRepo;
  const sealant = yield* SealantClient;
  // A settled agent may still have a live shell.
  const liveWorkspace = Effect.fn("Resources.liveWorkspace")(function* (worktreeId: WorktreeId) {
    const members = yield* sessions.listForWorktree(worktreeId);
    const flushed = new Set(
      yield* Effect.forEach(members, (member) => sessions.finalFlushedWorkspace(member.id)),
    );
    for (const session of members) {
      const id = session.sealantWorkspaceId;
      if (id === null || flushed.has(id)) continue;
      const found = yield* Effect.gen(function* () {
        const workspace = yield* sealant.getWorkspace(id);
        const status = yield* Effect.tryPromise(() => workspace.status());
        return status === "queued" || status === "running" || status === "ready"
          ? { workspace, owner: session.ownerUserId }
          : null;
      }).pipe(asSealantUser(session.ownerUserId));
      if (found !== null) return found;
    }
    return null;
  });

  return liveWorkspace;
});
