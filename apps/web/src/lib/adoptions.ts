import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import {
  adoptProject,
  type AdoptionProgressDto,
  type GitAuthModeDto,
  type ProjectDto,
} from "./api.ts";
import { readDraft, subscribeDrafts, writeDraft } from "./drafts.ts";
import { failureWords } from "./refusal.ts";
import { useTRPC } from "./trpc.ts";
import { uuidV4 } from "./uuid.ts";

/**
 * The adoption this tab started, apart from the dialog: closing the dialog (or reloading) leaves
 * the clone going on the Mend server, and opening Adopt again shows it, its progress read by its
 * key (`projects.adoption`). Kept in the draft store, so it goes at sign-out. Never in the query
 * cache, which holds only what the server said.
 */
export type AdoptionOutcome =
  | { readonly _tag: "Running" }
  | { readonly _tag: "Adopted"; readonly projectId: string }
  | { readonly _tag: "Failed"; readonly message: string; readonly gitSaid: string | null };

export interface AdoptionAttempt {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  /** Epoch milliseconds, when Adopt was pressed. */
  readonly startedAt: number;
  readonly outcome: AdoptionOutcome;
}

const KEY = "adoption";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isOutcome = (value: unknown): value is AdoptionOutcome =>
  isRecord(value) &&
  (value["_tag"] === "Running" ||
    (value["_tag"] === "Adopted" && typeof value["projectId"] === "string") ||
    (value["_tag"] === "Failed" &&
      typeof value["message"] === "string" &&
      (typeof value["gitSaid"] === "string" || value["gitSaid"] === null)));

let parsed: { readonly raw: string; readonly attempt: AdoptionAttempt | null } = {
  raw: "",
  attempt: null,
};

/** The stored attempt as read from its raw text; the same object while the text is the same. */
export const parseAttempt = (raw: string): AdoptionAttempt | null => {
  if (raw === parsed.raw) return parsed.attempt;
  let attempt: AdoptionAttempt | null = null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      isRecord(value) &&
      typeof value["id"] === "string" &&
      typeof value["name"] === "string" &&
      typeof value["source"] === "string" &&
      typeof value["startedAt"] === "number" &&
      isOutcome(value["outcome"])
    )
      attempt = {
        id: value["id"],
        name: value["name"],
        source: value["source"],
        startedAt: value["startedAt"],
        outcome: value["outcome"],
      };
  } catch {
    // Not what this tab wrote: no adoption to show.
  }
  parsed = { raw, attempt };
  return attempt;
};

const write = (attempt: AdoptionAttempt | null) =>
  writeDraft(KEY, attempt === null ? "" : JSON.stringify(attempt));

const settle = (id: string, outcome: AdoptionOutcome) => {
  const current = parseAttempt(readDraft(KEY));
  // A newer adoption replaced this one: its answer is not this one's to overwrite.
  if (current?.id === id) write({ ...current, outcome });
};

/** Forget the adoption once its end was seen (the dialog closes on it). */
export const forgetAdoption = () => write(null);

/** The adoption a person asked for: what the form says. */
export interface AdoptionRequest {
  readonly name: string;
  readonly source: string;
  readonly auth: GitAuthModeDto;
  readonly visibility: ProjectDto["visibility"];
}

/** What an adoption needs besides the request: re-reading the projects, reading its progress. */
export interface AdoptionDeps {
  readonly refreshProjects: () => Promise<unknown>;
  readonly readProgress: (id: string) => Promise<AdoptionProgressDto | null>;
}

/**
 * Start an adoption under a new key. The request blocks until the clone ends; its progress is
 * read meanwhile by the key, and its answer settles the stored attempt even after the dialog
 * that started it closed. A failure keeps git's own words, read once by the key.
 */
