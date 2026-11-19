import { createFileRoute } from "@tanstack/react-router";

import {
  sealantConnectionOptions,
  ServerPage,
  serverQueries,
} from "#/components/settings/server-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/**
 * (The file name escapes `server` in brackets: TanStack Start keeps any `*.server.*` file out of
 * the browser's bundle.)
 *
 * Settings → Server: what the server's operators read about the server they run. Anyone else is
 * sent to Profile before the page reads anything (the API answers them 404). The loader waits for
 * each section's read apart, so one that fails shows its own Try again; the Sealant check is a
 * live round-trip, started and not awaited, so the page says "Checking…" meanwhile.
 */
export const Route = createFileRoute("/_inbox/settings/server")({
  beforeLoad: guardSettingsPage("s-server"),
  loader: async ({ context: { queryClient, trpc } }) => {
    void queryClient.prefetchQuery(sealantConnectionOptions(trpc));
    const queries = serverQueries(trpc);
    await Promise.all([
      queryClient.prefetchQuery(queries.exposure),
      queryClient.prefetchQuery(queries.machine),
      queryClient.prefetchQuery(queries.health),
      queryClient.prefetchQuery(queries.settings),
      queryClient.prefetchQuery(queries.organizations),
      queryClient.prefetchQuery(queries.gate),
    ]);
  },
  component: ServerPage,
});
