import { repositoryCloneUrlIssue } from "@mend/domain/workbench";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState, useSyncExternalStore } from "react";

import { GitKeyCard } from "#/components/git-key-card";
import { Button } from "#/components/kit/button";
import { Field, FieldSource, GroupField, TextInput } from "#/components/kit/field";
import { ModalDialog } from "#/components/kit/modal";
import { SearchCombobox } from "#/components/kit/search-combobox";
import { Segment } from "#/components/kit/segment";
import { StatusWord } from "#/components/kit/status";
import { SetupSessionPanel } from "#/components/setup-session-panel";
import { adoptProject, initGitKey, type GitAuthModeDto, type ProjectDto } from "#/lib/api";
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
 * project. Adopting clones onto the Mend server; the dialog stays until the clone answers, then
 * offers the setup session.
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
  const [adopted, setAdopted] = useState<ProjectDto | null>(null);
  const [cloning, setCloning] = useState(false);
  const close = (next: boolean) => {
    if (cloning) return;
    onOpenChange(next);
    if (!next) setAdopted(null);
  };
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
      {!open ? null : adopted === null ? (
        <AdoptForm
          projects={projects}
          onCloningChange={setCloning}
          onAdopted={setAdopted}
          onCancel={() => close(false)}
        />
      ) : (
        <div className="grid gap-4">
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
      )}
    </ModalDialog>
  );
}

function AdoptForm({
  projects,
  onCloningChange,
  onAdopted,
  onCancel,
}: {
  readonly projects: ReadonlyArray<ProjectDto>;
  readonly onCloningChange: (cloning: boolean) => void;
  readonly onAdopted: (project: ProjectDto) => void;
  readonly onCancel: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState("");
  const [searched, setSearched] = useState("");
  const rest = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [picked, setPicked] = useState<GhRepo | null>(null);
  const [name, setName] = useState("");
  const [authOverride, setAuthOverride] = useState<GitAuthModeDto | null>(null);
  // Private until chosen otherwise (docs/adr/0003): only the adopter sees it; an owner can share it.
  const [visibility, setVisibility] = useState<ProjectDto["visibility"]>("private");
  const [startedAt, setStartedAt] = useState(0);
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
  const adopt = useMutation({
    mutationFn: () =>
      adoptProject(name.trim() === "" ? inferName(source) : name.trim(), source, auth, visibility),
    onMutate: () => {
      setStartedAt(Date.now());
      onCloningChange(true);
    },
    onSettled: () => onCloningChange(false),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries(trpc.projects.pathFilter());
      onAdopted(project);
    },
  });
  const busy = adopt.isPending;

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
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setAttempted(true);
        if (source === "" || sourceIssue !== null || needsKey || busy) return;
        adopt.mutate();
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
            disabled={busy}
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
            disabled={busy}
            placeholder={source === "" ? "inferred from the repository" : inferName(source)}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </Field>
      <GroupField label="Git access">
        <Segment
          label="Git access"
          value={auth}
          disabled={busy}
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
            <Button size="sm" disabled={busy} onClick={() => createKey.mutate()}>
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
          disabled={busy}
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
      <div aria-live="polite" className="empty:hidden">
        {busy ? (
          <StatusWord tone="run">
            cloning {picked?.nameWithOwner ?? inferName(source)} onto the Mend server ·{" "}
            <Elapsed since={startedAt} /> · observed
          </StatusWord>
        ) : null}
      </div>
      <p
        id="adopt-error"
        role="alert"
        className="border-l-2 border-[var(--sw-red)] pl-2 font-mono text-[12px] text-danger empty:hidden"
      >
        {adopt.isError ? `Not adopted: ${adopt.error.message}` : (shownIssue ?? "")}
      </p>
      <div className="flex items-center justify-end gap-2.5">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || source === "" || shownIssue !== null || needsKey}
        >
          {busy ? "Adopting…" : "Adopt"}
        </Button>
      </div>
    </form>
  );
}
