import { InlineAlert } from "@mend/ui/components/banner";
import { CopyField } from "@mend/ui/components/copy-field";
import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import { CodeBlock, CodeBlockContent } from "@mend/ui/components/ui/code-block";
import { Field, FieldDescription, FieldError, FieldLabel } from "@mend/ui/components/ui/field";
import { Input } from "@mend/ui/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@mend/ui/components/ui/input-group";
import { Progress } from "@mend/ui/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@mend/ui/components/ui/tabs";
import { cn } from "@mend/ui/lib/utils";
import {
  keepPreviousData,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookMarkedIcon, CheckIcon, SearchIcon } from "lucide-react";
import { useEffect, useId, useState, useSyncExternalStore } from "react";

import {
  type AdoptionAttempt,
  adoptionProgressOptions,
  clonePercent,
  forgetAdoption,
  rememberAdoption,
  useAdoptionAttempt,
} from "#/lib/adoptions";
import type { AdoptionProgressDto, ProjectDto } from "#/lib/api";
import { type CloneState, cloneStateOf, cloneWords } from "#/lib/clone-state";
import { laterPage } from "#/lib/later-pages";
import { usePhone } from "#/lib/phone";
import {
  alreadyAdded,
  cloneUrlOf,
  type GithubRepository,
  inferName,
  nameIssue,
  repositoryName,
  sourceIssue,
} from "#/lib/projects";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";

import { Overlay } from "./overlay.tsx";

type Visibility = ProjectDto["visibility"];
type Source = "github" | "url" | "empty";

/** What a person asked to clone: kept so a failed clone can be tried again as it was. */
interface CloneRequest {
  readonly name: string;
  readonly source: string;
  readonly visibility: Visibility;
}

/** How long typing rests before the repository search asks GitHub. */
const SEARCH_REST_MS = 250;

/**
 * The clone this browser started (`lib/adoptions`) and where it stands, shared by the Add project
 * dialog and the row that stands for the clone in the list. `start` begins a new one in its place.
 */
export function useClone(userId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const attempt = useAdoptionAttempt(userId);
  const progress = useQuery({
    ...adoptionProgressOptions(trpc, attempt?.id ?? ""),
    // The first read can reach the server before the clone does; ask again before giving up.
    retry: 3,
    retryDelay: 1_000,
    enabled: attempt !== null,
  });
  const adopt = useMutation(
    trpc.projects.adopt.mutationOptions({
      // The list gains the project, and the Projects list's clone row goes, however it ended.
      onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() }),
    }),
  );
  const ownRequest = attempt !== null && adopt.variables?.adoptionId === attempt.id;
  const state =
    attempt === null
      ? null
      : cloneStateOf(
          {
            data: progress.isPending || progress.isError ? undefined : progress.data,
            failed: progress.isError,
          },
          {
            pending: ownRequest && adopt.isPending,
            project: ownRequest ? adopt.data : undefined,
            error: ownRequest ? adopt.error : null,
          },
        );
  const added = state?._tag === "Added" ? state.projectId : null;
  // The clone ended in a project: the list reads it from the server now.
  useEffect(() => {
    if (added !== null)
      void queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() });
  }, [added, queryClient, trpc]);
  const start = (request: CloneRequest) => {
    const id = crypto.randomUUID();
    rememberAdoption(userId, {
      id,
      name: request.name,
      startedAt: Date.now(),
      source: request.source,
      visibility: request.visibility,
    });
    adopt.mutate({
      name: request.name,
      source: request.source,
      visibility: request.visibility,
      adoptionId: id,
    });
  };
  return { attempt, state, start, forget: () => forgetAdoption(userId) };
}

export type Clone = ReturnType<typeof useClone>;

/** A failed clone's request, when the browser kept what it asked for. */
const retryOf = (attempt: AdoptionAttempt): CloneRequest | null =>
  attempt.source === null
    ? null
    : { name: attempt.name, source: attempt.source, visibility: attempt.visibility ?? "private" };

