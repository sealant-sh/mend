import { InlineAlert } from "@mend/ui/components/banner";
import { CopyField } from "@mend/ui/components/copy-field";
import { Segmented } from "@mend/ui/components/segmented";
import { Avatar, AvatarFallback } from "@mend/ui/components/ui/avatar";
import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { Input } from "@mend/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@mend/ui/components/ui/native-select";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@mend/ui/components/ui/select";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  EllipsisIcon,
  KeyRoundIcon,
  LockIcon,
  LogOutIcon,
  MailIcon,
  ShieldIcon,
  UserCogIcon,
  UserMinusIcon,
  XIcon,
} from "lucide-react";
import { type RefObject, useEffect, useId, useRef, useState } from "react";

import { inboxQuery } from "#/lib/inbox-live";
import { initialsOf } from "#/lib/organization";
import {
  closedFold,
  closedState,
  createdLine,
  DEFAULT_EXPIRY_DAYS,
  emailProblem,
  EXPIRY_DAYS,
  expiresLine,
  expiryLabel,
  firstNameOf,
  invitationGroups,
  type InvitationRow,
  isNew,
  isOnlyOwner,
  joinedWithYours,
  linkOf,
  MAX_EXPIRY_DAYS,
  type Member,
  noOpenInvitations,
  refusalWords,
  removalLines,
  removalSessionsOf,
  removedToast,
  resetOffer,
  type Role,
  roleChanged,
  roleHint,
  roleWord,
  rosterOrder,
  sentTo,
  shortDay,
  whoCanUse,
} from "#/lib/organization-members";
import { usePhone } from "#/lib/phone";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";

import { LeaveOrganizationDialog } from "../organization-dialogs.tsx";
import { Overlay } from "../projects/overlay.tsx";
import { SettingSection } from "./setting-row.tsx";
import { SettingsPage } from "./settings-page.tsx";

/** A control's height: the frames' 36px on the desk, a 44px touch target on a phone. */
const CONTROL = "h-9 max-lg:h-11 max-lg:text-base";

/**
 * Settings → the organization → Members (Doop page 6 "Invite someone", "Linus joins", "Change a
 * role", "Remove a member"; page 7 "Members"): everyone reads the roster; owners change roles,
 * hand a member a password reset link, remove people, and make and revoke invitation links. The
 * route's loader read the roster, and the invitations for an owner.
 */
export function OrganizationMembersPage() {
  const trpc = useTRPC();
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const roster = useSuspenseQuery(trpc.organization.members.queryOptions()).data;
  const organization = viewer.organization;
  const owner = viewer.role === "owner";
  const people = rosterOrder(roster, viewer.userId);
  const [reset, setReset] = useState<{ readonly name: string; readonly link: string } | null>(null);
  return (
    <SettingsPage
      page="o-members"
      intro={
        owner
          ? `These are the people in ${organization.name}. Owners can invite people, change roles and remove members.`
          : `These are the people in ${organization.name}. Owners invite people, change roles and remove members.`
      }
    >
      <SettingSection title="Members" count={roster.length}>
        {reset === null ? null : (
          <ResetLinkPanel name={reset.name} link={reset.link} onClose={() => setReset(null)} />
        )}
        <MembersTable
          people={people}
          roster={roster}
          viewerId={viewer.userId}
          owner={owner}
          organization={organization}
          onReset={setReset}
        />
        {owner && isOnlyOwner(roster, viewer.userId) ? (
          <InlineAlert
            tone="info"
            icon={<ShieldIcon aria-hidden />}
            title={`You're ${organization.name}'s only owner.`}
            className="mt-4 max-lg:mx-4"
          >
            Make someone else an owner before you leave or change your own role. {organization.name}{" "}
            always needs at least one owner.
          </InlineAlert>
        ) : null}
      </SettingSection>
      {owner ? (
        <Invitations organization={organization.name} viewerId={viewer.userId} roster={roster} />
      ) : null}
    </SettingsPage>
  );
}

