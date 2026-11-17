import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button, Chevron } from "#/components/kit/button";
import { Menu, MenuItem, MenuSeparator } from "#/components/kit/menu";
import { ModalDialog } from "#/components/kit/modal";
import { Panel, SettingsSection } from "#/components/kit/section";
import { ErrorNote, errorText } from "#/components/kit/status";
import { DataTable } from "#/components/kit/table";
import type { OrganizationMemberDto } from "#/lib/api";
import { canLeaveOrganization, describeMemberRemoval } from "#/lib/organization";
import { loginWalk, useTRPC } from "#/lib/trpc";

import { day, Notice, OneTimeLinkDialog, useOrganizationView } from "./org-parts";

/** What removing someone does, stated before it happens. */
export const REMOVAL_FACTS = [
  "Their live sessions are checkpointed, then stopped.",
  "Their private projects stay in the organization, hidden. An owner can take one over in Projects.",
  "If this is their last organization, the account is deactivated and its devices signed out. Links already handed out keep their remaining lifetime.",
  "If this is their last organization, their workspace SSH keys are removed too. A key the platform does not remove now, Mend keeps trying until it does.",
] as const;

export const leavingFacts = (organizationName: string): ReadonlyArray<string> => [
  `Your live sessions in ${organizationName} are checkpointed, then stopped.`,
  `Your private projects stay in ${organizationName}, hidden.`,
  "Your account and your other organizations are not touched.",
];

/**
 * O1 · Members: everyone in the organization reads the roster; owners change roles, hand someone
 * a password reset link, and remove people. An organization keeps at least one owner, which the
 * server enforces and reports.
 */