/**
 * Add project (Doop "Add project · choose a repository", "Phone · Add project"): a repository the
 * Mend server's GitHub login can reach, any Git address, or an empty project, with its name and
 * who can see it. Adding one clones it onto the Mend server; the dialog shows the clone, which goes
 * on if the dialog closes, then how it ended.
 */
export function AddProject({
  open,
  onOpenChange,
  clone,
  projects,
  organizationName,
  onAdded,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The clone this browser started (`useClone`), which the page's list shows too. */
  readonly clone: Clone;
  readonly projects: ReadonlyArray<ProjectDto>;
  readonly organizationName: string;
  /** An empty project was made: the page says so. */
  readonly onAdded: (project: ProjectDto) => void;
}) {
  // "Change details" after a failure goes back to the form with what was asked.
  const [editing, setEditing] = useState<CloneRequest | null>(null);
  const close = () => {
    onOpenChange(false);
    setEditing(null);
    // An end seen is done with; a clone still running stays, for the list and the composer.
    if (clone.state !== null && clone.state._tag !== "Cloning") clone.forget();
  };
  const onOpen = (next: boolean) => (next ? onOpenChange(true) : close());

  const { attempt, state } = clone;
  if (attempt !== null && state !== null && state._tag !== "Gone" && editing === null) {
    if (state._tag === "Cloning")
      return (
        <Cloning open={open} onOpenChange={onOpen} attempt={attempt} progress={state.progress} />
      );
    if (state._tag === "Added")
      return (
        <Added
          open={open}
          onOpenChange={onOpen}
          name={projects.find((row) => row.id === state.projectId)?.name ?? attempt.name}
          projectId={state.projectId}
          source={attempt.source}
        />
      );
    const retry = retryOf(attempt);
    return (
      <CloneFailed
        open={open}
        onOpenChange={onOpen}
        attempt={attempt}
        failure={state}
        onRetry={retry === null ? null : () => clone.start(retry)}
        onEdit={() =>
          setEditing(retry ?? { name: attempt.name, source: "", visibility: "private" })
        }
      />
    );
  }
  return (
    <Overlay
      open={open}
      onOpenChange={onOpen}
      title="Add project"
      description="Mend clones the repository onto this server. Sessions in the project work on that copy."
      size="md"
      footer={null}
    >
      {open ? (
        <AddProjectForm
          key={editing === null ? "new" : `edit-${editing.source}`}
          projects={projects}
          organizationName={organizationName}
          initial={editing}
          onCancel={close}
          onClone={(request) => {
            setEditing(null);
            clone.start(request);
          }}
          onAdded={(project) => {
            close();
            onAdded(project);
          }}
        />
      ) : null}
    </Overlay>
  );
}

