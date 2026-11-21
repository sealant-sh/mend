/**
 * Going back to a checkpoint (SLNT-1259), as the web says it. The server does the restore: it
 * saves the worktree's files as a checkpoint first, puts them back to the one picked, and takes a
 * checkpoint after. The web only asks for it and draws what the session's details list.
 */

/** A checkpoint a restore names: its row when it still has one, and its number. */
export interface RestorePointDto {
  readonly id: string | null;
  readonly ordinal: number;
}

/** One restore as the session's details list it. */
export interface RestoreDto {
  readonly id: string;
  readonly actorId: string;
  readonly target: RestorePointDto;
  readonly saved: RestorePointDto;
  readonly result: RestorePointDto;
  readonly createdAt: Date | string;
}

/** A restore as the conversation draws it: a line where it happened. */
export interface RestoreMark {
  readonly key: string;
  readonly at: string;
  readonly target: RestorePointDto;
  readonly saved: RestorePointDto;
  /** "You", a member's name, or "Someone" when the roster can't say. */
  readonly who: string;
}

/**
 * The worktree's restores, oldest first. Every session in the worktree shows each one, because
 * they all work on the same files.
 */
export const restoreMarks = (
  restores: ReadonlyArray<RestoreDto>,
  viewerId: string,
  nameOf: (userId: string) => string | null,
): ReadonlyArray<RestoreMark> =>
  restores
    .map((restore) => ({
      key: `restore:${restore.id}`,
      at: new Date(restore.createdAt).toISOString(),
      target: restore.target,
      saved: restore.saved,
      who: restore.actorId === viewerId ? "You" : (nameOf(restore.actorId) ?? "Someone"),
    }))
    .toSorted((a, b) => a.at.localeCompare(b.at));

/** The line's label: "Went back to checkpoint 3". */
export const restoreLabel = (mark: Pick<RestoreMark, "target">): string =>
  `Went back to checkpoint ${mark.target.ordinal}`;

/** What the line's details say happened. */
export const restoreDetailWords = (mark: RestoreMark): string =>
  `${mark.who === "You" ? "You" : mark.who} put the files in this worktree back to how they were at checkpoint ${mark.target.ordinal}. Mend saved the files from just before as checkpoint ${mark.saved.ordinal}.`;

/** The toast once the files are back. */
export const wentBackWords = (restore: Pick<RestoreDto, "target" | "saved">): string =>
  `Went back to checkpoint ${restore.target.ordinal}. Your files from before are checkpoint ${restore.saved.ordinal}.`;
