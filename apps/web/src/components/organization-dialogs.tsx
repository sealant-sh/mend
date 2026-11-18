import { InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@mend/ui/components/ui/field";
import { Input } from "@mend/ui/components/ui/input";
import { Separator } from "@mend/ui/components/ui/separator";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FolderIcon, KeyRoundIcon, ShieldIcon, UserCheckIcon } from "lucide-react";
import { type ReactNode, type RefObject, useId, useState } from "react";

import { Overlay } from "#/components/projects/overlay";
import { inboxQuery } from "#/lib/inbox-live";
import { leavePlan, liveSessionsOf, refusedName } from "#/lib/organization-membership";
import { leaveSwitchedNote, openHomeAfterSwitch } from "#/lib/organization-switch";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

/**
 * The dialogs the organization switcher opens (Doop page 6, "Organizations" and "Members"): create
 * an organization, and leave the one this browser acts in. A dialog on a wide screen, a sheet
 * from the bottom on a phone. Both end the same way a switch does: the server has moved this
 * browser's sign-in, so home loads afresh in the organization it now acts in
 * (`lib/organization-switch.ts`), and says what happened.
 */

/** One line under the Name field: what the person gets with a new organization. */
function Fact({ icon, children }: { readonly icon: ReactNode; readonly children: ReactNode }) {
  return (
    <li className="flex gap-2.5 text-row text-muted-foreground [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0">
      {icon}
      <span>{children}</span>
    </li>
  );
}

/**
 * Create organization (Doop "Organizations · create organization dialog", "new name typed",
 * "name already taken"). The switcher offers it only where `canCreateOrganizations` says the
 * server lets this person create one. A refused name is said beside the field until the name
 * changes; any other refusal is the dialog's alert.
 */
