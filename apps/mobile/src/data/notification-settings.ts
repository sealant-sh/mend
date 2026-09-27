// What this account hears about on its phones — kept on the server, per
// person (GET/PUT /api/me/notifications), because the server decides whom to
// push. Every paired phone of the account reads the same setting.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/data/live";

export interface NotificationSettingsDto {
  /** Sessions started from Slack push what their thread already says. */
  readonly slackSessions: boolean;
  readonly turnFinished: boolean;
  readonly needsInput: boolean;
  readonly failed: boolean;
}

const KEY = ["notification-settings"] as const;

export const useNotificationSettings = (enabled: boolean) =>
  useQuery({
    queryKey: KEY,
    enabled,
    queryFn: () => api<NotificationSettingsDto>("GET", "/me/notifications"),
    staleTime: 60_000,
  });

/** Save the whole setting; the switch moves at once and moves back if the server says no. */
export const useSetNotificationSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (next: NotificationSettingsDto) =>
      api<NotificationSettingsDto>("PUT", "/me/notifications", next),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: KEY });
      const previous = queryClient.getQueryData<NotificationSettingsDto>(KEY);
      queryClient.setQueryData(KEY, next);
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(KEY, context.previous);
    },
    onSuccess: (saved) => queryClient.setQueryData(KEY, saved),
  });
};
