import { Collapsible } from "@base-ui/react/collapsible";
import { useContextMenu } from "@mend/ui/context-menu";
import { cn } from "@mend/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";

import { Button, focusRing } from "#/components/kit/button";
import { ListPanel, ListRow } from "#/components/kit/controls";
import { Icon } from "#/components/kit/icons";
import { StatusWord } from "#/components/kit/status";
import { HiddenEndedSessionsNotice } from "#/components/project-detail/hidden-ended-sessions-notice";
import { SessionComposer } from "#/components/session-composer";
import type { ProjectDetailDto } from "#/lib/api";
import { authClient } from "#/lib/auth-client";
import { inboxRows, matchesFilters, rowStatus, type InboxRow } from "#/lib/inbox";
import { useTRPC } from "#/lib/trpc";
import { useViewer } from "#/lib/viewer";
import { sessionMenu } from "#/lib/workbench-menus";

import { SessionsFilterLine, type ProjectSessionFilters } from "./sessions-filters";

const SETTLED_PAGE = 50;

const subscribeToMinutes = (onChange: () => void) => {
  const timer = setInterval(onChange, 15_000);
  return () => clearInterval(timer);
};
const minuteNow = () => Math.floor(Date.now() / 60_000);

/** The current minute; re-renders only when it turns, so "running · 6 min" stays true. */
const useMinute = () =>
  new Date(useSyncExternalStore(subscribeToMinutes, minuteNow, minuteNow) * 60_000);

/**
 * The Sessions tab (screen K1): the composer starts a session in this project, then every session
 * in it, newest activity first, with the ones that ended folded under Settled. The filter line
 * lives in the URL, so a reload or a shared link keeps it. Places follow each session's status
 * alone: snoozing and settling by hand belong to a person's inbox, not to the project.
 */
export function SessionsTab({
  detail,
  filters,
  onFiltersChange,
}: {
  readonly detail: ProjectDetailDto;
  readonly filters: ProjectSessionFilters;
  readonly onFiltersChange: (filters: ProjectSessionFilters) => void;
}) {
  const { project } = detail;
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const viewer = useViewer();
  const { openMenu, menuElement } = useContextMenu();
  const onMenu = (event: MouseEvent, row: InboxRow) =>
    openMenu(
      event,
      sessionMenu(row.session, row.annotation, navigate, { queryClient, trpc }, viewer),
    );
  const me = authClient.useSession().data?.user.id ?? null;
  const now = useMinute();
  const members = useOwnerNames();
  const rows = inboxRows({ projects: [{ project, detail }], marks: [], now });
  const inboxFilters = {
    projectIds: [],
    startedBy: filters.startedBy,
    agent: filters.agent,
    branch: filters.branch,
  };
  const visible = rows.filter((row) => matchesFilters(row, inboxFilters, me));
  const open = visible.filter((row) => row.place !== "settled");
  const settled = visible.filter((row) => row.place === "settled");
  const filtered =
    (filters.startedBy === "me" && me !== null) ||
    filters.agent !== null ||
    filters.branch !== null;

  return (
    <section aria-label={`Sessions in ${project.name}`}>
      <div className="mb-[18px]">
        <SessionComposer
          projects={[project]}
          pinned
          placeholder={`Start a session in ${project.name}`}
          submitLabel="Start session"
        />
      </div>
      <SessionsFilterLine
        filters={filters}
        rows={rows}
        viewerKnown={me !== null}
        onChange={onFiltersChange}
      />
      <HiddenEndedSessionsNotice count={detail.hiddenEndedSessions} />
      {rows.length === 0 ? (
        <EmptyNote>
          No sessions in {project.name} yet. Describe a change above to start one.
        </EmptyNote>
      ) : visible.length === 0 ? (
        <EmptyNote>
          No session matches these filters.{" "}
          <button
            type="button"
            className={cn("text-info underline-offset-2 hover:underline", focusRing)}
            onClick={() => onFiltersChange({ startedBy: "anyone", agent: null, branch: null })}
          >
            Show every session
          </button>
        </EmptyNote>
      ) : open.length === 0 ? (
        <EmptyNote>
          Nothing runs, waits or is ready to review{filtered ? " with these filters" : ""}.
        </EmptyNote>
      ) : (
        <ListPanel label="Open sessions">
          {open.map((row) => (
            <SessionRow
              key={row.session.id}
              row={row}
              now={now}
              owners={members}
              onMenu={onMenu}
              withStats
            />
          ))}
        </ListPanel>
      )}
      {settled.length === 0 ? null : (
        <SettledFold rows={settled} now={now} owners={members} onMenu={onMenu} />
      )}
      {menuElement}
    </section>
  );
}

