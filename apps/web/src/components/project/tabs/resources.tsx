import type { WorktreeId } from "@mend/domain";
import {
  resourceTableNotices,
  type ResourceDefinition,
  type ResourceLevel,
  type WorktreeChoice,
} from "@mend/domain/workbench";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";

import { Button, Eyebrow, focusRing } from "#/components/kit/button";
import { Menu, MenuGroup, MenuItem, MenuMeta } from "#/components/kit/menu";
import { Panel } from "#/components/kit/section";
import { Segment } from "#/components/kit/segment";
import { StatusWord } from "#/components/kit/status";
import { SwitchRow } from "#/components/kit/switch";
import { DataTable } from "#/components/kit/table";
import { type ProjectDetailDto } from "#/lib/api";
import { useProjectSetting } from "#/lib/project-settings";
import {
  chooseResource,
  controlResource,
  readerZone,
  removeResourceInstance,
  type ResourcesPageView,
  type ResourceSettingView,
} from "#/lib/resources";
import { answered, refusedNote, type ItemNote } from "#/lib/resources-card";
import { useTRPC, type TrpcProxy } from "#/lib/trpc";

import { LoadDataDialog, type LoadTargets } from "./load-data";
import { AddResourceDialog } from "./resources-add";
import {
  canStart,
  canStop,
  choiceOptions,
  levelLine,
  resourcePanels,
  toneOf,
  withoutName,
  worktreeDeclarations,
  type ResourcePanelModel,
  type WorktreeRead,
  type WorktreeRow,
} from "./resources-model";

/** The reads the tab makes: the project's, and one per worktree for how it uses each resource. */
export const projectResourcesOptions = (
  trpc: TrpcProxy,
  projectId: string,
  worktreeId: WorktreeId | null,
) =>
  trpc.resources.list.queryOptions({
    projectId,
    timeZone: readerZone(),
    worktreeId,
    ...(worktreeId === null ? { allInstances: true } : {}),
  });

/** What one start sends, kept so a refused start can be sent again as a restart. */
interface StartTarget {
  readonly worktreeId: WorktreeId;
  readonly level: ResourceLevel;
}

/** A start, stop or removal answered with the server's lines, under the panel it acted on. */
interface Actions {
  readonly busy: ReadonlySet<string>;
  readonly notes: ReadonlyMap<string, ItemNote>;
  readonly start: (
    key: string,
    spec: ResourceDefinition,
    target: StartTarget,
    restart?: boolean,
  ) => void;
  readonly stop: (key: string, entry: ResourceSettingView) => void;
  readonly remove: (key: string, entry: ResourceSettingView) => void;
  readonly reload: () => void;
  readonly lastStart: (key: string) => StartTarget | undefined;
}

/**
 * The Resources tab (screen K4, ADR 0019): the long-running services the project declares, one
 * panel each. A project resource lists the worktrees and how each uses it (shared, its own, or
 * none); a worktree resource lists the worktrees that run their own. Every status is the server's
 * line of what Sealant observed. Load data… (K5) replaces a Postgres database after saving the
 * previous data as a dump.
 */
