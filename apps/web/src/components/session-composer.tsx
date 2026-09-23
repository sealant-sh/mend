import {
  EFFORT_LEVELS,
  FAST_CAPABLE_HARNESSES,
  HARNESS_MODELS,
  type EffortLevel,
  type PermissionMode,
} from "@mend/domain/workbench";
import { cn } from "@mend/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronDown } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ComposerTargetPicker } from "#/components/composer-target-picker";
import { NewWorktreeDialog } from "#/components/project-detail/new-worktree-dialog";
import type { ProjectDto, WorktreeDto } from "#/lib/api";
import {
  effectiveHarnessPrefs,
  setComposerHarness,
  setComposerHarnessPrefs,
  setComposerProject,
  useComposerPrefs,
} from "#/lib/composer-prefs";
import { autoLandItems } from "#/lib/landing";
import { HARNESSES, startComposedSessionInWorktree, type Harness } from "#/lib/session-launch";
import { useTRPC } from "#/lib/trpc";

/** Harnesses the composer offers — the promptable ones. */
const COMPOSER_HARNESSES = HARNESSES.filter((choice) => choice !== "shell");

type MenuKind = "harness" | "model" | "settings" | "options";

interface MenuState {
  readonly kind: MenuKind;
  readonly anchor: { readonly left: number; readonly bottom: number };
}

