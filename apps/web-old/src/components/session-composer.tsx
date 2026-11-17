import { modelPickerFor, pickerLaunchFields, type PermissionMode } from "@mend/domain/workbench";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";

import { ComposerResources } from "#/components/composer-resources";
import { ComposerTargetPicker } from "#/components/composer-target-picker";
import { Button, Pick } from "#/components/kit/button";
import { Menu, MenuGroup, MenuMeta, MenuRadioGroup, MenuSeparator } from "#/components/kit/menu";
import { Dot } from "#/components/kit/status";
import type { ProjectDto, WorktreeDto } from "#/lib/api";
import {
  composerHarness,
  setComposerHarness,
  setComposerHarnessPrefs,
  setComposerProject,
  stickyHarnessPrefs,
  useComposerPrefs,
} from "#/lib/composer-prefs";
import { useHarnessCatalogs } from "#/lib/harness-models";
import { PROMPT_ID } from "#/lib/inbox";
import { autoLandItems } from "#/lib/landing";
import { readLaunchEdit } from "#/lib/pending-launches";
import { useSessionDefaults } from "#/lib/session-defaults";
import { HARNESSES, startPendingSession, type Harness } from "#/lib/session-launch";
import { useWorktreeJoinLine } from "#/lib/shared-workspace";
import { useTRPC } from "#/lib/trpc";

/** The New worktree dialog, loaded when it first opens. */
const NewWorktreeDialog = lazy(() =>
  import("#/components/project-detail/new-worktree-dialog").then((module) => ({
    default: module.NewWorktreeDialog,
  })),
);

/** Harnesses the composer offers — the promptable ones. */
const COMPOSER_HARNESSES = HARNESSES.filter((choice) => choice !== "shell");

const PERMISSIONS: ReadonlyArray<{ readonly value: PermissionMode; readonly label: string }> = [
  { value: "bypass", label: "Skip permission prompts" },
  { value: "ask", label: "Ask before acting" },
];

/**
 * Choose a project and worktree, then compose the session's first message and harness options.
 * Enter starts it and Shift+Enter makes a new line, as in a session's own composer.
 */
