import { resourceTableNotices, type ResourceDefinition } from "@mend/domain/workbench";
import { InlineAlert } from "@mend/ui/components/banner";
import { Status } from "@mend/ui/components/status";
import { Button } from "@mend/ui/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@mend/ui/components/ui/empty";
import { Switch } from "@mend/ui/components/ui/switch";
import { toast } from "@mend/ui/components/ui/toast";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseIcon, FileCodeIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import type { ProjectDetailDto } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import { type LoadRequest, runResourceLoad } from "#/lib/resource-load";
import {
  controlResource,
  resourcesQuery,
  type ResourcesPageView,
  type ResourceSettingView,
} from "#/lib/resources";
import { answered, type ItemNote, refusedNote } from "#/lib/resources-card";
import {
  declaredFile,
  engineWords,
  githubFileUrl,
  resourcePanels,
  usingWorktrees,
  worktreeDeclarations,
  type WorktreeRead,
} from "#/lib/resources-model";
import { useTRPC } from "#/lib/trpc";

import {
  AddResource,
  LoadData,
  type LoadTargets,
  RemoveResource,
  type RemovalTarget,
} from "./resource-dialogs.tsx";
import {
  NoteLines,
  type PanelLoad,
  RemovedWords,
  ResourcePanel,
  type ResourceActs,
  StartMenu,
  type StartTarget,
} from "./resource-panel.tsx";

/**
 * Start, Stop and a stop's answer for every panel and row, keyed (`p:db`, `w:db:<worktree>`,
 * `d:search`): one act per key at a time, its answer in the server's lines under what it acted
 * on, and the last Start kept so a start that asks for a restart can be sent again as one.
 */
function useResourceActs(projectId: string): ResourceActs {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
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
      .then((note) => setNotes((current) => answered(current, key, { at: key, note })))
      .finally(() => {
        running.current.delete(key);
        setBusy((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      });
  };
  return {
    busy,
    notes,
    reload: () => void reload(),
    lastStart: (key) => starts.current.get(key),
    start: (key, spec: ResourceDefinition, target, restart = false) => {
      starts.current.set(key, target);
      act(key, async () => {
        const outcome = await controlResource(
          projectId,
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
            lines: [result.statusLine, ...result.worktrees.map((row) => row.name), result.hint],
            reload: false,
            restartLevel: target.level,
          };
        // A start that failed says why on the panel; one that ran needs no line of its own.
        const message = "message" in result ? result.message : null;
        return message === null ? null : { refused: false, lines: [message], reload: false };
      });
    },
    stop: (key, entry) =>
      act(key, async () => {
        const outcome = await controlResource(
          projectId,
          entry,
          entry.worktreeId,
          "stop",
          entry.level,
        );
        if (!outcome.ok) return refusedNote(outcome);
        await reload();
        const result = outcome.result;
        const message = "message" in result ? result.message : null;
        return message === null ? null : { refused: false, lines: [message], reload: false };
      }),
  };
}

/**
 * Loads under way, one per resource: each runs to its end in the background while its panel shows
 * the progress, and the reads are refreshed once it ends. Its last line stays as the panel's note.
 */
function useResourceLoads(onEnded: (name: string, note: ItemNote) => void) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [loads, setLoads] = useState<ReadonlyMap<string, PanelLoad>>(new Map());
  const put = (name: string, load: PanelLoad | null) =>
    setLoads((current) => {
      const next = new Map(current);
      if (load === null) next.delete(name);
      else next.set(name, load);
      return next;
    });
  const start = (request: LoadRequest) => {
    const base = { target: request.target, worktreeId: request.worktreeId };
    put(request.name, {
      ...base,
      progress: { line: "Starting the load…", done: 0, total: null, phase: "receiving" },
    });
    void runResourceLoad(request, (progress) => put(request.name, { ...base, progress }))
      .then((answer) =>
        onEnded(
          request.name,
          answer.phase === "failed"
            ? {
                refused: true,
                lines: [
                  "The load didn't finish, and the database wasn't changed.",
                  answer.statusLine,
                ],
                reload: false,
              }
            : { refused: false, lines: [answer.statusLine], reload: false },
        ),
      )
      .catch((error: unknown) =>
        onEnded(request.name, {
          refused: true,
          lines: [error instanceof Error ? error.message : String(error)],
          reload: false,
        }),
      )
      .finally(() => {
        put(request.name, null);
        void queryClient.invalidateQueries(trpc.resources.pathFilter());
      });
  };
  return { loads, start };
}

