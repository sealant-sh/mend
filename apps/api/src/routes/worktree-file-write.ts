import {
  CurrentUser,
  SessionNotSteerable,
  StoreFailure,
  WorktreeNotFound,
} from "@mend/api-contracts";
import { SessionsRepo } from "@mend/db";
import { SessionId, type WorktreeId } from "@mend/domain";
import { canSteerSession } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import { isWorktreeRelativePath } from "@mend/store";
import { Effect } from "effect";

import { ProjectAccess } from "../access.ts";

/** A change's owner, or someone sharing its first conversation's control, may edit its files. */
export const writeWorktreeContents = (
  id: WorktreeId,
  input: { readonly path: string; readonly contents: string },
): Effect.Effect<
  { readonly path: string },
  WorktreeNotFound | SessionNotSteerable | StoreFailure,
  ProjectAccess | CurrentUser | SessionsRepo | SessionEngine
> =>
  Effect.gen(function* () {
    const worktree = yield* (yield* ProjectAccess)
      .worktree(id)
      .pipe(Effect.mapError(() => new WorktreeNotFound({ id })));
    const caller = (yield* CurrentUser).user.id;
    const members = yield* (yield* SessionsRepo).listForWorktree(id);
    const first = members
      .filter((session) => session.ownerUserId === worktree.changeOwnerUserId)
      .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    if (first === undefined || !canSteerSession(first, caller))
      return yield* new SessionNotSteerable({
        sessionId: first?.id ?? SessionId.make(id),
        message: "only the change owner or someone with shared control can edit its files",
      });
    if (
      !isWorktreeRelativePath(input.path) ||
      input.path.split("/").some((part) => part.toLowerCase() === ".git") ||
      Buffer.byteLength(input.contents) > 1024 * 1024
    )
      return yield* new StoreFailure({
        message: "write a text file of at most 1 MiB inside the worktree, outside .git",
      });
    yield* (yield* SessionEngine)
      .writeWorktreeFile(first.id, input.path, input.contents, caller)
      .pipe(
        Effect.mapError(
          (error) =>
            new StoreFailure({
              message:
                error._tag === "SessionNotLiveError"
                  ? "the worktree has no live workspace; resume its session before editing files"
                  : error.message,
            }),
        ),
      );
    return { path: input.path };
  });
