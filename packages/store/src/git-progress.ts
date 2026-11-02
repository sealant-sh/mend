/**
 * What git says of a long transfer as it goes (`git clone --progress`): one line per update on
 * stderr, rewritten in place with a carriage return. Read here into the step git names and its
 * counts, in git's own words, so a person can watch a clone rather than a clock.
 */
export interface GitProgress {
  /** Git's name for the step: `Receiving objects`, `Resolving deltas`, `Counting objects`… */
  readonly step: string;
  /** Whether the server side reported it (git prefixes those lines `remote:`). */
  readonly remote: boolean;
  readonly percent: number | null;
  readonly done: number;
  /** Null for a step git counts without knowing the end (`Enumerating objects: 160`). */
  readonly total: number | null;
  /** How much has arrived, as git prints it (`1.20 MiB`); only `Receiving objects` says. */
  readonly received: string | null;
  /** The transfer rate, as git prints it (`2.00 MiB/s`). */
  readonly rate: string | null;
}

// git's progress.c: "%s: %3u%% (%u/%u)%s" for a known total, "%s: %u%s" without one, the suffix
// carrying the throughput (", 1.20 MiB | 2.00 MiB/s") and, at the end, ", done.".
const PROGRESS =
  /^(remote: )?([A-Z][A-Za-z ]*[a-z]):\s+(?:(\d{1,3})% \((\d+)\/(\d+)\)|(\d+))(?:,\s+(\d+(?:\.\d+)? [KMGT]?i?B)(?:\s+\|\s+(\d+(?:\.\d+)? [KMGT]?i?B\/s))?)?/;

/** One line of git's stderr read as progress, or null when it says something else. */
export const parseGitProgress = (line: string): GitProgress | null => {
  const match = PROGRESS.exec(line.trim());
  if (match === null) return null;
  const [, remote, step, percent, done, total, count, received, rate] = match;
  if (step === undefined) return null;
  return {
    step,
    remote: remote !== undefined,
    percent: percent === undefined ? null : Number(percent),
    done: Number(done ?? count ?? 0),
    total: total === undefined ? null : Number(total),
    received: received ?? null,
    rate: rate ?? null,
  };
};

/** Git's stderr without its progress: what it said besides counting, for a failure's words. */
export const withoutGitProgress = (stderr: string): string =>
  stderr
    .split(/\r\n|\r|\n/)
    .map((line) => line.trimEnd())
    .filter(
      (line) =>
        line !== "" && parseGitProgress(line) === null && !line.trim().startsWith("Cloning into "),
    )
    .join("\n");

/**
 * Feeds git's stderr in as it arrives and calls `onProgress` once per progress line, whole lines
 * only: a chunk can end mid-line, and git ends each update with `\r`, each step with `\n`.
 */
export const gitProgressReader = (onProgress: (progress: GitProgress) => void) => {
  let carried = "";
  return (chunk: string) => {
    const lines = `${carried}${chunk}`.split(/\r|\n/);
    carried = lines.pop() ?? "";
    for (const line of lines) {
      const progress = parseGitProgress(line);
      if (progress !== null) onProgress(progress);
    }
  };
};
