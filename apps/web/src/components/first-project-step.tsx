import { InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@mend/ui/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldLabel } from "@mend/ui/components/ui/field";
import { Input } from "@mend/ui/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@mend/ui/components/ui/input-group";
import { Progress } from "@mend/ui/components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@mend/ui/components/ui/tabs";
import { cn } from "@mend/ui/lib/utils";
import { keepPreviousData, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, FolderGit2Icon, FolderSearchIcon, GithubIcon, SearchIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import type { AdoptionAttempt } from "#/lib/adoptions";
import { savedAgentLine } from "#/lib/agent-login";
import type { AdoptionProgressDto, ProjectDto } from "#/lib/api";
import { accountNameOptions } from "#/lib/auth-client";
import { type CloneState, cloneDetail } from "#/lib/clone-state";
import { savedModeLine, waitedFor } from "#/lib/git-access";
import { usePhone } from "#/lib/phone";
import {
  alreadyAdded,
  cloneUrlOf,
  type GithubRepository,
  inferName,
  nameIssue,
  pushedAgo,
  repositoriesMatching,
  repositoryName,
  searchesOnPage,
  shortOrigin,
  sourceIssue,
} from "#/lib/projects";
import { failureWords } from "#/lib/refusal";
import { firstProjectSkippable, hasAgentLogin } from "#/lib/setup";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";
import { type CloneRequest, retryOf, useClone } from "#/lib/use-clone";
import { useSecond } from "#/lib/use-second";

import { MendKeyHelp } from "./projects/mend-key-help.tsx";
import { RepositoryAddressField } from "./projects/repository-address.tsx";
import { SetupActions, SetupFrame } from "./setup-frame.tsx";

type Visibility = ProjectDto["visibility"];
type Source = "github" | "url";

/** How long typing rests before a search goes to GitHub. */
const SEARCH_REST_MS = 250;

/** How many repositories the list shows before a search: the frames' six, four on a phone. */
const SHOWN = { desktop: 6, phone: 4 } as const;

/**
 * Step 4 of setup (Doop "First project · …"): pick one of the repositories the Mend server's
 * GitHub login can reach, or paste any Git address, name the project and say who sees it. Adding
 * it starts the clone on this page; the person may go on to Mend while it runs, and a session
 * started there waits for the clone (`queuedSessions`). The clone is the Projects page's (it is
 * kept in this browser by `useClone`), so a reload, or Projects, shows the same one.
 */
export function FirstProjectStep() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const phone = usePhone();
  // The route's loader read these.
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const access = useSuspenseQuery(trpc.git.access.queryOptions()).data;
  const accountName = useSuspenseQuery(accountNameOptions()).data;
  const projects = useSuspenseQuery(trpc.projects.list.queryOptions()).data;
  // Read beside the page.
  const identity = useQuery(trpc.platform.sealantIdentity.queryOptions());
  const members = useQuery(trpc.organization.members.queryOptions());
  const clone = useClone(viewer.userId);
  // "Change details" after a failed clone goes back to the form with what was asked.
  const [editing, setEditing] = useState<CloneRequest | null>(null);
  // The repository picked on GitHub, while this page is open: the clone's summary names its
  // visibility on GitHub.
  const [picked, setPicked] = useState<GithubRepository | null>(null);

  // Until they answer, or if they can't, the steps name no agent and nobody may skip.
  const logins = identity.isPending || identity.isError ? null : identity.data;
  const memberCount = members.isPending || members.isError ? 0 : members.data.length;
  const skipped = logins !== null && !hasAgentLogin(logins);
  const agentLine = logins === null || skipped ? "" : savedAgentLine(logins.accounts);
  const skippable = firstProjectSkippable(memberCount);
  const organizationName = viewer.organization.name;
  const home = phone ? "/new" : "/";

  const { attempt, state } = clone;
  const retry = attempt === null ? null : retryOf(attempt);
  const showClone = attempt !== null && state !== null && state._tag !== "Gone" && editing === null;
  return (
    <SetupFrame
      title="Add a project"
      step={4}
      saved={{ account: accountName, git: savedModeLine(access.mode), agent: agentLine }}
      skipped={skipped ? "agent" : undefined}
      back={{ to: "/welcome/agent-login", label: "Back to Agent login" }}
    >
      <p className="text-prose text-pretty text-foreground max-lg:text-sm">
        A project is a git repository you add to Mend. Mend clones it onto this server, and sessions
        make their changes there, not on your computer.
      </p>
      {showClone ? (
        <CloneView
          attempt={attempt}
          state={state}
          progress={clone.progress}
          picked={picked}
          projects={projects}
          organizationName={organizationName}
          phone={phone}
          skippedAgent={skipped}
          onContinue={() => {
            // A clone that ended is done with; one still running stays, for the composer.
            if (state._tag === "Added") clone.forget();
            void navigate({ to: home });
          }}
          onRetry={retry === null ? null : () => clone.start(retry)}
          onEdit={() =>
            setEditing(retry ?? { name: attempt.name, source: "", visibility: "private" })
          }
        />
      ) : (
        <ChooseRepository
          key={editing === null ? "new" : `edit-${editing.source}`}
          initial={editing}
          projects={projects}
          organizationName={organizationName}
          phone={phone}
          onSkip={skippable ? () => void navigate({ to: home }) : null}
          onClone={(request, repository) => {
            setPicked(repository);
            setEditing(null);
            clone.start(request);
          }}
        />
      )}
    </SetupFrame>
  );
}

