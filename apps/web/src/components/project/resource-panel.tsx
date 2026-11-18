import type { WorktreeId } from "@mend/domain";
import type { ResourceDefinition, ResourceLevel, WorktreeChoice } from "@mend/domain/workbench";
import { InlineAlert } from "@mend/ui/components/banner";
import { Segmented } from "@mend/ui/components/segmented";
import { Status } from "@mend/ui/components/status";
import { Button } from "@mend/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { Progress } from "@mend/ui/components/ui/progress";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@mend/ui/components/ui/sheet";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GitBranchIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { usePhone } from "#/lib/phone";
import { type LoadProgress, showsBar } from "#/lib/resource-load";
import { chooseResource, resourcesQuery, type ResourceSettingView } from "#/lib/resources";
import type { ItemNote } from "#/lib/resources-card";
import {
  canStart,
  canStop,
  choiceOptions,
  engineWords,
  levelLine,
  panelWord,
  type ResourcePanelModel,
  rowTone,
  rowWords,
  withoutName,
  type WorktreeRow,
} from "#/lib/resources-model";
import { useTRPC } from "#/lib/trpc";

import { SheetHandle, SheetItem } from "../sheet-item.tsx";
import type { WorktreeName } from "./resource-dialogs.tsx";

/** What one Start sends: the worktree whose file it reads, and the level it starts at. */
export interface StartTarget {
  readonly worktreeId: WorktreeId;
  readonly level: ResourceLevel;
}

/** Start, Stop and Remove, answered with the server's lines under what they acted on. */
export interface ResourceActs {
  readonly busy: ReadonlySet<string>;
  readonly notes: ReadonlyMap<string, ItemNote>;
  readonly start: (
    key: string,
    spec: ResourceDefinition,
    target: StartTarget,
    restart?: boolean,
  ) => void;
  readonly stop: (key: string, entry: ResourceSettingView) => void;
  readonly reload: () => void;
  readonly lastStart: (key: string) => StartTarget | undefined;
}

/** A load under way or just finished on one resource. */
export interface PanelLoad {
  readonly target: "shared" | "own";
  readonly worktreeId: WorktreeId | null;
  readonly progress: LoadProgress | null;
}

/**
 * One resource (Doop "Project · Resources"): `@db`, what it is and at which level, what was
 * observed of it, Start or Stop, Load data… for Postgres and Remove…; then each worktree with how
 * it uses it. A failed start says why in the server's words; a load shows its progress here.
 */
