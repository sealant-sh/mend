import { createFileRoute } from "@tanstack/react-router";

import { DotfilesPage } from "#/components/settings/dotfiles-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/**
 * Settings → Account → Dotfiles: the dotfiles repository, the home files copied beside it, and
 * secret files. Old `/settings/workspace#…` links to those sections land here.
 */
export const Route = createFileRoute("/_inbox/settings/dotfiles")({
  beforeLoad: guardSettingsPage("a-dotfiles"),
  loader: ({ context: { queryClient, trpc } }) =>
    Promise.all([
      queryClient.ensureQueryData(trpc.settings.dotfiles.queryOptions()),
      queryClient.ensureQueryData(trpc.settings.secretFiles.queryOptions()),
    ]),
  component: DotfilesPage,
});