export const startAdoption = (
  deps: AdoptionDeps,
  request: AdoptionRequest,
  now = Date.now(),
): Promise<void> => {
  const id = uuidV4();
  write({
    id,
    name: request.name,
    source: request.source,
    startedAt: now,
    outcome: { _tag: "Running" },
  });
  const answered = async () => {
    try {
      const project = await adoptProject(
        request.name,
        request.source,
        request.auth,
        request.visibility,
        id,
      );
      await deps.refreshProjects();
      settle(id, { _tag: "Adopted", projectId: project.id });
    } catch (cause) {
      const progress = await deps.readProgress(id).catch(() => null);
      settle(id, {
        _tag: "Failed",
        message: failureWords(cause, "Not adopted. Try again; the server log has the detail."),
        gitSaid: progress?.gitSaid ?? null,
      });
    }
  };
  return answered();
};

/** The deps of `startAdoption` from this page's clients. */
export const useAdoptionDeps = (queryClient: QueryClient): AdoptionDeps => {
  const trpc = useTRPC();
  return {
    refreshProjects: () => queryClient.invalidateQueries(trpc.projects.pathFilter()),
    readProgress: (id) => queryClient.fetchQuery(trpc.projects.adoption.queryOptions({ id })),
  };
};

/** How often a running adoption's progress is read. */
const PROGRESS_MS = 500;

/**
 * The tab's adoption and how far it got. While it runs, its progress is read every half second;
 * an adoption whose request this tab no longer holds (a reload) ends as the server read says.
 */
export const useAdoption = () => {
  const trpc = useTRPC();
  const raw = useSyncExternalStore(
    subscribeDrafts,
    () => readDraft(KEY),
    () => "",
  );
  const attempt = parseAttempt(raw);
  const running = attempt?.outcome._tag === "Running";
  const progress = useQuery({
    ...trpc.projects.adoption.queryOptions(
      { id: attempt?.id ?? "" },
      {
        retry: false,
        refetchInterval: (query) => (query.state.data?.state === "running" ? PROGRESS_MS : false),
      },
    ),
    enabled: running,
  });
  return { attempt, progress: progress.data, lost: running && progress.isError };
};

/** One adoption's end as the dialog shows it: the stored answer, else the server's read. */
export const outcomeOf = (
  attempt: AdoptionAttempt,
  progress: AdoptionProgressDto | undefined,
  lost: boolean,
): AdoptionOutcome => {
  if (attempt.outcome._tag !== "Running") return attempt.outcome;
  if (progress?.state === "adopted" && progress.projectId !== null)
    return { _tag: "Adopted", projectId: progress.projectId };
  if (progress?.state === "failed")
    return {
      _tag: "Failed",
      message: progress.failure ?? "Not adopted.",
      gitSaid: progress.gitSaid,
    };
  // The server forgot it (a restart) while nothing here still waits on its answer.
  if (lost)
    return {
      _tag: "Failed",
      message:
        "The Mend server no longer knows how this adoption ended. The Projects list shows whether it did.",
      gitSaid: null,
    };
  return attempt.outcome;
};

/** How far a running adoption got, in words: Mend's phase, then git's own count. */
export const progressWords = (progress: AdoptionProgressDto | undefined): string => {
  if (progress === undefined) return "starting";
  switch (progress.phase) {
    case "preparing":
      return "preparing git access";
    case "checking":
      return "checking the repository";
    case "recording":
      return "recording the project";
    case "cloning": {
      const git = progress.git;
      if (git === null) return "cloning · waiting for the git host";
      const counted =
        git.total === null
          ? `${git.done.toLocaleString()}`
          : `${git.done.toLocaleString()} of ${git.total.toLocaleString()}`;
      const bytes =
        git.received === null
          ? ""
          : ` · ${git.received}${git.rate === null ? "" : ` at ${git.rate}`}`;
      return `${git.remote ? "server · " : ""}${git.step.toLowerCase()}${git.percent === null ? "" : ` ${git.percent}%`} · ${counted}${bytes}`;
    }
  }
};
