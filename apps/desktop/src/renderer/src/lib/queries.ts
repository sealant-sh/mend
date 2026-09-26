import { QueryClient, queryOptions } from "@tanstack/react-query";

import {
  changeComments,
  getSealantIdentity,
  getSettings,
  isUnauthorized,
  listProjects,
  listServices,
  listSessionProcesses,
  listSessionRecipes,
  processOutput,
  projectDetail,
  projectFiles,
  projectPullRequests,
  reviewDiff,
  sessionDetail,
  sessionLandings,
  sessionTranscript,
} from "#/lib/api";

/**
 * One QueryClient for the cockpit. Workbench events invalidate by key
 * (#/lib/events); a 401 is never retried — the credential is the problem,
 * and the connect screen is the fix.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: (count, error) => !isUnauthorized(error) && count < 1,
    },
  },
});

export const sealantIdentityQuery = queryOptions({
  queryKey: ["sealant-identity"],
  queryFn: getSealantIdentity,
});

export const projectsQuery = queryOptions({
  queryKey: ["projects"],
  queryFn: listProjects,
});

export const projectDetailQuery = (id: string) =>
  queryOptions({
    queryKey: ["project", id],
    queryFn: () => projectDetail(id),
  });

export const sessionDetailQuery = (id: string) =>
  queryOptions({
    queryKey: ["session", id],
    queryFn: () => sessionDetail(id),
  });

export const sessionProcessesQuery = (id: string) =>
  queryOptions({
    queryKey: ["session", id, "processes"],
    queryFn: () => listSessionProcesses(id),
  });

/**
 * The change's landing record as this session reads it. A server from before landing answers
 * 404, which reads as nothing to show.
 */
export const sessionLandingsQuery = (id: string) =>
  queryOptions({
    queryKey: ["session", id, "landings"],
    queryFn: () => sessionLandings(id),
    retry: false,
  });

/**
 * Every session's read of a landing record. The record is the change's, and every session in
 * the worktree reads the same one, while an event names only the session that landed or ran
 * the turn; so a landing, or a turn's landing decision, refreshes all of them, as the web does.
 */
export const isLandingsQuery = (query: { readonly queryKey: ReadonlyArray<unknown> }): boolean =>
  query.queryKey[0] === "session" && query.queryKey[2] === "landings";

export const invalidateLandings = () =>
  queryClient.invalidateQueries({ predicate: isLandingsQuery });

/** Settings change rarely, and only from the web app's Settings. */
export const settingsQuery = queryOptions({
  queryKey: ["settings"],
  queryFn: getSettings,
  staleTime: 60_000,
});

export const servicesQuery = queryOptions({
  queryKey: ["services"],
  queryFn: listServices,
});

export const sessionRecipesQuery = (id: string) =>
  queryOptions({
    queryKey: ["session", id, "recipes"],
    queryFn: () => listSessionRecipes(id),
  });

export const sessionTranscriptQuery = (id: string) =>
  queryOptions({
    queryKey: ["session", id, "transcript"],
    queryFn: () => sessionTranscript(id),
    staleTime: Number.POSITIVE_INFINITY,
  });

export const processOutputQuery = (id: string) =>
  queryOptions({
    queryKey: ["process", id, "output"],
    queryFn: () => processOutput(id),
    staleTime: Number.POSITIVE_INFINITY,
  });

export const reviewDiffQuery = (
  changeId: string,
  sliceId: string,
  options: { readonly whitespace: "include" | "ignore"; readonly context: number },
) =>
  queryOptions({
    queryKey: ["change", changeId, "review", sliceId, options],
    queryFn: () => reviewDiff(changeId, sliceId, options),
  });

export const reviewCommentsQuery = (changeId: string) =>
  queryOptions({
    queryKey: ["change", changeId, "comments"],
    queryFn: () => changeComments(changeId),
  });

export const projectFilesQuery = (projectId: string, sessionId: string | null) =>
  queryOptions({
    queryKey: ["project", projectId, "files", sessionId],
    queryFn: () => projectFiles(projectId, sessionId),
    staleTime: 30_000,
  });

/** Pull requests are a remote read through gh; refetch on a timer, not on every focus. */
export const projectPullRequestsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["project", projectId, "pull-requests"],
    queryFn: () => projectPullRequests(projectId),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
