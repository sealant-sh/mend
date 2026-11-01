import type { WorktreeId } from "@mend/domain";
import {
  choicesFor,
  type ResourceLevel,
  type WorktreeChoice,
  resourceControls,
  resourceTableNotices,
} from "@mend/domain/workbench";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";

import {
  choiceInUse,
  choiceWords,
  chooseResource,
  controlResource,
  readerZone,
  removeResourceInstance,
  type ResourceFileTableView,
  type ResourcesPageView,
  type ResourceSettingView,
} from "#/lib/resources";
import {
  answered,
  type ItemNote,
  refusedNote,
  resourcesRead,
  settleChoice,
} from "#/lib/resources-card";
import { useTRPC } from "#/lib/trpc";

import { ResourceLoadForm } from "./resource-load-form";

/** An item has at most one operation in progress. */
export type Busy = ReadonlyMap<string, string>;
const quiet =
  "shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50";
/** Shared choice control used by the Resources page and composer. */
export const choiceToggle = (on: boolean): string =>
  `rounded-lg border px-2 py-1 font-mono text-[11px] transition-colors disabled:opacity-50 ${on ? "border-border bg-wash text-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground"}`;
/** The Resources page reads definitions and remembered instances, with explicit starts. */
export function ResourcesSection({ projectId }: { readonly projectId: string }) {
  return <ProjectResources key={projectId} projectId={projectId} />;
}
function ProjectResources({ projectId }: { readonly projectId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [worktreeId, setWorktreeId] = useState<WorktreeId | null>(null);
  const worktreesQuery = useQuery(trpc.worktrees.list.queryOptions({ projectId }));
  const worktrees = worktreesQuery.data?.worktrees ?? [];
  const listOptions = trpc.resources.list.queryOptions({
    projectId,
    timeZone: readerZone(),
    worktreeId,
  });
  const query = useQuery(listOptions);
  const [busy, setBusy] = useState<Busy>(new Map());
  const running = useRef(new Set<string>());
  const [notes, setNotes] = useState<ReadonlyMap<string, ItemNote>>(new Map());
  const reading = `${projectId}\0${worktreeId ?? ""}`;
  const shown = useRef(reading);
  shown.current = reading;
  const reload = () => queryClient.invalidateQueries(trpc.resources.pathFilter());
  const act = (key: string, verb: string, run: () => Promise<ItemNote | null>) => {
    if (running.current.has(key)) return;
    running.current.add(key);
    setBusy((current) => new Map(current).set(key, verb));
    const startedOn = reading;
    void run()
      .catch(
        (error: unknown): ItemNote => ({
          refused: true,
          lines: [error instanceof Error ? error.message : String(error)],
          reload: false,
        }),
      )
      .then((note) => {
        if (shown.current === startedOn)
          setNotes((current) => answered(current, key, { at: key, note }));
        return null;
      })
      .finally(() => {
        running.current.delete(key);
        setBusy((current) => {
          const next = new Map(current);
          next.delete(key);
          return next;
        });
      });
  };
  const handlers: ResourceHandlers = {
    reload: () => {
      void reload();
    },
    remove: (entry) => {
      if (worktreeId === null) return;
      act(`s:${entry.id}:${entry.worktreeId ?? "project"}`, "remove", async () => {
        const outcome = await removeResourceInstance(projectId, entry, worktreeId);
        if (!outcome.ok) return refusedNote(outcome);
        await reload();
        return { refused: false, lines: [outcome.result.statusLine], reload: false };
      });
    },
    choose: (entry, read, mode) => {
      if (read === null) return;
      act(`s:${entry.id}:${entry.worktreeId ?? "project"}`, "use", async () => {
        const outcome = await chooseResource(projectId, read, entry.spec.name, mode);
        if (!outcome.ok) return refusedNote(outcome);
        await settleChoice(queryClient, listOptions.queryKey, outcome.result);
        return { refused: false, lines: [outcome.result.statusLine], reload: false };
      });
    },
    control: (entry, read, verb, level, restart = false) => {
      if (read === null) return;
      const key =
        "id" in entry ? `s:${entry.id}:${entry.worktreeId ?? "project"}` : `f:${entry.spec.name}`;
      act(key, verb, async () => {
        const outcome = await controlResource(projectId, entry, read, verb, level, restart);
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
            restartLevel: level,
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
  };
  return (
    <section className="mt-6">
      <h3 className="text-sm font-medium text-foreground">Resources</h3>
      <p className="mt-1 text-xs text-ink-2">
        Definitions live in .mend/mend.toml. Select a worktree to read its definitions and start a
        resource.
      </p>
      <select
        aria-label="Resource worktree"
        value={worktreeId ?? ""}
        onChange={(event) =>
          setWorktreeId(
            worktrees.find((worktree) => worktree.id === event.target.value)?.id ?? null,
          )
        }
        className="mt-3 rounded-lg border border-border bg-card px-2 py-1 text-xs"
      >
        <option value="">All running instances</option>
        {worktrees.map((worktree) => (
          <option key={worktree.id} value={worktree.id}>
            {worktree.name}
          </option>
        ))}
      </select>
      <ReadState
        read={resourcesRead(query, worktreeId)}
        worktreeName={worktrees.find((row) => row.id === worktreeId)?.name ?? null}
        onRetry={() => {
          void reload();
        }}
      >
        {(page, read) => (
          <ResourcesView
            projectId={projectId}
            page={page}
            worktreeId={read}
            worktreeName={worktrees.find((row) => row.id === read)?.name ?? null}
            busy={busy}
            notes={notes}
            handlers={handlers}
          />
        )}
      </ReadState>
    </section>
  );
}
/** A read never substitutes an empty file for unavailable bytes. */
export function ReadState(props: {
  readonly read: ReturnType<typeof resourcesRead>;
  readonly worktreeName: string | null;
  readonly onRetry: () => void;
  readonly children: (page: ResourcesPageView, worktreeId: WorktreeId | null) => ReactNode;
}) {
  if (props.read.kind === "pending")
    return <p className="mt-4 text-xs text-faint">reading resources…</p>;
  if (props.read.kind === "failed")
    return (
      <div className="mt-4 text-xs text-danger">
        {props.read.message}{" "}
        <button type="button" onClick={props.onRetry} className={quiet}>
          retry
        </button>
      </div>
    );
  return props.children(props.read.page, props.read.worktreeId);
}
/** All actions carry the worktree the displayed read came from. */
export interface ResourceHandlers {
  readonly remove: (entry: ResourceSettingView) => void;
  readonly choose: (
    entry: ResourceSettingView,
    read: WorktreeId | null,
    mode: WorktreeChoice,
  ) => void;
  readonly control: (
    entry: ResourceSettingView | ResourceFileTableView,
    read: WorktreeId | null,
    verb: "start" | "stop",
    level: ResourceLevel,
    restart?: boolean,
  ) => void;
  readonly reload: () => void;
}
/** Data-only view shared by the page and its rendering tests. */
export interface ResourcesViewProps {
  readonly projectId?: string;
  readonly page: ResourcesPageView;
  readonly worktreeId: WorktreeId | null;
  readonly worktreeName: string | null;
  readonly busy: Busy;
  readonly notes: ReadonlyMap<string, ItemNote>;
  readonly handlers: ResourceHandlers;
}
/** One status line for each remembered instance and each definition. */
export function ResourcesView(props: ResourcesViewProps) {
  const { page, handlers, worktreeId } = props;
  const controls = (entry: ResourceSettingView | ResourceFileTableView, key: string) => (
    <>
      {(["project", "worktree"] as const).map((level) => (
        <button
          key={level}
          type="button"
          disabled={worktreeId === null || props.busy.has(key)}
          onClick={() => handlers.control(entry, worktreeId, "start", level)}
          className={quiet}
        >
          start {level}
        </button>
      ))}
      {props.notes.get(key)?.restartLevel === undefined ? null : (
        <button
          type="button"
          disabled={worktreeId === null || props.busy.has(key)}
          onClick={() =>
            handlers.control(
              entry,
              worktreeId,
              "start",
              props.notes.get(key)?.restartLevel ?? "project",
              true,
            )
          }
          className={quiet}
        >
          restart with this definition
        </button>
      )}
    </>
  );
  const item = (
    entry: ResourceSettingView | ResourceFileTableView,
    key: string,
    children?: ReactNode,
  ) => (
    <div key={key} className="border-b border-rule-faint px-4 py-3">
      <p className="font-mono text-[12px] text-foreground">{entry.statusLine}</p>
      <p className="mt-1 font-mono text-[11px] text-faint">
        {"image" in entry ? entry.image : entry.spec.image}
      </p>
      <div className="mt-2 flex flex-wrap gap-3">
        {controls(entry, key)}
        {children}
      </div>
      {props.notes.get(key)?.lines.map((line) => (
        <p key={line} className="mt-1 text-xs text-ink-2">
          {line}
        </p>
      ))}
    </div>
  );
  return (
    <div className="mt-4 space-y-4">
      <div>
        {page.settings.map((entry) => {
          const key = `s:${entry.id}:${entry.worktreeId ?? "project"}`;
          return (
            <div key={key}>
              {item(
                entry,
                key,
                <>
                  {resourceControls(entry.instance).stop ? (
                    <button
                      type="button"
                      disabled={worktreeId === null || props.busy.has(key)}
                      onClick={() => handlers.control(entry, worktreeId, "stop", entry.level)}
                      className={quiet}
                    >
                      stop
                    </button>
                  ) : null}
                  {entry.canRemove ? (
                    <button
                      type="button"
                      disabled={worktreeId === null || props.busy.has(key)}
                      onClick={() => handlers.remove(entry)}
                      className={quiet}
                    >
                      remove {entry.level}
                    </button>
                  ) : null}
                </>,
              )}
              {worktreeId === null ? null : (
                <ChoiceLine
                  entry={entry}
                  worktreeName={props.worktreeName ?? "this worktree"}
                  busy={props.busy.has(key)}
                  onChoose={(mode) => handlers.choose(entry, worktreeId, mode)}
                />
              )}
              {entry.spec.preset === "postgres" && props.projectId !== undefined ? (
                <ResourceLoadForm
                  projectId={props.projectId}
                  name={entry.spec.name}
                  worktreeId={worktreeId}
                  mayLoadOwn={entry.canLoadOwn}
                  worktreeResource={false}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      {page.file.kind === "read" ? (
        <div>
          <p className="ev-eyebrow">.mend/mend.toml · {page.file.observed}</p>
          {page.file.tables.map((table) => item(table, `f:${table.spec.name}`))}
          {resourceTableNotices(page.file).map((notice) => (
            <p key={notice} className="text-xs text-ink-2">
              {notice}
            </p>
          ))}
        </div>
      ) : page.file.kind === "not-selected" ? null : (
        <p className="text-xs text-ink-2">
          {page.file.kind === "absent"
            ? "No resource definitions in this worktree."
            : page.file.message}
        </p>
      )}
      {page.settings.length === 0 && page.file.kind !== "read" ? (
        <p className="text-xs text-ink-2">No resources started.</p>
      ) : null}
    </div>
  );
}
/** A stored choice controls availability, without starting a missing resource. */
export function ChoiceLine(props: {
  readonly entry: ResourceSettingView;
  readonly worktreeName: string;
  readonly busy: boolean;
  readonly onChoose: (mode: WorktreeChoice) => void;
}) {
  const inUse = choiceInUse(props.entry);
  return (
    <div className="mt-2 px-4">
      <div
        role="group"
        aria-label={`How ${props.worktreeName} uses @${props.entry.spec.name}`}
        className="flex flex-wrap gap-1"
      >
        {props.entry.canChoose
          ? choicesFor(props.entry.spec).map((choice) => (
              <button
                key={choice}
                type="button"
                disabled={props.busy}
                aria-pressed={inUse.choice === choice}
                onClick={() => {
                  if (inUse.choice !== choice) props.onChoose(choice);
                }}
                className={choiceToggle(inUse.choice === choice)}
              >
                {choiceWords(props.entry.spec, choice).label}
              </button>
            ))
          : null}
      </div>
      <p className="mt-1 text-xs text-ink-2">
        {props.worktreeName} uses {choiceWords(props.entry.spec, inUse.choice).label}.
      </p>
    </div>
  );
}
