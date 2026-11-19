import { Avatar, AvatarFallback } from "@mend/ui/components/ui/avatar";
import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import { Input } from "@mend/ui/components/ui/input";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { InfoIcon } from "lucide-react";
import { useRef, useState } from "react";

import { initialsOf } from "#/lib/organization";
import {
  joinedLine,
  leaveRow,
  nameDraft,
  ownersOf,
  renameRefusal,
  type RosterMember,
  whoRenames,
} from "#/lib/organization-general";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";

import { LeaveOrganizationDialog } from "../organization-dialogs.tsx";
import { SettingRow, SettingSection } from "./setting-row.tsx";
import { settingsLink } from "./settings-links.tsx";
import { SettingsPage } from "./settings-page.tsx";

/** A control's height: the frames' 36px on the desk, a 44px touch target on a phone. */
const CONTROL = "h-9 max-lg:h-11 max-lg:text-base";

/**
 * Settings → the organization → General (Doop "Settings · Northwind · General"): the
 * organization's name, which its owners change and everyone else reads; the person's role; who
 * owns it; and leaving it. The route's loader read the roster and the person's organizations.
 */
export function OrganizationGeneralPage() {
  const trpc = useTRPC();
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const roster = useSuspenseQuery(trpc.organization.members.queryOptions()).data;
  const memberships = useSuspenseQuery(trpc.organizations.list.queryOptions()).data;
  const organization = viewer.organization;
  const owner = viewer.role === "owner";
  const owners = ownersOf(roster, viewer.userId);
  return (
    <SettingsPage
      page="o-general"
      intro={`The name and owners of ${organization.name}. Only owners can change them.`}
    >
      <SettingSection title="Organization">
        {owner ? (
          <NameField saved={organization.name} />
        ) : (
          <SettingRow
            layout="stack"
            label="Name"
            labelFor="organization-name"
            description={`People see it in the sidebar and when they open an invitation. ${whoRenames(
              organization.name,
              owners.map((person) => person.name),
            )}`}
            control={
              <Input
                id="organization-name"
                value={organization.name}
                readOnly
                className={`${CONTROL} w-80 text-muted-foreground max-lg:w-full`}
              />
            }
          />
        )}
        <SettingRow
          label="Your role"
          description={
            owner
              ? `Owners change ${organization.name}'s settings, invite people and see the audit log.`
              : `Owners change ${organization.name}'s settings, invite people and see the audit log. Ask one of them if you need to be an owner.`
          }
          control={<span>{owner ? "Owner" : "Member"}</span>}
        />
      </SettingSection>
      <SettingSection
        title="Owners"
        description={
          owner
            ? `${organization.name} always has at least one owner. You make a member an owner on the Members page.`
            : `${organization.name} always has at least one owner. Owners make a member an owner on the Members page.`
        }
        action={
          <Link
            {...settingsLink("o-members")}
            className={cn(buttonVariants({ variant: "outline" }), CONTROL)}
          >
            Manage members
          </Link>
        }
      >
        <ul aria-label={`${organization.name}'s owners`}>
          {owners.map((person) => (
            <OwnerRow key={person.userId} person={person} you={person.userId === viewer.userId} />
          ))}
        </ul>
        {/* The section shows its action beside the heading on the desk only; on a phone it goes
            under the owners, at full width (Doop "Phone · Settings · Northwind · General"). */}
        <div className="px-4 pt-3 lg:hidden">
          <Link
            {...settingsLink("o-members")}
            className={cn(buttonVariants({ variant: "outline", size: "touch" }), "w-full")}
          >
            Manage members
          </Link>
        </div>
      </SettingSection>
      <SettingSection title="Membership">
        <LeaveRow
          organization={organization}
          viewerId={viewer.userId}
          roster={roster}
          others={memberships
            .filter((membership) => membership.organization.id !== organization.id)
            .map((membership) => membership.organization.name)}
        />
      </SettingSection>
    </SettingsPage>
  );
}

/**
 * The name, for an owner: Save and Discard appear once it differs from the saved name, and the
 * description says what it was. Enter saves and Escape discards. A refused name is shown beside
 * the field in the server's words; the sidebar, breadcrumb and every member's page read the new
 * name once it is saved.
 */
