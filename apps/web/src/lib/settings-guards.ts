import { redirect } from "@tanstack/react-router";

import type { RouterAppContext } from "../router.tsx";
import {
  mayOpen,
  oldSettingsPath,
  pageAt,
  settingsPage,
  type SettingsPageId,
  type SettingsViewer,
} from "./settings-pages.ts";
import { signedInOptions } from "./sign-in.ts";

/** Where someone lands when a page isn't theirs to open: their own Profile. */
export const SETTINGS_HOME = "/settings/profile";

/**
 * Who is looking, for a settings loader: their role and whether they operate the server. Read
 * through the cache the root route already warmed, so moving between pages asks once.
 */
export const settingsViewerFor = async ({
  queryClient,
  trpc,
}: Pick<RouterAppContext, "queryClient" | "trpc">): Promise<SettingsViewer> => {
  const view = await queryClient.ensureQueryData(signedInOptions(trpc));
  return { role: view.role, operator: view.operator };
};

/**
 * A settings page's `beforeLoad`: anyone the page isn't for lands on Profile, so an owner's page
 * or the Server is refused by address as well as left out of the sidebar, the way a control a
 * role doesn't allow is not shown rather than shown and refused.
 *
 * ```ts
 * export const Route = createFileRoute("/_inbox/settings/organization/audit-log")({
 *   beforeLoad: guardSettingsPage("o-audit"),
 *   component: AuditLogPage,
 * });
 * ```
 */
export const guardSettingsPage =
  (id: SettingsPageId) =>
  async ({ context }: { readonly context: Pick<RouterAppContext, "queryClient" | "trpc"> }) => {
    if (!mayOpen(settingsPage(id), await settingsViewerFor(context))) {
      throw redirect({ to: SETTINGS_HOME, replace: true });
    }
  };

/**
 * An address under Settings that no page's route owns yet: an old address goes to its new home,
 * a page the person may not open goes to Profile, and anything else is the page's own address,
 * not built yet. Answers where to go, or null to stay.
 */
export const laterSettingsTarget = (pathname: string, viewer: SettingsViewer): string | null => {
  const moved = oldSettingsPath(pathname);
  const at = pageAt(moved ?? pathname);
  if (at !== null && !mayOpen(at.page, viewer)) return SETTINGS_HOME;
  return moved;
};