export function ResourcePanel({
  projectId,
  panel,
  worktrees,
  acts,
  load,
  removed,
  onLoadData,
  onRemove,
}: {
  readonly projectId: string;
  readonly panel: ResourcePanelModel;
  readonly worktrees: ReadonlyArray<WorktreeName>;
  readonly acts: ResourceActs;
  readonly load: PanelLoad | undefined;
  /** The volumes Mend kept when this resource's project instance was just removed. */
  readonly removed: ReadonlyArray<string> | undefined;
  readonly onLoadData: () => void;
  readonly onRemove: (entry: ResourceSettingView, worktree: string | null) => void;
}) {
  const phone = usePhone();
  const key = `p:${panel.name}`;
  const project = panel.project;
  const busy = acts.busy.has(key);
  const note = acts.notes.get(key);
  const last = acts.lastStart(key);
  const postgres = panel.spec.preset === "postgres";
  const loading =
    load?.progress !== null &&
    load?.progress !== undefined &&
    load.progress.phase !== "done" &&
    load.progress.phase !== "failed";
  const failed = project?.instance === "failed";
  const size = phone ? "touch" : "sm";
  const start = (label: string, variant: "outline" | "ghost" = "outline") => (
    <StartMenu
      name={panel.name}
      engine={engineWords(panel.spec)}
      label={label}
      worktrees={worktrees}
      busy={busy}
      variant={variant}
      onStart={(target) => acts.start(key, panel.spec, target)}
    />
  );
  const word = loading
    ? "Loading data"
    : removed !== undefined && project === undefined
      ? "Removed, volumes kept"
      : panelWord(panel);
  const tone = loading ? "run" : (panel.tone ?? "idle");

  const controls = (
    <>
      {postgres && project !== undefined && !failed ? (
        <Button variant="outline" size={size} disabled={loading} onClick={onLoadData}>
          Load data…
        </Button>
      ) : null}
      {project !== undefined && canStop(project) && !failed ? (
        <Button
          variant="ghost"
          size={size}
          disabled={busy || loading}
          onClick={() => acts.stop(key, project)}
        >
          {busy ? "Stopping…" : "Stop"}
        </Button>
      ) : !failed && canStart(project) ? (
        start(phone ? "Start…" : "Start")
      ) : null}
      {note?.restartLevel !== undefined && last !== undefined ? (
        <Button
          variant="outline"
          size={size}
          disabled={busy}
          onClick={() => acts.start(key, panel.spec, last, true)}
        >
          Restart with this definition
        </Button>
      ) : null}
      {project?.canRemove === true && !loading ? (
        <Button variant="ghost" size={size} disabled={busy} onClick={() => onRemove(project, null)}>
          Remove…
        </Button>
      ) : null}
    </>
  );

  return (
    <section
      aria-label={`@${panel.name}`}
      className="border-b py-5 last:border-b-0 max-lg:px-4 lg:py-6"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="font-mono text-lead font-semibold">@{panel.name}</h3>
        <span className="font-mono text-meta text-muted-foreground max-lg:order-last max-lg:basis-full">
          {panel.kindLine}
        </span>
        <span className="flex-1" />
        <Status tone={tone} title={panel.statusLine} className="text-row">
          {word}
          <span className="sr-only"> · {panel.statusLine}</span>
        </Status>
        <div className="flex items-center gap-1.5 max-lg:hidden">{controls}</div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 empty:hidden lg:hidden">
        {controls}
      </div>
      <NoteLines note={note} onReload={acts.reload} />
      {failed ? (
        <InlineAlert
          className="mt-3 max-w-2xl"
          size={phone ? "touch" : "default"}
          title={`@${panel.name} didn't start.`}
          actions={start(`Start @${panel.name} again`)}
        >
          {withoutName(panel.statusLine, panel.name).replace(/^failed · /, "")}
        </InlineAlert>
      ) : null}
      {loading && load?.progress !== null && load?.progress !== undefined ? (
        <div role="status" className="mt-3 flex max-w-xl flex-col gap-2">
          <p className="text-prose text-muted-foreground">
            {withoutName(load.progress.line, panel.name)}
          </p>
          {showsBar(load.progress) && load.progress.total !== null ? (
            <Progress
              aria-label={`@${panel.name} load progress`}
              value={Math.min(load.progress.done, load.progress.total)}
              max={load.progress.total}
            />
          ) : null}
        </div>
      ) : removed !== undefined && project === undefined ? (
        <p className="mt-2 text-prose text-muted-foreground">
          {removed.length === 0 ? (
            "Mend kept its data volumes."
          ) : (
            <>
              Mend kept <span className="font-mono text-meta">{removed.join(", ")}</span>.
            </>
          )}{" "}
          Until someone starts @{panel.name} again, no worktree has it.
        </p>
      ) : panel.project === undefined && panel.worktreeInstances.length === 0 ? null : (
        <p className="mt-2 text-prose text-muted-foreground">{levelLine(panel)}</p>
      )}
      {panel.rows.length === 0 ? null : (
        <WorktreeUses
          projectId={projectId}
          panel={panel}
          acts={acts}
          load={loading ? load : undefined}
          onRemove={onRemove}
        />
      )}
    </section>
  );
}