function AddProjectForm({
  projects,
  organizationName,
  initial,
  onCancel,
  onClone,
  onAdded,
}: {
  readonly projects: ReadonlyArray<ProjectDto>;
  readonly organizationName: string;
  readonly initial: CloneRequest | null;
  readonly onCancel: () => void;
  readonly onClone: (request: CloneRequest) => void;
  readonly onAdded: (project: ProjectDto) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const ids = useId();
  const github = useQuery(trpc.github.status.queryOptions(undefined, { staleTime: 60_000 }));
  const signedIn = github.isSuccess && github.data.authenticated;
  const [chosen, setChosen] = useState<Source | null>(initial === null ? null : "url");
  // From GitHub when the server can list repositories, else an address.
  const source: Source = chosen ?? (github.isPending || signedIn ? "github" : "url");
  const [search, setSearch] = useState("");
  const [searched, setSearched] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearched(search), SEARCH_REST_MS);
    return () => clearTimeout(timer);
  }, [search]);
  const repositories = useQuery({
    ...trpc.github.repos.queryOptions({ query: searched }, { staleTime: 30_000 }),
    enabled: signedIn && source === "github",
    placeholderData: keepPreviousData,
  });
  const [picked, setPicked] = useState<GithubRepository | null>(null);
  const [address, setAddress] = useState(initial?.source ?? "");
  const [typedName, setTypedName] = useState<string | null>(initial?.name ?? null);
  const [visibility, setVisibility] = useState<Visibility>(initial?.visibility ?? "private");
  // An address's problem shows once it looks finished: after a blur, or a try to add.
  const [touched, setTouched] = useState(false);

  const createEmpty = useMutation(
    trpc.projects.createNew.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() }),
    }),
  );
  const share = useMutation(trpc.projects.setVisibility.mutationOptions());
  const [made, setMade] = useState<ProjectDto | null>(null);

  const cloneSource =
    source === "github" ? (picked === null ? "" : cloneUrlOf(picked)) : address.trim();
  const name = typedName ?? (source === "empty" ? "" : inferName(cloneSource));
  const addressIssue = source === "url" ? sourceIssue(address) : null;
  const nameProblem =
    name === "" && typedName === null ? null : nameIssue(name, projects, organizationName);
  const missing =
    source === "github"
      ? picked === null
        ? "Pick a repository."
        : null
      : source === "url" && address.trim() === ""
        ? "Paste the repository's address."
        : null;
  const blocked =
    missing !== null ||
    addressIssue !== null ||
    nameIssue(name, projects, organizationName) !== null;
  const busy = createEmpty.isPending || share.isPending;

  const submit = () => {
    setTouched(true);
    if (blocked || busy) return;
    if (source !== "empty") {
      onClone({ name, source: cloneSource, visibility });
      return;
    }
    createEmpty.mutate(
      { name },
      {
        onSuccess: (project) => {
          if (visibility === "private") {
            onAdded(project);
            return;
          }
          setMade(project);
          share.mutate(
            { id: project.id, visibility: "shared" },
            {
              onSuccess: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() });
                onAdded(project);
              },
            },
          );
        },
      },
    );
  };

  const touch = phone ? "touch" : "default";
  return (
    <form
      aria-label="Add project"
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Tabs
        value={source}
        onValueChange={(value: Source) => {
          setChosen(value);
          setTouched(false);
        }}
        className="gap-3"
      >
        <TabsList aria-label="Repository" className={cn("w-full", phone && "h-11")}>
          <TabsTrigger value="github">From GitHub</TabsTrigger>
          <TabsTrigger value="url">From a Git URL</TabsTrigger>
          <TabsTrigger value="empty">Empty project</TabsTrigger>
        </TabsList>
        <TabsContent value="github" className="flex min-w-0 flex-col gap-2">
          {github.isPending ? (
            <p role="status" className="text-row text-muted-foreground">
              Asking the Mend server for its GitHub login…
            </p>
          ) : github.isError ? (
            <InlineAlert
              tone="warning"
              title="Mend couldn't reach GitHub."
              size={touch}
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
              repository's address under From a Git URL.
            </InlineAlert>
          ) : !signedIn ? (
            <InlineAlert
              tone="info"
              size={touch}
              actions={
                <Button
                  variant="secondary"
                  size={phone ? "touch" : "sm"}
                  onClick={() => setChosen("url")}
                >
                  Paste an address
                </Button>
              }
            >
              The Mend server has no GitHub login, so it can't list repositories. Paste the
              repository's address instead.
            </InlineAlert>
          ) : (
            <>
              <InputGroup className={cn(phone && "h-11")}>
                <InputGroupAddon>
                  <SearchIcon aria-hidden className="size-4" />
                </InputGroupAddon>
                <InputGroupInput
                  type="search"
                  aria-label="Search repositories"
                  aria-describedby={`${ids}-reach`}
                  placeholder="Search repositories"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </InputGroup>
              <p id={`${ids}-reach`} className="text-row text-muted-foreground">
                Repositories the{" "}
                <span className="font-mono text-meta">{github.data.login ?? "Mend"}</span> GitHub
                account can reach.
              </p>
              <RepositoryList
                query={repositories}
                searched={searched}
                projects={projects}
                organizationName={organizationName}
                picked={picked}
                onPick={(repository) => {
                  setPicked(repository);
                  setTypedName(null);
                }}
                touch={phone}
              />
            </>
          )}
        </TabsContent>
        <TabsContent value="url" className="flex min-w-0 flex-col">
          <Field data-invalid={touched && addressIssue !== null ? true : undefined}>
            <FieldLabel htmlFor={`${ids}-address`}>Repository address</FieldLabel>
            <Input
              id={`${ids}-address`}
              value={address}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://github.com/owner/repository"
              aria-invalid={touched && addressIssue !== null ? true : undefined}
              className={cn("font-mono", phone && "h-11")}
              onChange={(event) => setAddress(event.target.value)}
              onBlur={() => setTouched(address.trim() !== "")}
            />
            {touched && addressIssue !== null ? (
              <FieldError>{addressIssue}</FieldError>
            ) : (
              <FieldDescription>
                An HTTPS or SSH address. Mend clones it with your Git access.
              </FieldDescription>
            )}
          </Field>
        </TabsContent>
        <TabsContent value="empty">
          <p className="text-row text-muted-foreground">
            Mend makes a new repository for it on this server, with nothing in it yet.
          </p>
        </TabsContent>
      </Tabs>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
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
            <FieldDescription>Unique in {organizationName}.</FieldDescription>
          ) : (
            <FieldError>{nameProblem}</FieldError>
          )}
        </Field>
        <Field>
          <FieldLabel id={`${ids}-visible`}>Visible to</FieldLabel>
          <Tabs value={visibility} onValueChange={(value: Visibility) => setVisibility(value)}>
            <TabsList aria-labelledby={`${ids}-visible`} className={cn("w-full", phone && "h-11")}>
              <TabsTrigger value="private">Only you</TabsTrigger>
              <TabsTrigger value="shared" className="min-w-0">
                <span className="truncate">Everyone in {organizationName}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <FieldDescription>
            {visibility === "private"
              ? "You can share it later."
              : "Anyone in it can start sessions here."}
          </FieldDescription>
        </Field>
      </div>
      {createEmpty.isError ? (
        <InlineAlert size={touch} title="The project wasn't made.">
          {failureWords(createEmpty.error, "Mend didn't answer. Try again.")}
        </InlineAlert>
      ) : null}
      {share.isError && made !== null ? (
        <InlineAlert
          size={touch}
          title={`${made.name} was made, but it is only yours.`}
          actions={
            <Button variant="secondary" size={phone ? "touch" : "sm"} onClick={() => onAdded(made)}>
              Keep it private
            </Button>
          }
        >
          {failureWords(share.error, "Mend didn't answer.")} Press Add project to share it again.
        </InlineAlert>
      ) : null}
      {touched && missing !== null ? (
        <p role="alert" className="text-row text-destructive">
          {missing}
        </p>
      ) : null}
      <div className={cn("flex justify-end gap-2.5 pt-1", phone && "*:flex-1")}>
        <Button type="button" variant="secondary" size={touch} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type={share.isError && made !== null ? "button" : "submit"}
          size={touch}
          disabled={busy}
          onClick={
            share.isError && made !== null
              ? () =>
                  share.mutate(
                    { id: made.id, visibility: "shared" },
                    { onSuccess: () => onAdded(made) },
                  )
              : undefined
          }
        >
          {busy ? "Adding…" : "Add project"}
        </Button>
      </div>
    </form>
  );
}

