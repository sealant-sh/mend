import { Banner } from "@mend/ui/components/banner";
import { ComposerCard, PromptInput, PromptInputModel } from "@mend/ui/components/prompt-input";
import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@mend/ui/components/ui/empty";
import { Popover, PopoverContent, PopoverTrigger } from "@mend/ui/components/ui/popover";
import { Progress } from "@mend/ui/components/ui/progress";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@mend/ui/components/ui/sheet";
import { cn } from "@mend/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import {
  BotIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  FolderIcon,
  GitBranchIcon,
  KeyRoundIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { SidebarToggle } from "#/components/app-sidebar";
import { WorkspacesRefusedBanner } from "#/components/host-user-namespaces";
import { loginBlock } from "#/lib/new-session";

import { ComposerResources } from "./composer-resources.tsx";
import {
  AgentMenuItems,
  AgentSheetBody,
  agentPickWords,
  ProjectChoices,
  WorktreeChoices,
} from "./pickers.tsx";
import { type Clone, COMPOSER_AGENTS, type Composer, useComposer } from "./use-composer.ts";

/** The message field on each layout, for `c` to put the cursor in the one on screen. */
const PROMPT_IDS = ["new-session-task", "new-session-task-phone"] as const;

const PLACEHOLDER = "Describe a task or ask a question";

/** Where a person adds or chooses an agent login. */
const AGENT_LOGINS = { to: "/settings/agent-logins" } as const;

/**
 * The New session composer, Mend's home (Doop page 2, "Start a session"): write the task, pick the
 * project, the agent and model, and the worktree, and start. On a wide screen it is the sheet
 * beside the sidebar; under 1024px it is its own screen, opened from the inbox's New session, with
 * the pickers as rows and each picker in a bottom sheet. Both layouts draw one state, so the
 * screen can change width without losing what was written or picked.
 */
export function NewSessionPage() {
  const composer = useComposer();
  useFocusKey();
  return (
    <>
      <DesktopComposer composer={composer} />
      <PhoneComposer composer={composer} />
    </>
  );
}

/** `c` anywhere on the page outside a text field puts the cursor in the composer. */
function useFocusKey() {
  // A page-wide shortcut listens on the document for as long as the page is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "c" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      )
        return;
      const field = PROMPT_IDS.map((id) => document.getElementById(id)).find(
        (element) => element !== null && element.offsetParent !== null,
      );
      if (field === undefined || field === null) return;
      event.preventDefault();
      field.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

/** Why the picked agent can't start, when it can't; null while logins are unknown. */
const blockOf = (composer: Composer) => {
  if (composer.logins._tag === "unknown" || composer.logins.none) return null;
  const { of } = composer.logins;
  const others = COMPOSER_AGENTS.filter(
    (agent) => agent !== composer.agent && of(agent) === "ready",
  );
  return loginBlock(composer.agent, of(composer.agent), others);
};

/** Whether no agent can start: the person skipped the agent login at setup. */
const noLogins = (composer: Composer): boolean =>
  composer.logins._tag === "known" && composer.logins.none;

/** The line under the composer: why it can't send, what went wrong, or how to send. */
export function Hint({
  composer,
  phone = false,
}: {
  readonly composer: Composer;
  readonly phone?: boolean;
}) {
  const block = blockOf(composer);
  const failure = composer.startFailed ?? composer.promptProblem;
  if (failure !== null)
    return (
      <p role="alert" className="text-meta text-destructive">
        {failure}
      </p>
    );
  if (block !== null) return <p className="text-meta text-muted-foreground">{block.hint}</p>;
  if (noLogins(composer)) return null;
  if (composer.queuedOn !== null)
    return (
      <p role="status" className="text-meta text-muted-foreground">
        Queued. The session starts when {composer.queuedOn} finishes cloning. It's under Running in
        the sidebar.
      </p>
    );
  if (composer.saveFailed !== null)
    return <p className="text-meta text-muted-foreground">{composer.saveFailed}</p>;
  if (phone) return null;
  return (
    <p className="text-meta text-muted-foreground">
      Press Enter to start. Shift+Enter adds a new line.
    </p>
  );
}

/** The band naming the picked agent's missing login, with the way to add it. */
function LoginBanner({
  composer,
  layout,
}: {
  readonly composer: Composer;
  readonly layout: "inline" | "stacked";
}) {
  const block = blockOf(composer);
  if (block === null) return null;
  return (
    <Banner
      tone="info"
      layout={layout}
      title={block.title}
      actions={
        <Link
          {...AGENT_LOGINS}
          className={buttonVariants({
            variant: "outline",
            size: layout === "stacked" ? "touch" : "sm",
          })}
        >
          {block.action}
        </Link>
      }
    >
      {block.text}
    </Banner>
  );
}

/** Inside the card before any agent login: what's missing, and where to add one. */
function NoLoginNotice({ touch = false }: { readonly touch?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 text-row",
        touch ? "border-b border-border px-5 py-3 text-lead" : "mx-4.5 px-0 py-3",
      )}
    >
      <KeyRoundIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">Add a Claude Code or Codex login to start a session.</span>
      <Link {...AGENT_LOGINS} className="shrink-0 font-medium text-primary hover:underline">
        Add agent login
      </Link>
    </div>
  );
}

