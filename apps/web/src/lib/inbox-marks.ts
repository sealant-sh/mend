import { SessionId } from "@mend/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { SessionInboxMarkDto } from "./api.ts";
import { useTRPC } from "./trpc.ts";

/** The signed-in person's inbox marks: settled sessions, and snoozes not yet over. */
export const useInboxMarks = () => {
  const trpc = useTRPC();
  return useQuery(trpc.sessions.inboxMarks.queryOptions(undefined, { staleTime: 30_000 }));
};

/** A mark as a caller sends it: `until` may still be its wire string. */
type MarkInput =
  | { readonly _tag: "Snoozed"; readonly until: Date | string }
  | { readonly _tag: "Settled" }
  | { readonly _tag: "Inbox" };

const applied = (
  marks: ReadonlyArray<SessionInboxMarkDto>,
  id: SessionId,
  mark: MarkInput,
  now: Date,
): ReadonlyArray<SessionInboxMarkDto> => {
  const others = marks.filter((row) => row.sessionId !== id);
  switch (mark._tag) {
    case "Inbox":
      return others;
    case "Settled":
      return [...others, { sessionId: id, snoozedUntil: null, settledAt: now }];
    case "Snoozed":
      return [...others, { sessionId: id, snoozedUntil: new Date(mark.until), settledAt: null }];
  }
};

/**
 * Snooze, settle, or return a session to the inbox. The row moves at once; if the server refuses,
 * it moves back and `error` says why. The server's answer replaces the guess when it arrives.
 */
export const useSetInboxMark = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const key = trpc.sessions.inboxMarks.queryKey();
  return useMutation(
    trpc.sessions.setInboxMark.mutationOptions({
      onMutate: async ({ id, mark }) => {
        await queryClient.cancelQueries({ queryKey: key });
        const before = queryClient.getQueryData(key);
        queryClient.setQueryData(key, applied(before ?? [], SessionId.make(id), mark, new Date()));
        return { before };
      },
      onError: (_error, _input, context) => {
        if (context !== undefined) queryClient.setQueryData(key, context.before);
      },
      onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
    }),
  );
};
