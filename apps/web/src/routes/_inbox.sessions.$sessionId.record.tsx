import { createFileRoute } from "@tanstack/react-router";

/** The Record tab (screens P6, C6, X5): everything the session did, filterable. */
export const Route = createFileRoute("/_inbox/sessions/$sessionId/record")({
  loader: ({ context: { queryClient, trpc }, params }) => {
    void queryClient.prefetchQuery(trpc.screens.log.queryOptions({ id: params.sessionId }));
  },
});
