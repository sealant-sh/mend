import { InlineAlert } from "@mend/ui/components/banner";
import { Avatar, AvatarFallback } from "@mend/ui/components/ui/avatar";
import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import { cn } from "@mend/ui/lib/utils";
import {
  queryOptions,
  useIsFetching,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import type { inferRouterOutputs } from "@trpc/server";
import type { ReactNode } from "react";

import { authClient } from "#/lib/auth-client";
import { useFragmentSecret } from "#/lib/handed-links";
import { dayOf, initialsOf, joinState, spentReason, type SpentState } from "#/lib/organization";
import { forgetMessages } from "#/lib/outbox";
import { useTRPC } from "#/lib/trpc";
import type { AppRouter } from "#/server/routers/index";

import { article, JoinWithAccount } from "./join-account.tsx";
import { QueryView } from "./query-view.tsx";
import { QueryError, QueryPending } from "./route-screens.tsx";
import { SetupActions, SetupFrame, TOUCH } from "./setup-frame.tsx";

/**
 * `/join#<token>`: an invitation link an owner made (Settings, `mend invite`) or the operator made
 * (`mend operator`), and handed over; Mend sends no email. Someone signed out creates an account
 * and joins, or signs in first; someone signed in joins with the account they have. A new account
 * goes on to setup (`/welcome`); an account that had one already opens Mend (`/`).
 */
export function JoinPage() {
  const secret = useFragmentSecret();
  return secret === null ? <NotAnInvitation /> : <Invitation key={secret} token={secret} />;
}

type Outputs = inferRouterOutputs<AppRouter>;
type InvitationPreview = Outputs["organization"]["invitationPreview"];
type Memberships = Outputs["organizations"]["list"];

interface Person {
  readonly name: string;
  readonly email: string;
}

const codeOf = (error: unknown): string | null =>
  error instanceof TRPCClientError && typeof error.data?.code === "string" ? error.data.code : null;

/** The refusal the API declared (`NotFound`, `InvitationSpent`, …), as the web tier tags it. */
const tagOf = (error: unknown): string | null =>
  error instanceof TRPCClientError && typeof error.data?.tag === "string" ? error.data.tag : null;

/** Who this browser is signed in as, from Better Auth: no tRPC read, so no walk to sign-in. */
const readPerson = async (): Promise<Person | null> => {
  const session = await authClient.getSession();
  if (session.error !== null) {
    throw new Error(session.error.message ?? "Mend couldn't tell whether you're signed in.");
  }
  const user = session.data?.user ?? null;
  return user === null ? null : { name: user.name, email: user.email };
};

/** Every read on this page is fresh on each visit and after each step. */
const FRESH = { retry: false, staleTime: 0 } as const;

const SESSION_KEY = ["join", "session"] as const;
const sessionOptions = () => queryOptions({ queryKey: SESSION_KEY, queryFn: readPerson, ...FRESH });

/**
 * Reads the invitation and who is signed in again, after a step changed either: signing in or
 * out, or a join the server refused because the link was spent meanwhile.
 */
const useReread = (token: string): (() => void) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: SESSION_KEY });
    void queryClient.invalidateQueries({
      queryKey: trpc.organization.invitationPreview.queryKey({ token }),
    });
    void queryClient.invalidateQueries({ queryKey: trpc.organizations.list.queryKey() });
  };
};

function ReadFailed({ error, retry }: { readonly error: unknown; readonly retry: () => void }) {
  // Only this page's reads run here, so any read in flight is the one being tried again.
  const fetching = useIsFetching();
  return (
    <SetupFrame title="Invitation">
      <QueryError error={error} retry={retry} retrying={fetching > 0} />
    </SetupFrame>
  );
}

/** A read that failed; a token the server doesn't know is no invitation, not a failure. */
const readFailed = (error: unknown, retry: () => void): ReactNode =>
  codeOf(error) === "NOT_FOUND" ? <NotAnInvitation /> : <ReadFailed error={error} retry={retry} />;

const READING = (
  <SetupFrame title="Invitation">
    <QueryPending />
  </SetupFrame>
);

/** A full load, so whatever opens next reads with the new session and organization. */
const openPage = (path: "/" | "/welcome") => window.location.assign(path);

function Invitation({ token }: { readonly token: string }) {
  const trpc = useTRPC();
  const invitation = useQuery(trpc.organization.invitationPreview.queryOptions({ token }, FRESH));
  return (
    <QueryView query={invitation} pending={READING} error={readFailed}>
      {(preview: InvitationPreview) => <SignedIn invitation={preview} token={token} />}
    </QueryView>
  );
}

