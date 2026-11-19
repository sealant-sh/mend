import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@mend/ui/components/ui/command";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@mend/ui/components/ui/dropdown-menu";
import { cn } from "@mend/ui/lib/utils";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  BotIcon,
  CheckIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitBranchPlusIcon,
  LayersIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type { ProjectDto } from "#/lib/api";
import { age } from "#/lib/inbox";
import { type Agent, agentLoginWord, agentOf, type WorktreeTarget } from "#/lib/new-session";
import { runningWorkspaces, sessionCount } from "#/lib/shared-workspace";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";

import { type Clone, COMPOSER_AGENTS, type Composer } from "./use-composer.ts";

/**
 * The composer's three pickers, each as its desktop menu or popover body and its phone sheet
 * body: the project, the agent and model (with thinking, fast, asking before acting and automatic
 * landing, which the frames don't draw and sit here as the session's own options), and the
 * worktree.
 */

/** A row's size: the desktop's menu rows, or the phone's 52px touch rows. */
type Size = "default" | "touch";

const itemClass = (size: Size) =>
  cn("gap-2.5", size === "touch" ? "h-13 px-3 text-lead" : "py-1.5 text-row");

const searchClass = (size: Size) => (size === "touch" ? "h-11 text-lead" : undefined);

/** The project picker: find a project by name. */
export function ProjectChoices({
  projects,
  clone,
  selectedId,
  onPick,
  size,
}: {
  readonly projects: ReadonlyArray<ProjectDto>;
  /** The project this browser is cloning, listed last with how far it got. */
  readonly clone: Clone | null;
  readonly selectedId: string | undefined;
  readonly onPick: (id: string) => void;
  readonly size: Size;
}) {
  return (
    <Command loop>
      <CommandInput placeholder="Find a project" className={searchClass(size)} />
      <CommandList className={size === "touch" ? "max-h-[60dvh]" : undefined}>
        <CommandEmpty>No project has that name.</CommandEmpty>
        <CommandGroup>
          {projects.map((project) => (
            <CommandItem
              key={project.id}
              value={project.id}
              keywords={[project.name]}
              data-checked={project.id === selectedId}
              onSelect={() => onPick(project.id)}
              className={itemClass(size)}
            >
              <FolderGit2Icon aria-hidden className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
            </CommandItem>
          ))}
          {clone === null ? null : (
            <CommandItem
              value={clone.id}
              keywords={[clone.name]}
              data-checked={clone.id === selectedId}
              onSelect={() => onPick(clone.id)}
              className={itemClass(size)}
            >
              <FolderGit2Icon aria-hidden className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{clone.name}</span>
              <span className="shrink-0 text-meta text-muted-foreground">
                {clone.percent === null ? "Cloning" : `Cloning · ${clone.percent}%`}
              </span>
            </CommandItem>
          )}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

/**
 * The worktree picker: a new worktree from the project's default branch, one of the viewer's
 * running workspaces with how many sessions run in each (Doop "picks a running workspace"), or any
 * other of the project's worktrees, found by branch, with whose change it is and when it last
 * changed.
 */
export function WorktreeChoices({
  project,
  target,
  onPick,
  size,
  now,
}: {
  readonly project: ProjectDto;
  readonly target: WorktreeTarget;
  readonly onPick: (target: WorktreeTarget) => void;
  readonly size: Size;
  readonly now: Date;
}) {
  const trpc = useTRPC();
  const worktrees = useQuery(trpc.worktrees.list.queryOptions({ projectId: project.id }));
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const members = useQuery(trpc.organization.members.queryOptions());
  const roster = members.isPending || members.isError ? [] : members.data;
  const running =
    worktrees.isPending || worktrees.isError
      ? []
      : runningWorkspaces(worktrees.data, viewer.userId);
  const runningIds = new Set(running.map((each) => each.id));
  const others =
    worktrees.isPending || worktrees.isError
      ? []
      : worktrees.data.worktrees.filter((worktree) => !runningIds.has(worktree.id));
  const whose = (userId: string | null): string | null => {
    if (userId === null) return null;
    if (userId === viewer.userId) return "You";
    return roster.find((member) => member.userId === userId)?.name ?? null;
  };
  return (
    <div className="flex flex-col">
      <button
        type="button"
        role="menuitemradio"
        aria-checked={target._tag === "new"}
        onClick={() => onPick({ _tag: "new" })}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-sm text-left outline-none hover:bg-muted focus-visible:bg-muted [&_svg]:size-4 [&_svg]:shrink-0",
          size === "touch"
            ? "h-13 px-5 text-lead [&_svg]:size-5"
            : "mx-1 w-auto px-2 py-1.5 text-row",
        )}
      >
        <GitBranchPlusIcon aria-hidden className="text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">
          New worktree from <span className="font-mono">{project.defaultBranch}</span>
        </span>
        <CheckIcon aria-hidden className={cn(target._tag !== "new" && "invisible")} />
      </button>
      <div className="my-1 h-px bg-border" />
      {running.length === 0 ? null : (
        <div role="group" aria-labelledby={`running-${project.id}`} className="flex flex-col">
          <p
            id={`running-${project.id}`}
            className={cn(
              "pt-1.5 pb-1 text-muted-foreground",
              size === "touch" ? "px-5 text-sm" : "px-3 text-meta font-medium",
            )}
          >
            Your running workspaces in {project.name}
          </p>
          {running.map((workspace) => {
            const picked = target._tag === "existing" && target.id === workspace.id;
            return (
              <button
                key={workspace.id}
                type="button"
                role="menuitemradio"
                aria-checked={picked}
                onClick={() =>
                  onPick({ _tag: "existing", id: workspace.id, branch: workspace.branch })
                }
                className={cn(
                  "flex w-auto items-center gap-2.5 rounded-sm text-left outline-none hover:bg-muted focus-visible:bg-muted [&_svg]:size-4 [&_svg]:shrink-0",
                  size === "touch"
                    ? "h-13 px-5 text-lead [&_svg]:size-5"
                    : "mx-1 px-2 py-1.5 text-row",
                  picked && size === "default" && "bg-muted",
                )}
              >
                <LayersIcon aria-hidden className="text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                <span className="shrink-0 text-meta text-muted-foreground">
                  {sessionCount(workspace.sessions)}
                </span>
                <CheckIcon aria-hidden className={cn(!picked && "invisible")} />
              </button>
            );
          })}
          <div className="my-1 h-px bg-border" />
        </div>
      )}
      <p
        className={cn(
          "pt-1.5 pb-1 text-muted-foreground",
          size === "touch" ? "px-5 text-sm" : "px-3 text-meta font-medium",
        )}
      >
        Or start in a worktree
      </p>
      <Command loop className={size === "touch" ? "px-4" : undefined}>
        <CommandInput placeholder="Find a branch" className={searchClass(size)} />
        <CommandList className={size === "touch" ? "max-h-[45dvh]" : undefined}>
          {worktrees.isPending ? (
            <p role="status" className="px-2 py-1.5 text-row text-muted-foreground">
              Loading worktrees…
            </p>
          ) : worktrees.isError ? (
            <div role="alert" className="flex flex-col items-start gap-1 px-2 py-1.5 text-row">
              <span>The worktrees didn't load. {worktrees.error.message}</span>
              <button
                type="button"
                className="font-medium text-primary hover:underline"
                onClick={() => void worktrees.refetch()}
              >
                {worktrees.isRefetching ? "Trying again…" : "Try again"}
              </button>
            </div>
          ) : others.length === 0 ? (
            <p className="px-2 py-1.5 text-row text-muted-foreground">
              {running.length === 0
                ? `No worktrees in ${project.name} yet.`
                : `No other worktrees in ${project.name}.`}
            </p>
          ) : (
            <>
              <CommandEmpty>No worktree is on that branch.</CommandEmpty>
              <CommandGroup>
                {others
                  .toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
                  .map((worktree) => {
                    const owner = whose(worktree.changeOwnerUserId);
                    return (
                      <CommandItem
                        key={worktree.id}
                        value={worktree.id}
                        keywords={[worktree.branch, worktree.name]}
                        data-checked={target._tag === "existing" && target.id === worktree.id}
                        onSelect={() =>
                          onPick({ _tag: "existing", id: worktree.id, branch: worktree.branch })
                        }
                        className={itemClass(size)}
                      >
                        <GitBranchIcon aria-hidden className="text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate font-mono">{worktree.branch}</span>
                        <span className="shrink-0 text-meta text-muted-foreground">
                          {[owner, age(worktree.updatedAt, now)]
                            .filter((part) => part !== null)
                            .join(" · ")}
                        </span>
                      </CommandItem>
                    );
                  })}
              </CommandGroup>
            </>
          )}
        </CommandList>
      </Command>
    </div>
  );
}

