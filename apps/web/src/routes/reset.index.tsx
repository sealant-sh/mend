import { createFileRoute } from "@tanstack/react-router";

import { ResetPage } from "#/components/reset-page";

export const Route = createFileRoute("/reset/")({
  ssr: false,
  component: ResetPage,
});
