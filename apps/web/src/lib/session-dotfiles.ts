import type { SessionDotfiles } from "@mend/domain/workbench";

export interface SessionDotfilesLine {
  readonly text: string;
  /** A source the launch tried and left out; the line carries the reason. */
  readonly notApplied: boolean;
}

const shortSha = (sha: string): string => sha.slice(0, 7);

/**
 * What the session's launch did with its owner's dotfiles, as recorded facts: one line for the
 * archives Mend sent with the workspace create, one per source left out with the resolver's
 * reason. "Sent", not "applied": Mend observes what it shipped, not what the workspace's apply
 * made of it. Nothing before launch, and nothing when no dotfiles were configured.
 */
export const sessionDotfilesLines = (
  dotfiles: SessionDotfiles | null,
): ReadonlyArray<SessionDotfilesLine> => {
  if (dotfiles === null) return [];
  const leftOut = new Set(dotfiles.notApplied.map((entry) => entry.source));
  const sent = [
    dotfiles.repository === null || leftOut.has("repository")
      ? null
      : `repo ${dotfiles.repository.url}${dotfiles.repository.ref === null ? "" : ` @ ${dotfiles.repository.ref}`}`,
    dotfiles.snapshotSha === null || leftOut.has("snapshot")
      ? null
      : `snapshot ${shortSha(dotfiles.snapshotSha)}`,
  ].filter((part) => part !== null);
  return [
    ...(sent.length === 0
      ? []
      : [{ text: `dotfiles · ${sent.join(" · ")} · sent at launch`, notApplied: false }]),
    ...dotfiles.notApplied.map((entry) => ({
      text: `dotfiles · ${entry.source === "repository" ? "repo" : "snapshot"} not applied · ${entry.reason}`,
      notApplied: true,
    })),
  ];
};