/** Before any project exists there is nothing to start a session in. */
function NoProjects({ touch = false }: { readonly touch?: boolean }) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>
          <h2>No projects yet</h2>
        </EmptyTitle>
        <EmptyDescription>
          A session runs in a project. Add one on the Projects page, then start a session in it
          here.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Link to="/projects" className={buttonVariants({ size: touch ? "touch" : "default" })}>
          Go to Projects
        </Link>
      </EmptyContent>
    </Empty>
  );
}

/** Where the session would start: the project picked, or the clone; null before any project. */
const placeOf = (
  composer: Composer,
): { readonly id: string; readonly name: string; readonly defaultBranch: string | null } | null => {
  if (composer.onClone && composer.clone !== null)
    return { id: composer.clone.id, name: composer.clone.name, defaultBranch: null };
  const { project } = composer;
  return project === undefined
    ? null
    : { id: project.id, name: project.name, defaultBranch: project.defaultBranch };
};

/** How far the clone got, as a bar; a bar with no value while git hasn't said. */
function CloneProgress({
  clone,
  className,
}: {
  readonly clone: Clone;
  readonly className?: string;
}) {
  return (
    <Progress
      value={clone.percent}
      aria-label={`${clone.name} cloned`}
      className={cn("w-32 shrink-0 *:data-[slot=progress-track]:h-1", className)}
    />
  );
}

/** The cloning project is picked, beside other projects: the band says the session will wait. */
function CloneBanner({
  composer,
  layout,
}: {
  readonly composer: Composer;
  readonly layout: "inline" | "stacked";
}) {
  const { clone } = composer;
  // On the first run the card says it instead (frame "First run · clone still running").
  if (
    !composer.onClone ||
    clone === null ||
    (composer.projects.length === 0 && layout === "inline")
  )
    return null;
  return (
    <Banner
      tone="info"
      layout={layout}
      title={`${clone.name} is still cloning.`}
      actions={<CloneProgress clone={clone} className={layout === "stacked" ? "w-full" : ""} />}
    >
      {clone.percent === null ? "" : `It's ${clone.percent}% done. `}You can start the session now.
      It starts when the clone finishes.
    </Banner>
  );
}

/** The first run, while the first project clones: the card says the task can be written now. */
function CloneNotice({ clone }: { readonly clone: Clone }) {
  return (
    <div className="mx-4.5 flex items-center gap-4 py-3 text-row">
      <span className="min-w-0 flex-1">
        {clone.name} is still cloning. You can write your task now. It starts when the clone
        finishes.
      </span>
      <CloneProgress clone={clone} />
      <span className="w-9 shrink-0 text-right text-meta text-muted-foreground tabular-nums">
        {clone.percent === null ? "" : `${clone.percent}%`}
      </span>
    </div>
  );
}

export const sendBlocked = (composer: Composer): boolean =>
  composer.starting ||
  composer.promptProblem !== null ||
  noLogins(composer) ||
  blockOf(composer) !== null;

