import { Schema } from "effect";

import { CheckpointId, CheckpointRestoreId, SessionId, WorktreeId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

/**
 * A checkpoint a restore names, by its place in the worktree's chain. The ordinal stays when the
 * row goes (a removed worktree's chain), so the line in the conversation can still say which.
 */
export const RestorePoint = Schema.Struct({
  id: Schema.NullOr(CheckpointId),
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type RestorePoint = typeof RestorePoint.Type;

/**
 * Going back to a checkpoint (SLNT-1259): a person put the worktree's files back to how they were
 * at `target`. Before touching a file, Mend saved the files as they were as `saved`, so going back
 * to `saved` undoes it; `result` is the checkpoint Mend took once the files were back. The branch,
 * its commits and HEAD never move. The restore belongs to the worktree: every session in it shares
 * the files, and each is told on its next message.
 */
export class CheckpointRestore extends Schema.Class<CheckpointRestore>("CheckpointRestore")({
  id: CheckpointRestoreId,
  worktreeId: WorktreeId,
  /** The session the person went back from; null once that session is deleted. */
  sessionId: Schema.NullOr(SessionId),
  /** The Mend account that went back. */
  actorId: Schema.String,
  target: RestorePoint,
  saved: RestorePoint,
  result: RestorePoint,
  createdAt: Timestamp,
}) {}

/**
 * What the agent reads ahead of the person's next message after the worktree's files went back,
 * one paragraph per restore, oldest first. The person's message shows as they wrote it: this is
 * added only where Mend hands the turn to the agent.
 */
export const messageWithRestoreNotes = (
  input: string,
  restores: ReadonlyArray<Pick<CheckpointRestore, "target" | "saved" | "createdAt">>,
): string => {
  if (restores.length === 0) return input;
  return [
    ...restores.map(
      (restore) =>
        `Note from Mend: at ${new Date(restore.createdAt).toISOString()} a person put this worktree's files back to checkpoint ${restore.target.ordinal}. Files changed after that checkpoint are back as they were then, and files it didn't have are gone. Mend saved the files from just before as checkpoint ${restore.saved.ordinal}. The branch, its commits and HEAD did not move. Read files again before you rely on what you remember of them.`,
    ),
    "",
    "User message:",
    input,
  ].join("\n");
};
