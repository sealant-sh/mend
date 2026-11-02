import { createFileRoute } from "@tanstack/react-router";

/** The Screen tab (screens P4, P4b, C4, X3, X7): the agent's screen and its log. */
export const Route = createFileRoute("/sessions/$sessionId/screen")({
  loader: ({ context: { queryClient, trpc }, params }) => {
    void queryClient.prefetchQuery(trpc.screens.log.queryOptions({ id: params.sessionId }));
  },
});
