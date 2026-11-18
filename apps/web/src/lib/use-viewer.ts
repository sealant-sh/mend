import { useQuery, useSuspenseQuery } from "@tanstack/react-query";

import { signedInOptions } from "./sign-in.ts";
import { useTRPC } from "./trpc.ts";

/** Who is signed in, and the organization this browser acts in, as the sidebar names them. */
export interface Viewer {
  readonly organizationName: string;
  /** Empty until the roster answers, or if it can't: the account row then names the server. */
  readonly account: { readonly name: string; readonly email: string };
}

/**
 * The signed-in person and their organization, for the signed-in pages under the `_inbox` layout.
 * The root route read who is signed in before any of them rendered; the organization's roster
 * names them.
 */
export const useViewer = (): Viewer => {
  const trpc = useTRPC();
  const viewer = useSuspenseQuery(signedInOptions(trpc));
  const members = useQuery(trpc.organization.members.queryOptions());
  // A roster that failed to read again keeps the names it had.
  const roster =
    members.isPending || (members.isError && members.data === undefined) ? [] : members.data;
  const me = roster?.find((member) => member.userId === viewer.data.userId);
  return {
    organizationName: viewer.data.organization.name,
    account: { name: me?.name ?? "", email: me?.email ?? "" },
  };
};