/** The words on the agent pick: "Claude Code · Opus", or "No agent login" before any login. */
export const agentPickWords = (composer: Composer): string => {
  if (composer.logins._tag === "known" && composer.logins.none) return "No agent login";
  const label = agentOf(composer.agent).label;
  const { picker } = composer;
  return picker.hasModels && picker.model !== null ? `${label} · ${picker.modelLabel}` : label;
};

const loginWord = (composer: Composer, agent: Agent): string | null =>
  composer.logins._tag === "known" ? agentLoginWord(composer.logins.of(agent)) : null;

const LAND_LABEL = "Land when a turn completes";

/** The permission choice's words: the agent stops for your approval before it acts. */
export const ASK_LABEL = "Ask before acting";

/** The agent and model menu on the desktop: Agent, Model, Thinking, then the session's options. */
export function AgentMenuItems({ composer }: { readonly composer: Composer }) {
  const { picker, landing } = composer;
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>Agent</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={composer.agent}
          onValueChange={(value: string) => {
            const agent = COMPOSER_AGENTS.find((id) => id === value);
            if (agent !== undefined) composer.pickAgent(agent);
          }}
        >
          {COMPOSER_AGENTS.map((agent) => (
            <DropdownMenuRadioItem key={agent} value={agent}>
              <span className="flex-1">{agentOf(agent).label}</span>
              <span className="text-meta text-muted-foreground">{loginWord(composer, agent)}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      {picker.hasModels ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Model</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={picker.model ?? ""}
              onValueChange={(value: string) => composer.pickModel(value)}
            >
              {picker.models.map((model) => (
                <DropdownMenuRadioItem key={model.id} value={model.id}>
                  {model.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </>
      ) : null}
      {picker.efforts.length > 1 ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Thinking</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={picker.effort ?? "default"}
              onValueChange={(value: string) =>
                composer.pickEffort(
                  picker.efforts.find((row) => (row.effort ?? "default") === value)?.effort ?? null,
                )
              }
            >
              {picker.efforts.map((row) => (
                <DropdownMenuRadioItem
                  key={row.effort ?? "default"}
                  value={row.effort ?? "default"}
                >
                  {row.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>This session</DropdownMenuLabel>
        {picker.fastCapable ? (
          <DropdownMenuCheckboxItem checked={composer.fast} onCheckedChange={composer.setFast}>
            <span className="flex-1">Fast</span>
            <span className="text-meta text-muted-foreground">Uses more of the plan</span>
          </DropdownMenuCheckboxItem>
        ) : null}
        <DropdownMenuCheckboxItem
          checked={composer.askFirst}
          onCheckedChange={composer.setAskFirst}
        >
          {ASK_LABEL}
        </DropdownMenuCheckboxItem>
        {landing === null ? (
          <DropdownMenuItem disabled>{LAND_LABEL}</DropdownMenuItem>
        ) : landing._tag === "project-off" ? (
          <DropdownMenuItem disabled>
            <span className="flex-1">{LAND_LABEL}</span>
            <span className="text-meta">Off for this project</span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuCheckboxItem checked={landing.land} onCheckedChange={composer.setLand}>
            {LAND_LABEL}
          </DropdownMenuCheckboxItem>
        )}
      </DropdownMenuGroup>
    </>
  );
}

/** One row of a phone sheet: 52px, with a check when it is picked. */
function SheetChoice({
  picked,
  onPick,
  icon,
  meta,
  kind = "radio",
  disabled = false,
  children,
}: {
  readonly picked: boolean;
  readonly onPick: () => void;
  readonly icon?: ReactNode;
  readonly meta?: string | null;
  /** A choice among several, or a switch on its own. */
  readonly kind?: "radio" | "checkbox";
  readonly disabled?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      role={kind === "radio" ? "menuitemradio" : "menuitemcheckbox"}
      aria-checked={picked}
      disabled={disabled}
      onClick={onPick}
      className="flex h-13 w-full items-center gap-3 px-5 text-left text-lead outline-none focus-visible:bg-muted disabled:text-muted-foreground [&_svg]:size-5 [&_svg]:shrink-0"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {meta === undefined || meta === null ? null : (
        <span className="shrink-0 text-muted-foreground">{meta}</span>
      )}
      <CheckIcon aria-hidden className={cn("size-4.5!", !picked && "invisible")} />
    </button>
  );
}

function SheetSection({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="border-b border-border py-2 last:border-b-0">
      <p className="px-5 pt-2 pb-1 text-sm text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

/** The agent and model sheet on the phone: the same choices as the desktop menu. */
export function AgentSheetBody({ composer }: { readonly composer: Composer }) {
  const { picker, landing } = composer;
  return (
    <div role="menu" aria-label="Agent and model" className="min-h-0 overflow-y-auto">
      <SheetSection label="Agent">
        {COMPOSER_AGENTS.map((agent) => (
          <SheetChoice
            key={agent}
            icon={<BotIcon aria-hidden className="text-muted-foreground" />}
            picked={agent === composer.agent}
            meta={loginWord(composer, agent)}
            onPick={() => composer.pickAgent(agent)}
          >
            {agentOf(agent).label}
          </SheetChoice>
        ))}
      </SheetSection>
      {picker.hasModels ? (
        <SheetSection label="Model">
          {picker.models.map((model) => (
            <SheetChoice
              key={model.id}
              picked={model.selected}
              onPick={() => composer.pickModel(model.id)}
            >
              {model.label}
            </SheetChoice>
          ))}
        </SheetSection>
      ) : null}
      {picker.efforts.length > 1 ? (
        <SheetSection label="Thinking">
          {picker.efforts.map((row) => (
            <SheetChoice
              key={row.effort ?? "default"}
              picked={row.selected}
              onPick={() => composer.pickEffort(row.effort)}
            >
              {row.label}
            </SheetChoice>
          ))}
        </SheetSection>
      ) : null}
      <SheetSection label="This session">
        {picker.fastCapable ? (
          <SheetChoice
            kind="checkbox"
            picked={composer.fast}
            meta="Uses more of the plan"
            onPick={() => composer.setFast(!composer.fast)}
          >
            Fast
          </SheetChoice>
        ) : null}
        <SheetChoice
          kind="checkbox"
          picked={composer.askFirst}
          onPick={() => composer.setAskFirst(!composer.askFirst)}
        >
          {ASK_LABEL}
        </SheetChoice>
        {landing === null || landing._tag === "project-off" ? (
          <SheetChoice
            kind="checkbox"
            picked={false}
            disabled
            meta={landing === null ? null : "Off for this project"}
            onPick={() => undefined}
          >
            {LAND_LABEL}
          </SheetChoice>
        ) : (
          <SheetChoice
            kind="checkbox"
            picked={landing.land}
            onPick={() => composer.setLand(!landing.land)}
          >
            {LAND_LABEL}
          </SheetChoice>
        )}
      </SheetSection>
    </div>
  );
}
