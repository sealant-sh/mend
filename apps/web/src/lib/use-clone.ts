import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import {
  type AdoptionAttempt,
  adoptionProgressOptions,
  forgetAdoption,
  rememberAdoption,
  useAdoptionAttempt,
} from "./adoptions.ts";
import type { AdoptionProgressDto, ProjectDto } from "./api.ts";
import { cloneStateOf } from "./clone-state.ts";
import { useTRPC } from "./trpc.ts";

/** What a person asked to clone: kept so a failed clone can be tried again as it was. */
export interface CloneRequest {
  readonly name: string;
  readonly source: string;
  readonly visibility: ProjectDto["visibility"];
}

/** A failed clone's request, when the browser kept what it asked for. */
export const retryOf = (attempt: AdoptionAttempt): CloneRequest | null =>
  attempt.source === null
    ? null
    : { name: attempt.name, source: attempt.source, visibility: attempt.visibility ?? "private" };

/**
 * The clone this browser started (`lib/adoptions`) and where it stands, shared by the pages that
 * add a project: setup's First project step, and Projects' Add project dialog with the row that
 * stands for the clone in its list. `progress` is the server's last read of it, null before the
 * first one. `start` begins a new clone in place of the last.
 */
export function useClone(userId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const attempt = useAdoptionAttempt(userId);
  const read = useQuery({
    ...adoptionProgressOptions(trpc, attempt?.id ?? ""),
    // The first read can reach the server before the clone does; ask again before giving up.
    retry: 3,
    retryDelay: 1_000,
    enabled: attempt !== null,
  });
  const adopt = useMutation(
    trpc.projects.adopt.mutationOptions({
      // The list gains the project, and the Projects list's clone row goes, however it ended.
      onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() }),
    }),
  );
  const ownRequest = attempt !== null && adopt.variables?.adoptionId === attempt.id;
  const progress: AdoptionProgressDto | null = read.isPending || read.isError ? null : read.data;
  const state =
    attempt === null
      ? null
      : cloneStateOf(
          { data: progress ?? undefined, failed: read.isError },
          {
            pending: ownRequest && adopt.isPending,
            project: ownRequest ? adopt.data : undefined,
            error: ownRequest ? adopt.error : null,
          },
        );
  const added = state?._tag === "Added" ? state.projectId : null;
  // The clone ended in a project: the list reads it from the server now.
  useEffect(() => {
    if (added !== null)
      void queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() });
  }, [added, queryClient, trpc]);
  const start = (request: CloneRequest) => {
    const id = crypto.randomUUID();
    rememberAdoption(userId, {
      id,
      name: request.name,
      startedAt: Date.now(),
      source: request.source,
      visibility: request.visibility,
    });
    adopt.mutate({
      name: request.name,
      source: request.source,
      visibility: request.visibility,
      adoptionId: id,
    });
  };
  return { attempt, state, progress, start, forget: () => forgetAdoption(userId) };
}

export type Clone = ReturnType<typeof useClone>;
