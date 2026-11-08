import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery } from "@tanstack/react-query";

import { Eyebrow, focusRing } from "#/components/kit/button";
import { ErrorNote, errorText } from "#/components/kit/status";
import { organizationMenu } from "#/lib/organization";
import { loginWalk, useTRPC } from "#/lib/trpc";
import { useSignedInQuery } from "#/lib/viewer";

export const useOrganizationMenu = () => {
  const trpc = useTRPC();
  const tenancy = useSignedInQuery().data?.tenancy;
  const memberships = useQuery(
    trpc.organizations.list.queryOptions(undefined, {
      enabled: tenancy === "multi",
      retry: false,
      staleTime: 60_000,
    }),
  ).data;
  return organizationMenu(tenancy, memberships);
};

const ROW =
  "flex w-full items-baseline gap-2 rounded-lg px-1.5 py-1 font-sans text-[13px] font-medium";
const ROLE = "ml-auto shrink-0 font-mono text-[11.5px] font-normal";

export function OrganizationBlock({
  menu,
}: {
  readonly menu: NonNullable<ReturnType<typeof organizationMenu>>;
}) {
  const trpc = useTRPC();
  const switching = useMutation(
    trpc.organizations.switch.mutationOptions({ onSuccess: () => loginWalk.organizationChanged() }),
  );
  const busy = switching.isPending || switching.isSuccess;
  return (
    <div className="flex flex-col gap-1.5 border-t border-rule-faint pt-3">
      <Eyebrow>organization</Eyebrow>
      {menu.others.length === 0 ? (
        <p className="truncate font-sans text-[13px] font-medium text-foreground">
          {menu.current.organization.name}
        </p>
      ) : (
        <ul aria-label="Your organizations" className="-mx-1.5 flex flex-col gap-px">
          <li aria-current="true" className={cn(ROW, "bg-wash text-info")}>
            <span className="truncate">{menu.current.organization.name}</span>
            <span className={ROLE}>{menu.current.role}</span>
          </li>
          {menu.others.map((membership) => {
            const pending =
              busy && switching.variables?.organizationId === membership.organization.id;
            return (
              <li key={membership.organization.id}>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Switch to ${membership.organization.name}, ${membership.role}`}
                  onClick={() => switching.mutate({ organizationId: membership.organization.id })}
                  className={cn(
                    ROW,
                    "text-left text-ink-2 transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-60",
                    focusRing,
                  )}
                >
                  <span className="truncate">{membership.organization.name}</span>
                  <span className={cn(ROLE, "text-faint")}>
                    {pending ? "switching…" : membership.role}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {switching.error === null ? null : (
        <ErrorNote className="text-[12.5px]">{errorText(switching.error)}</ErrorNote>
      )}
    </div>
  );
}