/** The roster: one row per person, their role (a menu for an owner), when they joined, and "…". */
function MembersTable({
  people,
  roster,
  viewerId,
  owner,
  organization,
  onReset,
}: {
  readonly people: ReadonlyArray<Member>;
  readonly roster: ReadonlyArray<Member>;
  readonly viewerId: string;
  readonly owner: boolean;
  readonly organization: { readonly id: string; readonly name: string };
  readonly onReset: (reset: { readonly name: string; readonly link: string }) => void;
}) {
  return (
    <div role="table" aria-label={`${organization.name}'s members`} className="text-row">
      <div
        role="row"
        className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1.6fr)_9rem_7rem_2.5rem] items-center gap-4 border-b border-border py-2 text-meta text-muted-foreground max-lg:hidden"
      >
        <span role="columnheader">Name</span>
        <span role="columnheader">Email</span>
        <span role="columnheader">Role</span>
        <span role="columnheader">Joined</span>
        <span role="columnheader" className="sr-only">
          Actions
        </span>
      </div>
      {people.map((member) => (
        <MemberRow
          key={member.userId}
          member={member}
          roster={roster}
          you={member.userId === viewerId}
          owner={owner}
          organization={organization}
          onReset={onReset}
        />
      ))}
    </div>
  );
}

function MemberRow({
  member,
  roster,
  you,
  owner,
  organization,
  onReset,
}: {
  readonly member: Member;
  readonly roster: ReadonlyArray<Member>;
  readonly you: boolean;
  readonly owner: boolean;
  readonly organization: { readonly id: string; readonly name: string };
  readonly onReset: (reset: { readonly name: string; readonly link: string }) => void;
}) {
  const onlyOwner = isOnlyOwner(roster, member.userId);
  const [refusal, setRefusal] = useState<string | null>(null);
  const role = useRoleChange(member, organization.name, setRefusal);
  return (
    <div role="row" className="border-b border-border max-lg:px-4">
      <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1.6fr)_9rem_7rem_2.5rem] items-center gap-4 py-3 max-lg:grid-cols-[minmax(0,1fr)_auto] max-lg:gap-x-3 max-lg:gap-y-2">
        <div role="cell" className="flex min-w-0 items-center gap-3">
          <Avatar size="sm" aria-hidden>
            <AvatarFallback className="font-medium">
              {initialsOf(member.name, member.email)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate">
              <span className="font-medium text-foreground">{member.name}</span>
              {you ? (
                <span className="ml-1.5 text-meta text-muted-foreground max-lg:hidden">
                  You{onlyOwner ? " · only owner" : ""}
                </span>
              ) : isNew(member) ? (
                <span className="ml-1.5 text-meta text-muted-foreground max-lg:hidden">New</span>
              ) : null}
            </p>
            <p className="truncate text-meta text-muted-foreground lg:hidden">
              {phoneLine(member, you, onlyOwner)}
            </p>
          </div>
        </div>
        <div role="cell" className="truncate text-muted-foreground max-lg:hidden">
          {member.email}
        </div>
        <div role="cell" className="max-lg:col-start-2 max-lg:row-start-1 max-lg:hidden">
          <RoleControl
            member={member}
            owner={owner}
            onlyOwner={onlyOwner}
            organization={organization.name}
            role={role}
          />
        </div>
        <div role="cell" className="text-muted-foreground max-lg:hidden">
          {shortDay(member.joinedAt)}
        </div>
        <div
          role="cell"
          className="flex items-center justify-end gap-1 max-lg:col-start-2 max-lg:row-start-1"
        >
          {/* On a phone the role is a word here, and changes from the menu (Doop phone frames). */}
          <span className="text-muted-foreground lg:hidden">
            {role.pending ? "Saving…" : roleWord(member.role)}
          </span>
          <MemberMenu
            member={member}
            you={you}
            owner={owner}
            onlyOwner={onlyOwner}
            organization={organization}
            onReset={onReset}
            onRefused={setRefusal}
            role={role}
          />
        </div>
      </div>
      {refusal === null ? null : (
        <p role="alert" className="pb-3 text-row text-destructive">
          {refusal}
        </p>
      )}
    </div>
  );
}

