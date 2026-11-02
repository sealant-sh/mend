import { createFileRoute } from "@tanstack/react-router";

import { Exposure } from "#/components/settings/exposure";
import { requireOperator } from "#/lib/settings-guards";

export const Route = createFileRoute("/settings/instance/exposure")({
  beforeLoad: ({ context }) => requireOperator(context),
  loader: ({ context: { queryClient, trpc } }) =>
    queryClient.prefetchQuery(trpc.platform.exposure.queryOptions(undefined, { retry: false })),
  component: Exposure,
});