/** The form: a repository from GitHub or an address, its name, and who sees it. */
function ChooseRepository({
  initial,
  projects,
  organizationName,
  phone,
  onSkip,
  onClone,
}: {
  /** What a failed clone asked for, when the person went back to change it. */
  readonly initial: CloneRequest | null;
  readonly projects: ReadonlyArray<ProjectDto>;
  readonly organizationName: string;
  readonly phone: boolean;
  /** Go on to Mend with no project; null when the person must add one. */
  readonly onSkip: (() => void) | null;
  readonly onClone: (request: CloneRequest, repository: GithubRepository | null) => void;
}) {
  const trpc = useTRPC();
  const ids = useId();
  const github = useQuery(trpc.github.status.queryOptions(undefined, { staleTime: 60_000 }));
  const signedIn = github.isSuccess && github.data.authenticated;
  const [chosen, setChosen] = useState<Source | null>(initial === null ? null : "url");
  // From GitHub when the server can list repositories, else an address.
  const source: Source = chosen ?? (github.isPending || signedIn ? "github" : "url");
  const [picked, setPicked] = useState<GithubRepository | null>(null);
  const [address, setAddress] = useState(initial?.source ?? "");
  const [typedName, setTypedName] = useState<string | null>(initial?.name ?? null);
  const [visibility, setVisibility] = useState<Visibility>(initial?.visibility ?? "private");
  // An address's problem shows once it looks finished: after a blur, or a try to add.
  const [touched, setTouched] = useState(false);

  const cloneSource =
    source === "github" ? (picked === null ? "" : cloneUrlOf(picked)) : address.trim();
  const name = typedName ?? inferName(cloneSource);
  const addressIssue = source === "url" ? sourceIssue(address) : null;
  const nameProblem =
    name === "" && typedName === null ? null : nameIssue(name, projects, organizationName);
  const missing =
    cloneSource === ""
      ? source === "github"
        ? "Choose a repository to continue."
        : "Paste the repository's address to continue."
      : null;
  const ready = missing === null && addressIssue === null && nameProblem === null && name !== "";

  const submit = () => {
    setTouched(true);
    if (!ready) return;
    onClone({ name, source: cloneSource, visibility }, source === "github" ? picked : null);
  };
  const size = phone ? "touch" : "default";

  return (
    <form
      aria-label="Add a project"
      noValidate
      className="mt-6 flex min-w-0 flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {source === "github" ? (
        <section aria-labelledby={`${ids}-repository`} className="flex min-w-0 flex-col gap-2">
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 max-lg:flex-col">
            <span id={`${ids}-repository`} className="text-sm font-medium text-foreground">
              Repository
            </span>
            {signedIn ? (
              <span className="text-row text-muted-foreground">
                Repositories{" "}
                <span className="font-mono text-meta">{github.data.login ?? "Mend"}</span> can reach
                on GitHub
              </span>
            ) : null}
          </p>
          {github.isPending ? (
            <p role="status" className="py-2 text-row text-muted-foreground">
              Asking the Mend server for its GitHub login…
            </p>
          ) : github.isError ? (
            <InlineAlert
              tone="warning"
              title="Mend couldn't reach GitHub."
              size={size}
              actions={
                <Button
                  variant="secondary"
                  size={phone ? "touch" : "sm"}
                  onClick={() => void github.refetch()}
                >
                  Try again
                </Button>
              }
            >
              {failureWords(github.error, "The Mend server didn't answer.")} You can paste the
              repository's address instead.
            </InlineAlert>
          ) : (
            <GithubRepositories
              login={github.data.login ?? "the GitHub account"}
              projects={projects}
              organizationName={organizationName}
              picked={picked}
              onPick={(repository) => {
                setPicked(repository);
                setTypedName(null);
              }}
              phone={phone}
            />
          )}
          <Button
            variant="link"
            className="self-start px-0 text-row"
            onClick={() => {
              setChosen("url");
              setTouched(false);
            }}
          >
            Paste a Git URL instead
          </Button>
        </section>
      ) : (
        <section className="flex min-w-0 flex-col gap-2">
          {github.isSuccess && !signedIn ? (
            <p className="text-row text-pretty text-muted-foreground">
              The Mend server has no GitHub login, so Mend can't list your repositories. Paste the
              repository's address.
            </p>
          ) : null}
          <RepositoryAddressField
            value={address}
            onChange={setAddress}
            onBlur={() => setTouched(address.trim() !== "")}
            issue={addressIssue}
            showIssue={touched}
            touch={phone}
            autoFocus={chosen === "url" && initial === null}
          />
          {signedIn ? (
            <Button
              variant="link"
              className="self-start px-0 text-row"
              onClick={() => {
                setChosen("github");
                setTouched(false);
              }}
            >
              Choose from GitHub instead
            </Button>
          ) : null}
        </section>
      )}
      {cloneSource === "" && typedName === null ? null : (
        <Field data-invalid={nameProblem !== null ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-name`}>Name</FieldLabel>
          <Input
            id={`${ids}-name`}
            value={name}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={nameProblem !== null ? true : undefined}
            className={cn(phone && "h-11")}
            onChange={(event) => setTypedName(event.target.value)}
          />
          {nameProblem === null ? (
            <FieldDescription>Sessions and branches show this name.</FieldDescription>
          ) : (
            <FieldError>{nameProblem}</FieldError>
          )}
        </Field>
      )}
      <VisibleTo
        value={visibility}
        onChange={setVisibility}
        organizationName={organizationName}
        phone={phone}
      />
      <SetupActions
        status={missing ?? (ready ? "Mend starts cloning when you add it." : null)}
        divided={false}
      >
        {onSkip === null ? null : (
          <Button variant="ghost" size={size} onClick={onSkip}>
            Skip for now
          </Button>
        )}
        <Button type="submit" size={size} disabled={!ready}>
          Add project
        </Button>
      </SetupActions>
    </form>
  );
}

/**
 * The repositories the Mend server's GitHub login can reach, to pick one from (a radio group
 * under the hood). The server lists up to 30; while it lists fewer, that is all of them and the
 * search filters them here. A full list may be cut short, so a search goes to GitHub.
 */
function GithubRepositories({
  login,
  projects,
  organizationName,
  picked,
  onPick,
  phone,
}: {
  readonly login: string;
  readonly projects: ReadonlyArray<ProjectDto>;
  readonly organizationName: string;
  readonly picked: GithubRepository | null;
  readonly onPick: (repository: GithubRepository) => void;
  readonly phone: boolean;
}) {
  const trpc = useTRPC();
  const ids = useId();
  const now = useSecond();
  const [search, setSearch] = useState("");
  const [searched, setSearched] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearched(search), SEARCH_REST_MS);
    return () => clearTimeout(timer);
  }, [search]);
  const listed = useQuery(trpc.github.repos.queryOptions({ query: "" }, { staleTime: 30_000 }));
  const onPage = listed.isSuccess && searchesOnPage(listed.data.length);
  const words = search.trim();
  const found = useQuery({
    ...trpc.github.repos.queryOptions({ query: searched }, { staleTime: 30_000 }),
    enabled: listed.isSuccess && !onPage && searched.trim() !== "",
    placeholderData: keepPreviousData,
  });

  if (listed.isPending)
    return (
      <p role="status" className="py-2 text-row text-muted-foreground">
        Reading the repositories {login} can reach…
      </p>
    );
  if (listed.isError)
    return (
      <InlineAlert
        tone="warning"
        title="GitHub didn't answer."
        size={phone ? "touch" : "default"}
        actions={
          <Button
            variant="secondary"
            size={phone ? "touch" : "sm"}
            onClick={() => void listed.refetch()}
          >
            Try again
          </Button>
        }
      >
        {failureWords(listed.error, "The Mend server didn't answer.")}
      </InlineAlert>
    );
  if (listed.data.length === 0)
    return (
      <Empty className="rounded-lg border px-6 py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderSearchIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>
            <h2>No repositories found</h2>
          </EmptyTitle>
          <EmptyDescription>
            Mend reached GitHub as {login}, but {login} can't see any repositories yet. Give {login}{" "}
            access to a repository on GitHub, then check again.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            variant="outline"
            size={phone ? "touch" : "sm"}
            disabled={listed.isFetching}
            onClick={() => void listed.refetch()}
          >
            {listed.isFetching ? "Checking…" : "Check again"}
          </Button>
        </EmptyContent>
      </Empty>
    );

  const all = listed.data;
  const limit = phone ? SHOWN.phone : SHOWN.desktop;
  const rows =
    words === ""
      ? all.slice(0, limit)
      : onPage
        ? repositoriesMatching(all, words)
        : found.isSuccess
          ? found.data
          : [];
  const hidden = words === "" ? all.length - rows.length : 0;
  return (
    <div className="min-w-0">
      <InputGroup className={cn("rounded-b-none", phone && "h-11")}>
        <InputGroupAddon>
          <SearchIcon aria-hidden className="size-4" />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          aria-label="Search repositories"
          aria-describedby={`${ids}-count`}
          placeholder={onPage ? `Search ${all.length} repositories` : "Search repositories"}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <InputGroupAddon align="inline-end">
          <span id={`${ids}-count`} role="status" className="text-row text-muted-foreground">
            {words !== "" && onPage ? `${rows.length} of ${all.length}` : ""}
          </span>
        </InputGroupAddon>
      </InputGroup>
      <div className="rounded-b-lg border border-t-0">
        {words !== "" && !onPage && found.isPending ? (
          <p role="status" className="px-3 py-2.5 text-row text-muted-foreground">
            Searching GitHub…
          </p>
        ) : words !== "" && !onPage && found.isError ? (
          <div className="p-3">
            <InlineAlert tone="warning" title="GitHub didn't answer the search.">
              {failureWords(found.error, "The Mend server didn't answer.")}
            </InlineAlert>
          </div>
        ) : rows.length === 0 ? (
          <p role="status" className="px-3 py-2.5 text-row text-muted-foreground">
            No repositories match {words}.
          </p>
        ) : (
          <fieldset className="max-h-80 overflow-y-auto">
            <legend className="sr-only">Repositories</legend>
            {rows.map((repository) => (
              <RepositoryRow
                key={repository.nameWithOwner}
                repository={repository}
                name={`${ids}-pick`}
                selected={picked?.nameWithOwner === repository.nameWithOwner}
                taken={alreadyAdded(repository, projects)}
                organizationName={organizationName}
                pushed={pushedAgo(repository.pushedAt, now)}
                phone={phone}
                onPick={() => onPick(repository)}
              />
            ))}
          </fieldset>
        )}
        {hidden > 0 ? (
          <p className="border-t px-3 py-2 text-row text-muted-foreground">
            {onPage
              ? `${hidden} more. Search to find them.`
              : "More on GitHub. Search to find them."}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function RepositoryRow({
  repository,
  name,
  selected,
  taken,
  organizationName,
  pushed,
  phone,
  onPick,
}: {
  readonly repository: GithubRepository;
  readonly name: string;
  readonly selected: boolean;
  /** A project the person can see has this repository already. */
  readonly taken: boolean;
  readonly organizationName: string;
  readonly pushed: string;
  readonly phone: boolean;
  readonly onPick: () => void;
}) {
  const visibility = repository.visibility === "public" ? "Public" : "Private";
  const when = taken ? `Already in ${organizationName}` : pushed;
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-3 border-b px-3 last:border-b-0 has-focus-visible:ring-3 has-focus-visible:ring-ring/50 has-focus-visible:ring-inset",
        phone ? "min-h-14 py-2" : "h-10",
        selected && "bg-accent",
        taken && "cursor-default text-muted-foreground",
      )}
    >
      <input
        type="radio"
        name={name}
        className="sr-only"
        checked={selected}
        disabled={taken}
        onChange={onPick}
      />
      <GithubIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      {phone ? (
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate font-mono text-meta text-foreground">
            {repository.nameWithOwner}
          </span>
          <span className="truncate text-row text-muted-foreground">
            {when === "" ? visibility : `${visibility} · ${when}`}
          </span>
        </span>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate font-mono text-meta text-foreground">
            {repository.nameWithOwner}
          </span>
          <span className="shrink-0 text-2xs text-muted-foreground">{visibility}</span>
          <span className="w-32 shrink-0 text-right text-row text-muted-foreground">{when}</span>
        </>
      )}
      <CheckIcon
        aria-hidden
        className={cn("size-4 shrink-0 text-primary", selected ? "visible" : "invisible")}
      />
    </label>
  );
}

/** Who sees the project: the person only, or everyone in the organization. */
function VisibleTo({
  value,
  onChange,
  organizationName,
  phone,
  disabled = false,
}: {
  readonly value: Visibility;
  readonly onChange?: (value: Visibility) => void;
  readonly organizationName: string;
  readonly phone: boolean;
  readonly disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4 border-y py-3 max-lg:flex-col max-lg:items-stretch max-lg:gap-2 max-lg:border-0 max-lg:py-0">
      <p id={id} className="text-sm font-medium text-foreground">
        Visible to
      </p>
      <Tabs
        value={value}
        onValueChange={(next: Visibility) => onChange?.(next)}
        className="max-lg:w-full"
      >
        <TabsList aria-labelledby={id} className={cn("max-lg:w-full", phone && "h-11")}>
          <TabsTrigger value="private" disabled={disabled}>
            Only you
          </TabsTrigger>
          <TabsTrigger value="shared" disabled={disabled} className="min-w-0">
            <span className="truncate">Everyone in {organizationName}</span>
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}

/**
 * What was asked, as it stands while the clone runs and after it ends, then the clone itself:
 * running with git's progress, cloned, or failed with why.
 */
function CloneView({
  attempt,
  state,
  progress,
  picked,
  projects,
  organizationName,
  phone,
  skippedAgent,
  onContinue,
  onRetry,
  onEdit,
}: {
  readonly attempt: AdoptionAttempt;
  readonly state: Exclude<CloneState, { readonly _tag: "Gone" }>;
  readonly progress: AdoptionProgressDto | null;
  /** The repository picked on GitHub, when this page picked it. */
  readonly picked: GithubRepository | null;
  readonly projects: ReadonlyArray<ProjectDto>;
  readonly organizationName: string;
  readonly phone: boolean;
  readonly skippedAgent: boolean;
  readonly onContinue: () => void;
  /** Null when the browser didn't keep what was asked (a clone it didn't start here). */
  readonly onRetry: (() => void) | null;
  readonly onEdit: () => void;
}) {
  const ids = useId();
  const source = progress?.source ?? attempt.source;
  const size = phone ? "touch" : "default";
  const fromGithub = source !== null && shortOrigin(source).startsWith("github.com/");
  const onGithub =
    picked !== null && source !== null && cloneUrlOf(picked) === source
      ? picked.visibility === "public"
        ? "Public"
        : "Private"
      : null;
  return (
    <div className="mt-6 flex min-w-0 flex-col gap-5">
      <dl className="flex flex-col gap-5">
        <div className="grid gap-2">
          <dt className="text-sm font-medium text-foreground">Repository</dt>
          <dd className="grid gap-1.5">
            <span className="flex h-9 items-center gap-2.5 rounded-lg border border-input bg-muted px-3 text-row text-foreground max-lg:h-11">
              {fromGithub ? (
                <GithubIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <FolderGit2Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {source === null ? attempt.name : repositoryName(source)}
              </span>
              {onGithub === null ? null : (
                <span className="shrink-0 text-meta text-muted-foreground">{onGithub}</span>
              )}
            </span>
            {source === null ? null : (
              <span className="text-row text-muted-foreground">
                Mend clones <code className="font-mono text-meta break-all">{source}</code>
              </span>
            )}
          </dd>
        </div>
        <div className="grid gap-2">
          <dt className="text-sm font-medium text-foreground">Name</dt>
          <dd className="flex h-9 items-center rounded-lg border border-input bg-muted px-3 text-row text-foreground max-lg:h-11">
            {attempt.name}
          </dd>
        </div>
      </dl>
      <VisibleTo
        value={attempt.visibility ?? "private"}
        organizationName={organizationName}
        phone={phone}
        disabled
      />
      <section aria-labelledby={`${ids}-clone`} className="flex flex-col gap-2">
        <CloneHeading id={`${ids}-clone`} attempt={attempt} state={state} progress={progress} />
        {state._tag === "Cloning" ? (
          <Running progress={progress} />
        ) : state._tag === "Added" ? (
          <Added progress={progress} project={projects.find((row) => row.id === state.projectId)} />
        ) : (
          <>
            <Progress
              value={progress?.git?.percent ?? 0}
              aria-label="How far the clone got"
              className="[&_[data-slot=progress-indicator]]:bg-muted-foreground"
            />
            {state.gitSaid === null ? null : (
              <p className="font-mono text-meta break-words whitespace-pre-wrap text-muted-foreground">
                {state.gitSaid}
              </p>
            )}
            <InlineAlert size={size} title="The clone failed.">
              {state.message}
            </InlineAlert>
            <MendKeyHelp source={attempt.source} touch={phone} />
          </>
        )}
      </section>
      {state._tag === "Failed" ? (
        <SetupActions status="Your choices above stay as they are." divided={false}>
          <Button variant="secondary" size={size} onClick={onEdit}>
            Change details
          </Button>
          {onRetry === null ? null : (
            <Button size={size} onClick={onRetry}>
              Clone again
            </Button>
          )}
        </SetupActions>
      ) : (
        <SetupActions
          status={
            state._tag === "Cloning"
              ? "The clone keeps going if you continue."
              : skippedAgent
                ? "You can add an agent login later in Settings."
                : "You can add more projects later in Projects."
          }
        >
          <Button size={size} onClick={onContinue}>
            Continue to Mend
          </Button>
        </SetupActions>
      )}
    </div>
  );
}

/** "Cloning checkout-api · Running 12s", "Cloned … · Completed 34s", "… · Failed after 41s". */
function CloneHeading({
  id,
  attempt,
  state,
  progress,
}: {
  readonly id: string;
  readonly attempt: AdoptionAttempt;
  readonly state: Exclude<CloneState, { readonly _tag: "Gone" }>;
  readonly progress: AdoptionProgressDto | null;
}) {
  const now = useSecond();
  const took =
    state._tag === "Cloning"
      ? waitedFor(progress?.startedAt ?? new Date(attempt.startedAt), now)
      : state._tag === "Added"
        ? progress === null
          ? null
          : waitedFor(progress.startedAt, progress.updatedAt)
        : state.startedAt === null || state.endedAt === null
          ? null
          : `after ${waitedFor(state.startedAt, state.endedAt)}`;
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 id={id} className="min-w-0 truncate text-sm font-semibold text-foreground">
        {state._tag === "Added" ? "Cloned" : "Cloning"} {attempt.name}
      </h2>
      <p className="flex shrink-0 items-baseline gap-2 text-row text-muted-foreground">
        <span
          role="status"
          className={cn("text-meta", state._tag === "Failed" && "text-destructive")}
        >
          {state._tag === "Cloning" ? "Running" : state._tag === "Added" ? "Completed" : "Failed"}
        </span>
        {took === null ? null : <span className="tabular-nums">{took}</span>}
      </p>
    </div>
  );
}

function Running({ progress }: { readonly progress: AdoptionProgressDto | null }) {
  const percent = progress?.git?.percent ?? null;
  const detail = cloneDetail(progress);
  return (
    <>
      <Progress
        value={percent}
        aria-label={percent === null ? "Cloning" : `Cloning, ${percent}%`}
      />
      <p className="flex gap-3 text-row text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{detail.step}</span>
        {detail.transfer === null ? null : (
          <span className="shrink-0 tabular-nums">{detail.transfer}</span>
        )}
      </p>
    </>
  );
}

/** "Mend cloned 212.40 MiB. New sessions start from main." */
function Added({
  progress,
  project,
}: {
  readonly progress: AdoptionProgressDto | null;
  readonly project: ProjectDto | undefined;
}) {
  const received = progress?.git?.received ?? null;
  const branch = project?.defaultBranch ?? null;
  return (
    <p className="text-row text-muted-foreground">
      {received === null ? "Mend cloned the repository." : `Mend cloned ${received}.`}
      {branch === null ? null : (
        <>
          {" "}
          New sessions start from <code className="font-mono text-meta">{branch}</code>.
        </>
      )}
    </p>
  );
}