export function CreateOrganizationDialog({
  open,
  onOpenChange,
  current,
  host,
  finalFocus,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The organization this browser acts in now. */
  readonly current: string;
  /** This server's host name, or "" when the page can't tell. */
  readonly host: string;
  readonly finalFocus: RefObject<HTMLElement | null>;
}) {
  const trpc = useTRPC();
  const phone = usePhone();
  const ids = useId();
  const [name, setName] = useState("");
  const create = useMutation(
    trpc.organizations.create.mutationOptions({
      onSuccess: (membership) => {
        leaveSwitchedNote({ kind: "created", name: membership.organization.name });
        openHomeAfterSwitch();
      },
    }),
  );
  // Once the server has made it, the page is already loading home in it.
  const busy = create.isPending || create.isSuccess;
  // The refusal stands for the name it was given; a new name clears it.
  const refused = create.isError && create.variables?.name === name ? create.error : null;
  const nameProblem = refused !== null && refusedName(refused) ? refused.message : null;
  const close = (next: boolean) => {
    if (busy) return;
    onOpenChange(next);
    if (!next) {
      setName("");
      create.reset();
    }
  };
  const touch = phone ? "touch" : "default";
  return (
    <Overlay
      open={open}
      onOpenChange={close}
      size="md"
      finalFocus={finalFocus}
      title="Create organization"
      description={`An organization has its own projects, members and settings${host === "" ? "" : ` on ${host}`}.`}
      footer={
        <>
          <Button type="button" variant="secondary" size={touch} onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={`${ids}-form`}
            size={touch}
            disabled={busy || refused !== null}
          >
            {busy ? "Creating…" : phone ? "Create" : "Create organization"}
          </Button>
        </>
      }
    >
      <form
        id={`${ids}-form`}
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) create.mutate({ name });
        }}
      >
        <Field data-invalid={nameProblem !== null ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-name`}>Name</FieldLabel>
          <Input
            id={`${ids}-name`}
            value={name}
            autoComplete="off"
            aria-invalid={nameProblem !== null ? true : undefined}
            className={phone ? "h-11" : undefined}
            onChange={(event) => setName(event.target.value)}
          />
          {nameProblem === null ? (
            <FieldDescription>
              People see this name in the organization switcher and on invitations.
            </FieldDescription>
          ) : (
            <FieldError>{nameProblem}</FieldError>
          )}
        </Field>
        {refused !== null && nameProblem === null ? (
          <InlineAlert size={touch} title="The organization wasn't created.">
            {failureWords(refused, "Mend didn't answer. Try again.")}
          </InlineAlert>
        ) : null}
        <Separator />
        <ul className="flex flex-col gap-2.5">
          <Fact icon={<UserCheckIcon aria-hidden />}>
            You'll be its owner and its only member until you invite people.
          </Fact>
          <Fact icon={<FolderIcon aria-hidden />}>
            It starts with no projects. Nothing from {current} is shared with it.
          </Fact>
          <Fact icon={<KeyRoundIcon aria-hidden />}>
            Your agent logins and Git access come with you, because they belong to your account.
          </Fact>
        </ul>
      </form>
    </Overlay>
  );
}

/**
 * Leave the organization this browser acts in (Doop "Members · leave Northwind dialog", "General ·
 * leave confirmation", "Members · only owner"). It says what the person loses before they go; the
 * only owner is told to make someone else an owner first, with no Leave button. The server picks
 * where the sign-in goes next; the page that loads names it.
 */
export function LeaveOrganizationDialog({
  open,
  onOpenChange,
  organization,
  others,
  finalFocus,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly organization: { readonly id: string; readonly name: string };
  /** The names of the person's other organizations. */
  readonly others: ReadonlyArray<string>;
  readonly finalFocus: RefObject<HTMLElement | null>;
}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const phone = usePhone();
  const viewer = useQuery(signedInOptions(trpc));
  const roster = useQuery({ ...trpc.organization.members.queryOptions(), enabled: open });
  const inbox = useQuery({ ...inboxQuery(trpc), enabled: open });
  const leave = useMutation(
    trpc.organizations.leave.mutationOptions({
      onSuccess: async () => {
        // The server has moved this sign-in already; ask where, so home can say.
        const now = await client.organizations.list
          .query()
          .then((memberships) => memberships.find((held) => held.active)?.organization.name ?? null)
          .catch(() => null);
        leaveSwitchedNote({ kind: "left", left: organization.name, now });
        openHomeAfterSwitch();
      },
    }),
  );
  const busy = leave.isPending || leave.isSuccess;
  const viewerId = viewer.status === "success" ? viewer.data.userId : "";
  const plan = leavePlan({
    organization: organization.name,
    viewerId,
    // Unknown while either read is pending or failed: the dialog still offers Leave, and the
    // server refuses what it must.
    roster: roster.status === "success" && viewerId !== "" ? roster.data : null,
    others,
    liveSessions:
      inbox.status === "success" && viewerId !== "" ? liveSessionsOf(
            inbox.data.map((row) => row.session),
            viewerId,
          )
        : null,
  });
  const close = (next: boolean) => {
    if (busy) return;
    onOpenChange(next);
    if (!next) leave.reset();
  };
  const touch = phone ? "touch" : "default";
  if (plan.kind === "only-owner")
    return (
      <Overlay
        open={open}
        onOpenChange={close}
        size="sm"
        finalFocus={finalFocus}
        title={`Leave ${organization.name}?`}
        footer={
          <Button type="button" variant="secondary" size={touch} onClick={() => close(false)}>
            Close
          </Button>
        }
      >
        <InlineAlert
          tone="info"
          size={touch}
          icon={<ShieldIcon aria-hidden />}
          title="You can't leave yet."
        >
          You're {organization.name}'s only owner, and {organization.name} needs at least one owner.
          Make someone else an owner first.
        </InlineAlert>
      </Overlay>
    );
  return (
    <Overlay
      open={open}
      onOpenChange={close}
      size="sm"
      finalFocus={finalFocus}
      title={`Leave ${organization.name}?`}
      description={`You'll stop seeing ${organization.name}'s projects and sessions straight away. To come back, an owner has to invite you again.`}
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
            onClick={() => leave.mutate({ id: organization.id })}
          >
            {busy ? "Leaving…" : `Leave ${organization.name}`}
          </Button>
        </>
      }
    >
      <ul className="flex list-disc flex-col gap-2 pl-5 text-row">
        {plan.losses.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="text-row text-muted-foreground">{plan.destination}</p>
      {leave.isError ? (
        <InlineAlert size={touch} title={`You're still in ${organization.name}.`}>
          {failureWords(leave.error, "Mend didn't answer. Try again.")}
        </InlineAlert>
      ) : null}
    </Overlay>
  );
}
