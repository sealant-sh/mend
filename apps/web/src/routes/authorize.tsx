import { InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import { cn } from "@mend/ui/lib/utils";
import { queryOptions, useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CircleX } from "lucide-react";
import type { ReactNode } from "react";

import { SetupActions, SetupFrame, TOUCH } from "#/components/setup-frame";
import { SignInForm } from "#/components/sign-in-form";
import { authClient } from "#/lib/auth-client";
import {
  type Account,
  type Asker,
  askerOf,
  type AuthorizeRequest,
  expiryWords,
  failureOf,
  groupCode,
  readAuthorize,
} from "#/lib/authorize";
import { type TrpcClient, useTRPC } from "#/lib/trpc";

/**
 * Who is signed in in this browser, from Better Auth's session: null when nobody is. A session that
 * can't be read throws, which the page shows as the server not answering.
 */
const readAccount = async (): Promise<Account | null> => {
  const session = await authClient.getSession();
  if (session.error !== null) throw new Error(session.error.message ?? "No session answer.");
  return session.data === null
    ? null
    : { name: session.data.user.name, email: session.data.user.email };
};

/**
 * The page's one read: the session, then the request. Never refused: a signed-out person is a state
 * of this page, so nothing here starts the walk to /login. Read once per visit; a decision or a
 * sign-in reloads or replaces it.
 */
const authorizeOptions = (trpcClient: TrpcClient, code: string) =>
  queryOptions({
    queryKey: ["authorize", code],
    queryFn: () =>
      readAuthorize(code, {
        account: readAccount,
        request: (wanted) => trpcClient.devices.cliAuthRequest.query({ code: wanted }),
        now: Date.now,
      }),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

/**
 * `mend login`, the desktop app's sign-in and VS Code's Connect open an authorize request and send
 * the browser here (`/authorize?code=<code>`, built by the API's `cliAuthVerifyPath`). The
 * signed-in account compares the code with the one its terminal or app shows and approves or
 * denies it; the client's next poll collects a device token or the refusal. A signed-out person
 * signs in on this page and comes back to the same request.
 */
export const Route = createFileRoute("/authorize")({
  validateSearch: (search: Record<string, unknown>): { readonly code: string } => ({
    code: typeof search["code"] === "string" ? search["code"] : "",
  }),
  // The session cookie is the browser's to send; the page reads it there.
  ssr: false,
  loaderDeps: ({ search }) => ({ code: search.code }),
  loader: ({ context, deps }) =>
    context.queryClient.ensureQueryData(authorizeOptions(context.trpcClient, deps.code)),
  component: AuthorizePage,
});

function AuthorizePage() {
  const { code } = Route.useSearch();
  const { trpcClient } = Route.useRouteContext();
  const read = useSuspenseQuery(authorizeOptions(trpcClient, code));
  const state = read.data;
  switch (state.kind) {
    case "request":
      return (
        <Decide
          code={code}
          account={state.account}
          request={state.request}
          answeredAt={state.answeredAt}
        />
      );
    case "unusable":
      return <Unusable />;
    case "sign-in":
      return <SignInFirst />;
    case "unreachable":
      return <Unreachable retrying={read.isFetching} onRetry={() => void read.refetch()} />;
  }
}

/** Machine words in a sentence: a command, a host name. */
function Mono({ children }: { readonly children: ReactNode }) {
  return <code className="font-mono">{children}</code>;
}

/** The page's words for each client that asks. The frames draw the terminal's. */
const WORDS: Record<
  Asker,
  {
    readonly title: string;
    readonly lead: (name: string) => ReactNode;
    readonly asking: (name: string) => ReactNode;
    readonly shows: string;
    readonly lets: string;
    readonly authorized: string;
    readonly denied: string;
    readonly goBack: string;
    readonly stops: string;
    readonly again: ReactNode;
  }
> = {
  terminal: {
    title: "Authorize this terminal?",
    lead: (name) => (
      <>
        Someone ran <Mono>mend login</Mono> on <Mono>{name}</Mono> and asked to sign in to Mend as
        you.
      </>
    ),
    asking: (name) => (
      <>
        Mend CLI on <Mono>{name}</Mono>
      </>
    ),
    shows: "your terminal",
    lets: "this terminal",
    authorized: "Terminal authorized",
    denied: "Terminal denied",
    goBack: "You can go back to your terminal.",
    stops: "Your terminal stops waiting and says the request was denied.",
    again: (
      <>
        If you meant to approve it, run <Mono>mend login</Mono> again.
      </>
    ),
  },
  vscode: {
    title: "Authorize VS Code?",
    lead: () => "Someone chose Connect in VS Code and asked to sign in to Mend as you.",
    asking: (name) => name,
    shows: "VS Code",
    lets: "VS Code",
    authorized: "VS Code authorized",
    denied: "VS Code denied",
    goBack: "You can go back to VS Code.",
    stops: "VS Code stops waiting and says the request was denied.",
    again: "If you meant to approve it, choose Connect in VS Code again.",
  },
  app: {
    title: "Authorize the Mend app?",
    lead: () => "Someone signed in to the Mend desktop app and asked to sign in to Mend as you.",
    asking: (name) => name,
    shows: "the app",
    lets: "the app",
    authorized: "Mend app authorized",
    denied: "Mend app denied",
    goBack: "You can go back to the Mend app.",
    stops: "The app stops waiting and says the request was denied.",
    again: "If you meant to approve it, choose Sign in in the app again.",
  },
  // A client that doesn't say which it is (the desktop app today, or an older client).
  other: {
    title: "Authorize this sign-in?",
    lead: (name) => `${name} asked to sign in to Mend as you.`,
    asking: (name) => name,
    shows: "the device asking",
    lets: "it",
    authorized: "Sign-in authorized",
    denied: "Sign-in denied",
    goBack: "You can go back to where you signed in.",
    stops: "It stops waiting and says the request was denied.",
    again: "If you meant to approve it, sign in there again.",
  },
};

/** What the person sees after approving or denying: the result, and nothing left to do here. */
function Decided({
  decision,
  asker,
  name,
  account,
}: {
  readonly decision: "approved" | "denied";
  readonly asker: Asker;
  readonly name: string;
  readonly account: Account;
}) {
  const words = WORDS[asker];
  const machine = asker === "terminal" ? <Mono>{name}</Mono> : name;
  return decision === "approved" ? (
    <SetupFrame title={words.authorized}>
      <p className="text-lead text-pretty text-foreground">{words.goBack}</p>
      <p className="mt-3 text-row text-pretty text-muted-foreground">
        {machine} is signed in as {account.name}. You can revoke it any time in Settings, Devices.
      </p>
    </SetupFrame>
  ) : (
    <SetupFrame title={words.denied}>
      <p className="text-lead text-pretty text-foreground">Nothing was allowed. {words.stops}</p>
      <p className="mt-3 text-row text-pretty text-muted-foreground">{words.again}</p>
    </SetupFrame>
  );
}

/** The request, the code to compare, the account approving it, and Approve or Deny. */
function Decide({
  code,
  account,
  request,
  answeredAt,
}: {
  readonly code: string;
  readonly account: Account;
  readonly request: AuthorizeRequest;
  readonly answeredAt: number;
}) {
  const trpc = useTRPC();
  const approve = useMutation(trpc.devices.approveCliAuth.mutationOptions());
  const deny = useMutation(trpc.devices.denyCliAuth.mutationOptions());
  const signOut = useMutation({
    mutationFn: async () => {
      const result = await authClient.signOut();
      if (result.error !== null) throw new Error(result.error.message ?? "Not signed out.");
    },
    // A full load: this page reads again with nobody signed in, and offers sign-in for the same
    // request.
    onSuccess: () => window.location.reload(),
  });

  const asker = askerOf(request.client);
  const words = WORDS[asker];

  if (approve.isSuccess || deny.isSuccess) {
    return (
      <Decided
        decision={approve.isSuccess ? "approved" : "denied"}
        asker={asker}
        name={request.name}
        account={account}
      />
    );
  }

  const failed = approve.error ?? deny.error;
  const failure = failed === null ? null : failureOf(failed);
  // Expired or decided somewhere else while the page was open: the code is spent. (A session that
  // ended walks to sign-in from the mutation cache, as every refused request does.)
  if (failure === "unusable") return <Unusable />;

  const working = approve.isPending || deny.isPending;
  const decide = (decision: "approve" | "deny") => {
    approve.reset();
    deny.reset();
    (decision === "approve" ? approve : deny).mutate({ code });
  };

  return (
    <SetupFrame title={words.title}>
      <p className="text-prose text-pretty text-muted-foreground">{words.lead(request.name)}</p>
      <div className="mt-6 rounded-lg bg-muted px-5 py-5 text-center">
        <p className="font-mono text-3xl font-medium tracking-widest text-foreground">
          {groupCode(request.code)}
        </p>
        <p className="mt-2 text-row text-pretty text-muted-foreground">
          Approve only if {words.shows} shows the same code.{" "}
          {expiryWords(request, answeredAt, Date.now())}
        </p>
      </div>
      <dl className="mt-6 border-t text-row">
        <div className="grid grid-cols-[7rem_1fr] gap-x-4 border-b py-3 lg:grid-cols-[8.5rem_1fr]">
          <dt className="text-muted-foreground">Asking</dt>
          <dd className="min-w-0 break-words text-foreground">{words.asking(request.name)}</dd>
        </div>
        <div className="grid grid-cols-[7rem_1fr] gap-x-4 border-b py-3 lg:grid-cols-[8.5rem_1fr]">
          <dt className="text-muted-foreground">Approving as</dt>
          <dd className="flex min-w-0 flex-col text-foreground lg:flex-row lg:items-baseline lg:gap-1">
            <span>{account.name}</span>
            <span className="break-all text-muted-foreground lg:text-foreground">
              <span className="max-lg:hidden" aria-hidden>
                ·{" "}
              </span>
              {account.email}
            </span>
            <span className="lg:ml-auto">
              <Button
                type="button"
                variant="link"
                className="max-lg:h-11 max-lg:text-row"
                disabled={signOut.isPending || working}
                onClick={() => signOut.mutate()}
              >
                {signOut.isPending ? "Signing out…" : "Not you? Sign out"}
              </Button>
            </span>
          </dd>
        </div>
      </dl>
      {signOut.isError ? (
        <InlineAlert title="Mend didn't sign you out." className="mt-4 max-lg:text-sm">
          Your account is still signed in. Try again.
        </InlineAlert>
      ) : null}
      <p className="mt-4 text-prose text-pretty text-foreground">
        Approving lets {words.lets} do anything you can do in Mend, until you revoke it in Settings,
        Devices.
      </p>
      <DecisionRow
        failure={
          failure !== "unreachable"
            ? null
            : `Mend's server didn't answer, so nothing was ${approve.isError ? "approved" : "denied"}. Try again.`
        }
      >
        <Button
          type="button"
          variant="outline"
          className={cn(TOUCH, "lg:order-1")}
          disabled={working}
          onClick={() => decide("deny")}
        >
          {deny.isPending ? "Denying…" : "Deny"}
        </Button>
        <Button
          type="button"
          className={cn(TOUCH, "lg:order-3 lg:ml-auto")}
          disabled={working}
          onClick={() => decide("approve")}
        >
          {approve.isPending ? "Approving…" : "Approve"}
        </Button>
      </DecisionRow>
    </SetupFrame>
  );
}

/**
 * Deny and Approve at either end of the page's last row on a desktop, and side by side at the foot
 * of the screen on a phone (as `SetupActions` pins them). A failure is one sentence on that row:
 * between the two on a desktop, over them on a phone.
 */
function DecisionRow({
  failure,
  children,
}: {
  readonly failure: string | null;
  readonly children: ReactNode;
}) {
  return (
    <div className="mt-6 lg:mt-8 lg:flex lg:items-center lg:gap-4 lg:border-t lg:pt-7">
      <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-background px-4 pt-3 pb-[max(env(safe-area-inset-bottom),--spacing(3))] lg:contents">
        {failure === null ? null : (
          <p
            role="alert"
            className="mb-3 flex items-start justify-center gap-2 text-sm text-pretty text-foreground lg:order-2 lg:mb-0 lg:flex-1 lg:justify-end lg:text-row"
          >
            <CircleX aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
            {failure}
          </p>
        )}
        <div className="flex gap-2 max-lg:*:flex-1 lg:contents">{children}</div>
      </div>
    </div>
  );
}

function Unusable() {
  return (
    <SetupFrame title="Authorize a terminal or an app">
      <InlineAlert title="This code can't be used." className="max-lg:text-sm">
        It expired, it was already approved or denied, or the link is missing it.
      </InlineAlert>
      <p className="mt-6 text-prose text-pretty text-foreground">
        Start again where you signed in. In a terminal, run <Mono>mend login</Mono>. In the Mend
        desktop app or VS Code, choose Sign in again. Each gives you a new code.
      </p>
    </SetupFrame>
  );
}

function Unreachable({
  retrying,
  onRetry,
}: {
  readonly retrying: boolean;
  readonly onRetry: () => void;
}) {
  return (
    <SetupFrame title="Authorize a terminal or an app">
      <InlineAlert title="Mend's server didn't answer." className="max-lg:text-sm">
        Nothing was approved or denied, and the code may still be waiting.
      </InlineAlert>
      <p className="mt-6 text-row text-pretty text-muted-foreground">
        If the code runs out before Mend answers, run <Mono>mend login</Mono> again for a new one.
      </p>
      <SetupActions>
        <Button type="button" className={TOUCH} disabled={retrying} onClick={onRetry}>
          {retrying ? "Trying again…" : "Try again"}
        </Button>
      </SetupActions>
    </SetupFrame>
  );
}

/**
 * Signed out: the sign-in form, then the same request. The API looks a request up only for a
 * signed-in person, so this page can't yet say what is asking.
 */
function SignInFirst() {
  return (
    <SetupFrame title="Sign in">
      {/* A full load, so the request is read with the new session. */}
      <SignInForm onSignedIn={() => window.location.reload()}>
        <p className="mb-6 text-prose text-pretty text-muted-foreground">
          After you sign in, you can see what is asking and approve or deny it.
        </p>
      </SignInForm>
    </SetupFrame>
  );
}
