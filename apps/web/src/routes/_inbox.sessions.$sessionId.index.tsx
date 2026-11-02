import { createFileRoute } from "@tanstack/react-router";

import { conversationQuery } from "#/lib/conversation";
import { trpcClient } from "#/lib/trpc";

/** The Conversation tab (screens P1, C1, X6): the session route lays it out. */
export const Route = createFileRoute("/_inbox/sessions/$sessionId/")({
  loader: ({ context: { queryClient }, params }) => {
    void queryClient.prefetchQuery(conversationQuery(trpcClient, queryClient, params.sessionId));
  },
});
