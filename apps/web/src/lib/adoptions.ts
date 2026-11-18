import { useSyncExternalStore } from "react";

import type { AdoptionProgressDto, ProjectDto } from "./api.ts";
import type { TrpcProxy } from "./trpc.ts";

/**
 * The clone this browser started, apart from the page that started it: the server knows a clone
 * only by the key its client chose (`projects.adoption`), and no read lists a person's clones, so
 * the browser keeps that key for its account. The setup step that adds a first project, and
 * Projects' Add project, write it with `rememberAdoption` as they start one. The composer reads it to
 * offer the cloning project and queue a session on its clone (`queuedSessions.queue`).
 *
 * Kept in this browser's local storage, under the account that started it; never in the query
 * cache, which holds only what the server said.
 */
export interface AdoptionAttempt {
  /** The key the clone was started under (`AdoptProject.adoptionId`). */
  readonly id: string;
  /** The project's name, as the person typed it. */
  readonly name: string;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  /**
   * The address and visibility it was asked for, so Projects can try a failed clone again. Null
   * in a clone kept before Projects wrote them.
   */
  readonly source: string | null;
  readonly visibility: ProjectDto["visibility"] | null;
}

const keyOf = (userId: string) => `mend-adoption.${userId}`;

const listeners = new Set<() => void>();
const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  // Another tab of this browser started or forgot one.
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith("mend-adoption.") === true) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

let parsed: { readonly raw: string | null; readonly attempt: AdoptionAttempt | null } = {
  raw: null,
  attempt: null,
};

/** The stored attempt as read from its raw text; the same object while the text is the same. */
export const parseAttempt = (raw: string | null): AdoptionAttempt | null => {
  if (raw === parsed.raw) return parsed.attempt;
  let attempt: AdoptionAttempt | null = null;
  try {
    const value: unknown = raw === null ? null : JSON.parse(raw);
    if (
      isRecord(value) &&
      typeof value["id"] === "string" &&
      typeof value["name"] === "string" &&
      typeof value["startedAt"] === "number"
    )
      attempt = {
        id: value["id"],
        name: value["name"],
        startedAt: value["startedAt"],
        source: typeof value["source"] === "string" ? value["source"] : null,
        visibility:
          value["visibility"] === "private" || value["visibility"] === "shared"
            ? value["visibility"]
            : null,
      };
  } catch {
    // Not what this app wrote: no clone to show.
  }
  parsed = { raw, attempt };
  return attempt;
};

const readStored = (userId: string): string | null => {
  try {
    return localStorage.getItem(keyOf(userId));
  } catch {
    return null;
  }
};

const write = (userId: string, attempt: AdoptionAttempt | null) => {
  try {
    if (attempt === null) localStorage.removeItem(keyOf(userId));
    else localStorage.setItem(keyOf(userId), JSON.stringify(attempt));
  } catch {
    // Storage refused (a private window): the composer then doesn't offer the clone.
  }
  for (const listener of listeners) listener();
};

/** Keep the clone the account just started, in place of any earlier one. */
export const rememberAdoption = (userId: string, attempt: AdoptionAttempt) =>
  write(userId, attempt);

/** Forget the account's clone once its end was seen. */
export const forgetAdoption = (userId: string) => write(userId, null);

/** The account's clone, null on the server's render and when there is none. */
export const useAdoptionAttempt = (userId: string): AdoptionAttempt | null =>
  parseAttempt(
    useSyncExternalStore(
      subscribe,
      () => readStored(userId),
      () => null,
    ),
  );

/** How often a running clone's progress is read. */
const PROGRESS_MS = 1_000;

/**
 * How far a clone got, read again every second while it runs. A key the server doesn't know (a
 * restart forgets clones; one ended more than 15 minutes ago) answers null.
 */
export const adoptionProgressOptions = (trpc: TrpcProxy, id: string) =>
  trpc.projects.adoption.queryOptions(
    { id },
    {
      retry: false,
      refetchInterval: (query) =>
        query.state.status !== "error" &&
        (query.state.data === undefined || query.state.data?.state === "running")
          ? PROGRESS_MS
          : false,
    },
  );

/** How far a running clone got, as a whole percent; null before git says. */
export const clonePercent = (progress: AdoptionProgressDto | null | undefined): number | null =>
  progress?.git?.percent ?? null;