function EmptyNote({ children }: { readonly children: ReactNode }) {
  return (
    <p className="rounded-[22px] bg-panel px-5 py-6 font-mono text-[12px] leading-relaxed text-muted-foreground shadow-sm">
      {children}
    </p>
  );
}

/** Names of the organization's members by account, to say who started each session. */
const useOwnerNames = (): ReadonlyMap<string, string> | undefined => {
  const trpc = useTRPC();
  const members = useQuery(trpc.organization.members.queryOptions(undefined, { retry: false }));
  if (members.data === undefined) return undefined;
  return new Map(members.data.map((member) => [member.userId, member.name]));
};

function SettledFold({
  rows,
  now,
  owners,
  onMenu,
}: {
  readonly rows: ReadonlyArray<InboxRow>;
  readonly now: Date;
  readonly owners: ReadonlyMap<string, string> | undefined;
  readonly onMenu: (event: MouseEvent, row: InboxRow) => void;
}) {
  const [shown, setShown] = useState(SETTLED_PAGE);
  return (
    <Collapsible.Root render={<section aria-label="Settled sessions" />} className="mt-4">
      <Collapsible.Trigger
        className={cn(
          "group/fold flex items-center gap-1.5 rounded-[10px] px-2.5 py-[9px] font-sans text-[13px] font-medium text-ink-2 hover:bg-secondary",
          focusRing,
        )}
      >
        <Icon
          name="chevronRight"
          size={13}
          className="transition-transform group-data-[panel-open]/fold:rotate-90"
        />
        Settled
        <span className="font-mono text-[11px] font-normal text-faint">{rows.length}</span>
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <ListPanel label="Settled sessions" className="mt-1.5">
          {rows.slice(0, shown).map((row) => (
            <SessionRow key={row.session.id} row={row} now={now} owners={owners} onMenu={onMenu} />
          ))}
        </ListPanel>
        {rows.length > shown ? (
          <Button
            size="sm"
            variant="ghost"
            className="mt-2"
            onClick={() => setShown((count) => count + SETTLED_PAGE)}
          >
            Show {Math.min(SETTLED_PAGE, rows.length - shown)} more
          </Button>
        ) : null}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** One session: its title, `branch · agent · who started it`, its change's size and status. */
function SessionRow({
  row,
  now,
  owners,
  onMenu,
  withStats = false,
}: {
  readonly row: InboxRow;
  readonly now: Date;
  readonly owners: ReadonlyMap<string, string> | undefined;
  readonly onMenu: (event: MouseEvent, row: InboxRow) => void;
  readonly withStats?: boolean;
}) {
  const { session, annotation } = row;
  const status = rowStatus(row, now);
  const owner = session.ownerUserId === null ? null : (owners?.get(session.ownerUserId) ?? null);
  const changeId = annotation?.changeId ?? null;
  return (
    <ListRow
      className={cn(
        "relative rounded-[14px] transition-colors focus-within:bg-secondary hover:bg-secondary",
        row.place === "settled" ? "opacity-[0.72] hover:opacity-100 focus-within:opacity-100" : "",
      )}
      title={
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: session.id }}
          onContextMenu={(event) => onMenu(event, row)}
          className={cn(
            "text-foreground no-underline after:absolute after:inset-0 after:rounded-[14px]",
            focusRing,
          )}
        >
          {row.title}
        </Link>
      }
      meta={[session.branch, session.harness, owner].filter((part) => part !== null).join(" · ")}
      end={
        <>
          {withStats && changeId !== null ? <DiffStats changeId={changeId} /> : null}
          <StatusWord tone={status.tone}>{status.word}</StatusWord>
        </>
      }
    />
  );
}

/** `+218 −66`: one cached read per open row; nothing while it loads or when it cannot answer. */
function DiffStats({ changeId }: { readonly changeId: string }) {
  const trpc = useTRPC();
  const stats = useQuery(trpc.changes.stats.queryOptions({ id: changeId }, { staleTime: 60_000 }));
  if (stats.data === undefined) return null;
  if (stats.data.files === 0)
    return <span className="font-mono text-[11.5px] text-faint">no file changes</span>;
  return (
    <span
      className="font-mono text-[11.5px]"
      aria-label={`${stats.data.additions} lines added, ${stats.data.deletions} removed`}
    >
      <span className="text-success">+{stats.data.additions}</span>{" "}
      <span className="text-danger">−{stats.data.deletions}</span>
    </span>
  );
}
