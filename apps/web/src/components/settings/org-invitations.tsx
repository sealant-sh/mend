import { invitationState } from "@mend/domain/workbench";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "#/components/kit/button";
import { TextInput } from "#/components/kit/field";
import { FoldSection, Panel, SettingsSection } from "#/components/kit/section";
import { Segment } from "#/components/kit/segment";
import { ErrorNote, errorText } from "#/components/kit/status";
import { DataTable } from "#/components/kit/table";
import type { InvitationDto, OrganizationRoleDto } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

import { day, OneTimeLinkDialog } from "./org-parts";

const ROLES = [
  { value: "member", label: "Member" },
  { value: "owner", label: "Owner" },
] as const satisfies ReadonlyArray<{ value: OrganizationRoleDto; label: string }>;

const forWhom = (invitation: InvitationDto): string => invitation.email ?? "anyone with the link";

/**
 * O2 · Invitations (owners): registration is closed after the first account, so people join with
 * a single-use link. The link itself is shown once, when it is made; the list says who each open
 * one is for and when it expires. Mend sends no email.
 */
export function InvitationsTab() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invitations = useSuspenseQuery(trpc.organization.invitations.queryOptions()).data;
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrganizationRoleDto>("member");
  const refresh = () => queryClient.invalidateQueries(trpc.organization.invitations.pathFilter());

  const create = useMutation(
    trpc.organization.createInvitation.mutationOptions({
      onSuccess: () => setEmail(""),
      onSettled: refresh,
    }),
  );
  const revoke = useMutation(
    trpc.organization.revokeInvitation.mutationOptions({ onSettled: refresh }),
  );

  const now = new Date();
  const open = invitations.filter((invitation) => invitationState(invitation, now) === "open");
  const spent = invitations.filter((invitation) => invitationState(invitation, now) !== "open");

  return (
    <Panel>
      <SettingsSection
        title="Invitations"
        why="Each link works once and expires in 7 days. Whoever opens it creates an account and joins with the role you pick. Bind it to an email when it must not be forwarded."
      >
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate({ role, ...(email.trim() === "" ? {} : { email: email.trim() }) });
          }}
        >
          <TextInput
            sans
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-label="Bind the link to an email (optional)"
            placeholder="email (optional)"
            className="flex-1"
          />
          <Segment label="Role" value={role} onChange={setRole} options={ROLES} />
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "New link"}
          </Button>
        </form>
        {create.error === null ? null : (
          <ErrorNote className="mt-3">{errorText(create.error)}</ErrorNote>
        )}
        <DataTable
          className="mt-3"
          label="Open invitations"
          columns={[
            { head: "For", width: "1.6fr" },
            { head: "Role", width: "0.6fr" },
            { head: "Created", width: "0.7fr" },
            { head: "Expires", width: "0.7fr" },
            { head: "", width: "auto" },
          ]}
          empty="no open invitations"
          rows={open.map((invitation) => ({
            key: invitation.id,
            cells: [
              <span
                key="for"
                className={`font-mono text-[12px] ${invitation.email === null ? "text-muted-foreground" : "text-ink-2"}`}
              >
                {forWhom(invitation)}
              </span>,
              <span key="role" className="font-mono text-[12px] text-ink-2">
                {invitation.role}
              </span>,
              <span key="created" className="font-mono text-[12px] text-muted-foreground">
                {day(invitation.createdAt)}
              </span>,
              <span key="expires" className="font-mono text-[12px] text-muted-foreground">
                {day(invitation.expiresAt)}
              </span>,
              <Button
                key="revoke"
                size="sm"
                variant="ghost"
                disabled={revoke.isPending && revoke.variables?.id === invitation.id}
                aria-label={`Revoke the invitation for ${forWhom(invitation)}`}
                onClick={() => revoke.mutate({ id: invitation.id })}
              >
                {revoke.isPending && revoke.variables?.id === invitation.id
                  ? "Revoking…"
                  : "Revoke"}
              </Button>,
            ],
          }))}
        />
        {revoke.error === null ? null : (
          <ErrorNote className="mt-3">{errorText(revoke.error)}</ErrorNote>
        )}
      </SettingsSection>
      {spent.length === 0 ? null : (
        <FoldSection
          title="Used and closed"
          count={`${spent.length} ${spent.length === 1 ? "link" : "links"}`}
          why="Links that were accepted, revoked or expired. None of them works again."
          summary={spent
            .slice(0, 3)
            .map(
              (invitation) =>
                `${invitation.email ?? "anyone"} · ${invitationState(invitation, now)}`,
            )
            .join(" · ")}
          defaultOpen={false}
        >
          <DataTable
            label="Used and closed invitations"
            columns={[
              { head: "For", width: "1.6fr" },
              { head: "Role", width: "0.6fr" },
              { head: "State", width: "0.7fr" },
              { head: "Created", width: "0.7fr" },
            ]}
            rows={spent.map((invitation) => ({
              key: invitation.id,
              cells: [
                <span key="for" className="font-mono text-[12px] text-ink-2">
                  {forWhom(invitation)}
                </span>,
                <span key="role" className="font-mono text-[12px] text-ink-2">
                  {invitation.role}
                </span>,
                <span key="state" className="font-mono text-[12px] text-muted-foreground">
                  {invitationState(invitation, now)}
                </span>,
                <span key="created" className="font-mono text-[12px] text-muted-foreground">
                  {day(invitation.createdAt)}
                </span>,
              ],
            }))}
          />
        </FoldSection>
      )}
      <OneTimeLinkDialog
        link={
          create.data === undefined
            ? null
            : { path: create.data.path, expiresAt: create.data.invitation.expiresAt }
        }
        title="Invitation link"
        description={`For ${create.data?.invitation.email ?? "anyone with the link"}, joining as ${create.data?.invitation.role ?? "a member"}. Copy it now: Mend shows it only this once.`}
        onClose={() => create.reset()}
      />
    </Panel>
  );
}