/** How every worktree uses the resource: a table on a wide screen, a list on a phone. */
function WorktreeUses({
  projectId,
  panel,
  acts,
  load,
  onRemove,
}: {
  readonly projectId: string;
  readonly panel: ResourcePanelModel;
  readonly acts: ResourceActs;
  readonly load: PanelLoad | undefined;
  readonly onRemove: (entry: ResourceSettingView, worktree: string | null) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const [refusal, setRefusal] = useState<{
    readonly name: string;
    readonly message: string;
  } | null>(null);
  // A choice shows at once in the worktree's read, and goes back if the server refuses it.
  const choose = useMutation({
    mutationFn: async ({
      row,
      mode,
    }: {
      readonly row: WorktreeRow;
      readonly mode: WorktreeChoice;
    }) => {
      const outcome = await chooseResource(projectId, row.worktreeId, panel.name, mode);
      if (!outcome.ok) throw new Error(outcome.message);
      return outcome.result;
    },
    onMutate: async ({ row, mode }) => {
      setRefusal(null);
      const { queryKey } = resourcesQuery(trpc, projectId, row.worktreeId);
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      if (previous !== undefined)
        queryClient.setQueryData(queryKey, {
          ...previous,
          settings: previous.settings.map((entry) =>
            entry.spec.name === panel.name ? { ...entry, choice: mode } : entry,
          ),
        });
      return { queryKey, previous };
    },
    onError: (error, { row }, context) => {
      if (context?.previous !== undefined)
        queryClient.setQueryData(context.queryKey, context.previous);
      setRefusal({ name: row.name, message: error.message });
    },
    onSettled: () => queryClient.invalidateQueries(trpc.resources.pathFilter()),
  });
  const pendingFor = choose.isPending ? choose.variables.row.worktreeId : null;
  const loadingInto = (row: WorktreeRow) =>
    load === undefined
      ? null
      : load.target === "shared" || load.worktreeId === row.worktreeId
        ? load.target
        : null;

  const segment = (row: WorktreeRow) => (
    <Segmented
      aria-label={`How ${row.name} uses @${panel.name}`}
      size={phone ? "touch" : "default"}
      value={row.choice}
      disabled={row.use?.canChoose !== true || pendingFor === row.worktreeId}
      options={choiceOptions(panel.spec)}
      onValueChange={(mode) => choose.mutate({ row, mode })}
    />
  );
  const ownActions = (row: WorktreeRow) => {
    const own = row.own;
    if (own === undefined) return null;
    const ownKey = `w:${panel.name}:${row.worktreeId}`;
    const busy = acts.busy.has(ownKey);
    const size = phone ? "touch" : "sm";
    return (
      <span className="flex items-center justify-end gap-1">
        {canStop(own) ? (
          <Button
            variant="ghost"
            size={size}
            disabled={busy}
            onClick={() => acts.stop(ownKey, own)}
          >
            {busy ? "Stopping…" : "Stop"}
          </Button>
        ) : canStart(own) ? (
          <Button
            variant="ghost"
            size={size}
            disabled={busy}
            onClick={() =>
              acts.start(ownKey, panel.spec, { worktreeId: row.worktreeId, level: "worktree" })
            }
          >
            {busy ? "Starting…" : "Start"}
          </Button>
        ) : null}
        {own.canRemove ? (
          <Button
            variant="ghost"
            size={size}
            disabled={busy}
            onClick={() => onRemove(own, row.name)}
          >
            Remove…
          </Button>
        ) : null}
      </span>
    );
  };
  const words = (row: WorktreeRow) => (
    <Status tone={rowTone(row)} title={(row.own ?? row.use)?.statusLine} className="text-prose">
      {rowWords(row, panel, loadingInto(row))}
    </Status>
  );

  return (
    <>
      <table
        aria-label={`Worktrees using @${panel.name}`}
        className="mt-3 w-full text-prose max-lg:hidden"
      >
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th scope="col" className="h-9 w-[30%] font-normal">
              Worktree
            </th>
            {panel.choosing ? (
              <th scope="col" className="w-[25%] font-normal">
                Uses
              </th>
            ) : null}
            <th scope="col" className="font-normal">
              Status
            </th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {panel.rows.map((row) => (
            <tr key={row.worktreeId} className="border-b last:border-b-0">
              <td className="py-2 pr-3 align-middle">
                <span className="block truncate font-mono text-meta text-foreground">
                  {row.name}
                </span>
                <NoteLines
                  note={acts.notes.get(`w:${panel.name}:${row.worktreeId}`)}
                  onReload={acts.reload}
                />
              </td>
              {panel.choosing ? <td className="py-2 pr-3 align-middle">{segment(row)}</td> : null}
              <td className="py-2 pr-3 align-middle">{words(row)}</td>
              <td className="py-2 text-right align-middle">{ownActions(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul
        aria-label={`Worktrees using @${panel.name}`}
        className="mt-3 divide-y border-t lg:hidden"
      >
        {panel.rows.map((row) => (
          <li key={row.worktreeId} className="flex flex-col gap-2 py-3">
            <div className="flex min-h-11 items-center gap-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-meta text-foreground">
                  {row.name}
                </span>
                {panel.choosing ? (
                  <span className="block text-row text-muted-foreground">
                    {rowWords(row, panel, loadingInto(row))}
                  </span>
                ) : null}
              </span>
              {panel.choosing ? segment(row) : words(row)}
            </div>
            {ownActions(row)}
            <NoteLines
              note={acts.notes.get(`w:${panel.name}:${row.worktreeId}`)}
              onReload={acts.reload}
            />
          </li>
        ))}
      </ul>
      <div role="alert" className="empty:hidden">
        {refusal === null ? null : (
          <InlineAlert
            className="mt-3"
            size={phone ? "touch" : "default"}
            title={`${refusal.name} kept its choice.`}
          >
            {refusal.message}
          </InlineAlert>
        )}
      </div>
    </>
  );
}

/**
 * Start (Doop "removed, start menu"; on a phone "removed, start sheet"): Start reads the definition
 * in a worktree, as the project's resource or as that worktree's own.
 */
export function StartMenu({
  name,
  engine,
  label,
  worktrees,
  busy,
  variant = "outline",
  onStart,
}: {
  readonly name: string;
  readonly engine: string;
  readonly label: string;
  readonly worktrees: ReadonlyArray<WorktreeName>;
  readonly busy: boolean;
  readonly variant?: "outline" | "ghost";
  readonly onStart: (target: StartTarget) => void;
}) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const size = phone ? "touch" : "sm";
  const words = busy ? "Starting…" : label;
  if (worktrees.length === 0)
    return (
      <Button
        variant={variant}
        size={size}
        disabled
        title="Start reads the definition in a worktree; this project has none yet"
      >
        {label}
      </Button>
    );
  const groups: ReadonlyArray<{
    readonly level: ResourceLevel;
    readonly title: string;
    readonly meta: string;
  }> = [
    { level: "project", title: "As the project's resource, from", meta: "Project" },
    { level: "worktree", title: "As a worktree's own resource, in", meta: "Worktree" },
  ];
  if (phone)
    return (
      <>
        <Button
          variant={variant}
          size={size}
          disabled={busy}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          {words}
        </Button>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            side="bottom"
            className="max-h-[85dvh] gap-0 rounded-t-pop-touch pb-[env(safe-area-inset-bottom)]"
          >
            <SheetHandle />
            <SheetHeader className="border-b border-border py-2.5 pr-12 pl-5">
              <SheetTitle className="text-title font-semibold">Start @{name}</SheetTitle>
              <p className="text-prose text-muted-foreground">{engine}</p>
            </SheetHeader>
            <div className="overflow-y-auto py-1">
              {groups.map((group, index) => (
                <div
                  key={group.level}
                  role="group"
                  aria-label={group.title}
                  className={cn(index > 0 && "border-t")}
                >
                  <p className="px-5 pt-3 pb-1 text-prose text-muted-foreground">{group.title}</p>
                  {worktrees.map((worktree) => (
                    <SheetItem
                      key={`${group.level}:${worktree.id}`}
                      onClick={() => {
                        setOpen(false);
                        onStart({ worktreeId: worktree.id, level: group.level });
                      }}
                      icon={<GitBranchIcon aria-hidden />}
                      value={group.meta}
                    >
                      {worktree.name}
                    </SheetItem>
                  ))}
                </div>
              ))}
            </div>
          </SheetContent>
        </Sheet>
      </>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant={variant}
            size={size}
            disabled={busy}
            aria-label={label === "Start" ? `Start @${name}` : label}
          >
            {words}
          </Button>
        }
      />
      <DropdownMenuContent align="end" width="lg">
        {groups.map((group, index) => (
          <DropdownMenuGroup key={group.level}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel>{group.title}</DropdownMenuLabel>
            {worktrees.map((worktree) => (
              <DropdownMenuItem
                key={`${group.level}:${worktree.id}`}
                onClick={() => onStart({ worktreeId: worktree.id, level: group.level })}
              >
                <GitBranchIcon aria-hidden className="text-muted-foreground" />
                <SheetItemText>{worktree.name}</SheetItemText>
                <span className="text-meta text-muted-foreground">{group.meta.toLowerCase()}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SheetItemText({ children }: { readonly children: ReactNode }) {
  return <span className="min-w-0 flex-1 truncate">{children}</span>;
}

/** An act's answer in the server's words; a refusal is announced, a stale read offers a reload. */
export function NoteLines({
  note,
  onReload,
}: {
  readonly note: ItemNote | undefined;
  readonly onReload: () => void;
}): ReactNode {
  if (note === undefined) return null;
  return (
    <div role={note.refused ? "alert" : "status"} className="mt-1.5 flex flex-col gap-0.5">
      {note.lines.map((line) => (
        <p
          key={line}
          className={cn(
            "font-mono text-meta wrap-anywhere",
            note.refused ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {line}
        </p>
      ))}
      {note.reload ? (
        <Button variant="link" size="sm" className="h-auto w-fit p-0" onClick={onReload}>
          Read it again
        </Button>
      ) : null}
    </div>
  );
}