function SignedIn({
  invitation,
  token,
}: {
  readonly invitation: InvitationPreview;
  readonly token: string;
}) {
  const person = useQuery(sessionOptions());
  return (
    <QueryView query={person} pending={READING} error={readFailed}>
      {(signedIn: Person | null) =>
        signedIn === null ? (
          <Decide invitation={invitation} token={token} person={null} memberships={null} />
        ) : (
          <WithMemberships invitation={invitation} token={token} person={signedIn} />
        )
      }
    </QueryView>
  );
}

function WithMemberships({
  invitation,
  token,
  person,
}: {
  readonly invitation: InvitationPreview;
  readonly token: string;
  readonly person: Person;
}) {
  const trpc = useTRPC();
  const memberships = useQuery(trpc.organizations.list.queryOptions(undefined, FRESH));
  return (
    <QueryView query={memberships} pending={READING} error={readFailed}>
      {(held: Memberships) => (
        <Decide invitation={invitation} token={token} person={person} memberships={held} />
      )}
    </QueryView>
  );
}

function Decide({
  invitation,
  token,
  person,
  memberships,
}: {
  readonly invitation: InvitationPreview;
  readonly token: string;
  readonly person: Person | null;
  readonly memberships: Memberships | null;
}) {
  const reread = useReread(token);
  const state = joinState(invitation, memberships);
  switch (state.kind) {
    case "spent":
      return <Spent invitation={invitation} state={state.state} signedIn={person !== null} />;
    case "register":
      return (
        <JoinWithAccount
          invitation={invitation}
          token={token}
          reread={reread}
          onCreated={() => openPage("/welcome")}
        />
      );
    case "join":
      return person === null ? null : (
        <ReadyToJoin invitation={invitation} token={token} person={person} reread={reread} />
      );
    case "member":
      return person === null ? null : (
        <AlreadyMember
          invitation={invitation}
          person={person}
          active={state.active}
          reread={reread}
        />
      );
  }
}

/** The way out of a page that can't go on: sign-in, or Mend itself for someone signed in. */
function LeaveActions({ signedIn }: { readonly signedIn: boolean }) {
  return (
    <SetupActions>
      {signedIn ? (
        <a href="/" className={cn(buttonVariants({ variant: "outline" }), TOUCH)}>
          Open Mend
        </a>
      ) : (
        <Link to="/login" className={cn(buttonVariants({ variant: "outline" }), TOUCH)}>
          Sign in
        </Link>
      )}
    </SetupActions>
  );
}

function NotAnInvitation() {
  return (
    <SetupFrame title="This link is not an invitation">
      <p className="text-prose text-pretty text-foreground">
        Mend doesn't know this invitation. Check that the link was copied whole: it ends with a long
        code after <code className="font-mono text-meta">/join#</code>.
      </p>
      <p className="mt-3 text-row text-pretty text-muted-foreground">
        If it was, ask an owner of the organization for a new link. Mend doesn't send email, so they
        copy the link and send it to you.
      </p>
      <LeaveActions signedIn={false} />
    </SetupFrame>
  );
}

/** Two facts about the invitation, as label and value rows between hairlines. */
function Facts({ rows }: { readonly rows: ReadonlyArray<readonly [string, string]> }) {
  return (
    <dl className="mt-6 border-t text-prose">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[8rem_1fr] gap-4 border-b py-3 max-lg:py-3.5">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Spent({
  invitation,
  state,
  signedIn,
}: {
  readonly invitation: InvitationPreview;
  readonly state: SpentState;
  readonly signedIn: boolean;
}) {
  const org = invitation.organizationName;
  return (
    <SetupFrame title={`Join ${org}`}>
      <InlineAlert title="This invitation can't be used." className="max-lg:text-sm">
        {spentReason(state, invitation.expiresAt)} An invitation link works once and lasts up to 30
        days.
      </InlineAlert>
      <Facts
        rows={[
          ["Organization", org],
          ["Role", invitation.role],
        ]}
      />
      <p className="mt-6 text-prose text-pretty text-foreground">
        Ask an owner of {org} for a new link. Mend doesn't send email, so they copy the link and
        send it to you.
      </p>
      {signedIn ? null : (
        <p className="mt-3 text-row text-pretty text-muted-foreground">
          If you already used this link to join {org}, sign in instead.
        </p>
      )}
      <LeaveActions signedIn={signedIn} />
    </SetupFrame>
  );
}