/** The repositories a search found, as rows to pick one from: a radio group under the hood. */
function RepositoryList({
  query,
  searched,
  projects,
  organizationName,
  picked,
  onPick,
  touch,
}: {
  readonly query: UseQueryResult<ReadonlyArray<GithubRepository>, unknown>;
  readonly searched: string;
  readonly projects: ReadonlyArray<ProjectDto>;
  readonly organizationName: string;
  readonly picked: GithubRepository | null;
  readonly onPick: (repository: GithubRepository) => void;
  readonly touch: boolean;
}) {
  const name = useId();
  if (query.isPending)
    return (
      <p role="status" className="py-2 text-row text-muted-foreground">
        Searching your repositories…
      </p>
    );
  if (query.isError)
    return (
      <InlineAlert
        tone="warning"
        title="GitHub didn't answer the search."
        actions={
          <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      >
        {failureWords(query.error, "The Mend server didn't answer.")}
      </InlineAlert>
    );
  if (query.data.length === 0)
    return (
      <p role="status" className="py-2 text-row text-muted-foreground">
        {searched.trim() === ""
          ? "The GitHub account can't reach any repositories."
          : `No repositories match ${searched.trim()}.`}
      </p>
    );
  return (
    <fieldset className="max-h-64 overflow-y-auto rounded-lg border">
      <legend className="sr-only">Repositories</legend>
      {query.data.map((repository) => {
        const taken = alreadyAdded(repository, projects);
        const selected = picked?.nameWithOwner === repository.nameWithOwner;
        return (
          <label
            key={repository.nameWithOwner}
            className={cn(
              "flex cursor-pointer items-center gap-3 border-b px-3 last:border-b-0 has-focus-visible:ring-3 has-focus-visible:ring-ring/50 has-focus-visible:ring-inset",
              touch ? "min-h-11" : "h-10",
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
              onChange={() => onPick(repository)}
            />
            <BookMarkedIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate font-mono text-meta">{repository.nameWithOwner}</span>
            <span className="shrink-0 rounded-sm bg-muted px-1.5 text-2xs text-muted-foreground capitalize">
              {repository.visibility.toLowerCase()}
            </span>
            <span className="ml-auto shrink-0 text-meta text-muted-foreground max-sm:hidden">
              {taken ? `Already in ${organizationName}` : pushedWords(repository.pushedAt)}
            </span>
            {selected ? <CheckIcon aria-hidden className="size-4 shrink-0 text-info" /> : null}
          </label>
        );
      })}
    </fieldset>
  );
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "Updated 2 days ago", from GitHub's last push. */
const pushedWords = (pushedAt: string | null): string => {
  if (pushedAt === null) return "";
  const days = Math.round((Date.parse(pushedAt) - Date.now()) / 86_400_000);
  if (Number.isNaN(days)) return "";
  if (days > -1) return "Updated today";
  if (days > -30) return `Updated ${RELATIVE.format(days, "day")}`;
  if (days > -365) return `Updated ${RELATIVE.format(Math.round(days / 30), "month")}`;
  return `Updated ${RELATIVE.format(Math.round(days / 365), "year")}`;
};

const subscribeToSeconds = (onChange: () => void) => {
  const timer = setInterval(onChange, 1_000);
  return () => clearInterval(timer);
};
const secondNow = () => Math.floor(Date.now() / 1_000);

/** Whole seconds since `since`, drawn again each second while shown. */
function Elapsed({ since }: { readonly since: number }) {
  const now = useSyncExternalStore(subscribeToSeconds, secondNow, secondNow);
  return <>{Math.max(0, now - Math.floor(since / 1_000))} s</>;
}

function Cloning({
  open,
  onOpenChange,
  attempt,
  progress,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly attempt: AdoptionAttempt;
  readonly progress: AdoptionProgressDto | null;
}) {
  const phone = usePhone();
  const percent = clonePercent(progress);
  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      title={`Adding ${attempt.name}`}
      description={`Mend is cloning ${repositoryName(progress?.source ?? attempt.source ?? attempt.name)} onto this server. The clone goes on if you close this.`}
      size="md"
      footer={
        <Button
          variant="secondary"
          size={phone ? "touch" : "default"}
          onClick={() => onOpenChange(false)}
        >
          Close
        </Button>
      }
    >
      <div aria-live="polite" className="flex flex-col gap-2">
        <Progress
          value={percent}
          aria-label={percent === null ? "Cloning" : `Cloning, ${percent}%`}
        />
        <p className="flex gap-3 text-row text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">
            {cloneWords(progress)}
            {percent === null ? "" : ` · ${percent}%`}
          </span>
          <span className="shrink-0 tabular-nums">
            <Elapsed since={attempt.startedAt} />
          </span>
        </p>
      </div>
      <p className="text-row text-muted-foreground">
        You can start a session in {attempt.name} now. It waits for the clone, then starts.
      </p>
    </Overlay>
  );
}

function Added({
  open,
  onOpenChange,
  name,
  projectId,
  source,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly name: string;
  readonly projectId: string;
  readonly source: string | null;
}) {
  const phone = usePhone();
  const size = phone ? "touch" : "default";
  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      title={`${name} added`}
      description={
        source === null
          ? `Mend cloned ${name} onto this server.`
          : `Mend cloned ${repositoryName(source)} onto this server. Sessions in ${name} work on that copy.`
      }
      size="md"
      footer={
        <>
          <Button variant="secondary" size={size} onClick={() => onOpenChange(false)}>
            Done
          </Button>
          <Link
            {...laterPage(`projects/${projectId}`)}
            onClick={() => onOpenChange(false)}
            className={buttonVariants({ size })}
          >
            Open project
          </Link>
        </>
      }
    />
  );
}

/** Whether a clone of this address signs with a key (SSH or SCP-style), where Mend's key matters. */
const signsWithKey = (source: string | null): boolean =>
  source !== null && /^(ssh:\/\/|[^/@:]+@[^/:]+:)/.test(source.trim());

const durationWords = (from: Date | null, to: Date | null): string | null => {
  if (from === null || to === null) return null;
  const seconds = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1_000));
  return seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
};

