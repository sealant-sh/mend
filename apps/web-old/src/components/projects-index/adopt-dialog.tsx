import { repositoryCloneUrlIssue } from "@mend/domain/workbench";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState, useSyncExternalStore } from "react";

import { GitKeyCard } from "#/components/git-key-card";
import { Button } from "#/components/kit/button";
import { CodeBox } from "#/components/kit/code-box";
import { Field, FieldSource, GroupField, TextInput } from "#/components/kit/field";
import { ModalDialog } from "#/components/kit/modal";
import { SearchCombobox } from "#/components/kit/search-combobox";
import { Segment } from "#/components/kit/segment";
import { StatusWord } from "#/components/kit/status";
import { SetupSessionPanel } from "#/components/setup-session-panel";
import {
  type AdoptionAttempt,
  forgetAdoption,
  outcomeOf,
  progressWords,
  startAdoption,
  useAdoption,
  useAdoptionDeps,
} from "#/lib/adoptions";
import {
  initGitKey,
  type AdoptionProgressDto,
  type GitAuthModeDto,
  type ProjectDto,
} from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

import { shortOrigin } from "./model";

/** How long typing rests before the repository search asks GitHub. */
const SEARCH_REST_MS = 250;

type GhRepo = {
  readonly nameWithOwner: string;
  readonly visibility: string;
  readonly pushedAt: string | null;
  readonly url: string;
};

/**
 * The URL Mend clones a picked repository from. A public one over https needs no key; a private
 * one over ssh, so the git access chosen below (both are ssh keys) can read it.
 */
export const cloneUrlOf = (repo: GhRepo): string =>
  repo.visibility.toLowerCase() === "public"
    ? `https://github.com/${repo.nameWithOwner}`
    : `git@github.com:${repo.nameWithOwner}.git`;

/** The project name a source suggests: its last path segment, without `.git`. */
export const inferName = (source: string): string => {
  const trimmed = source.replace(/\/+$/, "").replace(/\.git$/, "");
  return trimmed.split(/[/:]/).at(-1) ?? trimmed;
};

/** True when the text is already a git URL or path, so there is nothing to search for. */
const looksLikeUrl = (text: string): boolean => /[:@]|^[/~.]/.test(text.trim());

const pushedWords = (pushedAt: string | null): string => {
  if (pushedAt === null) return "";
  const date = new Date(pushedAt);
  const now = new Date();
  return ` · pushed ${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  })}`;
};

const subscribeToSeconds = (onChange: () => void) => {
  const timer = setInterval(onChange, 1000);
  return () => clearInterval(timer);
};
const secondNow = () => Math.floor(Date.now() / 1000);

/** Whole seconds since `since`, re-rendering once a second while it is shown. */
function Elapsed({ since }: { readonly since: number }) {
  const now = useSyncExternalStore(subscribeToSeconds, secondNow, secondNow);
  return <>{Math.max(0, now - Math.floor(since / 1000))} s</>;
}

/**
 * Adopt a repository (screen J2). Search your GitHub repositories as the Mend server's GitHub
 * sign-in sees them, or paste any git URL; pick the git access the clone uses and who sees the
 * project. Adopting clones onto the Mend server, and the dialog shows how far the clone got in
 * git's own words. It can close while the clone goes on: opening Adopt again shows it, and its
 * end, then offers the setup session.
 */