export function SessionComposer({
  projects,
  autoFocus = false,
  placeholder = "Describe the change. Paste an error, a link or a screenshot.",
  submitLabel = "Start",
  pinned = false,
}: {
  readonly projects: ReadonlyArray<ProjectDto>;
  readonly autoFocus?: boolean;
  readonly placeholder?: string;
  readonly submitLabel?: string;
  /** One project, chosen by the page (a project's Sessions tab): no project picker. */
  readonly pinned?: boolean;
}) {
  const navigate = useNavigate();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const prefs = useComposerPrefs();
  const defaults = useSessionDefaults();
  const [restored] = useState(readLaunchEdit);
  const [pickedProjectId, setPickedProjectId] = useState<string | null>(
    restored?.projectId ?? null,
  );
  const [pickedWorktreeId, setPickedWorktreeId] = useState<WorktreeDto["id"] | null>(null);
  // `null` until first opened: the dialog's code loads then.
  const [newWorktreeOpen, setNewWorktreeOpen] = useState<boolean | null>(null);
  const [prompt, setPrompt] = useState(restored?.prompt ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Land when a turn completes" for this one session; null follows the project. Not sticky: a
  // push speaks as you on GitHub, so each session starts from the project's stance.
  const [autoLand, setAutoLand] = useState<boolean | null>(null);
  // What landing follows when the project sets nothing: the person's own, else their
  // organization's (`/me/automation`).
  const automation = useQuery(trpc.platform.automation.queryOptions()).data;
  const catalogs = useHarnessCatalogs();

  const preferredProjectId = pickedProjectId ?? prefs.lastProjectId;
  const project = projects.find((row) => row.id === preferredProjectId) ?? projects[0];
  const projectId = project?.id;
  const worktreesQuery = useQuery({
    ...trpc.worktrees.list.queryOptions({ projectId: projectId ?? "" }),
    enabled: projectId !== undefined,
  });
  // A project switch or a removed worktree must never retain a stale launch target.
  const worktrees = (worktreesQuery.data?.worktrees ?? []).filter(
    (row) => row.projectId === projectId,
  );
  const worktree = worktrees.find((row) => row.id === pickedWorktreeId);
  // Whose sessions already run in the chosen worktree (docs/adr/0016, decision 13): only live
  // sessions count, and the live list (the rail's read, with the people in each executor) has them.
  const projectSessions = useQuery(
    trpc.sessions.listActive.queryOptions(undefined, {
      select: (active) => active.filter((session) => session.projectId === projectId),
    }),
  ).data;
  const joinLine = useWorktreeJoinLine(worktree?.id ?? null, projectSessions ?? []);

  if (projectId === undefined || project === undefined) return null;

  // A sticky "shell" from before shell left the composer degrades to claude.
  const stickyHarness = composerHarness(prefs, defaults, projectId);
  const harness: Harness = stickyHarness === "shell" ? "claude" : stickyHarness;
  const harnessPrefs = stickyHarnessPrefs(prefs, defaults, projectId, harness);
  // The one picker (docs/models-audit.md): the server's catalog, the sticky choice, the default
  // preselected. What it says is what the launch sends and what the session records.
  const picker = modelPickerFor(catalogs, harness, harnessPrefs);

  const submit = () => {
    if (busy || worktreesQuery.isError) return;
    const body = prompt.trim();
    if (body.startsWith("-")) {
      setError("A prompt cannot start with “-” — the harness would read it as a flag.");
      return;
    }
    setBusy(true);
    setError(null);
    setComposerProject(projectId);
    const spec = {
      harness,
      prompt: body,
      ...pickerLaunchFields(picker),
      ...(harnessPrefs.permission === null ? {} : { permissionMode: harnessPrefs.permission }),
      ...(harnessPrefs.speed === null ? {} : { speed: harnessPrefs.speed }),
      autoLand: project.autoLand === "off" ? null : autoLand,
    };
    setPrompt("");
    void startPendingSession(
      navigate,
      { queryClient, trpc },
      project,
      spec,
      worktree?.id ?? null,
    ).catch((cause: unknown) => {
      setBusy(false);
      setPrompt(body);
      setError(cause instanceof Error ? cause.message : "Could not open the session.");
    });
  };

  const landing = autoLandItems({
    override: autoLand,
    project: project.autoLand,
    settings: automation?.effective.autoLand ?? null,
  });
  const efforts = picker.efforts.map((row) => ({
    value: row.effort ?? "default",
    label: row.label,
    effort: row.effort,
  }));
  const optionsSummary = [
    harnessPrefs.speed === "fast" ? "fast" : null,
    harnessPrefs.permission === "ask" ? "ask first" : null,
    landing.summary,
  ].filter((part): part is string => part !== null);

  return (
    <>
      <form
        aria-label="New session"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="@container w-full rounded-[18px] border border-input composer-glass shadow-md"
      >
        <label htmlFor={PROMPT_ID} className="sr-only">
          What should an agent work on?
        </label>
        <textarea
          id={PROMPT_ID}
          disabled={busy}
          value={prompt}
          rows={3}
          autoFocus={autoFocus}
          placeholder={placeholder}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") event.currentTarget.blur();
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            if (event.shiftKey) return;
            event.preventDefault();
            submit();
          }}
          className="block field-sizing-content max-h-[280px] min-h-[84px] w-full resize-none @max-md:min-h-[60px] bg-transparent px-[18px] pt-4 pb-2.5 font-sans text-[15px] leading-relaxed text-foreground outline-none placeholder:text-faint disabled:cursor-default"
        />
        {joinLine === null ? null : (
          <p className="px-[18px] pb-2 text-[12.5px] leading-relaxed text-ink-2">{joinLine}</p>
        )}
        {worktree === undefined ? null : (
          <ComposerResources key={worktree.id} projectId={projectId} worktreeId={worktree.id} />
        )}
        {error !== null && (
          <p role="alert" className="px-[18px] pb-1 font-sans text-xs text-danger">
            {error}
          </p>
        )}
        {/* In a narrow composer (a phone) the pickers wrap onto their own lines above Start. */}
        <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-2.5 @max-md:flex-wrap">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden p-0.5 @max-md:basis-full @max-md:flex-wrap @max-md:overflow-visible [&>*]:min-w-0">
            <div className="inline-flex min-w-0 shrink items-center rounded-[9px] border border-rule">
              {pinned ? null : (
                <ComposerTargetPicker
                  label="Project"
                  choices={projects.map((row) => ({
                    id: row.id,
                    label: row.name,
                    detail: row.originUrl ?? row.storePath,
                  }))}
                  selectedId={projectId}
                  disabled={busy}
                  lead={<Dot tone="ok" />}
                  onSelect={(id) => {
                    const chosen = projects.find((row) => row.id === id);
                    if (chosen === undefined) return;
                    setPickedProjectId(chosen.id);
                    setComposerProject(chosen.id);
                    setPickedWorktreeId(null);
                    setAutoLand(null);
                    setError(null);
                  }}
                />
              )}
              <ComposerTargetPicker
                key={projectId}
                label="Worktree"
                mono
                emptyLabel={`New worktree from ${project.defaultBranch}`}
                choices={worktrees.map((row) => ({
                  id: row.id,
                  label: row.name,
                  detail: row.branch,
                }))}
                selectedId={worktree?.id ?? null}
                disabled={busy}
                onSelect={(id) => {
                  const chosen = worktrees.find((row) => row.id === id);
                  setPickedWorktreeId(chosen?.id ?? null);
                  setError(null);
                }}
                status={
                  worktreesQuery.isPending ? (
                    <span role="status">Loading worktrees…</span>
                  ) : worktreesQuery.isError ? (
                    <span role="alert">
                      Could not load worktrees.{" "}
                      <button
                        type="button"
                        onClick={() => void worktreesQuery.refetch()}
                        className="text-info hover:underline"
                      >
                        Retry
                      </button>
                    </span>
                  ) : null
                }
                onCreate={() => setNewWorktreeOpen(true)}
              />
            </div>
            <Menu
              width={300}
              trigger={
                <Pick disabled={busy} aria-label={`Agent: ${harness}, model: ${picker.modelLabel}`}>
                  <span className="capitalize">{harness}</span>
                  {picker.hasModels ? (
                    <span className="truncate font-mono text-[11.5px] font-normal text-muted-foreground">
                      {[picker.modelLabel, picker.effort]
                        .filter((part) => part !== null)
                        .join(" · ")}
                    </span>
                  ) : null}
                </Pick>
              }
            >
              <MenuGroup label="Agent">
                <MenuRadioGroup
                  label="Agent"
                  value={harness}
                  options={COMPOSER_HARNESSES.map((choice) => ({ value: choice, label: choice }))}
                  onChange={(choice) => setComposerHarness(projectId, choice)}
                />
              </MenuGroup>
              {picker.hasModels ? (
                <>
                  <MenuSeparator />
                  <MenuGroup label="Model">
                    <MenuRadioGroup
                      label="Model"
                      value={picker.model ?? ""}
                      options={picker.models.map((model) => ({
                        value: model.id,
                        label: (
                          <>
                            {model.label}
                            <MenuMeta>{model.isDefault ? "default" : model.id}</MenuMeta>
                          </>
                        ),
                      }))}
                      onChange={(model) =>
                        setComposerHarnessPrefs(projectId, harness, { model }, defaults)
                      }
                    />
                  </MenuGroup>
                </>
              ) : null}
              <MenuSeparator />
              <MenuGroup label="Thinking">
                <MenuRadioGroup
                  label="Thinking"
                  value={picker.effort ?? "default"}
                  options={efforts.map((row) => ({ value: row.value, label: row.label }))}
                  onChange={(value) =>
                    setComposerHarnessPrefs(
                      projectId,
                      harness,
                      {
                        effort: efforts.find((row) => row.value === value)?.effort ?? null,
                      },
                      defaults,
                    )
                  }
                />
              </MenuGroup>
            </Menu>
            <Menu
              width={300}
              trigger={
                <Pick disabled={busy} aria-label="Session options">
                  {optionsSummary.length === 0 ? "Options" : optionsSummary.join(" · ")}
                </Pick>
              }
            >
              {picker.fastCapable ? (
                <>
                  <MenuGroup label="Speed">
                    <MenuRadioGroup
                      label="Speed"
                      value={harnessPrefs.speed === "fast" ? "fast" : "standard"}
                      options={[
                        { value: "standard", label: "Standard" },
                        {
                          value: "fast",
                          label: (
                            <>
                              Fast<MenuMeta>1.5× · more usage</MenuMeta>
                            </>
                          ),
                        },
                      ]}
                      onChange={(speed) =>
                        setComposerHarnessPrefs(
                          projectId,
                          harness,
                          {
                            speed: speed === "fast" ? "fast" : null,
                          },
                          defaults,
                        )
                      }
                    />
                  </MenuGroup>
                  <MenuSeparator />
                </>
              ) : null}
              <MenuGroup label="Permissions">
                <MenuRadioGroup
                  label="Permissions"
                  value={harnessPrefs.permission ?? "bypass"}
                  options={PERMISSIONS}
                  onChange={(mode) =>
                    setComposerHarnessPrefs(
                      projectId,
                      harness,
                      {
                        permission: mode === "bypass" ? null : mode,
                      },
                      defaults,
                    )
                  }
                />
              </MenuGroup>
              <MenuSeparator />
              <MenuGroup label="Land when a turn completes">
                <MenuRadioGroup
                  label="Land when a turn completes"
                  value={landing.items.find((item) => item.selected)?.key ?? ""}
                  options={landing.items.map((item) => ({
                    value: item.key,
                    label: (
                      <>
                        {item.label}
                        {item.detail === null ? null : <MenuMeta>{item.detail}</MenuMeta>}
                      </>
                    ),
                  }))}
                  onChange={(key) => {
                    const item = landing.items.find((row) => row.key === key);
                    if (item !== undefined) setAutoLand(item.override);
                  }}
                />
              </MenuGroup>
            </Menu>
          </div>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || worktreesQuery.isError}
            className="@max-md:ml-auto"
          >
            {busy ? "Starting…" : submitLabel}
          </Button>
        </div>
      </form>
      {newWorktreeOpen === null ? null : (
        <Suspense fallback={null}>
          <NewWorktreeDialog
            project={project}
            open={newWorktreeOpen}
            onOpenChange={setNewWorktreeOpen}
            onCreated={(created) => {
              setPickedWorktreeId(created.id);
              setError(null);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
