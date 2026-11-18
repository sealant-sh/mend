import { WorktreeId } from "@mend/domain";
import { isLoopbackHostname } from "@mend/domain/workbench";
import { infiniteQueryOptions, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";

import { useWorktreePreviews } from "#/lib/previews";
import { useTRPC, useTRPCClient } from "#/lib/trpc";
import {
  fileRecipes,
  readPreviews,
  shownService,
  workspaceServices,
  type WorkspaceService,
} from "#/lib/workspace-services";
import { workspaceRuns } from "#/lib/workspace-shells";

import type { ViewPlace } from "../views.tsx";
import { useWorkspaceShells } from "./use-workspace-shells.ts";

/** How often the list is read again while a Service runs that Mend hasn't seen answer yet. */
const UNSETTLED_POLL_MS = 3_000;

/**
 * The workspace's Services, the recipes its `.mend/mend.toml` declares, and its previews. Each read
 * is a cached query: the workbench events read the list and the previews again when a Service's
 * process starts, binds its port or ends, so the tab, its "+" item and the view share them.
 */
export const useWorkspaceServices = (place: ViewPlace) => {
  const trpc = useTRPC();
  const workspace = useWorkspaceShells(place);
  const sessionIds = new Set(workspace.sessions.map((session) => session.id));
  const list = useQuery(
    trpc.services.list.queryOptions(
      { all: true },
      {
        // An observation (the port answering) comes with no event of its own.
        refetchInterval: (query) =>
          (query.state.data ?? []).some(
            (view) =>
              sessionIds.has(view.service.sessionId) &&
              view.currentForward?.state === "bound" &&
              view.latestObservation?.state !== "reachable",
          )
            ? UNSETTLED_POLL_MS
            : false,
      },
    ),
  );
  const recipes = useQuery(trpc.sessions.recipes.queryOptions({ id: place.sessionId }));
  const previews = useWorktreePreviews(WorktreeId.make(place.worktreeId));
  const services = list.isPending || list.isError ? [] : workspaceServices(list.data, sessionIds);
  const offered = recipes.isPending || recipes.isError ? [] : fileRecipes(recipes.data, services);
  return {
    ...workspace,
    runs: workspaceRuns(workspace.sessions),
    list,
    services,
    recipes,
    offered,
    previewsRead: previews,
    previews: readPreviews(
      previews,
      place.sessionId,
      services,
      offered.map((recipe) => recipe.name),
    ),
  };
};

/**
 * The Service each workspace's Preview shows, by name, so its tab's port and its view agree. Kept
 * while the page is open; a new page shows the first web page that runs.
 */
const picks = new Map<string, string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const usePickedService = (worktreeId: string) => {
  const picked = useSyncExternalStore(
    subscribe,
    () => picks.get(worktreeId) ?? null,
    () => null,
  );
  const pick = (name: string) => {
    picks.set(worktreeId, name);
    for (const listener of listeners) listener();
  };
  return [picked, pick] as const;
};

/** The Service the place's Preview shows now. */
export const useShownService = (
  place: ViewPlace,
  services: ReadonlyArray<WorkspaceService>,
): WorkspaceService | null => shownService(services, usePickedService(place.worktreeId)[0]);

const noSubscription = () => () => {};

/**
 * Whether this page runs on the Mend host, where a loopback endpoint answers. The page's own
 * host says so; the server render keeps today's answer (yes) and the client corrects it.
 */
export const useOnMendHost = (): boolean =>
  useSyncExternalStore(
    noSubscription,
    () => isLoopbackHostname(window.location.hostname),
    () => true,
  );

/** How many chunks one read of a log asks for: the most the API gives. */
const LOG_PAGE = 1_000;
/** How often an open log of a running Service reads what it printed since. */
const LOG_FOLLOW_MS = 2_000;
/** Pages kept; older ones fall away as new output arrives (the record keeps them). */
const LOG_PAGES_KEPT = 20;

/**
 * A Service attempt's recorded output, from its start, read on while `follow` (the Service runs
 * and its log is open). Null `processId` (an adopted port, which has no process of Mend's) reads
 * nothing.
 */
export const useServiceLog = (processId: string | null, follow: boolean) => {
  const client = useTRPCClient();
  const log = useInfiniteQuery(
    infiniteQueryOptions({
      // Not under tRPC's own keys: an event that reads every Services query again would read the
      // whole record again too. Reading on moves it.
      queryKey: ["service-log", processId],
      queryFn: ({ pageParam }) =>
        client.services.logs.query({
          processId: processId ?? "",
          from: pageParam,
          limit: LOG_PAGE,
        }),
      initialPageParam: "0",
      getNextPageParam: (last) => last.nextFrom,
      maxPages: LOG_PAGES_KEPT,
      enabled: processId !== null,
      staleTime: Number.POSITIVE_INFINITY,
    }),
  );
  const { fetchNextPage, isFetchingNextPage, data } = log;
  const behind = data?.pages.at(-1)?.chunks.length === LOG_PAGE;
  // A full page means more is already recorded: read it now. Otherwise, while the Service runs,
  // look again every few seconds for what it printed since.
  useEffect(() => {
    if (processId === null || data === undefined || isFetchingNextPage) return;
    if (behind) {
      void fetchNextPage();
      return;
    }
    if (!follow) return;
    const timer = setTimeout(() => void fetchNextPage(), LOG_FOLLOW_MS);
    return () => clearTimeout(timer);
  }, [processId, data, behind, follow, isFetchingNextPage, fetchNextPage]);
  return log;
};
