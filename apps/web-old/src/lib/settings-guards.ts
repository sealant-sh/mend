import { redirect } from "@tanstack/react-router";

import type { RouterAppContext } from "#/router";

import type { OrganizationViewDto } from "./api.ts";
import { signedInOptions } from "./viewer.ts";

/**
 * Who is looking, for a settings loader: the organization view, or null for an account in none.
 * Read through the cache the settings layout already warmed, so moving between tabs asks once.
 */
export const viewerFor = async ({
  queryClient,
  trpc,
}: RouterAppContext): Promise<OrganizationViewDto | null> => {
  try {
    return await queryClient.ensureQueryData(signedInOptions(trpc));
  } catch {
    return null;
  }
};

/**
 * Organization tabs need an organization, and some need its owner: anyone else lands on Account,
 * the way a control their role does not allow is not shown rather than shown and refused.
 */
export const requireOrganization = async (
  context: RouterAppContext,
  role: "member" | "owner" = "member",
): Promise<OrganizationViewDto> => {
  const view = await viewerFor(context);
  if (view === null || (role === "owner" && view.role !== "owner")) {
    throw redirect({ to: "/settings/account", replace: true });
  }
  return view;
};

/** Instance tabs are the operator's (docs/adr/0003, "Operator"): nobody else sees they exist. */
export const requireOperator = async (context: RouterAppContext): Promise<OrganizationViewDto> => {
  const view = await viewerFor(context);
  if (view === null || !view.operator) throw redirect({ to: "/settings/account", replace: true });
  return view;
};