function CloneFailed({
  open,
  onOpenChange,
  attempt,
  failure,
  onRetry,
  onEdit,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly attempt: AdoptionAttempt;
  readonly failure: Extract<CloneState, { readonly _tag: "Failed" }>;
  /** Null when the browser didn't keep what was asked (a clone it didn't start here). */
  readonly onRetry: (() => void) | null;
  readonly onEdit: () => void;
}) {
  const trpc = useTRPC();
  const phone = usePhone();
  const size = phone ? "touch" : "default";
  const [showKey, setShowKey] = useState(false);
  const access = useQuery({ ...trpc.git.access.queryOptions(), enabled: showKey });
  const took = durationWords(failure.startedAt, failure.endedAt);
  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      title={`Mend couldn't clone ${repositoryName(attempt.source ?? attempt.name)}`}
      size="md"
      footer={
        <>
          <Button variant="secondary" size={size} onClick={onEdit}>
            Change details
          </Button>
          {onRetry === null ? null : (
            <Button size={size} onClick={onRetry}>
              Try again
            </Button>
          )}
        </>
      }
    >
      <p className="text-prose">{failure.message}</p>
      {failure.gitSaid === null ? null : (
        <CodeBlock aria-label="What git said">
          <CodeBlockContent wrap>{failure.gitSaid}</CodeBlockContent>
        </CodeBlock>
      )}
      {took === null ? null : (
        <p className="text-row text-muted-foreground">Failed after {took}.</p>
      )}
      {!signsWithKey(attempt.source) ? null : showKey ? (
        access.isPending ? (
          <p role="status" className="text-row text-muted-foreground">
            Reading Mend's key…
          </p>
        ) : access.isError ? (
          <InlineAlert size={phone ? "touch" : "default"} title="Mend's key couldn't be read.">
            {failureWords(access.error, "The Mend server didn't answer.")}
          </InlineAlert>
        ) : access.data.key.publicKey === null ? (
          <p className="text-row text-muted-foreground">
            You have no Mend key yet. Make one in Settings under Git access.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <p className="text-row text-muted-foreground">
              Add this key to the repository as a deploy key, or to a GitHub account that can read
              it. Then try again.
            </p>
            <CopyField
              value={access.data.key.publicKey}
              label="Copy key"
              size={phone ? "touch" : "default"}
            />
          </div>
        )
      ) : (
        <Button variant="link" className="self-start" onClick={() => setShowKey(true)}>
          Show Mend's key
        </Button>
      )}
    </Overlay>
  );
}
