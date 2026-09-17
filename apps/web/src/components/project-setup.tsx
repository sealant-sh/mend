import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { GitKeyCard } from "#/components/git-key-card";
import {
  addProjectLink,
  addProjectMount,
  addProjectRecipe,
  addReference,
  refreshReference,
  removeProject,
  removeProjectLink,
  removeProjectMount,
  removeProjectRecipe,
  removeReference,
  selectProjectReferences,
  setProjectAutomation,
  setProjectApplyDotfiles,
  setProjectGitAuth,
  setProjectHotSessions,
  setProjectFolders,
  setProjectInstallCommand,
  setProjectVisibility,
  type AutomationChoiceDto,
  type FolderDto,
  type GitAuthModeDto,
  type ProjectDto,
  type ReferenceDto,
} from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

/**
 * The project's setup sections — references, mounted folders, services,
 * dotfiles, git access, review automation, removal. They live on the project
 * setup page (one place to configure a project); the sidebar rail shows each
 * as a one-line fact linking to its anchor here. Each section is a plain
 * stacked block with an id the rail can target.
 */

const AUTOMATION_ROWS: ReadonlyArray<{
  readonly key: "autoTour" | "autoSuggest" | "autoName";
  readonly label: string;
}> = [
  { key: "autoTour", label: "Description & tour" },
  { key: "autoSuggest", label: "Suggest fixes" },
  { key: "autoName", label: "Name the session" },
];

const AUTOMATION_CHOICES: ReadonlyArray<{
  readonly value: AutomationChoiceDto;
  readonly label: string;
}> = [
  { value: "inherit", label: "inherit" },
  { value: "on", label: "on" },
  { value: "off", label: "off" },
];

const GIT_AUTH_CHOICES: ReadonlyArray<{
  readonly value: GitAuthModeDto;
  readonly label: string;
}> = [
  { value: "mend-key", label: "mend key" },
  { value: "bridge", label: "bridge" },
  { value: "ambient", label: "ambient" },
];

/**
 * How host-side git reaches this project's remote (docs/GIT-ACCESS.md), a
 * per-project override of the user's git access (Settings): mend-key signs
 * with the caller's own Mend key, whose public half this card hands out
 * (switching generates it, so the card can show it immediately); bridge
 * signs through the ssh-agent a mend command shares from the user's machine
 * — presence is shown as an observation, and ops fail readably while nobody
 * is connected; ambient rides the server's login user's ssh setup.
 */
