import { createFileRoute } from "@tanstack/react-router";

/** The Preview tab (screens P3, C3, X2): the session's Services and their previews. */
export const Route = createFileRoute("/_inbox/sessions/$sessionId/preview")({
  loader: ({ context: { queryClient, trpc } }) => {
    void queryClient.prefetchQuery(trpc.services.list.queryOptions({ all: true }));
  },
});