function DesktopComposer({ composer }: { readonly composer: Composer }) {
  const { project, clone } = composer;
  const place = placeOf(composer);
  const [open, setOpen] = useState<"project" | "worktree" | null>(null);
  const toggle = (picker: "project" | "worktree") => (next: boolean) =>
    setOpen(next ? picker : null);
  return (
    <div className="flex min-h-0 flex-1 flex-col max-lg:hidden">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border pr-5 pl-3">
        <SidebarToggle />
        <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
        <h1 className="text-lead font-semibold">New session</h1>
      </header>
      <WorkspacesRefusedBanner layout="inline" />
      <LoginBanner composer={composer} layout="inline" />
      <CloneBanner composer={composer} layout="inline" />
      {place === null ? (
        <NoProjects />
      ) : (
        <div className="flex flex-1 justify-center px-8 pt-40 pb-16">
          <div className="flex w-full max-w-conversation flex-col gap-2">
            <ComposerCard className="mx-0 w-full">
              {noLogins(composer) ? <NoLoginNotice /> : null}
              {composer.onClone && clone !== null && composer.projects.length === 0 ? (
                <CloneNotice clone={clone} />
              ) : null}
              {composer.target._tag === "existing" && project !== undefined ? (
                <ComposerResources
                  key={composer.target.id}
                  projectId={project.id}
                  worktreeId={composer.target.id}
                />
              ) : null}
              <PromptInput
                id={PROMPT_IDS[0]}
                placeholder={PLACEHOLDER}
                label="Task"
                value={composer.prompt}
                onValueChange={composer.setPrompt}
                onSubmit={composer.start}
                blocked={sendBlocked(composer)}
                submitLabel={composer.starting ? "Starting…" : "Start session"}
                model={
                  <div className="flex min-w-0 items-center gap-0.5">
                    <Popover open={open === "project"} onOpenChange={toggle("project")}>
                      <PopoverTrigger
                        render={
                          <PromptInputModel aria-label={`Project: ${place.name}`}>
                            <FolderGit2Icon aria-hidden className="size-4 text-muted-foreground" />
                            <span className="truncate">{place.name}</span>
                          </PromptInputModel>
                        }
                      />
                      <PopoverContent align="start" className="w-72 p-0">
                        <ProjectChoices
                          projects={composer.projects}
                          clone={clone}
                          selectedId={place.id}
                          size="default"
                          onPick={(id) => {
                            composer.pickProject(id);
                            setOpen(null);
                          }}
                        />
                      </PopoverContent>
                    </Popover>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <PromptInputModel
                            aria-label={`Agent and model: ${agentPickWords(composer)}`}
                            className={cn(noLogins(composer) && "text-muted-foreground")}
                          >
                            <span className="truncate">{agentPickWords(composer)}</span>
                          </PromptInputModel>
                        }
                      />
                      <DropdownMenuContent
                        width="lg"
                        className="max-h-[min(var(--available-height),32rem)]"
                      >
                        <AgentMenuItems composer={composer} />
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {project === undefined ? (
                      // A project still cloning has no worktrees yet: the session gets a new one.
                      <PromptInputModel aria-label="Worktree: New worktree" disabled>
                        <GitBranchIcon aria-hidden className="size-4 text-muted-foreground" />
                        <span className="truncate">New worktree</span>
                      </PromptInputModel>
                    ) : (
                      <Popover open={open === "worktree"} onOpenChange={toggle("worktree")}>
                        <PopoverTrigger
                          render={
                            <PromptInputModel aria-label={`Worktree: ${worktreeWords(composer)}`}>
                              <GitBranchIcon aria-hidden className="size-4 text-muted-foreground" />
                              <span className="truncate">{worktreeWords(composer)}</span>
                            </PromptInputModel>
                          }
                        />
                        <PopoverContent align="start" className="w-90 gap-0 px-0 py-1">
                          <WorktreeChoices
                            project={project}
                            target={composer.target}
                            size="default"
                            now={new Date()}
                            onPick={(target) => {
                              composer.pickTarget(target);
                              setOpen(null);
                            }}
                          />
                        </PopoverContent>
                      </Popover>
                    )}
                  </div>
                }
              />
            </ComposerCard>
            <div className="px-0.5">
              <Hint composer={composer} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** "New worktree", or the picked worktree's branch. */
function worktreeWords(composer: Composer): string {
  return composer.target._tag === "new" ? "New worktree" : composer.target.branch;
}

/** One picker row on the phone: icon, what it picks, what is picked, and a chevron. */
function PhoneRow({
  icon,
  label,
  value,
  onOpen,
  muted = false,
  disabled = false,
  meta,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: ReactNode;
  /** A short fact after the value: how far a clone got. */
  readonly meta?: string;
  readonly onOpen: () => void;
  readonly muted?: boolean;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={`${label}: ${typeof value === "string" ? value : ""}`.trim()}
      onClick={onOpen}
      className="flex h-14 w-full items-center gap-3 border-t border-border px-4 text-left text-lead outline-none focus-visible:bg-muted [&_svg]:size-5 [&_svg]:shrink-0"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="w-22 shrink-0 text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 flex-1 truncate", muted && "text-muted-foreground")}>
        {value}
      </span>
      {meta === undefined ? null : <span className="shrink-0 text-muted-foreground">{meta}</span>}
      <ChevronRightIcon aria-hidden className="text-muted-foreground" />
    </button>
  );
}

function PhoneSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[85dvh] gap-0 rounded-t-pop-touch pb-[env(safe-area-inset-bottom)]"
      >
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle className="text-title">{title}</SheetTitle>
          {description === undefined ? null : <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <div className="min-h-0 overflow-y-auto py-2">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

function PhoneComposer({ composer }: { readonly composer: Composer }) {
  const { project } = composer;
  const place = placeOf(composer);
  const [open, setOpen] = useState<"project" | "agent" | "worktree" | null>(null);
  const close = (next: boolean) => {
    if (!next) setOpen(null);
  };
  const send = () => {
    const text = composer.prompt.trim();
    if (text === "" || sendBlocked(composer)) return;
    composer.setPrompt("");
    composer.start(text);
  };
  return (
    <form
      aria-label="New session"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
      className="flex min-h-dvh flex-col bg-background lg:hidden"
    >
      <header className="sticky top-0 z-10 grid h-14 shrink-0 grid-cols-[44px_1fr_44px] items-center border-b border-border bg-background px-1">
        <Link
          to="/"
          aria-label="Close"
          className={buttonVariants({ variant: "ghost", size: "icon-touch" })}
        >
          <XIcon aria-hidden className="size-5.5" />
        </Link>
        <h1 className="text-center text-title font-semibold">New session</h1>
      </header>
      <WorkspacesRefusedBanner layout="stacked" />
      <LoginBanner composer={composer} layout="stacked" />
      <CloneBanner composer={composer} layout="stacked" />
      {place === null ? (
        <NoProjects touch />
      ) : (
        <>
          {noLogins(composer) ? <NoLoginNotice touch /> : null}
          <label htmlFor={PROMPT_IDS[1]} className="sr-only">
            Task
          </label>
          <textarea
            id={PROMPT_IDS[1]}
            value={composer.prompt}
            placeholder={PLACEHOLDER}
            onChange={(event) => composer.setPrompt(event.target.value)}
            className="min-h-40 flex-1 resize-none bg-transparent px-5 pt-4 pb-2 text-title leading-normal outline-none placeholder:text-faint"
          />
          <div className="px-5 pb-3">
            <Hint composer={composer} phone />
          </div>
          {composer.target._tag === "existing" && project !== undefined ? (
            <ComposerResources
              key={composer.target.id}
              projectId={project.id}
              worktreeId={composer.target.id}
              touch
            />
          ) : null}
          <div className="border-b border-border">
            <PhoneRow
              icon={<FolderGit2Icon aria-hidden />}
              label="Project"
              value={place.name}
              {...(composer.onClone && composer.clone !== null
                ? {
                    meta:
                      composer.clone.percent === null
                        ? "Cloning"
                        : `Cloning · ${composer.clone.percent}%`,
                  }
                : {})}
              onOpen={() => setOpen("project")}
            />
            <PhoneRow
              icon={<BotIcon aria-hidden />}
              label="Agent"
              value={agentPickWords(composer)}
              muted={noLogins(composer)}
              onOpen={() => setOpen("agent")}
            />
            <PhoneRow
              icon={<GitBranchIcon aria-hidden />}
              label="Worktree"
              value={
                composer.target._tag === "existing"
                  ? composer.target.branch
                  : place.defaultBranch === null
                    ? "New worktree"
                    : `New worktree from ${place.defaultBranch}`
              }
              disabled={project === undefined}
              onOpen={() => setOpen("worktree")}
            />
          </div>
          <div className="p-4">
            <Button
              type="submit"
              size="touch"
              className="w-full disabled:opacity-45"
              disabled={composer.prompt.trim() === "" || sendBlocked(composer)}
            >
              {composer.starting ? "Starting…" : "Start session"}
            </Button>
          </div>
          <PhoneSheet open={open === "project"} onOpenChange={close} title="Project">
            <div className="px-4">
              <ProjectChoices
                projects={composer.projects}
                clone={composer.clone}
                selectedId={place.id}
                size="touch"
                onPick={(id) => {
                  composer.pickProject(id);
                  setOpen(null);
                }}
              />
            </div>
          </PhoneSheet>
          <PhoneSheet open={open === "agent"} onOpenChange={close} title="Agent and model">
            <AgentSheetBody composer={composer} />
          </PhoneSheet>
          <PhoneSheet
            open={open === "worktree"}
            onOpenChange={close}
            title="Worktree"
            description={
              composer.target._tag === "new"
                ? "Mend makes a new branch for this session."
                : "The session starts in this worktree, beside any sessions already there."
            }
          >
            {project === undefined ? null : (
              <WorktreeChoices
                project={project}
                target={composer.target}
                size="touch"
                now={new Date()}
                onPick={(target) => {
                  composer.pickTarget(target);
                  setOpen(null);
                }}
              />
            )}
          </PhoneSheet>
        </>
      )}
    </form>
  );
}
