import { ProjectEnvironmentVariableId } from "@mend/domain";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useReducer, useRef, useState } from "react";

import {
  DotfilesSection,
  GitAccessSection,
  HotSessionsSection,
  InstallCommandSection,
  LandingSection,
  LinksSection,
  MountsSection,
  ProjectFoldersSection,
  ReferencesSection,
  RemoveProjectSection,
  ReviewAutomationSection,
  ServicesSection,
  SessionLifecycleSection,
  VisibilitySection,
} from "#/components/project-setup";
import { ProjectSkillsSection } from "#/components/project-skills-section";
import {
  setProjectWorkspaceImage,
  type ProjectDto,
  type WorkspaceImageDto,
  type WorkspacePackageResolutionDto,
} from "#/lib/api";
import {
  composerReducer,
  initialComposer,
  looksLikeDotenv,
  rowLane,
  savableRows,
  serializeRows,
} from "#/lib/env-composer";
import {
  addProjectClusterBinding,
  createProjectEnvironmentVariable,
  createProjectSecret,
  loadProjectEnvironment,
  removeProjectClusterBinding,
  removeProjectEnvironmentVariable,
  removeProjectSecret,
  setProjectClusterServiceAccount,
  updateProjectEnvironmentVariable,
  updateProjectSecret,
  type ProjectClusterBindingView,
  type ProjectEnvironmentVariableView,
  type ProjectEnvironmentWriteResult,
  type EnvironmentLoadReportView,
  type ProjectSecretView,
  type ProjectSecretWriteResult,
} from "#/lib/project-environment";
import {
  clientIssues,
  clientSecretIssues,
  initialProjectEnvironmentForm,
  issuesFor,
  projectEnvironmentFormReducer,
} from "#/lib/project-environment-form";
import { useTRPC } from "#/lib/trpc";
import { useInheritedSettings } from "#/lib/viewer";
import { copyText } from "#/lib/workbench-menus";
import {
  OS_LABELS,
  parsePackageDraft,
  resolutionIssue,
  workspaceImageSummary,
} from "#/lib/workspace-environment";

/**
 * Project environment (`docs/archive/plans/project-environment-variables.md` §UI): the workspace image the
 * project's sessions build from, and the project's ordinary environment variables. A child of the
 * project layout, so switching tabs keeps the shared ProjectShell mounted.
 */
export const Route = createFileRoute("/projects/$projectId/setup")({
  ssr: false,
  loader: async ({ context: { queryClient, trpc }, params }) => {
    await Promise.all([
      queryClient.ensureQueryData(trpc.projects.detail.queryOptions({ id: params.projectId })),
      queryClient.ensureQueryData(
        trpc.environment.environment.queryOptions({ projectId: params.projectId }),
      ),
      queryClient.ensureQueryData(
        trpc.environment.secrets.queryOptions({ projectId: params.projectId }),
      ),
      queryClient.ensureQueryData(
        trpc.environment.clusterBindings.queryOptions({ projectId: params.projectId }),
      ),
      queryClient.prefetchQuery(
        trpc.organization.settings.queryOptions(undefined, { retry: false }),
      ),
      queryClient.ensureQueryData(trpc.git.references.queryOptions()),
      queryClient.ensureQueryData(trpc.projects.references.queryOptions({ id: params.projectId })),
      queryClient.ensureQueryData(trpc.projects.mounts.queryOptions({ id: params.projectId })),
      queryClient.ensureQueryData(trpc.projects.recipes.queryOptions({ id: params.projectId })),
      queryClient.ensureQueryData(trpc.skills.list.queryOptions()),
      queryClient.ensureQueryData(trpc.skills.forProject.queryOptions({ id: params.projectId })),
    ]);
  },
  component: ProjectSetupPage,
});

function ProjectSetupPage() {
  const { projectId } = Route.useParams();
  const trpc = useTRPC();
  const { project, capabilities, mountDelivery } = useSuspenseQuery(
    trpc.projects.detail.queryOptions({ id: projectId }),
  ).data;

  return (
    <div className="mt-6">
      <h2 className="text-sm font-medium">Setup</h2>
      <p className="mt-2 max-w-[64ch] text-sm leading-relaxed text-muted-foreground">
        How sessions in this project launch — image, variables, secrets, references, mounts,
        services, dotfiles, git access, review automation. Changes apply to new workspace launches,
        including when you resume a settled session; running workspaces keep the configuration they
        started with.
      </p>

      <div className="mt-8 space-y-6">
        {capabilities.changeVisibility ? <VisibilitySection project={project} /> : null}
        {capabilities.manage ? (
          <>
            <div id="environment" className="scroll-mt-6">
              <WorkspaceImagePanel project={project} />
            </div>
            <ProjectSkillsSection project={project} />
            <div id="variables" className="scroll-mt-6 space-y-6">
              <VariablesComposer projectId={projectId} />
              <ConfigurationPanel projectId={projectId} />
            </div>
            <div id="secrets" className="scroll-mt-6">
              <SecretsPanel projectId={projectId} />
            </div>
            <div id="cluster-bindings" className="scroll-mt-6">
              <ClusterBindingsPanel projectId={projectId} />
            </div>
            <ReferencesSection projectId={projectId} />
            <ProjectFoldersSection projectId={project.id} mountDelivery={mountDelivery} />
            {capabilities.hostMounts ? <MountsSection projectId={projectId} /> : null}
            <LinksSection projectId={projectId} />
            <ServicesSection projectId={projectId} />
            <DotfilesSection project={project} />
            <HotSessionsSection project={project} />
            <InstallCommandSection project={project} />
            <GitAccessSection project={project} />
            <SessionLifecycleSection project={project} />
            <ReviewAutomationSection project={project} />
            <LandingSection project={project} />
          </>
        ) : (
          <p className="max-w-[64ch] border-l-2 border-[var(--sw-accent)] pl-3 text-[13px] leading-relaxed text-ink-2">
            How sessions here launch is set by the project&apos;s creator or an organization owner.
            You can start sessions and review changes as it stands.
          </p>
        )}
        {capabilities.remove ? <RemoveProjectSection projectId={projectId} /> : null}
      </div>
    </div>
  );
}

// ── Workspace image (moved from the project sidebar; same behavior, panel chrome) ──────────────

const WORKSPACE_OS_CHOICES = ["arch", "fedora", "ubuntu", "nix"] as const;

/**
 * The project's workspace image: a managed OS family, or a custom base image
 * with exactly three knobs — base ref, extra packages, setup commands. Not a
 * compose editor: the workspace is one container; compose already lives
 * inside it (the dind sidecar). Null inherits the organization's default (Settings); sessions
 * record the image they actually launched with.
 */