/** A role change, shared by the row's role menu (desk) and its "…" menu (every width). */
interface RoleChange {
  readonly pending: boolean;
  readonly change: (role: Role) => void;
}

/**
 * Changing someone's role: it applies at once, says so in a toast with Undo, and a refusal (the
 * last owner, an access key) is said under the row in the server's words.
 */
const useRoleChange = (
  member: Member,
  organization: string,
  onRefused: (words: string | null) => void,
): RoleChange => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const mutation = useMutation(
    trpc.organization.setMemberRole.mutationOptions({
      onSettled: () => queryClient.invalidateQueries(trpc.organization.pathFilter()),
    }),
  );
  const apply = async (role: Role, undo: boolean) => {
    onRefused(null);
    try {
      await mutation.mutateAsync({ userId: member.userId, role });
      if (undo) return;
      const before = member.role;
      toast.add({
        description: roleChanged(member, role, organization),
        priority: "low",
        actionProps: {
          children: "Undo",
          onClick: () => {
            void apply(before, true);
          },
        },
      });
    } catch (error) {
      onRefused(refusalWords(error, `Mend didn't change ${member.name}'s role. Try again.`));
    }
  };
  return { pending: mutation.isPending, change: (role) => void apply(role, false) };
};

/** A row's second line on a phone (Doop "Phone · Members · list"). */
const phoneLine = (member: Member, you: boolean, onlyOwner: boolean): string => {
  if (you) return `You${onlyOwner ? " · only owner" : ""} · Joined ${shortDay(member.joinedAt)}`;
  if (isNew(member)) return `New · Joined ${shortDay(member.joinedAt).toLowerCase()}`;
  return member.email;
};

/**
 * A person's role. Owners change it from a menu that applies at once, with Undo in the toast; the
 * only owner's is locked, since the server refuses leaving an organization with no owner. Members
 * read it as a word.
 */