/** Who this browser is signed in as, with the way to switch to another account. */
function SignedInAs({ person, reread }: { readonly person: Person; readonly reread: () => void }) {
  const signOut = useMutation({
    mutationFn: async () => {
      const result = await authClient.signOut();
      if (result.error !== null) throw new Error(result.error.message ?? "Signing out failed.");
      forgetMessages();
    },
    onSuccess: reread,
  });
  return (
    <div className="mt-6 border-y py-4">
      <div className="flex items-center gap-3">
        <Avatar size="lg" aria-hidden>
          <AvatarFallback className="font-medium text-foreground">
            {initialsOf(person.name, person.email)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-lead text-foreground">{person.name}</p>
          <p className="truncate text-row text-muted-foreground">{person.email}</p>
        </div>
        <Button
          type="button"
          variant="link"
          className="max-lg:h-11"
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
        >
          {signOut.isPending ? "Signing out…" : "Sign out"}
        </Button>
      </div>
      {signOut.isError ? (
        <InlineAlert title="Mend didn't sign you out." className="mt-4 max-lg:text-sm">
          Check your connection and try again.
        </InlineAlert>
      ) : null}
    </div>
  );
}

/** What a refused join or switch says, beside the button that asked. */
function Refused({ title, error }: { readonly title: string; readonly error: unknown }) {
  const unreachable = !(error instanceof TRPCClientError) || error.data === undefined;
  return (
    <div className="mt-6">
      {unreachable ? (
        <InlineAlert title="Mend's server didn't answer." className="max-lg:text-sm">
          Nothing changed. Check your connection, or wait a minute and try again.
        </InlineAlert>
      ) : (
        <InlineAlert title={title} className="max-lg:text-sm">
          {error.message}
        </InlineAlert>
      )}
    </div>
  );
}

function ReadyToJoin({
  invitation,
  token,
  person,
  reread,
}: {
  readonly invitation: InvitationPreview;
  readonly token: string;
  readonly person: Person;
  readonly reread: () => void;
}) {
  const trpc = useTRPC();
  const org = invitation.organizationName;
  const accept = useMutation(
    trpc.organizations.acceptInvitation.mutationOptions({
      // The server moved this browser's sign-in to the new organization.
      onSuccess: () => openPage("/"),
      onError: (error) => {
        // Spent or gone meanwhile: the page then says so in place of the button.
        const tag = tagOf(error);
        if (tag === "InvitationSpent" || tag === "NotFound") reread();
      },
    }),
  );
  const busy = accept.isPending || accept.isSuccess;
  return (
    <SetupFrame title={`Join ${org}`}>
      <p className="text-prose text-pretty text-muted-foreground">
        You're signed in. Join {org} as {article(invitation.role)} to accept the invitation.
      </p>
      <SignedInAs person={person} reread={reread} />
      <p className="mt-4 text-row text-pretty text-muted-foreground">
        Your account stays the same. You can switch between your organizations from the top of the
        sidebar.
      </p>
      {accept.isError ? (
        <Refused title={`Mend didn't add you to ${org}.`} error={accept.error} />
      ) : null}
      <SetupActions
        divided={false}
        note={`The invitation expires on ${dayOf(invitation.expiresAt)}.`}
      >
        <Button
          type="button"
          disabled={busy}
          className={TOUCH}
          onClick={() => accept.mutate({ token })}
        >
          {busy ? "Joining…" : accept.isError ? "Try again" : `Join ${org}`}
        </Button>
      </SetupActions>
    </SetupFrame>
  );
}

function AlreadyMember({
  invitation,
  person,
  active,
  reread,
}: {
  readonly invitation: InvitationPreview;
  readonly person: Person;
  readonly active: boolean;
  readonly reread: () => void;
}) {
  const trpc = useTRPC();
  const org = invitation.organizationName;
  const switching = useMutation(
    trpc.organizations.switch.mutationOptions({ onSuccess: () => openPage("/") }),
  );
  const busy = switching.isPending || switching.isSuccess;
  let action: ReactNode;
  if (active) {
    action = (
      <a href="/" className={cn(buttonVariants(), TOUCH)}>
        Open Mend
      </a>
    );
  } else {
    action = (
      <Button
        type="button"
        disabled={busy}
        className={TOUCH}
        onClick={() => switching.mutate({ organizationId: invitation.organizationId })}
      >
        {busy ? "Switching…" : `Switch to ${org}`}
      </Button>
    );
  }
  return (
    <SetupFrame title={`Join ${org}`}>
      <p className="text-prose text-pretty text-muted-foreground">
        {active
          ? `You're already a member of ${org}.`
          : `You're already a member of ${org}, and this browser is signed in to another of your organizations.`}
        {invitation.state === "open" ? " The invitation stays unused." : null}
      </p>
      <SignedInAs person={person} reread={reread} />
      {switching.isError ? (
        <Refused title={`Mend didn't switch you to ${org}.`} error={switching.error} />
      ) : null}
      <SetupActions divided={false}>{action}</SetupActions>
    </SetupFrame>
  );
}