function WorkspaceImagePanel({ project }: { readonly project: ProjectDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const inherited = useInheritedSettings()?.workspaceImage ?? null;
  const effective = project.workspaceImage ?? inherited;
  const [draft, setDraft] = useState<{
    readonly mode: "family" | "custom";
    readonly os: (typeof WORKSPACE_OS_CHOICES)[number];
    readonly shell: "bash" | "zsh" | "fish";
    readonly baseImage: string;
    readonly packagesDraft: string;
    readonly setupDraft: string;
    readonly docker: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejections, setRejections] = useState<ReadonlyArray<WorkspacePackageResolutionDto>>([]);

  const openEditor = () => {
    const from = effective;
    setError(null);
    setRejections([]);
    setDraft(
      from === null || from.mode === "family"
        ? {
            mode: "family",
            os: from === null ? "arch" : from.os,
            shell: from === null ? "bash" : from.shell,
            baseImage: "",
            packagesDraft: (from?.packages ?? []).join("\n"),
            setupDraft: "",
            docker: from?.services.docker ?? true,
          }
        : {
            mode: "custom",
            os: "arch",
            shell: "bash",
            baseImage: from.baseImage,
            packagesDraft: from.packages.join("\n"),
            setupDraft: from.setupCommands.join("\n"),
            docker: from.services.docker,
          },
    );
  };

  const save = (image: WorkspaceImageDto | null) => {
    setBusy(true);
    setError(null);
    setRejections([]);
    void setProjectWorkspaceImage(project.id, image)
      .then((result) => {
        if (!result.saved) {
          setRejections(result.resolutions.filter((r) => r.status !== "resolved" || !r.supported));
          return;
        }
        setDraft(null);
        return queryClient.invalidateQueries(trpc.projects.pathFilter());
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not save the workspace image."),
      )
      .finally(() => setBusy(false));
  };

  const draftImage = (): WorkspaceImageDto | null => {
    if (draft === null) return null;
    const packages = parsePackageDraft(draft.packagesDraft).packages;
    return draft.mode === "custom"
      ? {
          mode: "custom",
          baseImage: draft.baseImage.trim(),
          packages,
          setupCommands: draft.setupDraft
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== ""),
          services: { docker: draft.docker },
        }
      : {
          mode: "family",
          os: draft.os,
          packages,
          shell: draft.shell,
          services: { docker: draft.docker },
        };
  };

  return (
    <section className="project-setup-card">
      <h2 className="font-sans text-sm font-semibold">Workspace image</h2>
      {draft === null ? (
        <>
          <p className="mt-2.5 font-mono text-xs text-ink-2">
            {effective === null ? "inherited default" : workspaceImageSummary(effective)}
            {project.workspaceImage === null ? (
              <span className="text-faint"> · inherited</span>
            ) : (
              <span className="text-faint"> · project override</span>
            )}
          </p>
          <button
            type="button"
            onClick={openEditor}
            className="mt-2 font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Edit…
          </button>
        </>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex gap-1">
            {(
              [
                { mode: "family", label: "os family" },
                { mode: "custom", label: "custom image" },
              ] as const
            ).map((option) => (
              <button
                key={option.mode}
                type="button"
                disabled={busy}
                onClick={() => setDraft({ ...draft, mode: option.mode })}
                className={`rounded-lg border px-2 py-1 font-mono text-[11px] transition-colors disabled:opacity-50 ${
                  draft.mode === option.mode
                    ? "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash text-foreground"
                    : "border-border bg-card text-muted-foreground hover:text-foreground"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          {draft.mode === "family" ? (
            <>
              <div className="flex flex-wrap gap-1">
                {WORKSPACE_OS_CHOICES.map((os) => (
                  <button
                    key={os}
                    type="button"
                    disabled={busy}
                    onClick={() => setDraft({ ...draft, os })}
                    className={`rounded-lg border px-2 py-1 font-mono text-[11px] transition-colors disabled:opacity-50 ${
                      draft.os === os
                        ? "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash text-foreground"
                        : "border-border bg-card text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {OS_LABELS[os].toLowerCase()}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-baseline gap-1">
                <span className="mr-1 text-[11px] text-muted-foreground">shell</span>
                {(["bash", "zsh", "fish"] as const).map((shell) => (
                  <button
                    key={shell}
                    type="button"
                    disabled={busy}
                    onClick={() => setDraft({ ...draft, shell })}
                    className={`rounded-lg border px-2 py-1 font-mono text-[11px] transition-colors disabled:opacity-50 ${
                      draft.shell === shell
                        ? "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash text-foreground"
                        : "border-border bg-card text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {shell}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <input
                type="text"
                value={draft.baseImage}
                disabled={busy}
                placeholder="node:22-bookworm"
                spellCheck={false}
                aria-label="Base image reference"
                onChange={(event) => setDraft({ ...draft, baseImage: event.target.value })}
                className="w-full rounded-lg border border-input bg-card px-2.5 py-1.5 font-mono text-[11.5px] text-foreground outline-none transition-colors focus:border-[var(--sw-accent)]"
              />
              <textarea
                value={draft.setupDraft}
                disabled={busy}
                rows={2}
                spellCheck={false}
                placeholder="setup commands · one per line"
                aria-label="Setup commands"
                onChange={(event) => setDraft({ ...draft, setupDraft: event.target.value })}
                className="w-full resize-y rounded-lg border border-input bg-card px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed text-foreground outline-none transition-colors focus:border-[var(--sw-accent)]"
              />
            </>
          )}
          <textarea
            value={draft.packagesDraft}
            disabled={busy}
            rows={3}
            spellCheck={false}
            placeholder={
              draft.mode === "family" ? "packages · one per line" : "extra packages · one per line"
            }
            aria-label="Packages"
            onChange={(event) => setDraft({ ...draft, packagesDraft: event.target.value })}
            className="w-full resize-y rounded-lg border border-input bg-card px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed text-foreground outline-none transition-colors focus:border-[var(--sw-accent)]"
          />
          {rejections.length === 0 ? null : (
            <div className="flex flex-col gap-1">
              {rejections.map((resolution) => (
                <p key={resolution.requested} className="text-xs leading-relaxed text-danger">
                  <span className="font-mono">{resolution.requested}</span> ·{" "}
                  {resolutionIssue(resolution, draft.os)}
                </p>
              ))}
            </div>
          )}
          {error === null ? null : <p className="text-xs leading-relaxed text-danger">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || (draft.mode === "custom" && draft.baseImage.trim() === "")}
              onClick={() => save(draftImage())}
              className="rounded-lg border border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash px-2.5 py-1 font-sans text-xs font-medium text-foreground transition-colors disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save override"}
            </button>
            {project.workspaceImage !== null && (
              <button
                type="button"
                disabled={busy}
                onClick={() => save(null)}
                className="rounded-lg border border-border bg-card px-2.5 py-1 font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                Use default
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => setDraft(null)}
              className="font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ── Configuration: the project's ordinary environment variables ────────────────────────────────

const inputClass =
  "mt-1.5 w-full rounded-lg border border-input bg-card px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none transition-colors focus:border-[var(--sw-accent)] focus:ring-2 focus:ring-[color-mix(in_oklab,var(--sw-accent)_18%,transparent)] disabled:opacity-60";

/**
 * Ordinary name/value configuration, inherited by every process in the project's future
 * workspaces: the agent, shells you open later, Services, setup commands, checks. Explicitly not
 * a secret store — the panel says so before anything is typed, and secret-looking names are
 * refused with the same wording the server uses.
 */
function ConfigurationPanel({ projectId }: { readonly projectId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const environment = useSuspenseQuery(
    trpc.environment.environment.queryOptions({ projectId }),
  ).data;
  const [form, dispatch] = useReducer(projectEnvironmentFormReducer, initialProjectEnvironmentForm);

  const refresh = () =>
    queryClient.invalidateQueries(trpc.environment.environment.queryFilter({ projectId }));

  const settle = async (
    write: Promise<ProjectEnvironmentWriteResult>,
    notice: string,
  ): Promise<void> => {
    try {
      const outcome = await write;
      if (outcome.ok) {
        dispatch({ type: "save-succeeded", notice });
        await refresh();
        return;
      }
      // The write outcome is a closed union: rejected or stale. Transport
      // failures throw and land in the catch below as save-failed.
      if (outcome.kind === "rejected") {
        dispatch({ type: "save-rejected", issues: outcome.issues });
      } else {
        dispatch({ type: "save-conflicted" });
      }
    } catch (cause) {
      dispatch({
        type: "save-failed",
        message: cause instanceof Error ? cause.message : "The save failed.",
      });
    }
  };

  const submit = () => {
    if (form.editing === null || form.phase === "saving") return;
    // The exact policy the server re-applies — a bad name never round-trips.
    const found = clientIssues({ name: form.name, value: form.value });
    if (found.length > 0) {
      dispatch({ type: "save-rejected", issues: found });
      return;
    }
    dispatch({ type: "save-started" });
    if (form.editing.kind === "create") {
      void settle(
        createProjectEnvironmentVariable(projectId, { name: form.name, value: form.value }),
        `Saved ${form.name}.`,
      );
    } else {
      void settle(
        updateProjectEnvironmentVariable(projectId, form.editing.variableId, {
          name: form.name,
          value: form.value,
          expectedRevision: form.editing.expectedRevision,
        }),
        form.editing.originalName === form.name
          ? `Saved ${form.name}.`
          : `Renamed ${form.editing.originalName} to ${form.name}.`,
      );
    }
  };

  const nameIssues = issuesFor(form.issues, "name");
  const valueIssues = issuesFor(form.issues, "value");
  const aggregateIssues = issuesFor(form.issues, null);
  const editorOpen = form.editing !== null;
  const editingId = form.editing?.kind === "edit" ? form.editing.variableId : null;

  return (
    <section className="project-setup-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-sans text-sm font-semibold">Configuration</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            Environment variables for every process in this project’s workspaces — the agent,
            shells, Services, setup, and checks. Stored and sent as plaintext.
          </p>
        </div>
      </div>

      <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
        Passwords, tokens, and API keys belong in Secrets below — encrypted here, never persisted by
        the platform. Claude, Codex, and GitHub credentials use a connected account.
      </p>

      <p aria-live="polite" role="status" className="mt-2 text-xs text-success">
        {form.notice}
      </p>

      <div className="mt-4 border-t border-[var(--sw-faint-rule)]">
        {environment.variables.length === 0 && !editorOpen ? (
          <p className="pt-4 text-sm text-muted-foreground">
            No variables yet. Add them above — each one is set on the workspace container at launch
            and inherited by everything Mend starts inside it.
          </p>
        ) : (
          <ul>
            {environment.variables.map((variable) =>
              editingId === variable.id ? (
                <li key={variable.id} className="border-b border-[var(--sw-faint-rule)]">
                  <EnvironmentEditor
                    heading={`Edit ${variable.name}`}
                    form={form}
                    nameIssues={nameIssues}
                    valueIssues={valueIssues}
                    aggregateIssues={aggregateIssues}
                    dispatch={dispatch}
                    submit={submit}
                  />
                </li>
              ) : (
                <VariableRow
                  key={variable.id}
                  projectId={projectId}
                  variable={variable}
                  disabled={editorOpen}
                  onEdit={() => dispatch({ type: "edit-opened", variable })}
                  onRemoved={async () => {
                    dispatch({ type: "save-succeeded", notice: `Removed ${variable.name}.` });
                    await refresh();
                  }}
                />
              ),
            )}
          </ul>
        )}
      </div>

      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        Docker Compose may use these values for interpolation. Containers started by Compose or{" "}
        <span className="font-mono">docker run</span> receive only values your Compose file or
        command explicitly passes.
      </p>
    </section>
  );
}

function EnvironmentEditor({
  heading,
  form,
  nameIssues,
  valueIssues,
  aggregateIssues,
  dispatch,
  submit,
}: {
  readonly heading: string;
  readonly form: ReturnType<typeof projectEnvironmentFormReducer>;
  readonly nameIssues: ReadonlyArray<{ readonly message: string }>;
  readonly valueIssues: ReadonlyArray<{ readonly message: string }>;
  readonly aggregateIssues: ReadonlyArray<{ readonly message: string }>;
  readonly dispatch: (action: Parameters<typeof projectEnvironmentFormReducer>[1]) => void;
  readonly submit: () => void;
}) {
  const saving = form.phase === "saving";
  return (
    <form
      className="mt-4 rounded-xl border border-border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="font-sans text-[13px] font-medium text-foreground">{heading}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
        <div>
          <label htmlFor="env-name" className="font-sans text-xs font-medium text-foreground">
            Name
          </label>
          <input
            id="env-name"
            type="text"
            value={form.name}
            disabled={saving}
            spellCheck={false}
            autoComplete="off"
            placeholder="APP_MODE"
            aria-invalid={nameIssues.length > 0}
            aria-describedby={nameIssues.length > 0 ? "env-name-issues" : undefined}
            onChange={(event) => dispatch({ type: "name-changed", name: event.target.value })}
            className={inputClass}
          />
          {nameIssues.length === 0 ? null : (
            <div id="env-name-issues">
              {nameIssues.map((issue) => (
                <p key={issue.message} className="mt-1.5 text-xs leading-relaxed text-danger">
                  {issue.message}
                </p>
              ))}
            </div>
          )}
        </div>
        <div>
          <label htmlFor="env-value" className="font-sans text-xs font-medium text-foreground">
            Value
          </label>
          <textarea
            id="env-value"
            value={form.value}
            disabled={saving}
            rows={1}
            spellCheck={false}
            placeholder="empty is allowed"
            aria-invalid={valueIssues.length > 0}
            aria-describedby={valueIssues.length > 0 ? "env-value-issues" : undefined}
            onChange={(event) => dispatch({ type: "value-changed", value: event.target.value })}
            className={`${inputClass} resize-y leading-relaxed`}
          />
          {valueIssues.length === 0 ? null : (
            <div id="env-value-issues">
              {valueIssues.map((issue) => (
                <p key={issue.message} className="mt-1.5 text-xs leading-relaxed text-danger">
                  {issue.message}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
      {aggregateIssues.map((issue) => (
        <p key={issue.message} className="mt-2 text-xs leading-relaxed text-danger">
          {issue.message}
        </p>
      ))}
      {form.conflict ? (
        <p className="mt-2 text-xs leading-relaxed text-warning" aria-live="polite">
          This variable changed elsewhere since you opened it. Your draft is kept — cancel to load
          the current value, then reapply what you want.
        </p>
      ) : null}
      {form.error === null ? null : (
        <p className="mt-2 text-xs leading-relaxed text-danger" aria-live="polite">
          {form.error}
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg border border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash px-2.5 py-1 font-sans text-xs font-medium text-foreground transition-colors disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => dispatch({ type: "closed" })}
          className="font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function VariableRow({
  projectId,
  variable,
  disabled,
  onEdit,
  onRemoved,
}: {
  readonly projectId: string;
  readonly variable: ProjectEnvironmentVariableView;
  readonly disabled: boolean;
  readonly onEdit: () => void;
  readonly onRemoved: () => Promise<void>;
}) {
  const [removing, setRemoving] = useState<"idle" | "armed" | "working">("idle");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Second click executes — destructive actions confirm explicitly (plan §15). */
  const remove = () => {
    if (removing === "idle") {
      setRemoving("armed");
      return;
    }
    if (removing !== "armed") return;
    setRemoving("working");
    setError(null);
    void removeProjectEnvironmentVariable(projectId, variable.id, variable.revision)
      .then(async (outcome) => {
        if (outcome.ok) {
          await onRemoved();
          return undefined;
        }
        setError(
          outcome.kind === "stale"
            ? "This variable changed elsewhere — reload before removing it."
            : "The remove failed.",
        );
        return undefined;
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "The remove failed."),
      )
      .finally(() => setRemoving("idle"));
  };

  const copy = () => {
    copyText(`${variable.name}=${variable.value}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <li className="flex items-start justify-between gap-4 border-b border-[var(--sw-faint-rule)] py-3">
      <div className="min-w-0">
        <p className="font-mono text-[12.5px] font-medium text-foreground">{variable.name}</p>
        <p className="mt-0.5 font-mono text-[12px] break-all whitespace-pre-wrap text-ink-2">
          {variable.value === "" ? <span className="text-faint">(empty)</span> : variable.value}
        </p>
        {error === null ? null : (
          <p className="mt-1 text-xs leading-relaxed text-danger" aria-live="polite">
            {error}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        <button
          type="button"
          disabled={disabled}
          onClick={copy}
          className="font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          aria-live="polite"
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onEdit}
          className="font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          Edit
        </button>
        <button
          type="button"
          disabled={disabled || removing === "working"}
          onClick={remove}
          className={`font-sans text-xs font-medium transition-colors disabled:opacity-50 ${
            removing === "armed" ? "text-danger" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {removing === "armed"
            ? "Remove? Running workspaces keep it"
            : removing === "working"
              ? "Removing…"
              : "Remove"}
        </button>
      </div>
    </li>
  );
}

// ── Secrets: encrypted at rest, write-only, delivered through the transient secret channel ─────

/**
 * The half of a real `.env` that Configuration refuses. Values are sealed with this machine's key
 * before they touch the database and are never returned by any response — the row shows a name,
 * that a value is set, and when. At launch the set is unsealed once and handed to the platform's
 * transient secret channel: never persisted there, never in container env or `docker inspect`,
 * masked in captured output.
 */
function SecretsPanel({ projectId }: { readonly projectId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const snapshot = useSuspenseQuery(trpc.environment.secrets.queryOptions({ projectId })).data;
  const [form, dispatch] = useReducer(projectEnvironmentFormReducer, initialProjectEnvironmentForm);

  const refresh = () =>
    queryClient.invalidateQueries(trpc.environment.secrets.queryFilter({ projectId }));

  const settle = async (
    write: Promise<ProjectSecretWriteResult>,
    notice: string,
  ): Promise<void> => {
    try {
      const outcome = await write;
      if (outcome.ok) {
        dispatch({ type: "save-succeeded", notice });
        await refresh();
        return;
      }
      // The write outcome is a closed union: rejected or stale. Transport
      // failures throw and land in the catch below as save-failed.
      if (outcome.kind === "rejected") {
        dispatch({ type: "save-rejected", issues: outcome.issues });
      } else {
        dispatch({ type: "save-conflicted" });
      }
    } catch (cause) {
      dispatch({
        type: "save-failed",
        message: cause instanceof Error ? cause.message : "The save failed.",
      });
    }
  };

  const submit = () => {
    if (form.editing === null || form.phase === "saving") return;
    const editing = form.editing;
    // On edit, an empty value means "keep the stored value" (it cannot be shown to be re-entered).
    const replacing = editing.kind === "create" || form.value !== "";
    const found = clientSecretIssues({ name: form.name, value: replacing ? form.value : null });
    if (found.length > 0) {
      dispatch({ type: "save-rejected", issues: found });
      return;
    }
    dispatch({ type: "save-started" });
    if (editing.kind === "create") {
      void settle(
        createProjectSecret(projectId, { name: form.name, value: form.value }),
        `Saved secret ${form.name}.`,
      );
    } else {
      void settle(
        updateProjectSecret(projectId, editing.variableId, {
          name: form.name,
          value: replacing ? form.value : null,
          expectedRevision: editing.expectedRevision,
        }),
        replacing
          ? `Replaced secret ${form.name}.`
          : editing.originalName === form.name
            ? `Saved secret ${form.name}.`
            : `Renamed secret ${editing.originalName} to ${form.name}.`,
      );
    }
  };

  const nameIssues = issuesFor(form.issues, "name");
  const valueIssues = issuesFor(form.issues, "value");
  const aggregateIssues = issuesFor(form.issues, null);
  const editorOpen = form.editing !== null;
  const editingId = form.editing?.kind === "edit" ? form.editing.variableId : null;

  return (
    <section className="project-setup-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-sans text-sm font-semibold">Secrets</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            API keys, database URLs, anything a dev server needs that must not be stored in the
            clear. Encrypted on this machine; the platform never persists them and masks them in
            recorded output. Set once — a value cannot be read back, only replaced.
          </p>
        </div>
      </div>

      <p aria-live="polite" role="status" className="mt-2 text-xs text-success">
        {form.notice}
      </p>

      <div className="mt-4 border-t border-[var(--sw-faint-rule)]">
        {snapshot.secrets.length === 0 && !editorOpen ? (
          <p className="pt-4 text-sm text-muted-foreground">
            No secrets yet. Add them above (secret-shaped names land here on their own), or from a
            terminal: <span className="font-mono">mend env load</span>.
          </p>
        ) : (
          <ul>
            {snapshot.secrets.map((secret) =>
              editingId === secret.id ? (
                <li key={secret.id} className="border-b border-[var(--sw-faint-rule)]">
                  <SecretEditor
                    heading={`Edit ${secret.name}`}
                    form={form}
                    nameIssues={nameIssues}
                    valueIssues={valueIssues}
                    aggregateIssues={aggregateIssues}
                    dispatch={dispatch}
                    submit={submit}
                  />
                </li>
              ) : (
                <SecretRow
                  key={secret.id}
                  projectId={projectId}
                  secret={secret}
                  disabled={editorOpen}
                  onEdit={() =>
                    dispatch({
                      type: "edit-opened",
                      // The reducer pre-fills `value` from the row; a secret row has none to give.
                      // The shared form stores a variable-shaped row, so the secret id rides in
                      // the variable-id slot (re-branded) and flows back to updateProjectSecret.
                      variable: {
                        id: ProjectEnvironmentVariableId.make(secret.id),
                        projectId: secret.projectId,
                        name: secret.name,
                        value: "",
                        revision: secret.revision,
                        createdAt: secret.createdAt,
                        updatedAt: secret.updatedAt,
                      },
                    })
                  }
                  onRemoved={async () => {
                    dispatch({ type: "save-succeeded", notice: `Removed secret ${secret.name}.` });
                    await refresh();
                  }}
                />
              ),
            )}
          </ul>
        )}
      </div>
    </section>
  );
}

function SecretEditor({
  heading,
  form,
  nameIssues,
  valueIssues,
  aggregateIssues,
  dispatch,
  submit,
}: {
  readonly heading: string;
  readonly form: ReturnType<typeof projectEnvironmentFormReducer>;
  readonly nameIssues: ReadonlyArray<{ readonly message: string }>;
  readonly valueIssues: ReadonlyArray<{ readonly message: string }>;
  readonly aggregateIssues: ReadonlyArray<{ readonly message: string }>;
  readonly dispatch: (action: Parameters<typeof projectEnvironmentFormReducer>[1]) => void;
  readonly submit: () => void;
}) {
  const saving = form.phase === "saving";
  const editing = form.editing?.kind === "edit";
  return (
    <form
      className="mt-4 rounded-xl border border-border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="font-sans text-[13px] font-medium text-foreground">{heading}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
        <div>
          <label htmlFor="secret-name" className="font-sans text-xs font-medium text-foreground">
            Name
          </label>
          <input
            id="secret-name"
            type="text"
            value={form.name}
            disabled={saving}
            spellCheck={false}
            autoComplete="off"
            placeholder="STRIPE_API_KEY"
            aria-invalid={nameIssues.length > 0}
            aria-describedby={nameIssues.length > 0 ? "secret-name-issues" : undefined}
            onChange={(event) => dispatch({ type: "name-changed", name: event.target.value })}
            className={inputClass}
          />
          {nameIssues.length === 0 ? null : (
            <div id="secret-name-issues">
              {nameIssues.map((issue) => (
                <p key={issue.message} className="mt-1.5 text-xs leading-relaxed text-danger">
                  {issue.message}
                </p>
              ))}
            </div>
          )}
        </div>
        <div>
          <label htmlFor="secret-value" className="font-sans text-xs font-medium text-foreground">
            {editing ? "New value" : "Value"}
          </label>
          <input
            id="secret-value"
            type="password"
            value={form.value}
            disabled={saving}
            spellCheck={false}
            autoComplete="off"
            placeholder={editing ? "leave empty to keep the stored value" : ""}
            aria-invalid={valueIssues.length > 0}
            aria-describedby={valueIssues.length > 0 ? "secret-value-issues" : undefined}
            onChange={(event) => dispatch({ type: "value-changed", value: event.target.value })}
            className={inputClass}
          />
          {valueIssues.length === 0 ? null : (
            <div id="secret-value-issues">
              {valueIssues.map((issue) => (
                <p key={issue.message} className="mt-1.5 text-xs leading-relaxed text-danger">
                  {issue.message}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
      {aggregateIssues.map((issue) => (
        <p key={issue.message} className="mt-2 text-xs leading-relaxed text-danger">
          {issue.message}
        </p>
      ))}
      {form.conflict ? (
        <p className="mt-2 text-xs leading-relaxed text-warning" aria-live="polite">
          This secret changed elsewhere since you opened it. Your draft is kept — cancel to reload,
          then reapply what you want.
        </p>
      ) : null}
      {form.error === null ? null : (
        <p className="mt-2 text-xs leading-relaxed text-danger" aria-live="polite">
          {form.error}
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg border border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash px-2.5 py-1 font-sans text-xs font-medium text-foreground transition-colors disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => dispatch({ type: "closed" })}
          className="font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function SecretRow({
  projectId,
  secret,
  disabled,
  onEdit,
  onRemoved,
}: {
  readonly projectId: string;
  readonly secret: ProjectSecretView;
  readonly disabled: boolean;
  readonly onEdit: () => void;
  readonly onRemoved: () => Promise<void>;
}) {
  const [removing, setRemoving] = useState<"idle" | "armed" | "working">("idle");
  const [error, setError] = useState<string | null>(null);

  const remove = () => {
    if (removing === "idle") {
      setRemoving("armed");
      return;
    }
    if (removing !== "armed") return;
    setRemoving("working");
    setError(null);
    void removeProjectSecret(projectId, secret.id, secret.revision)
      .then(async (outcome) => {
        if (outcome.ok) {
          await onRemoved();
          return undefined;
        }
        setError(
          outcome.kind === "stale"
            ? "This secret changed elsewhere — reload before removing it."
            : "The remove failed.",
        );
        return undefined;
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "The remove failed."),
      )
      .finally(() => setRemoving("idle"));
  };

  return (
    <li className="flex items-start justify-between gap-4 border-b border-[var(--sw-faint-rule)] py-3">
      <div className="min-w-0">
        <p className="font-mono text-[12.5px] font-medium text-foreground">{secret.name}</p>
        <p className="mt-0.5 font-mono text-[12px] text-faint">
          value set · updated {new Date(secret.updatedAt).toLocaleString()}
        </p>
        {error === null ? null : (
          <p className="mt-1 text-xs leading-relaxed text-danger" aria-live="polite">
            {error}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        <button
          type="button"
          disabled={disabled}
          onClick={onEdit}
          className="font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          Replace
        </button>
        <button
          type="button"
          disabled={disabled || removing === "working"}
          onClick={remove}
          className={`font-sans text-xs font-medium transition-colors disabled:opacity-50 ${
            removing === "armed" ? "text-danger" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {removing === "armed"
            ? "Remove? Running workspaces keep it"
            : removing === "working"
              ? "Removing…"
              : "Remove"}
        </button>
      </div>
    </li>
  );
}

// ── Cluster bindings: names of cluster objects, resolved by the platform at launch ──────────────

/**
 * Bindings, not values: each row names a Kubernetes Secret or ConfigMap in the platform's
 * workspaces namespace. The Sealant worker resolves the object at each fresh workspace launch;
 * Mend never learns the keys or values inside it, and this panel says so instead of pretending
 * otherwise.
 */
function ClusterBindingsPanel({ projectId }: { readonly projectId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const snapshot = useSuspenseQuery(
    trpc.environment.clusterBindings.queryOptions({ projectId }),
  ).data;
  const [kind, setKind] = useState<"secret" | "configmap">("secret");
  const [objectName, setObjectName] = useState("");
  const [saDraft, setSaDraft] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "saving">("idle");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    queryClient.invalidateQueries(trpc.environment.clusterBindings.queryFilter({ projectId }));

  // `clusterCapable` is a hint driving the degraded state only — the platform's create-time
  // refusal is the enforcement. Remove stays enabled everywhere so a project whose bindings
  // arrive on a non-cluster install is never trapped unlaunchable.
  const addEnabled = snapshot.clusterCapable;

  const add = async () => {
    if (!addEnabled || phase === "saving" || objectName.trim() === "") return;
    setPhase("saving");
    setError(null);
    try {
      const outcome = await addProjectClusterBinding(projectId, {
        kind,
        objectName: objectName.trim(),
      });
      if (outcome.ok) {
        setNotice(`Bound ${kind}/${objectName.trim()}.`);
        setObjectName("");
        await refresh();
      } else {
        setError(
          outcome.kind === "duplicate"
            ? `${outcome.binding} is already bound on this project.`
            : outcome.message,
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The save failed.");
    } finally {
      setPhase("idle");
    }
  };

  const saveServiceAccount = async (next: string | null) => {
    if (phase === "saving") return;
    setPhase("saving");
    setError(null);
    try {
      const outcome = await setProjectClusterServiceAccount(projectId, next);
      if (outcome.ok) {
        setNotice(
          next === null ? "Cleared the workspace service account." : `Set service account ${next}.`,
        );
        setSaDraft(null);
        await refresh();
      } else if (outcome.kind === "rejected") {
        setError(outcome.message);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The save failed.");
    } finally {
      setPhase("idle");
    }
  };

  return (
    <section className="project-setup-card">
      <div>
        <h2 className="font-sans text-sm font-semibold">Cluster bindings</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          Names of Kubernetes Secrets and ConfigMaps in the platform&apos;s workspaces namespace,
          resolved by the platform at each fresh workspace launch. Mend stores the names only — the
          contents are unknown to Mend and never shown here. Only objects the operator labeled for
          workspace env resolve.
        </p>
      </div>

      {snapshot.clusterCapable ? null : (
        <p className="mt-3 text-xs leading-relaxed text-warning">
          This install runs workspaces on the local runner. Cluster bindings do not resolve here;
          declared bindings block launches — remove them to launch here.
        </p>
      )}
      <p aria-live="polite" role="status" className="mt-2 text-xs text-success">
        {notice}
      </p>
      {error === null ? null : (
        <p className="mt-1 text-xs leading-relaxed text-danger" aria-live="polite">
          {error}
        </p>
      )}

      <form
        className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,140px)_minmax(0,1fr)_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <div>
          <label htmlFor="binding-kind" className="font-sans text-xs font-medium text-foreground">
            Kind
          </label>
          <select
            id="binding-kind"
            value={kind}
            disabled={!addEnabled || phase === "saving"}
            onChange={(event) =>
              setKind(event.target.value === "configmap" ? "configmap" : "secret")
            }
            className={inputClass}
          >
            <option value="secret">secret</option>
            <option value="configmap">configmap</option>
          </select>
        </div>
        <div>
          <label htmlFor="binding-name" className="font-sans text-xs font-medium text-foreground">
            Object name
          </label>
          <input
            id="binding-name"
            type="text"
            value={objectName}
            disabled={!addEnabled || phase === "saving"}
            spellCheck={false}
            autoComplete="off"
            placeholder="app-env"
            onChange={(event) => setObjectName(event.target.value)}
            className={inputClass}
          />
        </div>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={!addEnabled || phase === "saving" || objectName.trim() === ""}
            className="rounded-lg border border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash px-2.5 py-1 font-sans text-xs font-medium text-foreground transition-colors disabled:opacity-50"
          >
            Bind
          </button>
        </div>
      </form>

      <div className="mt-4 border-t border-[var(--sw-faint-rule)]">
        {snapshot.bindings.length === 0 ? (
          <p className="pt-4 text-sm text-muted-foreground">No cluster bindings.</p>
        ) : (
          <ul>
            {snapshot.bindings.map((binding) => (
              <ClusterBindingRow
                key={binding.id}
                projectId={projectId}
                binding={binding}
                disabled={phase === "saving"}
                onRemoved={async () => {
                  setNotice(`Removed ${binding.kind}/${binding.objectName}.`);
                  await refresh();
                }}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="mt-5 border-t border-[var(--sw-faint-rule)] pt-4">
        <p className="font-sans text-xs font-semibold text-foreground">Workspace service account</p>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          The session agent holds this role&apos;s full permissions for the whole session; bind a
          least-privilege role intended for untrusted code — the operator binds and allowlists it
          cluster-side; names outside the allowlist fail the launch.
        </p>
        <div className="mt-3 flex items-end gap-2">
          <div className="min-w-0 grow sm:max-w-[280px]">
            <input
              aria-label="Workspace service account"
              type="text"
              value={saDraft ?? snapshot.serviceAccount ?? ""}
              disabled={!snapshot.clusterCapable || phase === "saving"}
              spellCheck={false}
              autoComplete="off"
              placeholder="none"
              onChange={(event) => setSaDraft(event.target.value)}
              className={inputClass}
            />
          </div>
          <button
            type="button"
            disabled={
              !snapshot.clusterCapable ||
              phase === "saving" ||
              (saDraft ?? "").trim() === "" ||
              (saDraft ?? "").trim() === snapshot.serviceAccount
            }
            onClick={() => void saveServiceAccount((saDraft ?? "").trim())}
            className="rounded-lg border border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash px-2.5 py-1 font-sans text-xs font-medium text-foreground transition-colors disabled:opacity-50"
          >
            Set
          </button>
          {snapshot.serviceAccount === null ? null : (
            <button
              type="button"
              disabled={phase === "saving"}
              onClick={() => void saveServiceAccount(null)}
              className="font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              Clear
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function ClusterBindingRow({
  projectId,
  binding,
  disabled,
  onRemoved,
}: {
  readonly projectId: string;
  readonly binding: ProjectClusterBindingView;
  readonly disabled: boolean;
  readonly onRemoved: () => Promise<void>;
}) {
  const [removing, setRemoving] = useState<"idle" | "armed" | "working">("idle");
  const [error, setError] = useState<string | null>(null);

  const remove = () => {
    if (removing === "idle") {
      setRemoving("armed");
      return;
    }
    if (removing !== "armed") return;
    setRemoving("working");
    setError(null);
    void removeProjectClusterBinding(projectId, binding.id)
      .then(async () => {
        await onRemoved();
        return undefined;
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "The remove failed."),
      )
      .finally(() => setRemoving("idle"));
  };

  return (
    <li className="flex items-start justify-between gap-4 border-b border-[var(--sw-faint-rule)] py-3">
      <div className="min-w-0">
        <p className="font-mono text-[12.5px] font-medium text-foreground">
          {binding.kind}/{binding.objectName}
        </p>
        <p className="mt-0.5 font-mono text-[12px] text-faint">
          resolved by the platform at launch · contents unknown to Mend
        </p>
        {error === null ? null : (
          <p className="mt-1 text-xs leading-relaxed text-danger" aria-live="polite">
            {error}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        <button
          type="button"
          disabled={disabled || removing === "working"}
          onClick={remove}
          className={`font-sans text-xs font-medium transition-colors disabled:opacity-50 ${
            removing === "armed" ? "text-danger" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {removing === "armed"
            ? "Remove? Running workspaces keep it"
            : removing === "working"
              ? "Removing…"
              : "Remove"}
        </button>
      </div>
    </li>
  );
}

// ── Add variables: Key/Value rows; paste a whole .env into any field to expand it ───────────────

const rowInputClass =
  "w-full rounded-lg border border-input bg-card px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none transition-colors focus:border-[var(--sw-accent)] focus:ring-2 focus:ring-[color-mix(in_oklab,var(--sw-accent)_18%,transparent)] disabled:opacity-60";

/**
 * The one way to add entries: Key/Value rows with "Add another", a Sensitive toggle, and paste
 * detection — dropping a whole `.env` (comments and all) into ANY field turns it into rows, one
 * per key. Each row shows live where it will land (Configuration, Secrets, or why it is refused).
 * Save posts every row through the same endpoint `mend env load` uses; existing names are
 * replaced; the report renders under the composer and both panels refresh.
 */
function VariablesComposer({ projectId }: { readonly projectId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(composerReducer, initialComposer);
  const [phase, setPhase] = useState<"idle" | "saving">("idle");
  const [report, setReport] = useState<EnvironmentLoadReportView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const rows = savableRows(state);
  const lanes = state.rows.map((row) => rowLane(row, state.allSecret));
  const anyValue = state.rows.some((row) => row.value !== "");
  const allRevealed = state.rows.filter((row) => row.value !== "").every((row) => row.revealed);
  const rejectedCount = lanes.filter((lane) => lane.kind === "rejected").length;
  const canSave = phase === "idle" && rows.length > 0 && rejectedCount === 0;

  const expandFrom = (intoId: number, text: string) =>
    dispatch({ type: "text-expanded", intoId, text });

  const onPaste = (rowId: number) => (event: React.ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!looksLikeDotenv(text)) return; // an ordinary paste of a key or a value
    event.preventDefault();
    expandFrom(rowId, text);
  };

  const importFile = (file: File | undefined) => {
    if (file === undefined) return;
    void file.text().then((text) => {
      const last = state.rows.at(-1);
      dispatch({ type: "text-expanded", intoId: last?.id ?? null, text });
      return undefined;
    });
  };

  const save = () => {
    if (!canSave) return;
    setPhase("saving");
    setError(null);
    void loadProjectEnvironment(projectId, {
      contents: serializeRows(rows),
      allSecret: state.allSecret,
      secretNames: [],
    })
      .then(async (result) => {
        setReport(result);
        const loadedNames = new Set(result.loaded.map((entry) => entry.name));
        dispatch({
          type: "rows-cleared",
          ids: rows.filter((row) => loadedNames.has(row.key)).map((row) => row.id),
        });
        await queryClient.invalidateQueries(trpc.environment.pathFilter());
        return undefined;
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "The save failed."),
      )
      .finally(() => setPhase("idle"));
  };

  return (
    <section className="project-setup-card">
      <h2 className="font-sans text-sm font-semibold">Add variables</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        One key per row. Paste a whole <span className="font-mono">.env</span> into any field and it
        becomes one row per key — comments are dropped. Values stay hidden until you choose to show
        them, and everything is stored as a secret unless you turn Sensitive off.
      </p>

      <div className="mt-4 flex items-start justify-between gap-4 rounded-xl border border-border bg-card p-3">
        <div>
          <p className="font-sans text-[13px] font-medium text-foreground">Sensitive</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            On: every row is stored as a secret — encrypted here, never persisted by the platform,
            not readable after saving, only replaceable. Off: ordinary names become plaintext
            Configuration you can read back; secret-looking names still go to Secrets.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={state.allSecret}
          disabled={phase === "saving"}
          onClick={() => dispatch({ type: "all-secret-toggled" })}
          className={`shrink-0 rounded-xl border px-3 py-1.5 font-sans text-xs font-medium shadow-xs transition-colors disabled:opacity-60 ${
            state.allSecret
              ? "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash text-foreground"
              : "border-border bg-card text-muted-foreground hover:text-foreground"
          }`}
        >
          {state.allSecret ? "Enabled" : "Disabled"}
        </button>
      </div>

      <div className="mt-4 grid grid-cols-[minmax(0,240px)_minmax(0,1fr)_auto_auto] gap-x-2 gap-y-1">
        <p className="font-sans text-xs font-medium text-muted-foreground">Key</p>
        <p className="flex items-baseline justify-between font-sans text-xs font-medium text-muted-foreground">
          <span>Value</span>
          {anyValue ? (
            <button
              type="button"
              disabled={phase === "saving"}
              onClick={() => dispatch({ type: "reveal-all-set", revealed: !allRevealed })}
              className="font-sans text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              {allRevealed ? "Hide all" : "Show all"}
            </button>
          ) : null}
        </p>
        <span />
        <span />
        {state.rows.map((row, index) => {
          const lane = lanes[index] ?? { kind: "empty" as const };
          return (
            <div key={row.id} className="contents">
              <div>
                <input
                  type="text"
                  value={row.key}
                  disabled={phase === "saving"}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="e.g. CLIENT_ID"
                  aria-label={`Key ${index + 1}`}
                  aria-invalid={lane.kind === "rejected"}
                  onChange={(event) =>
                    dispatch({ type: "key-changed", id: row.id, key: event.target.value })
                  }
                  onPaste={onPaste(row.id)}
                  className={rowInputClass}
                />
                <p className="mt-0.5 min-h-4 font-mono text-[11px] leading-4">
                  {lane.kind === "configuration" ? (
                    <span className="text-faint">→ configuration · plaintext</span>
                  ) : lane.kind === "secret" ? (
                    <span className="text-faint">→ secret</span>
                  ) : lane.kind === "rejected" ? (
                    <span className="font-sans text-danger">{lane.reason}</span>
                  ) : null}
                </p>
              </div>
              <div>
                <input
                  // Censored by default — typed or pasted — until this row is revealed. A whole
                  // pasted .env is exactly the content that should not sit on screen.
                  type={row.revealed ? "text" : "password"}
                  value={row.value}
                  disabled={phase === "saving"}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label={`Value ${index + 1}`}
                  onChange={(event) =>
                    dispatch({ type: "value-changed", id: row.id, value: event.target.value })
                  }
                  onPaste={onPaste(row.id)}
                  className={rowInputClass}
                />
              </div>
              <button
                type="button"
                disabled={phase === "saving" || row.value === ""}
                onClick={() => dispatch({ type: "reveal-toggled", id: row.id })}
                aria-label={`${row.revealed ? "Hide" : "Show"} value ${index + 1}`}
                aria-pressed={row.revealed}
                className="h-[30px] rounded-lg border border-border bg-card px-2.5 font-sans text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
              >
                {row.revealed ? "Hide" : "Show"}
              </button>
              <button
                type="button"
                disabled={phase === "saving"}
                onClick={() => dispatch({ type: "row-removed", id: row.id })}
                aria-label={`Remove row ${index + 1}`}
                className="h-[30px] rounded-lg border border-border bg-card px-2.5 font-sans text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                −
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        disabled={phase === "saving"}
        onClick={() => dispatch({ type: "row-added" })}
        className="mt-1 rounded-lg border border-border bg-card px-2.5 py-1 font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
      >
        + Add another
      </button>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--sw-faint-rule)] pt-4">
        <div className="flex items-center gap-3">
          <input
            ref={fileInput}
            type="file"
            accept=".env,text/plain,.txt"
            className="hidden"
            onChange={(event) => {
              importFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={phase === "saving"}
            onClick={() => fileInput.current?.click()}
            className="rounded-xl border border-border bg-card px-3 py-1.5 font-sans text-xs font-medium text-foreground shadow-xs transition-transform hover:-translate-y-0.5 disabled:opacity-50"
          >
            Import .env
          </button>
          <span className="text-xs text-muted-foreground">
            or paste the .env contents into any field above
          </span>
        </div>
        <button
          type="button"
          disabled={!canSave}
          onClick={save}
          className="rounded-xl border border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash px-3.5 py-1.5 font-sans text-xs font-medium text-foreground shadow-xs transition-colors disabled:opacity-50"
        >
          {phase === "saving" ? "Saving…" : rows.length > 1 ? `Save ${rows.length}` : "Save"}
        </button>
      </div>
      {state.skippedLines === 0 ? null : (
        <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
          Skipped {state.skippedLines} line{state.skippedLines === 1 ? "" : "s"} that were not{" "}
          <span className="font-mono">KEY=value</span>.
        </p>
      )}
      {rejectedCount === 0 ? null : (
        <p className="mt-2 text-xs text-danger" aria-live="polite">
          Fix or remove the {rejectedCount === 1 ? "row" : `${rejectedCount} rows`} marked above to
          save.
        </p>
      )}
      {error === null ? null : (
        <p className="mt-2 text-xs text-danger" aria-live="polite">
          {error}
        </p>
      )}
      {report === null ? null : (
        <div className="mt-3 border-t border-[var(--sw-faint-rule)] pt-3" aria-live="polite">
          <p className="font-sans text-xs font-medium text-foreground">
            Saved {report.loaded.length}
            {report.rejected.length === 0 ? "" : ` · rejected ${report.rejected.length}`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {report.loaded.map((entry) => (
              <li key={`loaded-${entry.name}`} className="font-mono text-[12px] text-ink-2">
                {entry.name}{" "}
                <span className="text-faint">
                  · {entry.lane}
                  {entry.lane === "configuration" ? " · plaintext" : ""} · {entry.action}
                </span>
              </li>
            ))}
            {report.rejected.map((entry) => (
              <li key={`rejected-${entry.name}`} className="font-mono text-[12px] text-ink-2">
                {entry.name} <span className="text-danger">· rejected</span>{" "}
                <span className="font-sans text-xs text-muted-foreground">{entry.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
