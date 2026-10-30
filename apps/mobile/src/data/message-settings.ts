// How Send works in a live conversation, per person (GET/PUT /api/me/message-settings): into their
// own running turn, or always as their next turn. Kept on the server, so every client of the
// account sends the same way.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { usePairing } from "@/data/pairing-scope";

export interface MessageSettingsDto {
  readonly sendSteersRunningTurn: boolean;
}

const KEY = ["message-settings"] as const;

export const useMessageSettings = (enabled: boolean) => {
  const { machine } = usePairing();
  return useQuery({
    queryKey: KEY,
    enabled,
    queryFn: () => machine.read<MessageSettingsDto>("/me/message-settings"),
    staleTime: 60_000,
  });
};

/** Save the setting; the switch moves at once and moves back if the server says no. */
export const useSetMessageSettings = () => {
  const { machine } = usePairing();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (next: MessageSettingsDto) =>
      machine.write<MessageSettingsDto>("PUT", "/me/message-settings", next),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: KEY });
      const previous = queryClient.getQueryData<MessageSettingsDto>(KEY);
      queryClient.setQueryData(KEY, next);
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(KEY, context.previous);
    },
    onSuccess: (saved) => queryClient.setQueryData(KEY, saved),
  });
};
