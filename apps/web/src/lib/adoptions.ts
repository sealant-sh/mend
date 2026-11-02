import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import {
  adoptProject,
  type AdoptionProgressDto,
  type GitAuthModeDto,
  type ProjectDto,
} from "./api.ts";
import { readDraft, subscribeDrafts, writeDraft } from "./drafts.ts";
import { useMessageOwner } from "./outbox.ts";
import { failureWords, refusalTagOf } from "./refusal.ts";
import { useTRPC } from "./trpc.ts";
import { uuidV4 } from "./uuid.ts";

/**
 * The adoption this tab started, apart from the dialog: closing the dialog (or reloading) leaves
 * the clone going on the Mend server, and opening Adopt again shows it, its progress read by its
 * key (`projects.adoption`). Kept in the draft store under the account that started it, shown
 * only once who is signed in is known (`useMessageOwner`), and gone at sign-out. Never in the
 * query cache, which holds only what the server said.
 *
 * `Unconfirmed`: the adoption's answer was lost and the server's progress could not be read
 * either, so this tab does not know how it ended.
 */
export type AdoptionOutcome =
  | { readonly _tag: "Running" }
  | { readonly _tag: "Adopted"; readonly projectId: string }
  | { readonly _tag: "Failed"; readonly message: string; readonly gitSaid: string | null }
  | { readonly _tag: "Unconfirmed"; readonly message: string };

export interface AdoptionAttempt {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  /** Epoch milliseconds, when Adopt was pressed. */
  readonly startedAt: number;
  readonly outcome: AdoptionOutcome;
}

/** The draft key of one account's adoption. */
const keyOf = (userId: string) => `${userId}.adoption`;

const ANSWER_LOST =
  "Mend's answer was lost and the clone's progress could not be read. The Projects list shows whether it was adopted.";

const SERVER_FORGOT =
  "The Mend server no longer knows how this adoption ended. The Projects list shows whether it was adopted.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isOutcome = (value: unknown): value is AdoptionOutcome =>
  isRecord(value) &&
  (value["_tag"] === "Running" ||
    (value["_tag"] === "Adopted" && typeof value["projectId"] === "string") ||
    (value["_tag"] === "Unconfirmed" && typeof value["message"] === "string") ||
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

/** One account's stored adoption. */
export const readAdoption = (userId: string): AdoptionAttempt | null =>
  parseAttempt(readDraft(keyOf(userId)));

const write = (userId: string, attempt: AdoptionAttempt | null) =>
  writeDraft(keyOf(userId), attempt === null ? "" : JSON.stringify(attempt));

const settle = (userId: string, id: string, outcome: AdoptionOutcome) => {
  const current = readAdoption(userId);
  // A newer adoption replaced this one: its answer is not this one's to overwrite.
  if (current?.id === id) write(userId, { ...current, outcome });
};

/** Forget the account's adoption once its end was seen (the dialog closes on it). */
export const forgetAdoption = (userId: string) => write(userId, null);

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
 * Where an adoption stands after its request failed: as the server's progress read says when
 * there is one, since the clone runs on when the request is cut off (still running, adopted, or
 * failed in git's words). With no read, a refusal in Mend's words is a failure, and a lost
 * answer is not confirmed either way.
 */
export const outcomeAfterFailure = (
  cause: unknown,
  progress: AdoptionProgressDto | null,
): AdoptionOutcome => {
  if (progress !== null) {
    if (progress.state === "running") return { _tag: "Running" };
    if (progress.state === "adopted" && progress.projectId !== null)
      return { _tag: "Adopted", projectId: progress.projectId };
    if (progress.state === "failed")
      return {
        _tag: "Failed",
        message: progress.failure ?? failureWords(cause, "Not adopted."),
        gitSaid: progress.gitSaid,
      };
  }
  return refusalTagOf(cause) === null
    ? { _tag: "Unconfirmed", message: ANSWER_LOST }
    : {
        _tag: "Failed",
        message: failureWords(cause, "Not adopted. Try again; the server log has the detail."),
        gitSaid: null,
      };
};

/**
 * Start an adoption under a new key, kept under the signed-in account. The request blocks until
 * the clone ends; its progress is read meanwhile by the key, and its answer settles the stored
 * attempt even after the dialog that started it closed.
 */
export const startAdoption = (
  deps: AdoptionDeps,
  userId: string,
  request: AdoptionRequest,
  now = Date.now(),
): Promise<void> => {
  const id = uuidV4();
  write(userId, {
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
      settle(userId, id, { _tag: "Adopted", projectId: project.id });
    } catch (cause) {
      const progress = await deps.readProgress(id).catch(() => null);
      const outcome = outcomeAfterFailure(cause, progress);
      if (outcome._tag === "Adopted") await deps.refreshProjects();
      settle(userId, id, outcome);
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
 * The signed-in account's adoption and how far it got, null until who is signed in is known.
 * While it runs, or its answer was lost, its progress is read every half second; one whose
 * request this tab no longer holds (a reload) ends as the server read says.
 */
export const useAdoption = () => {
  const trpc = useTRPC();
  const owner = useMessageOwner();
  const raw = useSyncExternalStore(
    subscribeDrafts,
    () => (owner === null ? "" : readDraft(keyOf(owner))),
    () => "",
  );
  const attempt = owner === null ? null : parseAttempt(raw);
  const open = attempt?.outcome._tag === "Running" || attempt?.outcome._tag === "Unconfirmed";
  const progress = useQuery({
    ...trpc.projects.adoption.queryOptions(
      { id: attempt?.id ?? "" },
      {
        retry: false,
        // Read on while the clone runs; a read the server refused (it does not know the key) is
        // not asked again.
        refetchInterval: (query) =>
          query.state.status !== "error" &&
          (query.state.data === undefined || query.state.data.state === "running")
            ? PROGRESS_MS
            : false,
      },
    ),
    enabled: open,
  });
  return {
    owner,
    attempt,
    progress: progress.data,
    lost: attempt?.outcome._tag === "Running" && progress.isError,
  };
};

/** One adoption's end as the dialog shows it: the stored answer, else the server's read. */
export const outcomeOf = (
  attempt: AdoptionAttempt,
  progress: AdoptionProgressDto | undefined,
  lost: boolean,
): AdoptionOutcome => {
  const stored = attempt.outcome;
  if (stored._tag === "Adopted" || stored._tag === "Failed") return stored;
  if (progress?.state === "adopted" && progress.projectId !== null)
    return { _tag: "Adopted", projectId: progress.projectId };
  if (progress?.state === "failed")
    return {
      _tag: "Failed",
      message: progress.failure ?? "Not adopted.",
      gitSaid: progress.gitSaid,
    };
  if (progress?.state === "running") return { _tag: "Running" };
  // The server forgot it (a restart) while nothing here still waits on its answer.
  if (lost) return { _tag: "Unconfirmed", message: SERVER_FORGOT };
  return stored;
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