export function AdoptDialog({
  open,
  onOpenChange,
  projects,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projects: ReadonlyArray<ProjectDto>;
}) {
  const { owner, attempt, progress, lost } = useAdoption();
  const outcome = attempt === null ? null : outcomeOf(attempt, progress, lost);
  const close = (next: boolean) => {
    onOpenChange(next);
    // An end seen is an end done with; a clone still running stays to be seen again.
    if (!next && owner !== null && outcome !== null && outcome._tag !== "Running")
      forgetAdoption(owner);
  };
  const adopted =
    attempt !== null && outcome?._tag === "Adopted"
      ? {
          id: outcome.projectId,
          name: projects.find((project) => project.id === outcome.projectId)?.name ?? attempt.name,
        }
      : null;
  return (
    <ModalDialog
      open={open}
      onOpenChange={close}
      title={adopted === null ? "Adopt a repository" : `${adopted.name} adopted`}
      description={
        adopted === null
          ? `Mend clones it onto the Mend server${typeof window === "undefined" ? "" : ` (${window.location.host})`}. Sessions work in worktrees; your own checkout is never changed.`
          : "It is in Mend's store. A setup session can study it and propose its .mend/ files."
      }
      width={560}
    >
      {!open ? null : adopted !== null ? (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
          <SetupSessionPanel projectId={adopted.id} onClose={() => close(false)} />
          <div className="flex items-center justify-end gap-2.5">
            <Button variant="ghost" onClick={() => close(false)}>
              Done
            </Button>
            <Link
              to="/projects/$projectId"
              params={{ projectId: adopted.id }}
              onClick={() => close(false)}
              className="inline-flex items-center rounded-xl border border-primary bg-primary px-3.5 py-[9px] font-sans text-[13px] leading-none font-medium text-primary-foreground no-underline shadow-cobalt outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sw-accent)]"
            >
              Open project
            </Link>
          </div>
        </div>
      ) : attempt !== null && outcome?._tag === "Running" ? (
        <Cloning attempt={attempt} progress={progress} onClose={() => close(false)} />
      ) : attempt !== null && outcome?._tag === "Unconfirmed" ? (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
          <p className="truncate font-mono text-[12px] text-ink-2">clones {attempt.source}</p>
          <p role="alert" className="font-mono text-[12px] text-warning">
            {attempt.name} · not confirmed · {outcome.message}
          </p>
          <div className="flex items-center justify-end">
            <Button variant="ghost" onClick={() => close(false)}>
              Close
            </Button>
          </div>
        </div>
      ) : (
        <AdoptForm
          // A failed adoption comes back as the form it was sent from, with why it failed.
          key={attempt?.id ?? "new"}
          projects={projects}
          owner={owner}
          failed={attempt !== null && outcome?._tag === "Failed" ? { attempt, ...outcome } : null}
          onCancel={() => close(false)}
        />
      )}
    </ModalDialog>
  );
}