function RoleControl({
  member,
  owner,
  onlyOwner,
  organization,
  role,
}: {
  readonly member: Member;
  readonly owner: boolean;
  readonly onlyOwner: boolean;
  readonly organization: string;
  readonly role: RoleChange;
}) {
  if (!owner) return <span className="text-foreground-2">{roleWord(member.role)}</span>;
  if (onlyOwner)
    return (
      <span
        className={cn(
          "inline-flex w-36 items-center justify-between rounded-lg border border-input bg-muted px-2.5 text-muted-foreground max-lg:w-full",
          CONTROL,
        )}
        title={`${organization} needs at least one owner`}
      >
        Owner
        <LockIcon aria-label="Locked: the only owner" className="size-3.5" />
      </span>
    );
  return (
    <Select
      value={member.role}
      onValueChange={(next) => {
        if ((next === "owner" || next === "member") && next !== member.role) role.change(next);
      }}
      disabled={role.pending}
    >
      <SelectTrigger
        aria-label={`${member.name}'s role`}
        className={cn("w-36 max-lg:w-full", CONTROL)}
      >
        {role.pending ? <Spinner aria-hidden /> : null}
        <SelectValue>{(value: Role) => (role.pending ? "Saving…" : roleWord(value))}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false}>
        <SelectGroup>
          <SelectLabel>{member.name}'s role</SelectLabel>
          {(["member", "owner"] as const).map((choice) => (
            <SelectItem key={choice} value={choice}>
              <span className="flex flex-1 items-center justify-between gap-6">
                {roleWord(choice)}
                <span className="text-meta text-muted-foreground">
                  {roleHint(choice, organization)}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/**
 * A person's "…": a password reset link for a member, Remove from the organization; for yourself,
 * Leave. What the server would refuse is offered disabled, with the reason as the item's own line.
 */
function MemberMenu({
  member,
  you,
  owner,
  onlyOwner,
  organization,
  onReset,
  onRefused,
  role,
}: {
  readonly member: Member;
  readonly you: boolean;
  readonly owner: boolean;
  readonly onlyOwner: boolean;
  readonly organization: { readonly id: string; readonly name: string };
  readonly onReset: (reset: { readonly name: string; readonly link: string }) => void;
  readonly onRefused: (words: string | null) => void;
  readonly role: RoleChange;
}) {
  const trpc = useTRPC();
  const phone = usePhone();
  const trigger = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState<"remove" | "leave" | null>(null);
  const memberships = useQuery(trpc.organizations.list.queryOptions());
  const reset = useMutation(
    // The link is a credential: gone from the mutation cache as soon as nothing shows it.
    trpc.organization.issuePasswordReset.mutationOptions({ gcTime: 0 }),
  );
  const offer = resetOffer(member, you);
  if (!owner && !you) return null;
  const others =
    memberships.status === "success"
      ? memberships.data
          .filter((membership) => membership.organization.id !== organization.id)
          .map((membership) => membership.organization.name)
      : [];
  // The server refuses leaving your only organization: no Leave item there.
  const canLeave = memberships.status === "success" && memberships.data.length > 1;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          ref={trigger}
          aria-label={you ? "Your membership" : `${member.name}, more`}
          className={cn(
            buttonVariants({ variant: "ghost", size: phone ? "icon-touch" : "icon" }),
            "text-muted-foreground",
          )}
        >
          {reset.isPending ? <Spinner aria-hidden /> : <EllipsisIcon aria-hidden />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" width="md">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{you ? "You" : member.name}</DropdownMenuLabel>
            {owner ? (
              <DropdownMenuItem
                disabled={onlyOwner || role.pending}
                onClick={() => role.change(member.role === "owner" ? "member" : "owner")}
              >
                <UserCogIcon aria-hidden />
                <span className="flex min-w-0 flex-col">
                  {member.role === "owner"
                    ? `Make ${you ? "yourself" : firstNameOf(member)} a member`
                    : `Make ${firstNameOf(member)} an owner`}
                  {onlyOwner ? (
                    <span className="text-meta text-muted-foreground">
                      {organization.name} needs at least one owner.
                    </span>
                  ) : null}
                </span>
              </DropdownMenuItem>
            ) : null}
            {owner ? (
              <DropdownMenuItem
                disabled={!offer.offer || reset.isPending}
                onClick={() =>
                  void (async () => {
                    onRefused(null);
                    try {
                      const issued = await reset.mutateAsync({ userId: member.userId });
                      onReset({
                        name: member.name,
                        link: linkOf(issued.path, window.location.origin),
                      });
                      reset.reset();
                    } catch (error) {
                      onRefused(
                        refusalWords(
                          error,
                          `Mend didn't make a reset link for ${member.name}. Try again.`,
                        ),
                      );
                    }
                  })()
                }
              >
                <KeyRoundIcon aria-hidden />
                <span className="flex min-w-0 flex-col">
                  Create password reset link…
                  {offer.offer ? null : (
                    <span className="text-meta text-muted-foreground">{offer.why}</span>
                  )}
                </span>
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuGroup>
          {you ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={!canLeave || onlyOwner}
                onClick={() => setDialog("leave")}
              >
                <LogOutIcon aria-hidden />
                <span className="flex min-w-0 flex-col">
                  Leave {organization.name}…
                  {onlyOwner ? (
                    <span className="text-meta text-muted-foreground">
                      Make someone else an owner first.
                    </span>
                  ) : !canLeave ? (
                    <span className="text-meta text-muted-foreground">
                      It's your only organization on this server.
                    </span>
                  ) : null}
                </span>
              </DropdownMenuItem>
            </>
          ) : owner ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={onlyOwner}
                onClick={() => setDialog("remove")}
              >
                <UserMinusIcon aria-hidden />
                Remove from {organization.name}…
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {you ? (
        canLeave ? (
          <LeaveOrganizationDialog
            open={dialog === "leave"}
            onOpenChange={(open) => setDialog(open ? "leave" : null)}
            organization={organization}
            others={others}
            finalFocus={trigger}
          />
        ) : null
      ) : (
        <RemoveDialog
          open={dialog === "remove"}
          onOpenChange={(open) => setDialog(open ? "remove" : null)}
          member={member}
          organization={organization.name}
          finalFocus={trigger}
        />
      )}
    </>
  );
}

/** Remove someone (Doop "Remove a member"): what it does to their access and sessions, first. */
function RemoveDialog({
  open,
  onOpenChange,
  member,
  organization,
  finalFocus,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly member: Member;
  readonly organization: string;
  readonly finalFocus: RefObject<HTMLElement | null>;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const inbox = useQuery({ ...inboxQuery(trpc), enabled: open });
  const sessions = removalSessionsOf(inbox.status === "success" ? inbox.data : null, member.userId);
  const remove = useMutation(trpc.organization.removeMember.mutationOptions());
  const lines = removalLines(member, organization, sessions);
  const busy = remove.isPending;
  const touch = phone ? "touch" : "default";
  const close = (next: boolean) => {
    if (busy) return;
    onOpenChange(next);
    if (!next) remove.reset();
  };
  const confirm = async () => {
    try {
      const outcome = await remove.mutateAsync({ userId: member.userId });
      onOpenChange(false);
      toast.add({
        description: removedToast(member, organization, sessions.running.length, outcome),
      });
      await queryClient.invalidateQueries(trpc.organization.pathFilter());
    } catch {
      // Shown in the dialog from the mutation's error.
    }
  };
  return (
    <Overlay
      open={open}
      onOpenChange={close}
      size="sm"
      finalFocus={finalFocus}
      title={`Remove ${member.name} from ${organization}?`}
      footer={
        <>
          <Button type="button" variant="secondary" size={touch} onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size={touch}
            disabled={busy}
            onClick={() => {
              void confirm();
            }}
          >
            {busy ? <Spinner aria-hidden /> : null}
            {busy ? "Removing…" : `Remove ${member.name}`}
          </Button>
        </>
      }
    >
      <p className="text-muted-foreground">{lines.access}</p>
      {lines.sessions === null ? null : (
        <p className="text-muted-foreground">
          <SessionsLead line={lines.sessions} />
        </p>
      )}
      <p className="text-muted-foreground">{lines.again}</p>
      {remove.isError ? (
        <InlineAlert size={touch} title={`${firstNameOf(member)} is still in ${organization}.`}>
          {refusalWords(remove.error, "Mend didn't answer. Try again.")}
        </InlineAlert>
      ) : null}
    </Overlay>
  );
}

/** The sessions line, its first sentence in the foreground as the frame draws it. */
function SessionsLead({ line }: { readonly line: string }) {
  const end = line.indexOf(". ");
  if (end === -1) return <span className="font-medium text-foreground">{line}</span>;
  return (
    <>
      <span className="font-medium text-foreground">{line.slice(0, end + 1)}</span>
      {line.slice(end + 1)}
    </>
  );
}

/**
 * A member's password reset link (Doop "member menu and reset link"): shown once above the
 * roster with Copy; closing it drops the link, and nothing keeps it.
 */
function ResetLinkPanel({
  name,
  link,
  onClose,
}: {
  readonly name: string;
  readonly link: string;
  readonly onClose: () => void;
}) {
  const phone = usePhone();
  const first = name.trim().split(/\s+/)[0] ?? name;
  return (
    <section
      aria-label={`Password reset link for ${name}`}
      className="my-3 rounded-lg border border-border bg-card p-4 max-lg:mx-4"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">Password reset link for {name}</h3>
          <p className="mt-0.5 text-row text-muted-foreground">
            Send this link to {first} yourself. It works once, and setting a password with it signs{" "}
            {first} out everywhere. You won't see it again after you close this.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size={phone ? "icon-touch" : "icon"}
          aria-label="Close the reset link"
          onClick={onClose}
        >
          <XIcon aria-hidden />
        </Button>
      </div>
      <CopyField
        className="mt-3"
        value={link}
        label="Copy reset link"
        size={phone ? "touch" : "default"}
      />
    </section>
  );
}

/**
 * Invitations (owners only): the open links, Create invitation…, and the used, expired and
 * revoked ones behind a fold. A link's token is shown once, in the dialog that made it.
 */
function Invitations({
  organization,
  viewerId,
  roster,
}: {
  readonly organization: string;
  readonly viewerId: string;
  readonly roster: ReadonlyArray<Member>;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const invitations = useSuspenseQuery(trpc.organization.invitations.queryOptions()).data;
  const [creating, setCreating] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [revoked, setRevoked] = useState<{ readonly email: string | null } | null>(null);
  const [refusal, setRefusal] = useState<{ readonly id: string; readonly words: string } | null>(
    null,
  );
  const createButton = useRef<HTMLButtonElement>(null);
  const revoke = useMutation(
    trpc.organization.revokeInvitation.mutationOptions({
      onSettled: () => queryClient.invalidateQueries(trpc.organization.invitations.queryFilter()),
    }),
  );
  useJoinedToast(invitations, roster, viewerId, organization);
  const { open, closed } = invitationGroups(invitations);
  return (
    <SettingSection
      title="Invitations"
      count={open.length === 0 ? undefined : `${open.length} open`}
      description={`People need an invitation link to join ${organization}. Each link works once and expires after the time you pick.`}
      action={
        <Button
          ref={createButton}
          type="button"
          variant="outline"
          className={CONTROL}
          onClick={() => setCreating(true)}
        >
          Create invitation…
        </Button>
      }
    >
      <div className="px-4 pt-3 lg:hidden">
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="w-full"
          onClick={() => setCreating(true)}
        >
          Create invitation…
        </Button>
      </div>
      {open.length === 0 ? (
        <p className="border-b border-border px-5 py-3.5 text-row text-muted-foreground max-lg:px-4">
          {noOpenInvitations(revoked)}
        </p>
      ) : (
        <div role="table" aria-label="Open invitations" className="text-row">
          <div
            role="row"
            className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1.6fr)_6rem_7rem_5rem] items-center gap-4 border-b border-border py-2 text-meta text-muted-foreground max-lg:hidden"
          >
            <span role="columnheader">Sent to</span>
            <span role="columnheader">Created</span>
            <span role="columnheader">Role</span>
            <span role="columnheader">Expires</span>
            <span role="columnheader" className="sr-only">
              Revoke
            </span>
          </div>
          {open.map((invitation) => {
            const busy = revoke.isPending && revoke.variables?.id === invitation.id;
            return (
              <div role="row" key={invitation.id} className="border-b border-border max-lg:px-4">
                <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1.6fr)_6rem_7rem_5rem] items-center gap-4 py-3 max-lg:grid-cols-[minmax(0,1fr)_auto] max-lg:gap-y-1">
                  <div role="cell" className="flex min-w-0 items-center gap-3">
                    <span className="grid size-6 flex-none place-items-center rounded-full bg-muted text-muted-foreground">
                      <MailIcon aria-hidden className="size-3.5" />
                    </span>
                    <span className="truncate font-medium">{sentTo(invitation)}</span>
                  </div>
                  <div
                    role="cell"
                    className="truncate text-muted-foreground max-lg:col-span-2 max-lg:row-start-2"
                  >
                    {createdLine(invitation, viewerId, roster)}
                    <span className="lg:hidden">
                      {" "}
                      · {roleWord(invitation.role)} · expires {shortDay(invitation.expiresAt)}
                    </span>
                  </div>
                  <div role="cell" className="max-lg:hidden">
                    {roleWord(invitation.role)}
                  </div>
                  <div role="cell" className="text-muted-foreground max-lg:hidden">
                    {shortDay(invitation.expiresAt)}
                  </div>
                  <div
                    role="cell"
                    className="flex justify-end max-lg:col-start-2 max-lg:row-start-1"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size={phone ? "touch" : "sm"}
                      disabled={busy}
                      aria-label={`Revoke the invitation for ${sentTo(invitation)}`}
                      onClick={() =>
                        void (async () => {
                          setRefusal(null);
                          try {
                            await revoke.mutateAsync({ id: invitation.id });
                            setRevoked({ email: invitation.email });
                            toast.add({
                              description: `Revoked the invitation for ${invitation.email ?? "anyone with the link"}.`,
                            });
                          } catch (error) {
                            setRefusal({
                              id: invitation.id,
                              words: refusalWords(error, "Mend didn't revoke the link. Try again."),
                            });
                          }
                        })()
                      }
                    >
                      {busy ? "Revoking…" : "Revoke"}
                    </Button>
                  </div>
                </div>
                {refusal?.id === invitation.id ? (
                  <p role="alert" className="pb-3 text-row text-destructive">
                    {refusal.words}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {closed.length === 0 ? null : (
        <>
          <Button
            type="button"
            variant="link"
            className="mt-3 max-lg:mx-4"
            aria-expanded={showClosed}
            onClick={() => setShowClosed((was) => !was)}
          >
            {showClosed ? "Hide used, expired and revoked links" : closedFold(closed.length)}
          </Button>
          {showClosed ? (
            <ul aria-label="Used, expired and revoked links" className="mt-2 text-row">
              {closed.map((invitation) => (
                <li
                  key={invitation.id}
                  className="flex items-center gap-4 border-b border-border py-2.5 text-muted-foreground max-lg:flex-col max-lg:items-start max-lg:gap-0.5 max-lg:px-4"
                >
                  <span className="min-w-0 flex-1 truncate text-foreground-2">
                    {sentTo(invitation)} · {roleWord(invitation.role)}
                  </span>
                  <span>{closedState(invitation, roster)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      <CreateInvitationDialog
        open={creating}
        onOpenChange={setCreating}
        organization={organization}
        finalFocus={createButton}
        onCreated={() => setRevoked(null)}
      />
    </SettingSection>
  );
}

/**
 * When someone joins with one of your links while the page is open, the roster and the
 * invitations read again (the `organization` event) and a toast says who.
 */
const useJoinedToast = (
  invitations: ReadonlyArray<InvitationRow>,
  roster: ReadonlyArray<Member>,
  viewerId: string,
  organization: string,
) => {
  const seen = useRef(invitations);
  useEffect(() => {
    const joined = joinedWithYours(seen.current, invitations, roster, viewerId);
    seen.current = invitations;
    for (const member of joined)
      toast.add({ description: `${member.name} joined ${organization} with your invitation.` });
  }, [invitations, roster, viewerId, organization]);
};

/**
 * Create invitation (Doop "Invite someone"): the role, an optional email the link is bound to, and
 * how long it lasts. Once made, the same dialog shows the link once, with Copy, and what it allows.
 */
function CreateInvitationDialog({
  open,
  onOpenChange,
  organization,
  finalFocus,
  onCreated,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly organization: string;
  readonly finalFocus: RefObject<HTMLElement | null>;
  readonly onCreated: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const id = useId();
  const [role, setRole] = useState<Role>("member");
  const [email, setEmail] = useState("");
  const [days, setDays] = useState(DEFAULT_EXPIRY_DAYS);
  const [problem, setProblem] = useState<string | null>(null);
  const create = useMutation(
    trpc.organization.createInvitation.mutationOptions({
      // The token is a credential: gone from the mutation cache once nothing shows it.
      gcTime: 0,
      onSuccess: () => {
        onCreated();
        return queryClient.invalidateQueries(trpc.organization.invitations.queryFilter());
      },
    }),
  );
  const touch = phone ? "touch" : "default";
  const close = () => {
    if (create.isPending) return;
    onOpenChange(false);
    // Nothing typed, and no link, stays once the dialog is gone.
    setRole("member");
    setEmail("");
    setDays(DEFAULT_EXPIRY_DAYS);
    setProblem(null);
    create.reset();
  };
  const submit = () => {
    const refused = emailProblem(email);
    setProblem(refused);
    if (refused !== null) return;
    const bound = email.trim().toLowerCase();
    create.mutate({ role, expiresInDays: days, ...(bound === "" ? {} : { email: bound }) });
  };
  const made = create.data;
  if (made !== undefined) {
    const first = made.invitation.email?.split("@")[0];
    return (
      <Overlay
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        size="md"
        finalFocus={finalFocus}
        title="Invitation link created"
        description={`Send this link to ${made.invitation.email === null ? "the person you're inviting" : (first ?? "them")} yourself. Mend doesn't email it. You won't see the link again after you close this.`}
        footer={
          <Button type="button" variant="outline" size={touch} onClick={close}>
            Done
          </Button>
        }
      >
        <CopyField
          value={linkOf(made.path, window.location.origin)}
          label="Copy link"
          size={phone ? "touch" : "default"}
        />
        <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-row max-lg:grid-cols-1">
          <dt className="text-muted-foreground">Who can use it</dt>
          <dd>{whoCanUse(made.invitation.email)}</dd>
          <dt className="text-muted-foreground">Role</dt>
          <dd>{roleWord(made.invitation.role)}</dd>
          <dt className="text-muted-foreground">Expires</dt>
          <dd>{expiresLine(made.invitation.expiresAt)}</dd>
        </dl>
      </Overlay>
    );
  }
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      size="md"
      finalFocus={finalFocus}
      title="Create invitation"
      description={`Mend makes a link that lets one person join ${organization}. You copy the link and send it to them yourself.`}
      footer={
        <>
          <Button type="button" variant="outline" size={touch} onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form={`${id}-form`} size={touch} disabled={create.isPending}>
            {create.isPending ? <Spinner aria-hidden /> : null}
            {create.isPending ? "Creating…" : "Create invitation link"}
          </Button>
        </>
      }
    >
      <form
        id={`${id}-form`}
        noValidate
        className="grid gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-2">
          <span id={`${id}-role`} className="font-medium">
            Role
          </span>
          <Segmented
            aria-label="Role"
            value={role}
            onValueChange={setRole}
            size={touch}
            options={[
              { value: "member", label: "Member" },
              { value: "owner", label: "Owner" },
            ]}
          />
          <p className="text-row text-muted-foreground">
            Members can use {organization}'s projects. Owners can also change {organization}'s
            settings, invite people and remove members.
          </p>
        </div>
        <div className="grid gap-2">
          <label htmlFor={`${id}-email`} className="font-medium">
            Email <span className="font-normal text-muted-foreground">· optional</span>
          </label>
          <Input
            id={`${id}-email`}
            type="email"
            autoComplete="off"
            value={email}
            aria-invalid={problem !== null}
            aria-describedby={`${id}-email-hint`}
            onChange={(event) => {
              setEmail(event.target.value);
              setProblem(null);
            }}
            className={CONTROL}
          />
          <p id={`${id}-email-hint`} className="text-row text-muted-foreground">
            Only someone signing up with this email can use the link. Leave it empty and anyone who
            has the link can join.
          </p>
          {problem === null ? null : (
            <p role="alert" className="text-row text-destructive">
              {problem}
            </p>
          )}
        </div>
        <div className="grid gap-2">
          <label htmlFor={`${id}-days`} className="font-medium">
            Expires after
          </label>
          <NativeSelect
            id={`${id}-days`}
            size="field"
            className="w-48 max-lg:w-full"
            value={String(days)}
            onChange={(event) => setDays(Number(event.target.value))}
          >
            {EXPIRY_DAYS.map((choice) => (
              <NativeSelectOption key={choice} value={String(choice)}>
                {expiryLabel(choice)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <p className="text-row text-muted-foreground">
            You can pick up to {MAX_EXPIRY_DAYS} days. The link stops working once someone uses it.
          </p>
        </div>
        {create.isError ? (
          <InlineAlert size={touch} title="Mend didn't make the link.">
            {refusalWords(create.error, "Mend didn't answer. Try again.")}
          </InlineAlert>
        ) : null}
      </form>
    </Overlay>
  );
}
