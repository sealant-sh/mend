import type { WorktreeId } from "@mend/domain";
import type { WorktreeChoice } from "@mend/domain/workbench";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type { ResourcesPageView } from "./resources.ts";

/**
 * The Resources card's state between reads and writes (ADR 0019): which read is on screen, where
 * each act's answer lands, and how a worktree's choice reaches the cache.
 */

/** What answered an act on one item: the server's lines, and whether a reload helps. */
export interface ItemNote {
  readonly refused: boolean;
  readonly lines: ReadonlyArray<string>;
  readonly reload: boolean;
  readonly restartLevel?: "project" | "worktree";
}

/** Where an act's answer lands (an added table's lands on its definition), and what it says. */
export interface Answer {
  readonly at: string;
  readonly note: ItemNote | null;
}

/** The notes once the act started on `started` is answered: its own note goes, the answer lands. */
export const answered = (
  notes: ReadonlyMap<string, ItemNote>,
  started: string,
  answer: Answer,
): ReadonlyMap<string, ItemNote> => {
  const next = new Map(notes);
  next.delete(started);
  if (answer.note !== null) next.set(answer.at, answer.note);
  return next;
};

/** A refused write in the server's words, one line per refusal; a stale read is offered a reload. */
export const refusedNote = (outcome: {
  readonly kind: string;
  readonly message: string;
}): ItemNote => ({
  refused: true,
  lines: outcome.message.split("\n").filter((line) => line !== ""),
  reload: outcome.kind === "stale",
});

/** The read on screen. Only a loaded read is acted on, and only for the worktree it was made for. */
export type ResourcesRead =
  | { readonly kind: "pending" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "loaded";
      readonly page: ResourcesPageView;
      readonly worktreeId: WorktreeId | null;
    };

/**
 * The page query as the card shows it. Data a query keeps from another key while it reads is not
 * this worktree's, so it reads as pending, never as something to act on.
 */
export const resourcesRead = (
  query: {
    readonly status: "pending" | "error" | "success";
    readonly data: ResourcesPageView | undefined;
    readonly error: unknown;
    readonly isPlaceholderData: boolean;
  },
  worktreeId: WorktreeId | null,
): ResourcesRead => {
  if (query.data !== undefined && !query.isPlaceholderData && query.status === "success") {
    return { kind: "loaded", page: query.data, worktreeId };
  }
  if (query.status === "error") {
    return {
      kind: "failed",
      message: query.error instanceof Error ? query.error.message : String(query.error),
    };
  }
  return { kind: "pending" };
};

/**
 * A choice the server stored, into the page it changed: reads already in flight are cancelled so
 * none lands over it, the answer is shown, then the page is read again so the server's wins.
 */
export const settleChoice = async (
  queryClient: QueryClient,
  queryKey: QueryKey,
  answer: {
    readonly definitionId: string;
    readonly mode: WorktreeChoice;
    readonly statusLine: string;
  },
) => {
  await queryClient.cancelQueries({ queryKey });
  queryClient.setQueryData<ResourcesPageView>(queryKey, (current) =>
    current === undefined
      ? current
      : {
          ...current,
          settings: current.settings.map((each) =>
            each.id === answer.definitionId
              ? { ...each, choice: answer.mode, statusLine: answer.statusLine }
              : each,
          ),
        },
  );
  await queryClient.invalidateQueries({ queryKey });
};
