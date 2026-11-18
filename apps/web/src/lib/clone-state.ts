import type { AdoptionProgressDto, ProjectDto } from "./api.ts";
import { failureWords } from "./refusal.ts";

/**
 * Where the clone this browser started stands, from the server's read of it, or from the request
 * itself while the server doesn't know the key yet (its first read can arrive before the clone
 * starts) or no longer knows it (a restart, or it ended over 15 minutes ago).
 */
export type CloneState =
  | { readonly _tag: "Cloning"; readonly progress: AdoptionProgressDto | null }
  | { readonly _tag: "Added"; readonly projectId: string }
  | {
      readonly _tag: "Failed";
      readonly message: string;
      readonly gitSaid: string | null;
      readonly startedAt: Date | null;
      readonly endedAt: Date | null;
    }
  | { readonly _tag: "Gone" };

export const cloneStateOf = (
  progress: { readonly data: AdoptionProgressDto | undefined; readonly failed: boolean },
  request: {
    readonly pending: boolean;
    readonly project: ProjectDto | undefined;
    readonly error: unknown;
  },
): CloneState => {
  const read = progress.data;
  if (read !== undefined && !progress.failed) {
    if (read.state === "running") return { _tag: "Cloning", progress: read };
    if (read.state === "adopted" && read.projectId !== null)
      return { _tag: "Added", projectId: read.projectId };
    if (read.state === "failed")
      return {
        _tag: "Failed",
        message: read.failure ?? "Mend couldn't clone the repository.",
        gitSaid: read.gitSaid,
        startedAt: read.startedAt,
        endedAt: read.updatedAt,
      };
  }
  if (request.project !== undefined) return { _tag: "Added", projectId: request.project.id };
  if (request.error !== null)
    return {
      _tag: "Failed",
      message: failureWords(request.error, "Mend couldn't clone the repository. Try again."),
      gitSaid: null,
      startedAt: null,
      endedAt: null,
    };
  if (request.pending || (read === undefined && !progress.failed))
    return { _tag: "Cloning", progress: null };
  return { _tag: "Gone" };
};

/** How far a clone got, in words: Mend's step, then git's own. */
export const cloneWords = (progress: AdoptionProgressDto | null): string => {
  if (progress === null) return "Starting";
  switch (progress.phase) {
    case "preparing":
      return "Getting Git access ready";
    case "checking":
      return "Checking the repository";
    case "recording":
      return "Saving the project";
    case "cloning": {
      const git = progress.git;
      if (git === null) return "Waiting for the Git host";
      return git.received === null ? git.step : `${git.step} · ${git.received}`;
    }
  }
};

const COUNT = new Intl.NumberFormat("en");

/**
 * The line under a running clone's bar, split for its two ends: git's step with its count
 * ("Receiving objects: 18,240 of 28,500 (64%)"), and what has arrived and how fast, in git's own
 * units ("41.20 MiB at 6.20 MiB/s"), when git has said.
 */
export const cloneDetail = (
  progress: AdoptionProgressDto | null,
): { readonly step: string; readonly transfer: string | null } => {
  const git = progress?.phase === "cloning" ? progress.git : null;
  if (git === null || git === undefined) return { step: cloneWords(progress), transfer: null };
  const count =
    git.total === null
      ? git.percent === null
        ? ""
        : ` (${git.percent}%)`
      : `: ${COUNT.format(git.done)} of ${COUNT.format(git.total)}${git.percent === null ? "" : ` (${git.percent}%)`}`;
  const transfer =
    git.received === null
      ? null
      : git.rate === null
        ? git.received
        : `${git.received} at ${git.rate}`;
  return { step: `${git.step}${count}`, transfer };
};
