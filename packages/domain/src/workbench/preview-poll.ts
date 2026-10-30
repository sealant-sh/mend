export const PREVIEW_POLL_MS = 2_000;

export const PREVIEW_POLL_STALL_MS = 10 * 60_000;

export const PREVIEW_POLL_CAP_MS = 30 * 60_000;

export interface PreviewPollRead {
  readonly unprepared: string | null;
  readonly starting?: boolean;
  readonly previews: ReadonlyArray<{
    readonly preview: { readonly id: string };
    readonly facts?: ReadonlyArray<unknown>;
  }>;
}

const ignoringObservedAt = (key: string, value: unknown) => (key === "observedAt" ? null : value);

const factsOf = (read: PreviewPollRead): string =>
  JSON.stringify(
    [read.unprepared, read.previews.map(({ preview, facts = [] }) => [preview.id, facts])],
    ignoringObservedAt,
  );

interface Episode {
  readonly worktreeId: string;
  readonly began: number;
  readonly facts: string;
  readonly since: number;
}

export const makePreviewPoll = () => {
  let episode: Episode | null = null;
  return (worktreeId: string, read: PreviewPollRead | undefined, now: number): number | false => {
    if (read === undefined || read.starting !== true) {
      episode = null;
      return false;
    }
    const facts = factsOf(read);
    if (episode === null || episode.worktreeId !== worktreeId) {
      episode = { worktreeId, began: now, facts, since: now };
    } else if (episode.facts !== facts) {
      episode = { ...episode, facts, since: now };
    }
    return now - episode.since < PREVIEW_POLL_STALL_MS && now - episode.began < PREVIEW_POLL_CAP_MS
      ? PREVIEW_POLL_MS
      : false;
  };
};
