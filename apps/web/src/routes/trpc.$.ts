import { loadPublicNetwork } from "@mend/network";
import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";

import { createTrpcHandler } from "../server/trpc-handler.ts";

/**
 * The tRPC surface as a Start SERVER route: nitro bundles and serves it with
 * the app, so /trpc exists wherever the app runs — vite dev, the nitro
 * output, the combined single-host image — with no separate host process.
 * Procedures forward to the API (MEND_API_URL) with the caller's credentials.
 */
let configuredHandler: Promise<ReturnType<typeof createTrpcHandler>> | undefined;
const handler = async ({ request }: { readonly request: Request }) => {
  // Parse once at the server route boundary, not during a client/build import.
  configuredHandler ??= Effect.runPromise(loadPublicNetwork).then((network) =>
    createTrpcHandler({
      network,
      apiUrl: new URL(process.env["MEND_API_URL"] ?? "http://localhost:3101").origin,
    }),
  );
  return (await configuredHandler)(request);
};

export const Route = createFileRoute("/trpc/$")({
  server: {
    handlers: {
      GET: handler,
      POST: handler,
    },
  },
});