/** Choose a project and worktree, then compose the session's first message and harness options. */
export function SessionComposer({ projects }: { readonly projects: ReadonlyArray<ProjectDto> }) {
  const navigate = useNavigate();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const prefs = useComposerPrefs();
  const [pickedProjectId, setPickedProjectId] = useState<ProjectDto["id"] | null>(null);
  const [pickedWorktreeId, setPickedWorktreeId] = useState<WorktreeDto["id"] | null>(null);
  const [newWorktreeOpen, setNewWorktreeOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // "Land when a turn completes" for this one session; null follows the project. Not sticky: a
  // push speaks as you on GitHub, so each session starts from the project's stance.
  const [autoLand, setAutoLand] = useState<boolean | null>(null);
  const settingsQuery = useQuery(trpc.settings.get.queryOptions());

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

  if (projectId === undefined || project === undefined) return null;

  // A sticky "shell" from before shell left the composer degrades to claude.
  const stickyHarness = prefs.byProject[projectId]?.harness ?? "claude";
  const harness: Harness = stickyHarness === "shell" ? "claude" : stickyHarness;
  const harnessPrefs = effectiveHarnessPrefs(prefs, projectId, harness);

  const openMenu = (kind: MenuKind) => (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu((current) =>
      current?.kind === kind ? null : { kind, anchor: { left: rect.left, bottom: rect.bottom } },
    );
  };

  const submit = () => {
    if (busy || worktree === undefined || worktreesQuery.isError) return;
    const body = prompt.trim();
    if (body.startsWith("-")) {
      setError("A prompt cannot start with “-” — the harness would read it as a flag.");
      return;
    }
    setBusy(true);
    setError(null);
    setComposerProject(projectId);
    void startComposedSessionInWorktree(navigate, { queryClient, trpc }, worktree.id, {
      harness,
      prompt: body,
      ...(harnessPrefs.model === null ? {} : { model: harnessPrefs.model }),
      ...(harnessPrefs.effort === null ? {} : { effort: harnessPrefs.effort }),
      ...(harnessPrefs.permission === null ? {} : { permissionMode: harnessPrefs.permission }),
      ...(harnessPrefs.speed === null ? {} : { speed: harnessPrefs.speed }),
      autoLand: project.autoLand === "off" ? null : autoLand,
    }).catch((cause: unknown) => {
      setBusy(false);
      setError(cause instanceof Error ? `Could not start — ${cause.message}` : "Could not start.");
    });
  };

  const landing = autoLandItems({
    override: autoLand,
    project: project.autoLand,
    settings: settingsQuery.data?.autoLand ?? null,
  });
  const settingsSummary = [
    harnessPrefs.effort,
    harnessPrefs.speed === "fast" ? "fast" : null,
    harnessPrefs.permission === "ask" ? "ask" : null,
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
        className="@container rounded-2xl border border-rule-faint bg-panel shadow-sm transition-[border-color,box-shadow] focus-within:border-rule focus-within:shadow-md"
      >
        <div className="flex min-w-0 items-center gap-0.5 px-3 pt-3">
          <ComposerTargetPicker
            label="Project"
            choices={projects.map((row) => ({
              id: row.id,
              label: row.name,
              detail: row.originUrl ?? row.storePath,
            }))}
            selectedId={projectId}
            disabled={busy}
            onSelect={(id) => {
              const chosen = projects.find((row) => row.id === id);
              if (chosen === undefined) return;
              setPickedProjectId(chosen.id);
              setComposerProject(chosen.id);
              setPickedWorktreeId(null);
              setAutoLand(null);
              setError(null);
              setMenu(null);
            }}
          />
          <span aria-hidden="true" className="shrink-0 px-0.5 text-sm text-faint">
            /
          </span>
          <ComposerTargetPicker
            key={projectId}
            label="Worktree"
            choices={worktrees.map((row) => ({ id: row.id, label: row.name, detail: row.branch }))}
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
            onCreate={() => {
              setMenu(null);
              setNewWorktreeOpen(true);
            }}
          />
        </div>
        <textarea
          disabled={busy}
          value={prompt}
          rows={1}
          placeholder="What should the session do?"
          onChange={(event) => setPrompt(event.target.value)}
          onInput={(event) => {
            const el = event.currentTarget;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") event.currentTarget.blur();
            if (event.key !== "Enter") return;
            if (event.nativeEvent.isComposing) return;
            if (event.shiftKey) return;
            event.preventDefault();
            submit();
          }}
          className="block max-h-[200px] min-h-[88px] w-full resize-none bg-transparent px-5 pb-3 pt-3 font-sans text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-default"
        />
        {error !== null && (
          <p role="alert" className="px-4 pt-1 font-sans text-xs text-danger">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <ComposerPill onClick={openMenu("harness")} open={menu?.kind === "harness"}>
              <span className="font-mono text-[12px]">{harness}</span>
            </ComposerPill>
            <ComposerPill
              className="hidden @md:inline-flex"
              onClick={openMenu("model")}
              open={menu?.kind === "model"}
            >
              <span className="truncate text-xs">
                {HARNESS_MODELS[harness]?.find((option) => option.id === harnessPrefs.model)
                  ?.label ??
                  harnessPrefs.model ??
                  "Model"}
              </span>
            </ComposerPill>
            <ComposerPill
              className="hidden @md:inline-flex"
              onClick={openMenu("settings")}
              open={menu?.kind === "settings"}
            >
              <span className="font-mono text-[12px]">
                {settingsSummary.length === 0 ? "settings" : settingsSummary.join(" · ")}
              </span>
            </ComposerPill>
            <ComposerPill
              className="@md:hidden"
              onClick={openMenu("options")}
              open={menu?.kind === "options"}
            >
              <span className="font-sans">options</span>
            </ComposerPill>
          </div>
          <button
            type="submit"
            disabled={busy || worktree === undefined || worktreesQuery.isError}
            onPointerDown={(event) => event.preventDefault()}
            className="h-8 shrink-0 rounded-xl bg-primary px-3.5 font-sans text-[13px] font-medium text-primary-foreground shadow-[var(--shadow-cobalt)] transition-transform hover:-translate-y-0.5 disabled:opacity-50"
          >
            {busy ? "Starting…" : "Start"}
          </button>
        </div>
        {menu !== null && (
          <ComposerMenu state={menu} onClose={() => setMenu(null)}>
            {menu.kind === "harness" && (
              <MenuRadioGroup
                mono
                items={COMPOSER_HARNESSES.map((choice) => ({
                  key: choice,
                  label: choice,
                  selected: choice === harness,
                  onSelect: () => {
                    setComposerHarness(projectId, choice);
                    setMenu(null);
                  },
                }))}
              />
            )}
            {(menu.kind === "model" || menu.kind === "options") && (
              <MenuRadioGroup
                label={menu.kind === "options" ? "Model" : undefined}
                items={(HARNESS_MODELS[harness] ?? []).map((option) => ({
                  key: option.id,
                  label: option.label,
                  detail: option.id,
                  selected: option.id === harnessPrefs.model,
                  onSelect: () => {
                    setComposerHarnessPrefs(projectId, harness, { model: option.id });
                    if (menu.kind === "model") setMenu(null);
                  },
                }))}
              />
            )}
            {(menu.kind === "settings" || menu.kind === "options") && (
              <>
                <MenuRadioGroup
                  label="Thinking"
                  mono
                  items={[
                    {
                      key: "default",
                      label: "default",
                      selected: harnessPrefs.effort === null,
                      onSelect: () => setComposerHarnessPrefs(projectId, harness, { effort: null }),
                    },
                    ...EFFORT_LEVELS.map((level: EffortLevel) => ({
                      key: level,
                      label: level,
                      selected: harnessPrefs.effort === level,
                      onSelect: () =>
                        setComposerHarnessPrefs(projectId, harness, { effort: level }),
                    })),
                  ]}
                />
                {FAST_CAPABLE_HARNESSES.has(harness) && (
                  <MenuRadioGroup
                    label="Speed"
                    items={[
                      {
                        key: "standard",
                        label: "Standard",
                        selected: harnessPrefs.speed !== "fast",
                        onSelect: () =>
                          setComposerHarnessPrefs(projectId, harness, { speed: null }),
                      },
                      {
                        key: "fast",
                        label: "Fast",
                        detail: "1.5× · more usage",
                        selected: harnessPrefs.speed === "fast",
                        onSelect: () =>
                          setComposerHarnessPrefs(projectId, harness, { speed: "fast" }),
                      },
                    ]}
                  />
                )}
                <MenuRadioGroup
                  label="Permissions"
                  items={(
                    [
                      ["bypass", "Skip permission prompts"],
                      ["ask", "Ask before acting"],
                    ] as ReadonlyArray<readonly [PermissionMode, string]>
                  ).map(([mode, label]) => ({
                    key: mode,
                    label,
                    selected: (harnessPrefs.permission ?? "bypass") === mode,
                    onSelect: () =>
                      setComposerHarnessPrefs(projectId, harness, {
                        permission: mode === "bypass" ? null : mode,
                      }),
                  }))}
                />
                <MenuRadioGroup
                  label="Land when a turn completes"
                  items={landing.items.map((item) => ({
                    key: item.key,
                    label: item.label,
                    ...(item.detail === null ? {} : { detail: item.detail }),
                    selected: item.selected,
                    onSelect: () => setAutoLand(item.override),
                  }))}
                />
              </>
            )}
          </ComposerMenu>
        )}
      </form>
      <NewWorktreeDialog
        project={project}
        open={newWorktreeOpen}
        onOpenChange={setNewWorktreeOpen}
        onCreated={(created) => {
          setPickedWorktreeId(created.id);
          setError(null);
        }}
      />
    </>
  );
}

function ComposerPill({
  children,
  onClick,
  open,
  className = "",
}: {
  readonly children: React.ReactNode;
  readonly onClick: React.MouseEventHandler<HTMLButtonElement>;
  readonly open: boolean;
  readonly className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs transition-colors",
        open
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground",
        className,
      )}
    >
      {children}
      <ChevronDown className="size-3 shrink-0 text-faint" />
    </button>
  );
}

/**
 * The pill popover — portaled to <body> (ancestor transforms would hijack
 * position:fixed) and clamped to the viewport, same mechanics as the
 * context menu. Radio rows close on select; the base input does not.
 */
function ComposerMenu({
  state,
  onClose,
  children,
}: {
  readonly state: MenuState;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const rect = panel.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(state.anchor.left, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(state.anchor.bottom + 6, window.innerHeight - rect.height - 8)),
    });
  }, [state]);

  // Focus once the panel is visible — focus() on a visibility:hidden element
  // is silently ignored, and Escape needs the focus inside the overlay.
  useLayoutEffect(() => {
    if (position !== null) panelRef.current?.focus();
  }, [position]);

  return createPortal(
    <div
      className="fixed inset-0 z-50"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        ref={panelRef}
        role="menu"
        aria-orientation="vertical"
        tabIndex={-1}
        style={
          position ?? { left: state.anchor.left, top: state.anchor.bottom, visibility: "hidden" }
        }
        onClick={(event) => event.stopPropagation()}
        className="fixed min-w-[220px] max-w-[300px] rounded-xl border border-rule bg-popover py-1.5 shadow-[var(--shadow-overlay)] focus:outline-none"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

interface MenuRadioItem {
  readonly key: string;
  readonly label: string;
  /** Quiet mono id beside the label (e.g. a model id). */
  readonly detail?: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

function MenuRadioGroup({
  label,
  mono = false,
  items,
}: {
  readonly label?: string | undefined;
  readonly mono?: boolean;
  readonly items: ReadonlyArray<MenuRadioItem>;
}) {
  return (
    <div className="not-first:mt-1 not-first:border-t not-first:border-rule-faint not-first:pt-1">
      {label !== undefined && (
        <p className="px-3.5 pb-1 pt-1.5 text-xs font-medium text-label">{label}</p>
      )}
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitemradio"
          aria-checked={item.selected}
          onClick={item.onSelect}
          className="flex w-full items-center gap-2 px-3.5 py-1.5 text-left transition-colors hover:bg-secondary"
        >
          <Check className={`size-3.5 shrink-0 ${item.selected ? "text-primary" : "invisible"}`} />
          <span
            className={`min-w-0 flex-1 truncate ${mono ? "font-mono text-[12px]" : "font-sans text-[13px]"} text-foreground`}
          >
            {item.label}
          </span>
          {item.detail !== undefined && (
            <span className="shrink-0 font-mono text-[11px] text-faint">{item.detail}</span>
          )}
        </button>
      ))}
    </div>
  );
}