/**
 * The Resources tab (Doop "Project · Resources" and its states, ADR 0019): the databases and other
 * services that run beside the project's sessions. What `.mend/mend.toml` declares is shown as the
 * file's, read-only, with a line saying to edit the file in a session; what Mend stores is chosen
 * here: how each worktree uses a project resource (Shared, Own, Off) and whether new worktrees use
 * project resources. Start, Stop, Load data… and Remove… act on the instances.
 */
export function ResourcesTab({ detail }: { readonly detail: ProjectDetailDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const ids = useId();
  const { project, capabilities } = detail;
  const worktrees = detail.worktrees.map((worktree) => ({ id: worktree.id, name: worktree.name }));
  const projectRead = useQuery(resourcesQuery(trpc, project.id, null));
  const worktreeReads = useQueries({
    queries: detail.worktrees.map((worktree) => resourcesQuery(trpc, project.id, worktree.id)),
  });
  const reads: ReadonlyArray<WorktreeRead> = detail.worktrees.map((worktree, index) => {
    const read = worktreeReads[index];
    return {
      id: worktree.id,
      name: worktree.name,
      // A read still on its way shows its rows as "Reading…"; one that failed says so.
      page: read === undefined || read.isPending ? undefined : read.data,
      failed: read === undefined || read.error === null ? null : read.error.message,
    };
  });
  const acts = useResourceActs(project.id);
  const [loadNotes, setLoadNotes] = useState<ReadonlyMap<string, ItemNote>>(new Map());
  const { loads, start: startLoad } = useResourceLoads((name, note) =>
    setLoadNotes((current) => new Map(current).set(name, note)),
  );
  const [adding, setAdding] = useState(false);
  const [loadingInto, setLoadingInto] = useState<string | null>(null);
  const [removing, setRemoving] = useState<RemovalTarget | null>(null);
  const [removed, setRemoved] = useState<ReadonlyMap<string, ReadonlyArray<string>>>(new Map());
  const newWorktrees = useMutation(
    trpc.projects.setNewWorktreesUseProjectResources.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries(trpc.projects.detail.queryFilter({ id: project.id })),
    }),
  );
  const useProjectResources = newWorktrees.isPending
    ? newWorktrees.variables.newWorktreesUseProjectResources
    : project.newWorktreesUseProjectResources;
  const size = phone ? "touch" : "default";

  const dialogs = (page: ResourcesPageView | null) => {
    const panel =
      page === null
        ? undefined
        : resourcePanels(page, reads, project.defaultBranch).find(
            (row) => row.name === loadingInto,
          );
    const targets: LoadTargets = {
      shared:
        panel?.project === undefined
          ? null
          : { users: panel.rows.filter((row) => row.choice === "project").map((row) => row.name) },
      own:
        panel?.rows.flatMap((row) =>
          row.use?.canLoadOwn === true && (row.choice === "worktree" || row.own !== undefined)
            ? [{ id: row.worktreeId, name: row.name }]
            : [],
        ) ?? [],
    };
    return (
      <>
        <AddResource
          projectId={project.id}
          worktrees={worktrees}
          open={adding}
          onOpenChange={setAdding}
        />
        {panel === undefined ? null : (
          <LoadData
            projectId={project.id}
            name={panel.name}
            engine={engineWords(panel.spec)}
            targets={targets}
            open={loadingInto !== null}
            onOpenChange={(open) => {
              if (!open) setLoadingInto(null);
            }}
            onLoad={(request) => {
              setLoadNotes((current) => {
                const next = new Map(current);
                next.delete(request.name);
                return next;
              });
              startLoad(request);
            }}
          />
        )}
        <RemoveResource
          projectId={project.id}
          target={removing}
          onClose={() => setRemoving(null)}
          onRemoved={(target, statusLine) => {
            if (target.worktree === null)
              setRemoved((current) =>
                new Map(current).set(
                  target.entry.spec.name,
                  target.entry.spec.volumes.map((volume) => volume.name),
                ),
              );
            toast.add({ description: statusLine.split("\n")[0] ?? statusLine });
          }}
        />
      </>
    );
  };

  if (projectRead.isPending)
    return (
      <p role="status" className="px-8 pt-6 text-prose text-muted-foreground max-lg:px-4">
        Reading resources…
      </p>
    );
  if (projectRead.isError)
    return (
      <div className="px-8 pt-6 max-lg:px-4">
        <InlineAlert
          size={size}
          title="Resources didn't load."
          actions={
            <Button
              variant="outline"
              size={size}
              disabled={projectRead.isFetching}
              onClick={() => void projectRead.refetch()}
            >
              {projectRead.isFetching ? "Trying again…" : "Try again"}
            </Button>
          }
        >
          {projectRead.error.message}
        </InlineAlert>
      </div>
    );

  const page = projectRead.data;
  const panels = resourcePanels(page, reads, project.defaultBranch);
  const declared = worktreeDeclarations(page, reads);
  const file = page.file;
  const fileName = declaredFile(file) ?? ".mend/mend.toml";
  const openFile =
    file.kind === "read" || file.kind === "unparsed"
      ? githubFileUrl(project.originUrl, project.defaultBranch, fileName)
      : null;
  const notices = [
    ...(file.kind === "read"
      ? resourceTableNotices(file)
      : file.kind === "unparsed" || file.kind === "unavailable"
        ? [file.message]
        : []),
    ...reads.flatMap((read) =>
      read.page?.file.kind === "read"
        ? resourceTableNotices(read.page.file).map((notice) => `${read.name} · ${notice}`)
        : read.page?.file.kind === "unparsed" || read.page?.file.kind === "unavailable"
          ? [`${read.name} · ${read.page.file.message}`]
          : [],
    ),
  ];
  const fileBroken = file.kind === "unparsed" || file.kind === "unavailable";

  if (panels.length === 0 && declared.length === 0 && !fileBroken)
    return (
      <>
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <DatabaseIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>
              <h2>No resources yet</h2>
            </EmptyTitle>
            <EmptyDescription>
              {project.name}'s {fileName} declares no resources. A resource is a database or
              service, such as Postgres, Redis, MySQL or any image, that runs beside your sessions
              and keeps its data between them.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size={size} onClick={() => setAdding(true)}>
              Add a resource…
            </Button>
          </EmptyContent>
        </Empty>
        {dialogs(page)}
      </>
    );

  const declaredLine = (
    <>
      {fileBroken ? (
        <>
          Mend couldn't read <span className="font-mono text-meta">{fileName}</span> on{" "}
          <span className="font-mono text-meta">{project.defaultBranch}</span>.
        </>
      ) : file.kind === "absent" ? (
        <>
          <span className="font-mono text-meta">{project.defaultBranch}</span> has no{" "}
          <span className="font-mono text-meta">.mend/mend.toml</span> yet. What's listed was
          started from a worktree's file.
        </>
      ) : (
        <>
          Declared in <span className="font-mono text-meta">{fileName}</span> on{" "}
          <span className="font-mono text-meta">{project.defaultBranch}</span>. To change{" "}
          {phone ? "one" : "a resource"}, edit that file in a session.
        </>
      )}
    </>
  );

  return (
    <section aria-label="Resources" className="flex flex-1 flex-col lg:px-8 lg:pt-6 lg:pb-12">
      <div className="flex items-end gap-4 border-b pb-4 max-lg:hidden">
        <div className="min-w-0 flex-1">
          <h2 className="text-prose font-semibold">Resources in {project.name}</h2>
          <p className="mt-1 text-prose text-muted-foreground">
            Databases and other services that run beside your sessions and keep their data between
            them.
          </p>
        </div>
        <Button variant="outline" onClick={() => setAdding(true)}>
          Add a resource…
        </Button>
      </div>
      <div className="flex items-start gap-3 border-b py-3 text-prose text-muted-foreground max-lg:px-4">
        <FileCodeIcon aria-hidden className="mt-0.5 size-4 shrink-0 max-lg:hidden" />
        <div className="min-w-0 flex-1">
          <p>{declaredLine}</p>
          {notices.length === 0 ? null : (
            <ul
              aria-label={`What Mend refused or ignored in ${fileName}`}
              className="mt-1.5 flex flex-col gap-0.5"
            >
              {notices.map((line) => (
                <li key={line} className="font-mono text-meta wrap-anywhere text-destructive">
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
        {openFile === null ? null : (
          <a
            href={openFile}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-info outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 max-lg:hidden"
          >
            Open file
          </a>
        )}
      </div>
      <div>
        {panels.map((panel) => (
          <div key={panel.name}>
            <ResourcePanel
              projectId={project.id}
              panel={panel}
              worktrees={worktrees}
              acts={acts}
              load={loads.get(panel.name)}
              removed={panel.project === undefined ? removed.get(panel.name) : undefined}
              onLoadData={() => setLoadingInto(panel.name)}
              onRemove={(entry: ResourceSettingView, worktree) =>
                setRemoving({
                  entry,
                  worktree,
                  using: usingWorktrees(panel),
                  worktrees: detail.worktrees.length,
                })
              }
            />
            <NoteLines note={loadNotes.get(panel.name)} onReload={acts.reload} />
          </div>
        ))}
      </div>
      {declared.length === 0 ? null : (
        <ul
          aria-label="Declared only in a worktree"
          className="flex flex-col gap-2 border-t py-4 max-lg:px-4"
        >
          {declared.map((row) => {
            const key = `d:${row.spec.name}`;
            return (
              <li key={key} className="flex flex-wrap items-center gap-3">
                <span className="min-w-0 flex-1 text-prose text-muted-foreground">
                  <span className="font-mono text-meta">.mend/mend.toml</span> in{" "}
                  <span className="font-mono text-meta text-foreground">{row.worktree}</span>{" "}
                  declares{" "}
                  <span className="font-mono text-meta text-foreground">@{row.spec.name}</span>
                </span>
                {removed.has(row.spec.name) ? (
                  <Status tone="idle" className="text-row">
                    Removed, volumes kept
                  </Status>
                ) : null}
                <StartMenu
                  name={row.spec.name}
                  engine={engineWords(row.spec)}
                  label="Start"
                  worktrees={[{ id: row.worktreeId, name: row.worktree }]}
                  busy={acts.busy.has(key)}
                  onStart={(target) => acts.start(key, row.spec, target)}
                />
                <div className="basis-full empty:hidden">
                  {removed.has(row.spec.name) ? (
                    <RemovedWords name={row.spec.name} volumes={removed.get(row.spec.name) ?? []} />
                  ) : null}
                  <NoteLines note={acts.notes.get(key)} onReload={acts.reload} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {capabilities.manage ? (
        <div className="flex items-center gap-4 border-t py-4 max-lg:px-4">
          <div className="min-w-0 flex-1">
            <label htmlFor={`${ids}-new-worktrees`} className="text-prose text-foreground">
              New worktrees use project resources
            </label>
            <p id={`${ids}-new-worktrees-detail`} className="text-prose text-muted-foreground">
              {phone
                ? "When this is off, a new worktree starts with none."
                : "Until a worktree picks for a resource, it uses the project's instance. When this is off, a new worktree starts with none."}
            </p>
            {newWorktrees.isError ? (
              <p role="alert" className="mt-1 text-row text-destructive">
                That didn't save: {newWorktrees.error.message}
              </p>
            ) : null}
          </div>
          <Switch
            id={`${ids}-new-worktrees`}
            aria-describedby={`${ids}-new-worktrees-detail`}
            checked={useProjectResources}
            disabled={newWorktrees.isPending}
            onCheckedChange={(checked) =>
              newWorktrees.mutate({ id: project.id, newWorktreesUseProjectResources: checked })
            }
          />
        </div>
      ) : null}
      <div className="sticky bottom-0 mt-auto border-t bg-background px-4 pt-3 pb-[max(--spacing(4),env(safe-area-inset-bottom))] lg:hidden">
        <Button size="touch" className="w-full" onClick={() => setAdding(true)}>
          Add a resource…
        </Button>
      </div>
      {dialogs(page)}
    </section>
  );
}