export function GitAccessSection({ project }: { readonly project: ProjectDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gitKey = useQuery(
    trpc.git.key.queryOptions(undefined, { enabled: project.gitAuthMode === "mend-key" }),
  );
  const bridge = useQuery(
    trpc.git.bridgeStatus.queryOptions(undefined, {
      refetchInterval: 5_000,
      enabled: project.gitAuthMode === "bridge",
    }),
  );

  const choose = (value: GitAuthModeDto) => {
    if (project.gitAuthMode === value || busy) return;
    setBusy(true);
    setError(null);
    void setProjectGitAuth(project.id, value)
      .then(() => {
        void queryClient.invalidateQueries(trpc.projects.pathFilter());
        void queryClient.invalidateQueries(trpc.git.key.queryFilter());
        return null;
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <section id="git" className="project-setup-card">
      <h2 className="font-sans text-sm font-semibold">Git access</h2>
      <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
        How Mend reaches this project&apos;s remote; the default for new projects is set in
        Settings. The Mend key is your own key on the server, added to your git account. Bridge
        signs through your machine&apos;s ssh-agent while a <span className="font-mono">mend</span>{" "}
        command runs there. Ambient uses the server&apos;s login user&apos;s git and ssh setup.
      </p>
      <div className="mt-3 flex gap-1">
        {GIT_AUTH_CHOICES.map((choice) => (
          <button
            key={choice.value}
            type="button"
            disabled={busy}
            onClick={() => choose(choice.value)}
            className={`rounded-lg border px-2 py-1 font-mono text-[11px] transition-colors disabled:opacity-50 ${
              project.gitAuthMode === choice.value
                ? "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash text-foreground"
                : "border-border bg-card text-muted-foreground hover:text-foreground"
            }`}
          >
            {choice.label}
          </button>
        ))}
      </div>
      {error !== null && (
        <p className="mt-3 border-l-2 border-[var(--sw-red)] pl-2 text-xs text-danger">{error}</p>
      )}
      {project.gitAuthMode === "mend-key" && gitKey.data !== undefined && (
        <div className="mt-3">
          <GitKeyCard gitKey={gitKey.data} originUrl={project.originUrl} />
        </div>
      )}
      {project.gitAuthMode === "bridge" && bridge.data !== undefined && (
        <div className="mt-3">
          <p className="flex items-center gap-2 font-mono text-xs">
            <span
              className={`inline-block size-2 rounded-full ${
                bridge.data.connected
                  ? "bg-[var(--sw-green-dot)]"
                  : "border-[1.5px] border-[#b3b0a8]"
              }`}
            />
            <span className={bridge.data.connected ? "text-ink-2" : "text-faint"}>
              {bridge.data.connected
                ? `signer connected · ${bridge.data.clientName ?? "unknown machine"}`
                : "no signer connected"}
            </span>
          </p>
          {!bridge.data.connected && (
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              Any attaching <span className="font-mono">mend</span> command on the machine that
              holds your key shares its agent while it runs (or{" "}
              <span className="font-mono">mend keys share</span> by hand); git ops for this project
              wait for no one — they fail readably until a signer connects.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Whether sessions in this project receive the launching user's dotfiles (repo + synced home
 * files, configured per account in Settings). A boolean, not a cascade: dotfiles are identity,
 * so the only project-level question is "does this project want them applied". Custom-image
 * projects skip dotfiles regardless — a BYO base brings its own environment, and the platform
 * rejects them there.
 */
export function DotfilesSection({ project }: { readonly project: ProjectDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const settings = useQuery(trpc.settings.get.queryOptions());
  const customImage = (project.workspaceImage ?? settings.data?.workspaceImage)?.mode === "custom";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = (applyDotfiles: boolean) => {
    setBusy(true);
    setError(null);
    void setProjectApplyDotfiles(project.id, applyDotfiles)
      .then(() => queryClient.invalidateQueries(trpc.projects.pathFilter()))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not save the dotfiles switch."),
      )
      .finally(() => setBusy(false));
  };

  return (
    <section id="dotfiles" className="project-setup-card">
      <h2 className="font-sans text-sm font-semibold">Dotfiles</h2>
      {customImage ? (
        <p className="mt-2.5 font-mono text-xs text-faint">custom image · dotfiles not applied</p>
      ) : (
        <div className="mt-2.5 flex items-center justify-between gap-3">
          <p className="min-w-0 font-mono text-xs text-ink-2">
            {project.applyDotfiles ? "your dotfiles · applied at launch" : "dotfiles · off"}
            <span className="text-faint"> · set up in Settings</span>
          </p>
          <div className="flex shrink-0 gap-1">
            {([true, false] as const).map((value) => (
              <button
                key={String(value)}
                type="button"
                disabled={busy}
                onClick={() => save(value)}
                className={`rounded-lg border px-2 py-1 font-mono text-[11px] transition-colors disabled:opacity-50 ${
                  project.applyDotfiles === value
                    ? "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash text-foreground"
                    : "border-border bg-card text-muted-foreground hover:text-foreground"
                }`}
              >
                {value ? "on" : "off"}
              </button>
            ))}
          </div>
        </div>
      )}
      {error === null ? null : <p className="mt-2 text-xs leading-relaxed text-danger">{error}</p>}
    </section>
  );
}

/**
 * Hot sessions: how many pre-provisioned workspaces this project keeps ready. A new session
 * claims one and attaches immediately instead of waiting for a container to build and boot.
 * Each ready workspace is a live container on this machine — the count is explicit resource
 * intent. The pool drains and rewarms itself when the image, variables, secrets, references,
 * mounts, or dotfiles change.
 */
export function HotSessionsSection({ project }: { readonly project: ProjectDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const status = useQuery(
    trpc.projects.hotSessionsStatus.queryOptions({ id: project.id }, { refetchInterval: 5_000 }),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = (hotSessions: number) => {
    if (busy || hotSessions < 0 || hotSessions > 8 || hotSessions === project.hotSessions) return;
    setBusy(true);
    setError(null);
    void setProjectHotSessions(project.id, hotSessions)
      .then(() => queryClient.invalidateQueries(trpc.projects.pathFilter()))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not save the hot-sessions count."),
      )
      .finally(() => setBusy(false));
  };

  const observed = status.data;
  const parts: Array<string> = [];
  if (observed !== undefined) {
    if (observed.ready > 0) parts.push(`${observed.ready} ready`);
    if (observed.warming > 0) parts.push(`${observed.warming} warming`);
    if (observed.failed > 0) parts.push(`${observed.failed} failed`);
  }
  const statusLine =
    parts.length > 0 ? parts.join(" · ") : project.hotSessions === 0 ? "off" : "none ready yet";

  return (
    <section id="hot-sessions" className="project-setup-card">
      <h2 className="font-sans text-sm font-semibold">Hot sessions</h2>
      <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
        Workspaces kept ready for each person who started a session here in the last week — their
        next session claims one and attaches immediately. Each ready workspace is a live container
        on this machine, so the count applies per person; the pool rebuilds when the image,
        variables, secrets, references, mounts, or dotfiles change.
      </p>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="min-w-0 font-mono text-xs text-ink-2">{statusLine}</p>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            disabled={busy || project.hotSessions === 0}
            onClick={() => save(project.hotSessions - 1)}
            aria-label="Keep one fewer workspace ready"
            className="h-[26px] rounded-lg border border-border bg-card px-2 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          >
            −
          </button>
          <span className="min-w-5 text-center font-mono text-xs text-foreground">
            {project.hotSessions}
          </span>
          <button
            type="button"
            disabled={busy || project.hotSessions >= 8}
            onClick={() => save(project.hotSessions + 1)}
            aria-label="Keep one more workspace ready"
            className="h-[26px] rounded-lg border border-border bg-card px-2 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          >
            +
          </button>
        </div>
      </div>
      {observed?.error != null && (
        <p className="mt-2 border-l-2 border-[var(--sw-red)] pl-2 font-mono text-xs text-danger">
          warming failed · {observed.error}
        </p>
      )}
      {error !== null && (
        <p className="mt-2 border-l-2 border-[var(--sw-red)] pl-2 text-xs text-danger">{error}</p>
      )}
    </section>
  );
}

export function ReviewAutomationSection({ project }: { readonly project: ProjectDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const choose = (key: "autoTour" | "autoSuggest" | "autoName", value: AutomationChoiceDto) => {
    if (project[key] === value) return;
    setBusy(key);
    void setProjectAutomation(project.id, {
      autoTour: key === "autoTour" ? value : project.autoTour,
      autoSuggest: key === "autoSuggest" ? value : project.autoSuggest,
      autoName: key === "autoName" ? value : project.autoName,
      backgroundSessions: project.backgroundSessions,
    })
      .then(() => queryClient.invalidateQueries(trpc.projects.pathFilter()))
      .finally(() => setBusy(null));
  };

  return (
    <section id="review" className="project-setup-card">
      <h2 className="font-sans text-sm font-semibold">Review automation</h2>
      <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
        What Mend runs when a session settles here. Inherit follows the defaults in Settings.
      </p>
      <div className="mt-3 flex flex-col gap-3">
        {AUTOMATION_ROWS.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate font-sans text-[13px] font-medium text-foreground">
              {row.label}
            </p>
            <div className="flex shrink-0 gap-1">
              {AUTOMATION_CHOICES.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => choose(row.key, choice.value)}
                  className={`rounded-lg border px-2 py-1 font-mono text-[11px] transition-colors disabled:opacity-50 ${
                    project[row.key] === choice.value
                      ? "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash text-foreground"
                      : "border-border bg-card text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The project's stance on the session lifecycle: inherit follows Settings.
 * Resolved by the launching CLI (flag → project → settings) — only the client
 * that would stop the session can enforce foreground.
 */
export function SessionLifecycleSection({ project }: { readonly project: ProjectDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const choose = (value: AutomationChoiceDto) => {
    if (project.backgroundSessions === value || busy) return;
    setBusy(true);
    void setProjectAutomation(project.id, {
      autoTour: project.autoTour,
      autoSuggest: project.autoSuggest,
      autoName: project.autoName,
      backgroundSessions: value,
    })
      .then(() => queryClient.invalidateQueries(trpc.projects.pathFilter()))
      .finally(() => setBusy(false));
  };

  return (
    <section id="sessions" className="project-setup-card">
      <h2 className="font-sans text-sm font-semibold">Sessions</h2>
      <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
        Whether sessions here keep running when every client disconnects. Off gives CLI launches
        foreground semantics — the session stops when the launching mend exits. Inherit follows the
        default in Settings.
      </p>
      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="min-w-0 truncate font-sans text-[13px] font-medium text-foreground">
          Run sessions in the background
        </p>
        <div className="flex shrink-0 gap-1">
          {AUTOMATION_CHOICES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              disabled={busy}
              onClick={() => choose(choice.value)}
              className={`rounded-lg border px-2 py-1 font-mono text-[11px] transition-colors disabled:opacity-50 ${
                project.backgroundSessions === choice.value
                  ? "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash text-foreground"
                  : "border-border bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

export function RemoveProjectSection({ projectId }: { readonly projectId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState<"idle" | "armed" | "working">("idle");
  const [leftoverNote, setLeftoverNote] = useState<string | null>(null);

  const remove = () => {
    if (removing === "idle") {
      setRemoving("armed");
      return;
    }
    if (removing !== "armed") return;
    setRemoving("working");
    void removeProject(projectId)
      .then((report) => {
        if (report.leftover !== null) setLeftoverNote(report.leftover);
        void queryClient.invalidateQueries();
        return navigate({ to: "/projects" });
      })
      .catch(() => setRemoving("idle"));
  };

  return (
    <section id="remove" className="project-setup-card">
      <button
        type="button"
        disabled={removing === "working"}
        onClick={remove}
        onBlur={() => setRemoving((current) => (current === "armed" ? "idle" : current))}
        className={`font-sans text-xs font-medium transition-colors disabled:opacity-50 ${removing === "armed" ? "text-danger" : "text-muted-foreground hover:text-danger"}`}
      >
        {removing === "working"
          ? "Removing…"
          : removing === "armed"
            ? "Really remove project and store copy?"
            : "Remove project…"}
      </button>
      {removing === "armed" && (
        <p className="mt-2 font-mono text-xs text-faint">
          Stops live sessions, deletes sessions and reviews, and removes the store copy. The origin
          repository is untouched.
        </p>
      )}
      {leftoverNote !== null && (
        <p className="mt-2 font-mono text-xs text-warning">
          some files would not delete (container-owned) — remaining at {leftoverNote}
        </p>
      )}
    </section>
  );
}

/**
 * Per-project extra mounts (plan §17, 2026-08-01): host folders this
 * project's sessions can see at /workspace/home/<name>. Read-only by default;
 * read-write is a deliberate per-folder choice, and writes there land on the
 * host folder directly — outside the reviewed change, which stays exactly
 * worktree-versus-base.
 */
export function MountsSection({ projectId }: { readonly projectId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const mounts = useSuspenseQuery(trpc.projects.mounts.queryOptions({ id: projectId })).data;
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries(trpc.projects.pathFilter());

  const remove = (mountId: string) => {
    setBusy(mountId);
    void removeProjectMount(projectId, mountId)
      .then(invalidate)
      .finally(() => setBusy(null));
  };

  const add = (form: HTMLFormElement) => {
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const hostPath = String(data.get("hostPath") ?? "").trim();
    const readOnly = data.get("readOnly") === "on";
    if (name === "" || hostPath === "") return;
    setBusy("add");
    setAddError(null);
    void addProjectMount(projectId, { name, hostPath, readOnly })
      .then(async () => {
        await invalidate();
        form.reset();
        setAdding(false);
        return null;
      })
      .catch((error: unknown) => {
        setAddError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setBusy(null));
  };

  return (
    <section id="mounts" className="project-setup-card">
      <h2 className="font-sans text-sm font-semibold">Mounted folders</h2>
      <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
        Host folders next sessions see at{" "}
        <span className="font-mono text-[11px]">/workspace/home/&lt;name&gt;</span>. Read-only
        unless deliberately chosen otherwise — the reviewed change stays the worktree.
      </p>
      <div className="mt-4 overflow-hidden rounded-xl border border-rule-faint">
        {mounts.map((mount, index) => (
          <div
            key={mount.id}
            className={`px-4 py-3 ${index === 0 ? "" : "border-t border-rule-faint"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="truncate font-sans text-[13px] font-medium text-foreground">
                {mount.name}
                {mount.readOnly ? null : (
                  <span className="ml-2 font-mono text-[11px] text-warning">read-write</span>
                )}
              </p>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => remove(mount.id)}
                className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-danger disabled:opacity-50"
              >
                {busy === mount.id ? "working…" : "remove"}
              </button>
            </div>
            <p className="mt-1 truncate font-mono text-[11px] text-faint">{mount.hostPath}</p>
          </div>
        ))}
        {adding ? (
          <form
            className={`flex flex-col gap-2 px-4 py-3 ${mounts.length === 0 ? "" : "border-t border-rule-faint"}`}
            onSubmit={(event) => {
              event.preventDefault();
              add(event.currentTarget);
            }}
          >
            <input
              name="name"
              autoFocus
              placeholder="name (experiments)"
              className="w-full rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-faint"
            />
            <input
              name="hostPath"
              placeholder="/home/you/Developer/experiments"
              className="w-full rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-faint"
            />
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  name="readOnly"
                  defaultChecked
                  className="size-3.5 accent-[var(--sw-accent)]"
                />
                read-only
              </label>
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false);
                    setAddError(null);
                  }}
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  cancel
                </button>
                <button
                  type="submit"
                  disabled={busy !== null}
                  className="rounded-xl border border-border bg-card px-3 py-1.5 font-mono text-xs text-foreground shadow-xs transition-transform hover:-translate-y-0.5 disabled:opacity-50"
                >
                  {busy === "add" ? "adding…" : "add folder"}
                </button>
              </div>
            </div>
            {addError === null ? null : (
              <p className="border-l-2 border-[var(--sw-red)] pl-2 text-xs text-danger">
                {addError}
              </p>
            )}
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className={`w-full px-4 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground ${mounts.length === 0 ? "" : "border-t border-rule-faint"}`}
          >
            + add folder…
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * Linked projects (ADR-0001): sibling adopted projects this project's
 * sessions work in, read-write, at /workspace/repos/<name>. The linked
 * project's named worktree is bound at launch; commits there are that
 * project's own change, reviewed on its side.
 */
export function LinksSection({ projectId }: { readonly projectId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const links = useSuspenseQuery(trpc.projects.links.queryOptions({ id: projectId })).data;
  const projects = useSuspenseQuery(trpc.projects.list.queryOptions()).data;
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries(trpc.projects.pathFilter());
  const candidates = projects.filter(
    (project) =>
      project.id !== projectId && !links.some((link) => link.linkedProjectId === project.id),
  );
  const nameOf = (id: string) => projects.find((project) => project.id === id)?.name ?? id;

  const remove = (linkId: string) => {
    setBusy(linkId);
    void removeProjectLink(projectId, linkId)
      .then(invalidate)
      .finally(() => setBusy(null));
  };

  const add = (form: HTMLFormElement) => {
    const data = new FormData(form);
    const linkedProjectId = String(data.get("linkedProjectId") ?? "");
    const name = String(data.get("name") ?? "").trim();
    const worktreeName = String(data.get("worktreeName") ?? "").trim();
    if (linkedProjectId === "" || name === "") return;
    setBusy("add");
    setAddError(null);
    void addProjectLink(projectId, {
      linkedProjectId,
      name,
      worktreeName: worktreeName === "" ? null : worktreeName,
    })
      .then(async () => {
        await invalidate();
        form.reset();
        setAdding(false);
        return null;
      })
      .catch((error: unknown) => {
        setAddError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setBusy(null));
  };

  return (
    <section id="links" className="project-setup-card">
      <h2 className="font-sans text-sm font-semibold">Linked projects</h2>
      <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
        Other adopted projects next sessions can work in, read-write, at{" "}
        <span className="font-mono text-[11px]">/workspace/repos/&lt;name&gt;</span>. One of the
        linked project's worktrees is bound at launch; commits there are that project's own change.
      </p>
      <div className="mt-4 overflow-hidden rounded-xl border border-rule-faint">
        {links.map((link, index) => (
          <div
            key={link.id}
            className={`px-4 py-3 ${index === 0 ? "" : "border-t border-rule-faint"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="truncate font-sans text-[13px] font-medium text-foreground">
                {link.name}
                <span className="ml-2 font-mono text-[11px] text-warning">read-write</span>
              </p>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => remove(link.id)}
                className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-danger disabled:opacity-50"
              >
                {busy === link.id ? "working…" : "remove"}
              </button>
            </div>
            <p className="mt-1 truncate font-mono text-[11px] text-faint">
              {nameOf(link.linkedProjectId)} · worktree {link.worktreeName}
            </p>
          </div>
        ))}
        {adding ? (
          <form
            className={`flex flex-col gap-2 px-4 py-3 ${links.length === 0 ? "" : "border-t border-rule-faint"}`}
            onSubmit={(event) => {
              event.preventDefault();
              add(event.currentTarget);
            }}
          >
            <select
              name="linkedProjectId"
              autoFocus
              className="w-full rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground"
            >
              {candidates.length === 0 ? (
                <option value="" disabled>
                  every other project is already linked
                </option>
              ) : null}
              {candidates.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <input
              name="name"
              placeholder="name (api)"
              className="w-full rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-faint"
            />
            <input
              name="worktreeName"
              placeholder="worktree (blank = the default branch's)"
              className="w-full rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-faint"
            />
            <div className="flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  setAddError(null);
                }}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                cancel
              </button>
              <button
                type="submit"
                disabled={busy !== null || candidates.length === 0}
                className="rounded-xl border border-border bg-card px-3 py-1.5 font-mono text-xs text-foreground shadow-xs transition-transform hover:-translate-y-0.5 disabled:opacity-50"
              >
                {busy === "add" ? "linking…" : "link project"}
              </button>
            </div>
            {addError === null ? null : (
              <p className="border-l-2 border-[var(--sw-red)] pl-2 text-xs text-danger">
                {addError}
              </p>
            )}
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className={`w-full px-4 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground ${links.length === 0 ? "" : "border-t border-rule-faint"}`}
          >
            + link a project…
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * Declared Services (docs/SESSION-SERVICES.md): the project's recipes on this
 * machine — the web-editable twin of mend.toml. Sessions offer the union of
 * both as one-tap launchers; on a name collision the file wins.
 */
export function ServicesSection({ projectId }: { readonly projectId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const recipes = useSuspenseQuery(trpc.projects.recipes.queryOptions({ id: projectId })).data;
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries(trpc.projects.pathFilter());

  const remove = (name: string) => {
    setBusy(name);
    void removeProjectRecipe(projectId, name)
      .then(invalidate)
      .finally(() => setBusy(null));
  };

  const add = (form: HTMLFormElement) => {
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const command = String(data.get("command") ?? "").trim();
    const port = Number(String(data.get("port") ?? "").trim());
    const protocol = data.get("udp") === "on" ? ("udp" as const) : ("tcp" as const);
    const requestedScheme = String(data.get("browserScheme") ?? "");
    const browserScheme =
      protocol === "udp" || requestedScheme === ""
        ? null
        : requestedScheme === "https"
          ? ("https" as const)
          : ("http" as const);
    if (name === "" || !Number.isInteger(port)) return;
    setBusy("add");
    setAddError(null);
    void addProjectRecipe(projectId, {
      name,
      command: command === "" ? null : command,
      port,
      protocol,
      browserScheme,
    })
      .then(async () => {
        await invalidate();
        form.reset();
        setAdding(false);
        return null;
      })
      .catch((error: unknown) => {
        setAddError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setBusy(null));
  };

  return (
    <section id="services" className="project-setup-card">
      <h2 className="font-sans text-sm font-semibold">Services</h2>
      <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
        Commands sessions can run and expose — a dev server, a database. Every session offers these
        one tap away, beside whatever <span className="font-mono text-[11px]">mend.toml</span>{" "}
        declares in the repo. Leave the command empty to adopt an already-listening port.
      </p>
      <div className="mt-4 overflow-hidden rounded-xl border border-rule-faint">
        {recipes.map((recipe, index) => (
          <div
            key={recipe.name}
            className={`px-4 py-3 ${index === 0 ? "" : "border-t border-rule-faint"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="truncate font-sans text-[13px] font-medium text-foreground">
                {recipe.name}
              </p>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => remove(recipe.name)}
                className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-danger disabled:opacity-50"
              >
                {busy === recipe.name ? "working…" : "remove"}
              </button>
            </div>
            <p className="mt-1 truncate font-mono text-[11px] text-faint">
              {recipe.command ?? "adopt"} · :{recipe.port}
              {recipe.protocol === "udp" ? "/udp" : ""}
              {recipe.browserScheme === null ? "" : ` · ${recipe.browserScheme}`}
            </p>
          </div>
        ))}
        {adding ? (
          <form
            className={`flex flex-col gap-2 px-4 py-3 ${recipes.length === 0 ? "" : "border-t border-rule-faint"}`}
            onSubmit={(event) => {
              event.preventDefault();
              add(event.currentTarget);
            }}
          >
            <input
              name="name"
              autoFocus
              placeholder="name (web)"
              className="w-full rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-faint"
            />
            <input
              name="command"
              placeholder="pnpm dev (empty = adopt a listening port)"
              className="w-full rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-faint"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2.5">
                <input
                  name="port"
                  inputMode="numeric"
                  placeholder="port (3000)"
                  className="w-28 rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-faint"
                />
                <select
                  name="browserScheme"
                  aria-label="Browser behavior"
                  defaultValue=""
                  className="rounded-lg border border-input bg-background px-2 py-1.5 font-mono text-[11px] text-muted-foreground"
                >
                  <option value="">raw</option>
                  <option value="http">http</option>
                  <option value="https">https</option>
                </select>
                <label className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    name="udp"
                    className="size-3.5 accent-[var(--sw-accent)]"
                  />
                  udp
                </label>
              </span>
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false);
                    setAddError(null);
                  }}
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  cancel
                </button>
                <button
                  type="submit"
                  disabled={busy !== null}
                  className="rounded-xl border border-border bg-card px-3 py-1.5 font-mono text-xs text-foreground shadow-xs transition-transform hover:-translate-y-0.5 disabled:opacity-50"
                >
                  {busy === "add" ? "declaring…" : "declare service"}
                </button>
              </div>
            </div>
            {addError === null ? null : (
              <p className="border-l-2 border-[var(--sw-red)] pl-2 text-xs text-danger">
                {addError}
              </p>
            )}
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className={`w-full px-4 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground ${recipes.length === 0 ? "" : "border-t border-rule-faint"}`}
          >
            + declare service…
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * References (plan §17, 2026-08-01): read-only clones of dependency sources.
 * The list is global; the checkbox is this project's selection — what its
 * next sessions mount at /workspace/ref/<name>. Running sessions keep the
 * mounts they launched with; the session records what it received.
 */
export function ReferencesSection({ projectId }: { readonly projectId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const references = useSuspenseQuery(trpc.git.references.queryOptions()).data;
  const selected = useSuspenseQuery(trpc.projects.references.queryOptions({ id: projectId })).data;
  const selectedIds = new Set(selected.map((reference) => reference.id));
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries(trpc.git.references.queryFilter()),
      queryClient.invalidateQueries(trpc.projects.pathFilter()),
    ]);

  const toggle = (referenceId: ReferenceDto["id"]) => {
    const next = selectedIds.has(referenceId)
      ? [...selectedIds].filter((id) => id !== referenceId)
      : [...selectedIds, referenceId];
    setBusy(referenceId);
    void selectProjectReferences(projectId, next)
      .then(invalidate)
      .finally(() => setBusy(null));
  };

  const refresh = (referenceId: string) => {
    setBusy(referenceId);
    void refreshReference(referenceId)
      .then(invalidate)
      .finally(() => setBusy(null));
  };

  const remove = (referenceId: string) => {
    setBusy(referenceId);
    void removeReference(referenceId)
      .then(invalidate)
      .finally(() => setBusy(null));
  };

  const add = (form: HTMLFormElement) => {
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const source = String(data.get("source") ?? "").trim();
    const ref = String(data.get("ref") ?? "").trim();
    if (name === "" || source === "") return;
    setBusy("add");
    setAddError(null);
    void addReference(name, source, ref === "" ? null : ref)
      .then(async (created) => {
        // A reference added from this page is meant for this project.
        await selectProjectReferences(projectId, [...selectedIds, created.id]);
        await invalidate();
        form.reset();
        setAdding(false);
        return null;
      })
      .catch((error: unknown) => {
        setAddError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setBusy(null));
  };

  return (
    <section id="references" className="project-setup-card">
      <h2 className="font-sans text-sm font-semibold">References</h2>
      <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
        Read-only clones of dependency sources. Checked ones mount at{" "}
        <span className="font-mono text-[11px]">/workspace/ref/&lt;name&gt;</span> in next sessions.
      </p>
      <div className="mt-4 overflow-hidden rounded-xl border border-rule-faint">
        {references.map((reference, index) => (
          <div
            key={reference.id}
            title={reference.originUrl}
            className={`px-4 py-3 ${index === 0 ? "" : "border-t border-rule-faint"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <label className="flex min-w-0 cursor-pointer items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={selectedIds.has(reference.id)}
                  disabled={busy !== null}
                  onChange={() => toggle(reference.id)}
                  className="size-3.5 shrink-0 accent-[var(--sw-accent)]"
                />
                <span className="truncate font-sans text-[13px] font-medium text-foreground">
                  {reference.name}
                </span>
              </label>
              <div className="flex shrink-0 items-center gap-2.5">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => refresh(reference.id)}
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  {busy === reference.id ? "working…" : "refresh"}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => remove(reference.id)}
                  className="text-xs text-muted-foreground transition-colors hover:text-danger disabled:opacity-50"
                >
                  remove
                </button>
              </div>
            </div>
            <p className="mt-1 truncate pl-6 font-mono text-[11px] text-faint">
              {reference.pinnedRef === null ? "" : `@${reference.pinnedRef} · `}
              {reference.headSha === null ? "" : `${reference.headSha.slice(0, 7)}`}
              {reference.refreshedAt === null
                ? ""
                : ` · fetched ${new Date(reference.refreshedAt).toLocaleDateString()}`}
            </p>
          </div>
        ))}
        {adding ? (
          <form
            className={`flex flex-col gap-2 px-4 py-3 ${references.length === 0 ? "" : "border-t border-rule-faint"}`}
            onSubmit={(event) => {
              event.preventDefault();
              add(event.currentTarget);
            }}
          >
            <input
              name="name"
              autoFocus
              placeholder="name (effect)"
              className="w-full rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-faint"
            />
            <input
              name="source"
              placeholder="https://github.com/Effect-TS/effect.git"
              className="w-full rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-faint"
            />
            <input
              name="ref"
              placeholder="ref (optional)"
              className="w-full rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-faint"
            />
            <div className="flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  setAddError(null);
                }}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                cancel
              </button>
              <button
                type="submit"
                disabled={busy !== null}
                className="rounded-xl border border-border bg-card px-3 py-1.5 font-mono text-xs text-foreground shadow-xs transition-transform hover:-translate-y-0.5 disabled:opacity-50"
              >
                {busy === "add" ? "cloning…" : "add reference"}
              </button>
            </div>
            {addError === null ? null : (
              <p className="border-l-2 border-[var(--sw-red)] pl-2 text-xs text-danger">
                {addError}
              </p>
            )}
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className={`w-full px-4 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground ${references.length === 0 ? "" : "border-t border-rule-faint"}`}
          >
            + add reference…
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * The install command (ADR-0002 decisions 2 and 9): what builds the dependency tree. Mend runs
 * it in a workspace whose captured tree does not match the executor's platform, and in the
 * install it launches itself to fill the project's shared cache — never an agent's tree. Empty
 * means Mend detects it from the lockfile at the root of the base tree at launch.
 */
export function InstallCommandSection({ project }: { readonly project: ProjectDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(project.installCommand ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = project.installCommand ?? "";
  const dirty = draft.trim() !== current;

  const save = () => {
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    void setProjectInstallCommand(project.id, draft.trim() === "" ? null : draft.trim())
      .then(() => queryClient.invalidateQueries(trpc.projects.pathFilter()))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not save the install command."),
      )
      .finally(() => setBusy(false));
  };

  return (
    <section id="install-command" className="project-setup-card">
      <h2 className="font-sans text-sm font-semibold">Install command</h2>
      <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
        Builds the dependency tree. Mend runs it in a workspace whose captured tree was built for
        another platform, and in the install Mend launches itself to fill this project&apos;s shared
        cache; an agent&apos;s own tree is never shared. Empty: detected from the lockfile at the
        root of the base tree.
      </p>
      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="detected from the lockfile"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-border bg-card px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-faint"
        />
        <button
          type="submit"
          disabled={busy || !dirty}
          className="h-[26px] rounded-lg border border-border bg-card px-2.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          save
        </button>
      </form>
      <p className="mt-2 font-mono text-xs text-ink-2">
        {current === "" ? "detected from the lockfile at launch" : `runs · ${current}`}
      </p>
      {error !== null && (
        <p className="mt-2 border-l-2 border-[var(--sw-red)] pl-2 text-xs text-danger">{error}</p>
      )}
    </section>
  );
}

/**
 * Private or shared (docs/adr/0003-organizations-and-tenancy.md). Only organization owners see
 * this: the setup page renders it when the project's capabilities allow the change.
 */
export function VisibilitySection({ project }: { readonly project: ProjectDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = (visibility: ProjectDto["visibility"]) => {
    if (busy || visibility === project.visibility) return;
    setBusy(true);
    setError(null);
    void setProjectVisibility(project.id, visibility)
      .then(() => queryClient.invalidateQueries(trpc.projects.pathFilter()))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <section id="visibility" className="project-setup-card">
      <h2 className="font-sans text-sm font-semibold">Visibility</h2>
      <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
        Private: only its creator sees it. Shared: every member sees it, starts sessions in it, and
        reviews its changes. Making a shared project private drains other members&apos; warm
        workspaces; their sessions keep running until they end.
      </p>
      <div
        role="group"
        aria-label="Visibility"
        className="mt-3 flex w-fit rounded-lg bg-wash p-0.5"
      >
        {(["private", "shared"] as const).map((choice) => (
          <button
            key={choice}
            type="button"
            aria-pressed={project.visibility === choice}
            disabled={busy}
            onClick={() => save(choice)}
            className={`rounded-md px-2.5 py-1 font-sans text-xs font-medium transition-colors ${
              project.visibility === choice
                ? "bg-panel text-foreground shadow-[var(--shadow-xs)]"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {choice}
          </button>
        ))}
      </div>
      {error !== null && (
        <p className="mt-2 border-l-2 border-[var(--sw-red)] pl-2 text-xs text-danger">{error}</p>
      )}
    </section>
  );
}

/**
 * Which organization folders this project's sessions mount (docs/adr/0003), at
 * /workspace/home/<name>. Folders themselves are created and filled in Settings.
 */
export function ProjectFoldersSection({
  projectId,
  mountDelivery,
}: {
  readonly projectId: ProjectDto["id"];
  readonly mountDelivery: "bind" | "none";
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const folders = useQuery(trpc.folders.list.queryOptions()).data ?? [];
  const selected = useQuery(trpc.projects.folders.queryOptions({ id: projectId })).data ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = (
    next: ReadonlyArray<{
      readonly folderId: FolderDto["id"];
      readonly name: string;
      readonly readOnly: boolean;
    }>,
  ) => {
    setBusy(true);
    setError(null);
    void setProjectFolders(projectId, next)
      .then(() => queryClient.invalidateQueries(trpc.projects.folders.pathFilter()))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  const current = selected.map((view) => ({
    folderId: view.folder.id,
    name: view.name,
    readOnly: view.readOnly,
  }));
  const toggle = (folder: FolderDto) =>
    save(
      current.some((entry) => entry.folderId === folder.id)
        ? current.filter((entry) => entry.folderId !== folder.id)
        : [...current, { folderId: folder.id, name: folder.name, readOnly: true }],
    );
  const setReadOnly = (folderId: FolderDto["id"], readOnly: boolean) =>
    save(current.map((entry) => (entry.folderId === folderId ? { ...entry, readOnly } : entry)));

  return (
    <section id="folders" className="project-setup-card">
      <h2 className="font-sans text-sm font-semibold">Folders</h2>
      <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
        Organization folders this project&apos;s next sessions mount at{" "}
        <span className="font-mono">/workspace/home/&lt;name&gt;</span>, read-only unless chosen
        otherwise. Create and fill folders in Settings.
        {mountDelivery === "none"
          ? " This deployment records the selection but does not mount folders into captured workspaces yet."
          : ""}
      </p>
      <div className="mt-3 space-y-2">
        {folders.length === 0 ? (
          <p className="font-mono text-xs text-faint">no folders in this organization yet</p>
        ) : (
          folders.map((folder) => {
            const entry = current.find((candidate) => candidate.folderId === folder.id);
            return (
              <div key={folder.id} className="flex items-center justify-between gap-3">
                <label className="flex min-w-0 items-center gap-2 font-mono text-xs text-ink-2">
                  <input
                    type="checkbox"
                    checked={entry !== undefined}
                    disabled={busy}
                    onChange={() => toggle(folder)}
                  />
                  {folder.name}
                </label>
                {entry === undefined ? null : (
                  <label className="flex items-center gap-2 font-sans text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={!entry.readOnly}
                      disabled={busy}
                      onChange={() => setReadOnly(folder.id, !entry.readOnly)}
                    />
                    sessions may write
                  </label>
                )}
              </div>
            );
          })
        )}
      </div>
      {error !== null && (
        <p className="mt-2 border-l-2 border-[var(--sw-red)] pl-2 text-xs text-danger">{error}</p>
      )}
    </section>
  );
}
