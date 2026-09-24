import {
  EFFORT_LEVELS,
  FAST_CAPABLE_HARNESSES,
  HARNESS_MODELS,
  type EffortLevel,
  type PermissionMode,
} from "@mend/domain/workbench";
import { Button } from "@mend/ui/components/ui/button";
import { Check, ChevronDown } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  createSession,
  launchSessionStart,
  type LaunchStartDto,
  type ProjectDto,
  type SessionDto,
} from "#/lib/api";
import { HARNESSES, useAppSettings } from "#/lib/app-settings";
import {
  effectiveHarness,
  effectiveHarnessPrefs,
  setComposerHarness,
  setComposerHarnessPrefs,
  useComposerPrefs,
} from "#/lib/composer-prefs";
import { CONVERSATION_HARNESSES, rememberLaunchMode } from "#/lib/conversation";
import { queryClient } from "#/lib/queries";

/**
 * The launcher (BRIEF.md) as a composer, the same one the web app starts
 * sessions with: the prompt is the session's first message (it rides the
 * launch and seeds auto-naming); the quiet pill row carries harness, model,
 * and settings, sticky per project + harness. An empty prompt is a bare
 * `mend <harness>` — the CLI and the app produce identical sessions. The
 * session tab opens the moment the row exists; the terminal pane carries the
 * provisioning fact until the PTY binds.
 */

type MenuKind = "project" | "harness" | "model" | "settings";

/** Which action is in flight — the labels differ, the lock is shared. */
type Pending = "start" | "shell" | null;

export interface MenuState {
  readonly kind: MenuKind;
  readonly anchor: { readonly left: number; readonly bottom: number };
}

