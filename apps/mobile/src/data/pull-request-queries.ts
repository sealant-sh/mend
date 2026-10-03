/**
 * What the pull request card asks the server. Nothing here asks GitHub: Refresh asks the server,
 * which asks `gh` as the change's owner (docs/adr/0007-landing.md).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/data/live";
import type { ChangeLandingDto, SessionLandingsDto } from "@/data/pull-requests";

/**
 * The change's landing facts and whether this account may refresh, read only while a pull
 * request card is on screen: they are git reads on the server, so slower than the session.
 */
export const useSessionLandings = (sessionId: string, enabled: boolean) =>
  useQuery({
    queryKey: ["session-landings", sessionId],
    enabled,
    queryFn: () => api<SessionLandingsDto>("GET", `/sessions/${sessionId}/landings`),
    refetchInterval: 30_000,
  });

/** Ask `gh`, as the change's owner, for the pull request's state now. */
export const useRefreshPullRequest = (sessionId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (landingId: string) =>
      api<ChangeLandingDto>("POST", `/landings/${landingId}/refresh`),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      await queryClient.invalidateQueries({ queryKey: ["session-landings", sessionId] });
    },
  });
};