function NameField({ saved }: { readonly saved: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  // Null while the person hasn't typed: the field follows the saved name, even when another owner
  // renames it meanwhile.
  const [draft, setDraft] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const typed = draft ?? saved;
  const { changed, problem } = nameDraft(saved, typed);
  const rename = useMutation(
    trpc.organization.rename.mutationOptions({
      onSuccess: async (renamed) => {
        setDraft(null);
        toast.add({ description: `Renamed to ${renamed.name}.` });
        await Promise.all([
          queryClient.invalidateQueries(trpc.organization.pathFilter()),
          queryClient.invalidateQueries(trpc.organizations.list.queryFilter()),
        ]);
      },
      onError: (error) => setRefusal(renameRefusal(error, saved)),
    }),
  );
  const save = () => {
    if (!changed || rename.isPending) return;
    setRefusal(problem);
    if (problem === null) rename.mutate({ name: typed.trim() });
  };
  const discard = () => {
    setDraft(null);
    setRefusal(null);
    rename.reset();
  };
  return (
    <>
      <SettingRow
        layout="stack"
        label="Name"
        labelFor="organization-name"
        description={`People see it in the sidebar and when they open an invitation.${changed ? ` It was ${saved}.` : ""}`}
        note={
          refusal === null ? null : (
            <span id="organization-name-problem" role="alert" className="text-destructive">
              {refusal}
            </span>
          )
        }
        control={
          <Input
            id="organization-name"
            value={typed}
            autoComplete="organization"
            aria-invalid={refusal !== null}
            aria-describedby={refusal === null ? undefined : "organization-name-problem"}
            onChange={(event) => {
              setDraft(event.target.value);
              setRefusal(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") save();
              if (event.key === "Escape") discard();
            }}
            className={`${CONTROL} w-80 max-lg:w-full`}
          />
        }
      />
      {changed ? (
        <div
          role="group"
          aria-label="Unsaved changes"
          className="flex items-center gap-3 border-b border-border py-3 max-lg:sticky max-lg:bottom-0 max-lg:z-10 max-lg:flex-col max-lg:items-stretch max-lg:border-t max-lg:bg-background max-lg:px-4"
        >
          <p className="min-w-0 flex-1">Unsaved changes</p>
          <div className="flex gap-2 max-lg:*:flex-1">
            <Button
              type="button"
              variant="outline"
              className={CONTROL}
              disabled={rename.isPending}
              onClick={discard}
            >
              Discard
            </Button>
            <Button type="button" className={CONTROL} disabled={rename.isPending} onClick={save}>
              {rename.isPending ? <Spinner aria-hidden /> : null}
              {rename.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** One owner: initials, name (with "You"), email, and when they joined. */
function OwnerRow({ person, you }: { readonly person: RosterMember; readonly you: boolean }) {
  const joined = joinedLine(person.joinedAt);
  return (
    <li className="flex items-center gap-3 border-b border-border py-3 max-lg:px-4">
      <Avatar aria-hidden>
        <AvatarFallback className="font-medium">
          {initialsOf(person.name, person.email)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate">
          <span className="font-semibold">{person.name}</span>
          {you ? <span className="ml-1.5 text-row text-muted-foreground">You</span> : null}
        </p>
        <p className="truncate text-row text-muted-foreground">
          {person.email}
          <span className="lg:hidden"> · {joined}</span>
        </p>
      </div>
      <span className="flex-none text-row text-muted-foreground max-lg:hidden">{joined}</span>
    </li>
  );
}

/**
 * Leave the organization: what the person loses, and whatever the server would refuse, said
 * before they try. The dialog is the organization switcher's, with the same words.
 */
function LeaveRow({
  organization,
  viewerId,
  roster,
  others,
}: {
  readonly organization: { readonly id: string; readonly name: string };
  readonly viewerId: string;
  readonly roster: ReadonlyArray<RosterMember>;
  readonly others: ReadonlyArray<string>;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const row = leaveRow({
    organization: organization.name,
    viewerId,
    roster,
    organizations: others.length + 1,
  });
  return (
    <>
      <SettingRow
        layout="stack"
        label={`Leave ${organization.name}`}
        description={`You lose access to ${organization.name}'s projects and sessions. Your account and its settings stay, and so do any other organizations you're in.`}
        note={
          row.note === null ? null : (
            <span className="flex gap-1.5 text-muted-foreground">
              <InfoIcon aria-hidden className="mt-0.5 size-3.5 flex-none" />
              {row.note}
            </span>
          )
        }
        control={
          row.offer ? (
            <Button
              ref={trigger}
              type="button"
              variant="destructive"
              className={CONTROL}
              onClick={() => setOpen(true)}
            >
              Leave {organization.name}…
            </Button>
          ) : undefined
        }
      />
      {row.offer ? (
        <LeaveOrganizationDialog
          open={open}
          onOpenChange={setOpen}
          organization={organization}
          others={others}
          finalFocus={trigger}
        />
      ) : null}
    </>
  );
}
