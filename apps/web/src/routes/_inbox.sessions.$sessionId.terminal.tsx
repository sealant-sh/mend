import { createFileRoute } from "@tanstack/react-router";

/** The Terminal tab (screens P5, C5, X4): the agent's terminal and the shells in its workspace. */
export const Route = createFileRoute("/_inbox/sessions/$sessionId/terminal")({
  loader: ({ context: { queryClient, trpc }, params }) => {
    void queryClient.prefetchQuery(trpc.sessions.processes.queryOptions({ id: params.sessionId }));
  },
});