export function ProjectResources({ detail }: { readonly detail: ProjectDetailDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { project, capabilities } = detail;
  const worktrees = detail.worktrees;
  const projectRead = useQuery(projectResourcesOptions(trpc, project.id, null));
  const worktreeReads = useQueries({
    queries: worktrees.map((worktree) => projectResourcesOptions(trpc, project.id, worktree.id)),
  });
  const reads: ReadonlyArray<WorktreeRead> = worktrees.map((worktree, index) => {
    const read = worktreeReads[index];
    return {
      id: worktree.id,
      name: worktree.name,
      page: read?.data,
      failed:
        read?.error === null || read?.error === undefined
          ? null
          : read.error instanceof Error
            ? read.error.message
            : String(read.error),
    };
  });

  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [notes, setNotes] = useState<ReadonlyMap<string, ItemNote>>(new Map());
  const running = useRef(new Set<string>());
  const starts = useRef(new Map<string, StartTarget>());
  const reload = () => queryClient.invalidateQueries(trpc.resources.pathFilter());

  const act = (key: string, run: () => Promise<ItemNote | null>) => {
    if (running.current.has(key)) return;
    running.current.add(key);
    setBusy((current) => new Set(current).add(key));
    void run()
      .catch(
        (error: unknown): ItemNote => ({
          refused: true,
          lines: [error instanceof Error ? error.message : String(error)],
          reload: false,
        }),
      )
      .then((note) => {
        setNotes((current) => answered(current, key, { at: key, note }));
        return null;
      })
      .finally(() => {
        running.current.delete(key);
        setBusy((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      });
  };

  const actions: Actions = {
    busy,
    notes,
    reload: () => void reload(),
    lastStart: (key) => starts.current.get(key),
    start: (key, spec, target, restart = false) => {
      starts.current.set(key, target);
      act(key, async () => {
        const outcome = await controlResource(
          project.id,
          { spec },
          target.worktreeId,
          "start",
          target.level,
          restart,
        );
        if (!outcome.ok) return refusedNote(outcome);
        await reload();
        const result = outcome.result;
        if ("kind" in result && result.kind === "needs-restart")
          return {
            refused: true,
            lines: [
              result.statusLine,
              ...result.worktrees.map((worktree) => worktree.name),
              result.hint,
            ],
            reload: false,
            restartLevel: target.level,
          };
        return {
          refused: false,
          lines: [
            result.statusLine,
            ...("message" in result && result.message !== null ? [result.message] : []),
          ],
          reload: false,
        };
      });
    },
    stop: (key, entry) =>
      act(key, async () => {
        const outcome = await controlResource(
          project.id,
          entry,
          entry.worktreeId,
          "stop",
          entry.level,
        );
        if (!outcome.ok) return refusedNote(outcome);
        await reload();
        return { refused: false, lines: [outcome.result.statusLine], reload: false };
      }),
    remove: (key, entry) =>
      act(key, async () => {
        const outcome = await removeResourceInstance(project.id, entry, entry.worktreeId);
        if (!outcome.ok) return refusedNote(outcome);
        await reload();
        return { refused: false, lines: [outcome.result.statusLine], reload: false };
      }),
  };

  const newWorktrees = useProjectSetting(project.id, "newWorktreesUseProjectResources");

  if (projectRead.isPending)
    return (
      <p role="status" className="font-mono text-[12px] text-faint">
        Reading resources…
      </p>
    );
  if (projectRead.isError)
    return (
      <p role="alert" className="font-mono text-[12px] text-danger">
        Resources did not load: {projectRead.error.message}{" "}
        <button
          type="button"
          onClick={() => void projectRead.refetch()}
          className={cn("text-info underline-offset-2 hover:underline", focusRing)}
        >
          Try again
        </button>
      </p>
    );

  const page = projectRead.data;
  const panels = resourcePanels(page, reads);
  const declared = worktreeDeclarations(page, reads);

  return (
    <div className="grid gap-3">
      {panels.length === 0 ? (
        <Panel className="px-[22px] py-[18px]">
          <p className="text-[13.5px] text-muted-foreground">
            No resources yet. A project declares them in{" "}
            <span className="font-mono text-[12px]">.mend/mend.toml</span>: Postgres, Redis or any
            image, each written with its @ (<span className="font-mono text-[12px]">@db</span>).
          </p>
        </Panel>
      ) : (
        panels.map((panel) => (
          <ResourcePanel
            key={panel.name}
            projectId={project.id}
            panel={panel}
            worktrees={worktrees}
            actions={actions}
          />
        ))
      )}
      <FileNotices page={page} reads={reads} />
      {capabilities.manage ? (
        <Panel className="px-[22px] py-1.5">
          <SwitchRow
            label="New worktrees use project resources"
            detail="Until a worktree picks for a resource, it uses the project's instance. Off, it starts with none."
            checked={project.newWorktreesUseProjectResources}
            pending={newWorktrees.isPending}
            onCheckedChange={(value) => newWorktrees.mutate(value)}
          />
          <p role="alert" className="pb-2 font-mono text-[11.5px] text-danger empty:hidden">
            {newWorktrees.isError ? `That did not save: ${newWorktrees.error.message}` : ""}
          </p>
        </Panel>
      ) : null}
      <div className="flex flex-wrap items-start gap-2">
        <AddResourceDialog projectId={project.id} worktrees={worktrees} />
        <span className="flex-1" />
        <div className="grid justify-items-end gap-1.5">
          {declared.map((row) => {
            const key = `d:${row.spec.name}`;
            return (
              <div key={key} className="flex items-center gap-2">
                <span className="font-mono text-[12px] text-muted-foreground">
                  mend.toml in {row.worktree} declares @{row.spec.name}
                </span>
                <StartMenu
                  label={`Start @${row.spec.name}`}
                  worktrees={[{ id: row.worktreeId, name: row.worktree }]}
                  disabled={busy.has(key)}
                  onStart={(target) => actions.start(key, row.spec, target)}
                />
                <ItemNoteLines note={notes.get(key)} onReload={actions.reload} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The default branch's file as read, and any keys a worktree's file refused or ignores. */
function FileNotices({
  page,
  reads,
}: {
  readonly page: ResourcesPageView;
  readonly reads: ReadonlyArray<WorktreeRead>;
}) {
  const file = page.file;
  const worktreeNotices = reads.flatMap((read) =>
    read.page?.file.kind === "read"
      ? resourceTableNotices(read.page.file).map((notice) => `${read.name} · ${notice}`)
      : read.page?.file.kind === "unparsed" || read.page?.file.kind === "unavailable"
        ? [`${read.name} · ${read.page.file.message}`]
        : [],
  );
  const lines =
    file.kind === "read"
      ? resourceTableNotices(file)
      : file.kind === "unparsed" || file.kind === "unavailable"
        ? [file.message]
        : [];
  if (lines.length === 0 && worktreeNotices.length === 0 && file.kind !== "read") return null;
  return (
    <div className="grid gap-1 px-1">
      {file.kind === "read" || file.kind === "absent" || file.kind === "unparsed" ? (
        <Eyebrow>Default branch · {file.observed}</Eyebrow>
      ) : null}
      {[...lines, ...worktreeNotices].map((line) => (
        <p key={line} className="font-mono text-[11.5px] text-ink-2">
          {line}
        </p>
      ))}
    </div>
  );
}

function ResourcePanel({
  projectId,
  panel,
  worktrees,
  actions,
}: {
  readonly projectId: string;
  readonly panel: ResourcePanelModel;
  readonly worktrees: ProjectDetailDto["worktrees"];
  readonly actions: Actions;
}) {
  const [loadOpen, setLoadOpen] = useState(false);
  const key = `p:${panel.name}`;
  const project = panel.project;
  const restart = actions.notes.get(key)?.restartLevel;
  const last = actions.lastStart(key);
  const postgres = panel.spec.preset === "postgres";
  const targets: LoadTargets = {
    shared: project !== undefined,
    own: panel.rows.flatMap((row) =>
      row.use?.canLoadOwn === true && (row.choice === "worktree" || row.own !== undefined)
        ? [{ id: row.worktreeId, name: row.name }]
        : [],
    ),
  };

  return (
    <Panel className="px-[22px] py-[18px]">
      <section aria-label={`@${panel.name}`}>
        <div className="flex flex-wrap items-center gap-2.5">
          <h3 className="font-sans text-[15px] font-semibold">@{panel.name}</h3>
          <span className="font-mono text-[12px] text-muted-foreground">{panel.kindLine}</span>
          <span className="flex-1" />
          <StatusWord tone={panel.tone} className="max-w-[420px]">
            <span title={panel.statusLine}>{panel.statusLine}</span>
          </StatusWord>
          {project !== undefined && canStop(project) ? (
            <Button
              size="sm"
              disabled={actions.busy.has(key)}
              onClick={() => actions.stop(key, project)}
            >
              {actions.busy.has(key) ? "Stopping…" : "Stop"}
            </Button>
          ) : canStart(project) ? (
            <StartMenu
              label={`Start @${panel.name}`}
              worktrees={worktrees}
              disabled={actions.busy.has(key)}
              onStart={(target) => actions.start(key, panel.spec, target)}
            />
          ) : null}
          {restart !== undefined && last !== undefined ? (
            <Button
              size="sm"
              disabled={actions.busy.has(key)}
              onClick={() => actions.start(key, panel.spec, last, true)}
            >
              Restart with this definition
            </Button>
          ) : null}
          {postgres ? (
            <Button size="sm" onClick={() => setLoadOpen(true)}>
              Load data…
            </Button>
          ) : null}
          {project?.canRemove === true ? (
            <RemoveButton
              label={`Remove the project's @${panel.name}`}
              busy={actions.busy.has(key)}
              onRemove={() => actions.remove(key, project)}
            />
          ) : null}
        </div>
        <ItemNoteLines note={actions.notes.get(key)} onReload={actions.reload} />
        {panel.project === undefined && panel.worktreeInstances.length === 0 ? null : (
          <p className="mt-2.5 mb-3 text-[13px] text-muted-foreground">{levelLine(panel)}</p>
        )}
        {panel.rows.length === 0 ? null : (
          <WorktreeTable projectId={projectId} panel={panel} actions={actions} />
        )}
      </section>
      {loadOpen ? (
        <LoadDataDialog
          projectId={projectId}
          name={panel.name}
          targets={targets}
          open={loadOpen}
          onOpenChange={setLoadOpen}
        />
      ) : null}
    </Panel>
  );
}

function WorktreeTable({
  projectId,
  panel,
  actions,
}: {
  readonly projectId: string;
  readonly panel: ResourcePanelModel;
  readonly actions: Actions;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [refusal, setRefusal] = useState<{
    readonly name: string;
    readonly lines: ReadonlyArray<string>;
  } | null>(null);
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
    // The worktree's read shows the new choice at once and goes back if the server refuses it.
    onMutate: async ({ row, mode }) => {
      setRefusal(null);
      const queryKey = projectResourcesOptions(trpc, projectId, row.worktreeId).queryKey;
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
      setRefusal({
        name: row.name,
        lines: error.message.split("\n").filter((line) => line !== ""),
      });
    },
    onSettled: () => queryClient.invalidateQueries(trpc.resources.pathFilter()),
  });
  const pendingFor = choose.isPending ? choose.variables.row.worktreeId : null;

  const columns = panel.choosing
    ? [
        { head: "Worktree", width: "1fr" },
        { head: "Uses", width: "230px" },
        { head: "Status", width: "1fr", align: "end" as const },
        { head: "", width: "auto" },
      ]
    : [
        { head: "Worktree", width: "1fr" },
        { head: "Status", width: "1.2fr", align: "end" as const },
        { head: "", width: "auto" },
      ];

  return (
    <>
      <DataTable
        label={`Worktrees using @${panel.name}`}
        className="-mx-1"
        columns={columns}
        rows={panel.rows.map((row) => {
          const ownKey = `w:${panel.name}:${row.worktreeId}`;
          const statusLine =
            row.failed !== null
              ? `not read · ${row.failed}`
              : row.use === undefined
                ? "reading…"
                : row.choice === "off"
                  ? "off"
                  : withoutName((row.own ?? row.use).statusLine, panel.name);
          const tone =
            row.failed !== null
              ? "bad"
              : row.choice === "off"
                ? "off"
                : toneOf((row.own ?? row.use)?.instance ?? "none");
          // The row says what the worktree uses; the server's whole line stays on hover.
          const postgres = panel.spec.preset === "postgres";
          const rowWords =
            row.failed !== null || row.use === undefined
              ? statusLine
              : row.choice === "off"
                ? postgres
                  ? "no database"
                  : "off"
                : row.choice === "worktree"
                  ? postgres
                    ? "its own database"
                    : `its own @${panel.name}`
                  : postgres
                    ? "the shared database"
                    : `the project's @${panel.name}`;
          const status = (
            <StatusWord tone={tone} className="max-w-full justify-end">
              <span title={statusLine}>
                {tone === "bad" ? `${rowWords} · not running` : rowWords}
              </span>
            </StatusWord>
          );
          const own = row.own;
          const rowActions = (
            <span className="flex items-center justify-end gap-1">
              {own !== undefined && canStop(own) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={actions.busy.has(ownKey)}
                  onClick={() => actions.stop(ownKey, own)}
                >
                  Stop
                </Button>
              ) : own !== undefined && canStart(own) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={actions.busy.has(ownKey)}
                  onClick={() =>
                    actions.start(ownKey, panel.spec, {
                      worktreeId: row.worktreeId,
                      level: "worktree",
                    })
                  }
                >
                  Start
                </Button>
              ) : null}
              {own?.canRemove === true ? (
                <RemoveButton
                  label={`Remove ${row.name}'s @${panel.name}`}
                  busy={actions.busy.has(ownKey)}
                  onRemove={() => actions.remove(ownKey, own)}
                />
              ) : null}
            </span>
          );
          const name = (
            <span className="grid gap-0.5">
              <span className="truncate font-mono text-[12px] text-ink-2">{row.name}</span>
              <ItemNoteLines note={actions.notes.get(ownKey)} onReload={actions.reload} />
            </span>
          );
          return {
            key: row.worktreeId,
            cells: panel.choosing
              ? [
                  name,
                  <Segment
                    key="uses"
                    label={`How ${row.name} uses @${panel.name}`}
                    value={row.choice}
                    options={choiceOptions(panel.spec)}
                    disabled={row.use?.canChoose !== true || pendingFor === row.worktreeId}
                    onChange={(mode) => choose.mutate({ row, mode })}
                  />,
                  status,
                  rowActions,
                ]
              : [name, status, rowActions],
          };
        })}
      />
      <div role="alert" className="mt-2 empty:hidden">
        {refusal === null
          ? null
          : refusal.lines.map((line) => (
              <p key={line} className="font-mono text-[11.5px] text-danger">
                {refusal.name} · {line}
              </p>
            ))}
      </div>
    </>
  );
}

/** Start reads the definition in a worktree, as a project resource or as that worktree's own. */
function StartMenu({
  label,
  worktrees,
  disabled,
  onStart,
}: {
  readonly label: string;
  readonly worktrees: ReadonlyArray<{ readonly id: WorktreeId; readonly name: string }>;
  readonly disabled: boolean;
  readonly onStart: (target: StartTarget) => void;
}) {
  if (worktrees.length === 0)
    return (
      <Button
        size="sm"
        disabled
        title="Start reads the definition in a worktree; this project has none"
      >
        Start
      </Button>
    );
  return (
    <Menu
      align="end"
      width={300}
      trigger={
        <Button size="sm" disabled={disabled} aria-label={label}>
          {disabled ? "Starting…" : "Start"}
        </Button>
      }
    >
      <MenuGroup label="As the project resource, from">
        {worktrees.map((worktree) => (
          <MenuItem
            key={`project:${worktree.id}`}
            onClick={() => onStart({ worktreeId: worktree.id, level: "project" })}
          >
            <span className="min-w-0 truncate font-mono text-[12.5px]">{worktree.name}</span>
            <MenuMeta>project</MenuMeta>
          </MenuItem>
        ))}
      </MenuGroup>
      <MenuGroup label="As a worktree resource, in">
        {worktrees.map((worktree) => (
          <MenuItem
            key={`worktree:${worktree.id}`}
            onClick={() => onStart({ worktreeId: worktree.id, level: "worktree" })}
          >
            <span className="min-w-0 truncate font-mono text-[12.5px]">{worktree.name}</span>
            <MenuMeta>worktree</MenuMeta>
          </MenuItem>
        ))}
      </MenuGroup>
    </Menu>
  );
}

/** Removal archives the instance and keeps its volumes; it asks once more before it goes. */
function RemoveButton({
  label,
  busy,
  onRemove,
}: {
  readonly label: string;
  readonly busy: boolean;
  readonly onRemove: () => void;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={armed ? `${label}: press again to remove; its volumes are kept` : label}
      disabled={busy}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onRemove();
      }}
      className={armed ? "text-danger" : undefined}
    >
      {busy ? "Removing…" : armed ? "Remove? Volumes are kept" : "Remove"}
    </Button>
  );
}

/** An act's answer in the server's words; a refusal is announced, a stale read offers a reload. */
function ItemNoteLines({
  note,
  onReload,
}: {
  readonly note: ItemNote | undefined;
  readonly onReload: () => void;
}): ReactNode {
  if (note === undefined) return null;
  return (
    <div role={note.refused ? "alert" : "status"} className="mt-1.5 grid gap-0.5">
      {note.lines.map((line) => (
        <p
          key={line}
          className={cn(
            "font-mono text-[11.5px] break-words",
            note.refused ? "text-danger" : "text-ink-2",
          )}
        >
          {line}
        </p>
      ))}
      {note.reload ? (
        <button
          type="button"
          onClick={onReload}
          className={cn(
            "w-fit font-mono text-[11.5px] text-info underline-offset-2 hover:underline",
            focusRing,
          )}
        >
          Read it again
        </button>
      ) : null}
    </div>
  );
}