export function MembersTab() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const view = useOrganizationView();
  const members = useSuspenseQuery(trpc.organization.members.queryOptions()).data;
  const memberships = useQuery(trpc.organizations.list.queryOptions(undefined, { retry: false }));
  const owner = view.role === "owner";
  const canLeave = canLeaveOrganization({
    memberships: memberships.data?.length ?? 0,
    role: view.role,
    owners: members.filter((member) => member.role === "owner").length,
  });
  const [removing, setRemoving] = useState<OrganizationMemberDto | null>(null);
  const refresh = () => queryClient.invalidateQueries(trpc.organization.pathFilter());

  const role = useMutation(trpc.organization.setMemberRole.mutationOptions({ onSettled: refresh }));
  // The reset link is a credential: closing its dialog drops it from the mutation cache at once.
  const reset = useMutation(trpc.organization.issuePasswordReset.mutationOptions({ gcTime: 0 }));
  const remove = useMutation(
    trpc.organization.removeMember.mutationOptions({
      onSuccess: () => setRemoving(null),
      onSettled: refresh,
    }),
  );
  const leave = useMutation(
    trpc.organizations.leave.mutationOptions({
      onSuccess: () => loginWalk.organizationChanged(),
    }),
  );
  const leaving = removing?.userId === view.userId;
  const departure = leaving ? leave : remove;
  const resetFor = members.find((member) => member.userId === reset.variables?.userId);
  const notice = remove.data === undefined ? null : describeMemberRemoval(remove.data);
  const actionError = role.error ?? reset.error;
  const pickLeaving = (member: OrganizationMemberDto) => {
    leave.reset();
    setRemoving(member);
  };

  return (
    <Panel>
      <SettingsSection
        title="Members"
        why={
          owner
            ? "Owners can change roles, reset a password or remove someone. An organization keeps at least one owner."
            : "Everyone here sees the organization's shared projects and their own private ones. Owners manage members."
        }
      >
        <DataTable
          label="Members"
          columns={[
            { head: "Name", width: "1fr" },
            { head: "Email", width: "1.6fr" },
            { head: "Role", width: "0.6fr" },
            { head: "Joined", width: "0.7fr" },
            ...(owner || canLeave ? [{ head: "", width: "auto" }] : []),
          ]}
          empty="no members"
          rows={members.map((member) => {
            const self = member.userId === view.userId;
            const busy =
              (role.isPending && role.variables?.userId === member.userId) ||
              (reset.isPending && reset.variables?.userId === member.userId);
            return {
              key: member.userId,
              cells: [
                <span key="name">
                  {member.name}
                  {self ? (
                    <span className="ml-1.5 font-mono text-[11px] text-faint">you</span>
                  ) : null}
                </span>,
                <span key="email" className="font-mono text-[12px] text-ink-2">
                  {member.email}
                </span>,
                <span key="role" className="font-mono text-[12px] text-ink-2">
                  {member.role}
                </span>,
                <span key="joined" className="font-mono text-[12px] text-muted-foreground">
                  {day(member.joinedAt)}
                </span>,
                ...(owner
                  ? [
                      <Menu
                        key="manage"
                        align="end"
                        trigger={
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            aria-label={self ? "Manage your membership" : `Manage ${member.name}`}
                          >
                            {busy ? "Saving…" : self && canLeave ? "Leave…" : "Manage"}
                            {busy ? null : <Chevron />}
                          </Button>
                        }
                      >
                        <MenuItem
                          onClick={() =>
                            role.mutate({
                              userId: member.userId,
                              role: member.role === "owner" ? "member" : "owner",
                            })
                          }
                        >
                          {member.role === "owner" ? "Make member" : "Make owner"}
                        </MenuItem>
                        {member.role === "member" && !self ? (
                          <MenuItem onClick={() => reset.mutate({ userId: member.userId })}>
                            Reset password…
                          </MenuItem>
                        ) : null}
                        {self && !canLeave ? null : (
                          <>
                            <MenuSeparator />
                            <MenuItem
                              className="text-danger data-highlighted:text-danger"
                              onClick={() => {
                                if (self) {
                                  pickLeaving(member);
                                  return;
                                }
                                remove.reset();
                                setRemoving(member);
                              }}
                            >
                              {self ? `Leave ${view.organization.name}…` : "Remove…"}
                            </MenuItem>
                          </>
                        )}
                      </Menu>,
                    ]
                  : canLeave
                    ? [
                        self ? (
                          <Button
                            key="leave"
                            size="sm"
                            variant="ghost"
                            aria-label={`Leave ${view.organization.name}`}
                            onClick={() => pickLeaving(member)}
                          >
                            Leave…
                          </Button>
                        ) : (
                          <span key="leave" />
                        ),
                      ]
                    : []),
              ],
            };
          })}
        />
        {notice === null ? null : <Notice>{notice}</Notice>}
        {actionError === null ? null : (
          <ErrorNote className="mt-3">{errorText(actionError)}</ErrorNote>
        )}
      </SettingsSection>
      <RemoveMemberDialog
        member={removing}
        self={leaving}
        organizationName={view.organization.name}
        pending={departure.isPending || leave.isSuccess}
        error={departure.error === null ? null : errorText(departure.error)}
        onCancel={() => setRemoving(null)}
        onConfirm={(userId) =>
          leaving ? leave.mutate({ id: view.organization.id }) : remove.mutate({ userId })
        }
      />
      <OneTimeLinkDialog
        link={reset.data ?? null}
        title={`Password reset link for ${resetFor?.name ?? "this member"}`}
        description="Setting a password with it signs them out everywhere. Mend sends no email; you hand them the link."
        onClose={() => reset.reset()}
      />
    </Panel>
  );
}

/** Removing someone, or leaving, with what it does stated before it happens. */
export function RemoveMemberDialog({
  member,
  self,
  organizationName,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  readonly member: Pick<OrganizationMemberDto, "userId" | "name"> | null;
  readonly self: boolean;
  readonly organizationName: string;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: (userId: string) => void;
}) {
  const action = self ? `Leave ${organizationName}` : `Remove ${member?.name ?? ""}`;
  return (
    <ModalDialog
      open={member !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
      title={self ? `Leave ${organizationName}?` : `Remove ${member?.name ?? ""}?`}
      width={520}
      footer={
        <>
          <Button variant="ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            className="border-danger text-danger"
            disabled={pending || member === null}
            onClick={() => {
              if (member !== null) onConfirm(member.userId);
            }}
          >
            {pending ? (self ? "Leaving…" : "Removing…") : action}
          </Button>
        </>
      }
    >
      <ul className="grid list-disc gap-1 pl-5 text-[13px] leading-relaxed text-muted-foreground">
        {(self ? leavingFacts(organizationName) : REMOVAL_FACTS).map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
      {error === null ? null : <ErrorNote>{error}</ErrorNote>}
    </ModalDialog>
  );
}