export function Launcher({
  project,
  onLaunched,
  onClose,
}: {
  readonly project: ProjectDto;
  readonly onLaunched: (session: SessionDto) => void;
  readonly onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center bg-[rgba(27,27,29,0.28)] pt-[18vh]"
      onMouseDown={() => {
        if (!busy) onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-label={`New session in ${project.name}`}
        onMouseDown={(event) => event.stopPropagation()}
        className="no-drag w-[560px] overflow-hidden rounded-2xl border border-rule bg-panel shadow-overlay"
      >
        <p className="border-b border-rule px-4 py-3 font-sans text-[14px] font-medium text-foreground">
          New session · <span className="text-muted-foreground">{project.name}</span>
        </p>
        <SessionComposer
          project={project}
          onLaunched={onLaunched}
          onClose={onClose}
          onBusy={setBusy}
          variant="dialog"
        />
      </div>
    </div>
  );
}

/**
 * The composer itself. `dialog` lives inside the launcher modal (Cancel,
 * Escape closes); `inline` fills the empty terminal pane when the focused
 * project has no tabs open — its own bordered card, no chrome to dismiss.
 */
export function SessionComposer({
  project,
  onLaunched,
  onClose,
  onBusy,
  variant,
}: {
  readonly project: ProjectDto;
  readonly onLaunched: (session: SessionDto) => void;
  readonly onClose?: () => void;
  /** Lets the host hold its backdrop closed while a launch is in flight. */
  readonly onBusy?: (busy: boolean) => void;
  readonly variant: "dialog" | "inline";
}) {
  const { defaultHarness } = useAppSettings();
  const prefs = useComposerPrefs();
  const [prompt, setPrompt] = useState("");
  /** The worktree's name comes first — it is the identity being created. */
  const [worktreeName, setWorktreeName] = useState("");
  const [base, setBase] = useState("");
  const [busy, setBusyState] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const setBusy = (next: Pending) => {
    setBusyState(next);
    onBusy?.(next !== null);
  };

  const harness = effectiveHarness(prefs, project.id, defaultHarness);
  const harnessPrefs = effectiveHarnessPrefs(prefs, project.id, harness);
  /** Harnesses with a catalog take model/thinking/permission flags; the rest only a prompt. */
  const tunable = HARNESS_MODELS[harness] !== undefined;
  /** claude and codex also run as a conversation (protocol mode) instead of a terminal. */
  const conversable = CONVERSATION_HARNESSES.has(harness);
  const runsAs = conversable ? harnessPrefs.mode : null;

  const openMenu = (kind: MenuKind) => (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu((current) =>
      current?.kind === kind ? null : { kind, anchor: { left: rect.left, bottom: rect.bottom } },
    );
  };

  /**
   * Create the row, hand it to the host at once, and let the launch run on —
   * the session tab shows "provisioning" until the PTY binds (a cold first
   * launch can take minutes; a hot skeleton, seconds). A launch failure
   * settles the session server-side, so the tab shows it. Only a create
   * failure lands back here, with the prompt intact. `start` empty = bare harness.
   */
  const launch = async (
    which: Pending,
    sessionHarness: string,
    start: LaunchStartDto,
    launchMode: "protocol" | null = null,
  ) => {
    if (busy !== null) return;
    setBusy(which);
    setError(null);
    try {
      const cleanedName = worktreeName
        .trim()
        .replace(/^[^a-z0-9]+/, "")
        .slice(0, 64);
      const created = await createSession(
        project.id,
        sessionHarness,
        null,
        base.trim() === "" ? null : base.trim(),
        cleanedName === "" ? null : cleanedName,
        launchMode,
      );
      if (launchMode !== null) rememberLaunchMode(created.id, launchMode);
      void launchSessionStart(
        created.id,
        launchMode === null ? start : { ...start, mode: launchMode },
      )
        .catch(() => undefined)
        .finally(() => {
          void queryClient.invalidateQueries({ queryKey: ["session", created.id] });
          void queryClient.invalidateQueries({ queryKey: ["project", project.id] });
        });
      void queryClient.invalidateQueries({ queryKey: ["project", project.id] });
      onLaunched(created);
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
      setBusy(null);
    }
  };

  const submit = () => {
    const body = prompt.trim();
    if (body.startsWith("-")) {
      setError("A prompt cannot start with “-” — the harness would read it as a flag.");
      return;
    }
    void launch(
      "start",
      harness,
      {
        ...(body === "" ? {} : { prompt: body }),
        ...(tunable && harnessPrefs.model !== null ? { model: harnessPrefs.model } : {}),
        ...(tunable && harnessPrefs.effort !== null ? { effort: harnessPrefs.effort } : {}),
        ...(tunable && harnessPrefs.permission !== null
          ? { permissionMode: harnessPrefs.permission }
          : {}),
        ...(tunable && harnessPrefs.speed !== null ? { speed: harnessPrefs.speed } : {}),
      },
      runsAs,
    );
  };

  /** A bare login shell in its own worktree — nothing to prompt, so it is not a composer harness. */
  const openShell = () => void launch("shell", "shell", {});

  const settingsSummary = [
    runsAs === "protocol" ? "conversation" : null,
    tunable ? harnessPrefs.effort : null,
    tunable && harnessPrefs.speed === "fast" ? "fast" : null,
    tunable && harnessPrefs.permission === "ask" ? "ask" : null,
    base.trim() === "" ? null : base.trim(),
  ].filter((part): part is string => part !== null);

  return (
    <form
      aria-label={`New session in ${project.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && menu === null && busy === null) onClose?.();
      }}
      className={
        variant === "inline"
          ? "no-drag w-full max-w-[640px] rounded-2xl border border-rule bg-panel shadow-sm transition-[border-color,box-shadow] focus-within:border-[var(--sw-accent)] focus-within:shadow-md"
          : undefined
      }
    >
      <input
        value={worktreeName}
        autoFocus
        disabled={busy !== null}
        placeholder="worktree name — e.g. fix-auth (empty = auto)"
        onChange={(event) =>
          setWorktreeName(event.target.value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"))
        }
        className="block w-full border-b border-[var(--sw-faint-rule)] bg-transparent px-4 pb-2 pt-3 font-mono text-xs text-foreground outline-none placeholder:text-faint disabled:opacity-60"
      />
      <textarea
        value={prompt}
        rows={1}
        disabled={busy !== null}
        placeholder="What should the session do?"
        onChange={(event) => setPrompt(event.target.value)}
        onInput={(event) => {
          const el = event.currentTarget;
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          if (event.nativeEvent.isComposing) return;
          if (event.shiftKey) return;
          event.preventDefault();
          submit();
        }}
        className="block max-h-[220px] min-h-[84px] w-full resize-none bg-transparent px-4 pt-3.5 font-sans text-[13.5px] leading-relaxed text-foreground outline-none placeholder:text-faint disabled:cursor-default disabled:opacity-60"
      />
      {error !== null && <p className="px-4 pt-1 font-mono text-[12px] text-danger">{error}</p>}
      <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <ComposerPill
            disabled={busy !== null}
            onClick={openMenu("harness")}
            open={menu?.kind === "harness"}
          >
            <span className="font-mono text-[12px]">{harness}</span>
          </ComposerPill>
          {tunable && (
            <ComposerPill
              disabled={busy !== null}
              onClick={openMenu("model")}
              open={menu?.kind === "model"}
            >
              <span className="font-mono text-[12px]">{harnessPrefs.model ?? "model"}</span>
            </ComposerPill>
          )}
          <ComposerPill
            disabled={busy !== null}
            onClick={openMenu("settings")}
            open={menu?.kind === "settings"}
          >
            <span className="font-mono text-[12px]">
              {settingsSummary.length === 0 ? "settings" : settingsSummary.join(" · ")}
            </span>
          </ComposerPill>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={openShell}
            className="text-muted-foreground"
          >
            {busy === "shell" ? "Opening…" : "Open a shell"}
          </Button>
          {onClose !== undefined && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={onClose}
            >
              Cancel
            </Button>
          )}
          <Button
            type="submit"
            size="sm"
            disabled={busy !== null}
            onPointerDown={(event) => event.preventDefault()}
          >
            {busy === "start" ? "Starting…" : "Start"}
          </Button>
        </div>
      </div>
      {menu !== null && (
        <ComposerMenu state={menu} onClose={() => setMenu(null)}>
          {menu.kind === "harness" && (
            <MenuRadioGroup
              mono
              items={HARNESSES.map((choice) => ({
                key: choice,
                label: choice,
                detail: choice === defaultHarness ? "default" : undefined,
                selected: choice === harness,
                onSelect: () => {
                  setComposerHarness(project.id, choice);
                  setMenu(null);
                },
              }))}
            />
          )}
          {menu.kind === "model" && (
            <MenuRadioGroup
              items={(HARNESS_MODELS[harness] ?? []).map((option) => ({
                key: option.id,
                label: option.label,
                detail: option.id,
                selected: option.id === harnessPrefs.model,
                onSelect: () => {
                  setComposerHarnessPrefs(project.id, harness, {
                    model: option.id,
                  });
                  setMenu(null);
                },
              }))}
            />
          )}
          {menu.kind === "settings" && (
            <>
              {conversable && (
                <MenuRadioGroup
                  label="Runs as"
                  items={[
                    {
                      key: "pty",
                      label: "Terminal",
                      detail: "PTY",
                      selected: runsAs === null,
                      onSelect: () => setComposerHarnessPrefs(project.id, harness, { mode: null }),
                    },
                    {
                      key: "protocol",
                      label: "Conversation",
                      detail: "turns · approvals",
                      selected: runsAs === "protocol",
                      onSelect: () =>
                        setComposerHarnessPrefs(project.id, harness, { mode: "protocol" }),
                    },
                  ]}
                />
              )}
              {tunable && (
                <MenuRadioGroup
                  label="Thinking"
                  mono
                  items={[
                    {
                      key: "default",
                      label: "default",
                      selected: harnessPrefs.effort === null,
                      onSelect: () =>
                        setComposerHarnessPrefs(project.id, harness, {
                          effort: null,
                        }),
                    },
                    ...EFFORT_LEVELS.map((level: EffortLevel) => ({
                      key: level,
                      label: level,
                      selected: harnessPrefs.effort === level,
                      onSelect: () =>
                        setComposerHarnessPrefs(project.id, harness, {
                          effort: level,
                        }),
                    })),
                  ]}
                />
              )}
              {tunable && FAST_CAPABLE_HARNESSES.has(harness) && (
                <MenuRadioGroup
                  label="Speed"
                  items={[
                    {
                      key: "standard",
                      label: "Standard",
                      selected: harnessPrefs.speed !== "fast",
                      onSelect: () =>
                        setComposerHarnessPrefs(project.id, harness, {
                          speed: null,
                        }),
                    },
                    {
                      key: "fast",
                      label: "Fast",
                      detail: "1.5× · more usage",
                      selected: harnessPrefs.speed === "fast",
                      onSelect: () =>
                        setComposerHarnessPrefs(project.id, harness, {
                          speed: "fast",
                        }),
                    },
                  ]}
                />
              )}
              {tunable && (
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
                      setComposerHarnessPrefs(project.id, harness, {
                        permission: mode === "bypass" ? null : mode,
                      }),
                  }))}
                />
              )}
              <div
                className={
                  tunable
                    ? "mt-1 border-t border-rule-faint px-3.5 pb-1.5 pt-2"
                    : "px-3.5 pb-1.5 pt-1"
                }
              >
                <p className="text-xs font-medium text-label">Base</p>
                <input
                  value={base}
                  placeholder={project.defaultBranch}
                  onChange={(event) => setBase(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setMenu(null);
                    }
                  }}
                  className="mt-1.5 w-full rounded-lg border border-input bg-background px-2 py-1 font-mono text-[12px] text-foreground outline-none transition-colors placeholder:text-faint focus:border-[var(--sw-accent)]"
                />
              </div>
            </>
          )}
        </ComposerMenu>
      )}
    </form>
  );
}

export function ComposerPill({
  children,
  onClick,
  open,
  disabled,
  className = "",
}: {
  readonly children: React.ReactNode;
  readonly onClick: React.MouseEventHandler<HTMLButtonElement>;
  readonly open: boolean;
  readonly disabled: boolean;
  readonly className?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs transition-colors disabled:opacity-50 ${open ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"} ${className}`}
    >
      {children}
      <ChevronDown className="size-3 shrink-0 text-faint" />
    </button>
  );
}

export function ComposerMenu({
  state,
  onClose,
  children,
}: {
  readonly state: MenuState;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

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
      className="fixed inset-0 z-[60]"
      onClick={onClose}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        role="menu"
        aria-orientation="vertical"
        tabIndex={-1}
        style={
          position ?? {
            left: state.anchor.left,
            top: state.anchor.bottom,
            visibility: "hidden",
          }
        }
        onClick={(event) => event.stopPropagation()}
        className="no-drag fixed min-w-[220px] max-w-[300px] rounded-xl border border-rule bg-popover py-1.5 shadow-overlay focus:outline-none"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export interface MenuRadioItem {
  readonly key: string;
  readonly label: string;
  /** Quiet mono note beside the label (a model id, "default"). */
  readonly detail?: string | undefined;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

export function MenuRadioGroup({
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

/**
 * The project word in the inline composer's header, as a picker: the same
 * pill + popover the composer's own row uses. Choosing re-focuses that
 * project, so the tree and the composer move together.
 */
export function ProjectPicker({
  projects,
  projectId,
  onPick,
}: {
  readonly projects: ReadonlyArray<ProjectDto>;
  readonly projectId: string;
  readonly onPick: (projectId: string) => void;
}) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const project = projects.find((row) => row.id === projectId);
  return (
    <>
      <ComposerPill
        disabled={false}
        open={menu !== null}
        className="h-8 px-2 text-[14px] font-medium"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu((current) =>
            current !== null
              ? null
              : { kind: "project", anchor: { left: rect.left, bottom: rect.bottom } },
          );
        }}
      >
        <span className="truncate font-sans">{project?.name ?? "project"}</span>
      </ComposerPill>
      {menu !== null && (
        <ComposerMenu state={menu} onClose={() => setMenu(null)}>
          <MenuRadioGroup
            items={projects.map((row) => ({
              key: row.id,
              label: row.name,
              selected: row.id === projectId,
              onSelect: () => {
                onPick(row.id);
                setMenu(null);
              },
            }))}
          />
        </ComposerMenu>
      )}
    </>
  );
}