/** A clone under way: Mend's phase, git's own count and a bar where git gives a percent. */
function Cloning({
  attempt,
  progress,
  onClose,
}: {
  readonly attempt: AdoptionAttempt;
  readonly progress: AdoptionProgressDto | undefined;
  readonly onClose: () => void;
}) {
  const percent = progress?.phase === "cloning" ? (progress.git?.percent ?? null) : null;
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      <p className="truncate font-mono text-[12px] text-ink-2">clones {attempt.source}</p>
      <div aria-live="polite" className="grid gap-2">
        <StatusWord tone="run">
          {attempt.name} · {progressWords(progress)} · <Elapsed since={attempt.startedAt} /> ·
          observed
        </StatusWord>
        {percent === null ? null : (
          <progress
            max={100}
            value={percent}
            aria-label={`${progress?.git?.step ?? "Cloning"}, ${percent}%`}
            className="h-1 w-full appearance-none overflow-hidden rounded-full bg-secondary [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-secondary [&::-webkit-progress-value]:bg-primary"
          />
        )}
      </div>
      <p className="text-[12.5px] text-muted-foreground">
        The clone goes on if you close this. Adopt shows it again.
      </p>
      <div className="flex items-center justify-end">
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

function AdoptForm({
  projects,
  owner,
  failed,
  onCancel,
}: {
  readonly projects: ReadonlyArray<ProjectDto>;
  /** The signed-in account the adoption is kept under; null while that is being read. */
  readonly owner: string | null;
  /** The adoption this form sent last, when it failed: its words and git's. */
  readonly failed: {
    readonly attempt: AdoptionAttempt;
    readonly message: string;
    readonly gitSaid: string | null;
  } | null;
  readonly onCancel: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const deps = useAdoptionDeps(queryClient);
  const [typed, setTyped] = useState(failed?.attempt.source ?? "");
  const [searched, setSearched] = useState("");
  const rest = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [picked, setPicked] = useState<GhRepo | null>(null);
  const [name, setName] = useState(failed?.attempt.name ?? "");
  const [authOverride, setAuthOverride] = useState<GitAuthModeDto | null>(null);
  // Private until chosen otherwise (docs/adr/0003): only the adopter sees it; an owner can share it.
  const [visibility, setVisibility] = useState<ProjectDto["visibility"]>("private");
  // A search term is not a URL yet: the URL's words show once it looks like one or Adopt is pressed.
  const [attempted, setAttempted] = useState(false);

  const access = useQuery(trpc.git.access.queryOptions());
  const organization = useQuery(
    trpc.organization.current.queryOptions(undefined, { retry: false, staleTime: 60_000 }),
  ).data;
  const github = useQuery(trpc.github.status.queryOptions(undefined, { staleTime: 60_000 }));
  const signedIn = github.data?.authenticated === true;
  const searching = signedIn && !looksLikeUrl(searched);
  const repos = useQuery({
    ...trpc.github.repos.queryOptions({ query: searched }, { staleTime: 30_000 }),
    enabled: searching,
    placeholderData: keepPreviousData,
  });

  const createKey = useMutation({
    mutationFn: initGitKey,
    onSuccess: () => queryClient.invalidateQueries(trpc.git.access.queryFilter()),
  });
  const auth: GitAuthModeDto = authOverride ?? access.data?.mode ?? "mend-key";
  const gitKey = createKey.data ?? (access.data?.key.exists === true ? access.data.key : null);

  const source = (picked === null ? typed : cloneUrlOf(picked)).trim();
  const sourceIssue = source === "" || picked !== null ? null : repositoryCloneUrlIssue(source);
  const shownIssue = attempted || looksLikeUrl(source) ? sourceIssue : null;
  // A private clone with Mend's key needs the key to exist first: a picked private repository,
  // or an SSH URL, which only a key can read.
  const needsKey =
    auth === "mend-key" &&
    gitKey === null &&
    ((picked !== null && picked.visibility.toLowerCase() !== "public") ||
      /^(ssh:\/\/|[^/@:]+@)/.test(source));
  // The adoption lives apart from the form (`lib/adoptions`): sent, the dialog shows its clone.
  const adopt = () => {
    if (owner === null) return;
    void startAdoption(deps, owner, {
      name: name.trim() === "" ? inferName(source) : name.trim(),
      source,
      auth,
      visibility,
    });
  };

  const adoptedOrigins = new Set(
    projects.flatMap((project) =>
      project.originUrl === null ? [] : [shortOrigin(project.originUrl).toLowerCase()],
    ),
  );
  const isAdopted = (repo: GhRepo) =>
    adoptedOrigins.has(`github.com/${repo.nameWithOwner}`.toLowerCase());

  // Choosing Mend's key creates it up front: its public half must be on the git host before a
  // private clone can succeed, so it shows now.
  const chooseAuth = (mode: GitAuthModeDto) => {
    setAuthOverride(mode);
    if (mode === "mend-key" && gitKey === null && !createKey.isPending) createKey.mutate();
  };

  const onTyped = (value: string) => {
    setTyped(value);
    setAttempted(false);
    if (picked !== null && value !== picked.nameWithOwner) setPicked(null);
    if (rest.current !== null) clearTimeout(rest.current);
    rest.current = setTimeout(() => setSearched(value), SEARCH_REST_MS);
  };

  const status = github.isPending
    ? "checking GitHub on the Mend server…"
    : github.isError
      ? `GitHub not read · ${github.error.message} · paste any git URL`
      : !signedIn
        ? "GitHub search is off: the Mend server has no GitHub login · paste any git URL"
        : !searching
          ? null
          : repos.isError
            ? `search refused · ${repos.error.message}`
            : repos.isFetching
              ? "searching…"
              : repos.data?.length === 0
                ? `no repositories match ${searched.trim()}`
                : null;
  const results = searching ? (repos.data ?? []) : [];

  return (
    <form
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setAttempted(true);
        if (source === "" || sourceIssue !== null || needsKey) return;
        adopt();
      }}
    >
      <Field
        label="Repository"
        source={<FieldSource>{signedIn ? "your GitHub repositories" : "any git URL"}</FieldSource>}
      >
        {(id) => (
          <SearchCombobox
            id={id}
            autoFocus
            items={results}
            itemKey={(repo) => repo.nameWithOwner}
            itemText={(repo) => repo.nameWithOwner}
            meta={(repo) =>
              `${repo.visibility.toLowerCase()}${isAdopted(repo) ? " · adopted" : pushedWords(repo.pushedAt)}`
            }
            value={typed}
            onValueChange={onTyped}
            onPick={(repo) => {
              setPicked(repo);
              setTyped(repo.nameWithOwner);
            }}
            filter="none"
            placeholder={signedIn ? "Search your repositories, or paste a git URL" : "Git URL"}
            status={status}
            footer={
              signedIn && results.length > 0 ? (
                <>
                  <span>
                    {results.length} shown · github.com as {github.data?.login ?? "you"}
                  </span>
                  <span className="flex-1" />
                  <span>or paste any git URL</span>
                </>
              ) : undefined
            }
            invalid={shownIssue !== null}
            describedBy="adopt-source-line adopt-error"
          />
        )}
      </Field>
      <p
        id="adopt-source-line"
        className="-mt-2 truncate font-mono text-[11.5px] text-faint empty:hidden"
      >
        {picked === null ? "" : `clones ${source}`}
      </p>
      <Field label="Name" source={<FieldSource>optional</FieldSource>}>
        {(id) => (
          <TextInput
            id={id}
            value={name}
            placeholder={source === "" ? "inferred from the repository" : inferName(source)}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </Field>
      <GroupField label="Git access">
        <Segment
          label="Git access"
          value={auth}
          onChange={chooseAuth}
          options={[
            { value: "mend-key", label: "Mend's key" },
            { value: "bridge", label: "Your computer's key" },
          ]}
        />
        {auth === "bridge" ? (
          <p className="text-[12.5px] text-muted-foreground">
            Stays on your computer. Each clone and push asks it to sign, so{" "}
            <span className="font-mono text-[12px]">mend bridge</span> must be running there.
          </p>
        ) : createKey.isPending ? (
          <StatusWord tone="run">creating Mend&apos;s key…</StatusWord>
        ) : gitKey !== null ? (
          <div className="mt-1">
            <p className="mb-1.5 text-[12.5px] text-muted-foreground">
              For a private repository, add this public key to your git account first.
            </p>
            <GitKeyCard gitKey={gitKey} originUrl={source === "" ? null : source} />
          </div>
        ) : access.isPending ? (
          <StatusWord tone={null}>reading your git access…</StatusWord>
        ) : (
          <div className="mt-1 flex flex-wrap items-center gap-2.5">
            <p className="text-[12.5px] text-muted-foreground">
              You have no Mend key yet. A private repository needs its public key on your git
              account before Mend can clone it.
            </p>
            <Button size="sm" onClick={() => createKey.mutate()}>
              Create Mend&apos;s key
            </Button>
          </div>
        )}
        {createKey.isError ? (
          <p role="alert" className="font-mono text-[11.5px] text-danger">
            Mend&apos;s key was not created: {createKey.error.message}
          </p>
        ) : null}
        {needsKey ? (
          <p className="font-mono text-[11.5px] text-warning">
            create Mend&apos;s key and add it to your git account before adopting this repository
          </p>
        ) : null}
      </GroupField>
      <GroupField label="Visible to">
        <Segment
          label="Visible to"
          value={visibility}
          onChange={setVisibility}
          options={[
            { value: "private", label: "Only you" },
            {
              value: "shared",
              label: `Everyone in ${organization?.organization.name ?? "the organization"}`,
            },
          ]}
        />
      </GroupField>
      <p
        id="adopt-error"
        role="alert"
        className="border-l-2 border-[var(--sw-red)] pl-2 font-mono text-[12px] text-danger empty:hidden"
      >
        {failed !== null && source === failed.attempt.source
          ? `Not adopted: ${failed.message}`
          : (shownIssue ?? "")}
      </p>
      {failed?.gitSaid != null && failed.gitSaid !== failed.message ? (
        <CodeBox label="What git said" wrap>
          {failed.gitSaid}
        </CodeBox>
      ) : null}
      <div className="flex items-center justify-end gap-2.5">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={owner === null || source === "" || shownIssue !== null || needsKey}
        >
          Adopt
        </Button>
      </div>
    </form>
  );
}
