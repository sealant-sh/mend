import { Status } from "@mend/ui/components/status";
import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "@mend/ui/components/ui/input-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mend/ui/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@mend/ui/components/ui/tabs";
import { cn } from "@mend/ui/lib/utils";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { MessagesSquareIcon, SearchIcon } from "lucide-react";
import { useMemo, useRef } from "react";

import type { ProjectDetailDto } from "#/lib/api";
import { age, inboxRows } from "#/lib/inbox";
import { inboxQuery } from "#/lib/inbox-live";
import { lastProject } from "#/lib/new-session";
import { usePhone } from "#/lib/phone";
import {
  filterChoices,
  filterWords,
  highlightParts,
  matchesSessionFilters,
  matchLine,
  type ProjectSessionRow,
  projectSessionRows,
} from "#/lib/project-sessions";
import {
  parseProjectSessionsSearch,
  type ProjectSessionsSearch,
} from "#/lib/project-sessions-search";
import { useSeenAfterIdle } from "#/lib/seen";
import { sessionLink } from "#/lib/session-sheet";
import { worktreeJoinLine } from "#/lib/shared-workspace";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";
import { useMinute } from "#/lib/use-inbox";

import { initialsOf } from "../app-sidebar.tsx";
import { PhoneSessionActions, SessionRowMenu } from "./session-actions.tsx";

/** One row as the table and the phone list draw it. */
interface RowEntry {
  readonly row: ProjectSessionRow;
  /** Who started it; null when they are no longer a member, undefined until the roster is read. */
  readonly owner: string | null | undefined;
  readonly joinLine: string | null;
}

/**
 * The Sessions tab (Doop "Project · sessions", "sessions filtered", "cloned, no sessions yet",
 * "Grace's session in the list"): every session in the project, open ones first in view, with a
 * search, a Filter menu (agent and branch), Mine or Everyone, and Open or Stopped. The filters
 * live in the address (`search`), so a filtered list can be linked and reloaded. A row opens its
 * session; its "…" starts another session or a shell in its worktree.
 */
export function SessionsTab({
  detail,
  search,
  onSearch,
  onSetUp,
}: {
  readonly detail: ProjectDetailDto;
  readonly search: ProjectSessionsSearch;
  /** Replace the filters (the address keeps them). */
  readonly onSearch: (search: ProjectSessionsSearch) => void;
  readonly onSetUp: () => void;
}) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const phone = usePhone();
  const now = useMinute();
  const { project } = detail;
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const inbox = useQuery(inboxQuery(trpc));
  const membersRead = useQuery(trpc.organization.members.queryOptions());
  // The inbox read names the sessions it carries and says what their agents do; without it the
  // rows still list, with the project's own words.
  const inboxData = inbox.isPending || inbox.isError ? undefined : inbox.data;
  // A roster that failed to read again keeps the names it had; until then nobody is named.
  const members =
    membersRead.isPending || membersRead.isError ? (membersRead.data ?? []) : membersRead.data;
  const rows = useMemo(
    () =>
      projectSessionRows(
        detail,
        inboxRows({
          rows: (inboxData ?? []).filter((row) => row.session.projectId === project.id),
          marks: [],
          now,
        }),
        now,
      ),
    [detail, inboxData, project.id, now],
  );
  const choices = filterChoices(rows);
  const stopped = search.show === "stopped";
  const inView = rows.filter((row) => row.open !== stopped);
  const shown = inView.filter((row) => matchesSessionFilters(row, search, viewer.userId));
  const line = matchLine(shown.length, inView.length, search);
  const entries: ReadonlyArray<RowEntry> = shown.map((row) => ({
    row,
    owner:
      row.ownerUserId === null
        ? null
        : (members.find((member) => member.userId === row.ownerUserId)?.name ??
          (membersRead.isSuccess ? null : undefined)),
    joinLine: worktreeJoinLine(detail.sessions, row.worktreeId, viewer.userId),
  }));
  // A change to one filter; an emptied one leaves the address.
  const update = (change: Partial<Record<keyof ProjectSessionsSearch, string | undefined>>) =>
    onSearch(parseProjectSessionsSearch({ ...search, ...change }));
  const clearFilters = () => onSearch(search.show === undefined ? {} : { show: search.show });
  const othersShown =
    search.who !== "mine" && shown.some((row) => row.ownerUserId !== viewer.userId);
  const newSession = () => {
    lastProject.set(project.id);
    void navigate({ to: phone ? "/new" : "/" });
  };

  if (detail.sessions.length === 0)
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessagesSquareIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>
            <h2>No sessions yet</h2>
          </EmptyTitle>
          <EmptyDescription>
            Sessions in {project.name} start from {project.defaultBranch}. A setup session can
            propose its .mend/ files: the setup steps and services its sessions start with.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row flex-wrap justify-center">
          <Button size={phone ? "touch" : "default"} className="lg:hidden" onClick={newSession}>
            New session
          </Button>
          <Button variant="outline" size={phone ? "touch" : "default"} onClick={onSetUp}>
            Set up this project…
          </Button>
        </EmptyContent>
      </Empty>
    );

  return (
    <section
      aria-label={`Sessions in ${project.name}`}
      className="flex flex-col lg:px-8 lg:pt-6 lg:pb-12"
    >
      <div className="flex flex-wrap items-center gap-2.5 max-lg:px-4 max-lg:pt-3">
        <InputGroup className="w-80 max-lg:h-11 max-lg:w-full">
          <InputGroupAddon>
            <SearchIcon aria-hidden className="size-4 max-lg:size-5" />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label="Search sessions"
            placeholder="Search sessions"
            value={search.q ?? ""}
            onChange={(event) => update({ q: event.target.value })}
            className="max-lg:text-lead"
          />
        </InputGroup>
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(buttonVariants({ variant: "outline" }), "max-lg:h-11")}
          >
            Filter sessions
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" width="md">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Agent</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={search.agent ?? ""}
                onValueChange={(value: string) => update({ agent: value })}
              >
                <DropdownMenuRadioItem value="">Any agent</DropdownMenuRadioItem>
                {choices.agents.map((agent) => (
                  <DropdownMenuRadioItem key={agent} value={agent}>
                    {agent}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Branch</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={search.branch ?? ""}
                onValueChange={(value: string) => update({ branch: value })}
              >
                <DropdownMenuRadioItem value="">Any branch</DropdownMenuRadioItem>
                {choices.branches.map((branch) => (
                  <DropdownMenuRadioItem key={branch} value={branch}>
                    <span className="truncate font-mono text-meta">{branch}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <p className="text-row text-muted-foreground max-lg:hidden">{filterWords(search)}</p>
        <div className="flex items-center gap-2.5 max-lg:w-full lg:ml-auto">
          <Tabs
            value={search.who ?? "everyone"}
            onValueChange={(value: string) =>
              update({ who: value === "mine" ? "mine" : undefined })
            }
          >
            <TabsList aria-label="Whose sessions" className="max-lg:h-11">
              <TabsTrigger value="mine" className="px-2.5">
                Mine
              </TabsTrigger>
              <TabsTrigger value="everyone" className="px-2.5">
                Everyone
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Tabs
            value={search.show ?? "open"}
            onValueChange={(value: string) =>
              update({ show: value === "stopped" ? "stopped" : undefined })
            }
          >
            <TabsList aria-label="Which sessions" className="max-lg:h-11">
              <TabsTrigger value="open" className="px-2.5">
                Open
              </TabsTrigger>
              <TabsTrigger value="stopped" className="px-2.5">
                Stopped
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>
      <div className="mt-2 min-h-6 max-lg:px-4" role="status">
        {line === null ? (
          othersShown ? (
            <p className="text-row text-muted-foreground">
              Sessions that aren't yours open read-only unless their owner turns on shared control.
            </p>
          ) : null
        ) : (
          <p className="flex flex-wrap items-baseline gap-x-1 text-row text-muted-foreground">
            {line}
            <Button variant="link" className="h-auto p-0 text-row" onClick={clearFilters}>
              Clear filters
            </Button>
          </p>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="py-6 text-prose text-muted-foreground max-lg:px-4">
          {line !== null
            ? "No session matches."
            : stopped
              ? `No session in ${project.name} has stopped.`
              : `Nothing is open in ${project.name}. Stopped sessions are under Stopped.`}
        </p>
      ) : (
        <>
          <div className="max-lg:hidden">
            <SessionsTable projectId={project.id} entries={entries} search={search} now={now} />
          </div>
          <div className="lg:hidden">
            <SessionsList projectId={project.id} entries={entries} search={search} now={now} />
          </div>
        </>
      )}
      {/* Ended sessions with no record are left out of Stopped; say so there. */}
      {!stopped || detail.hiddenEndedSessions === 0 ? null : (
        <p className="mt-3 text-row text-muted-foreground max-lg:px-4">
          {detail.hiddenEndedSessions === 1
            ? "1 ended session isn't listed: Mend kept no record of it."
            : `${detail.hiddenEndedSessions} ended sessions aren't listed: Mend kept no record of them.`}
        </p>
      )}
    </section>
  );
}

/** The title with the search's words in bold. */
function Highlighted({
  value,
  query,
}: {
  readonly value: string;
  readonly query: string | undefined;
}) {
  return (
    <>
      {highlightParts(value, query).map((part, index) =>
        part.match ? (
          // oxlint-disable-next-line react/no-array-index-key -- the parts are the title's pieces, in order
          <strong key={index} className="font-semibold">
            {part.text}
          </strong>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

const CELL = "h-14 px-3";

function SessionsTable({
  projectId,
  entries,
  search,
  now,
}: {
  readonly projectId: string;
  readonly entries: ReadonlyArray<RowEntry>;
  readonly search: ProjectSessionsSearch;
  readonly now: Date;
}) {
  return (
    <Table aria-label="Sessions" className="text-prose">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-10 w-40 pl-0 font-normal text-muted-foreground">Status</TableHead>
          <TableHead className="px-3 font-normal text-muted-foreground">Session</TableHead>
          <TableHead className="px-3 font-normal text-muted-foreground">Worktree</TableHead>
          <TableHead className="px-3 font-normal text-muted-foreground">Owner</TableHead>
          <TableHead className="px-3 font-normal text-muted-foreground">Updated</TableHead>
          <TableHead className="px-3 text-right font-normal text-muted-foreground">
            Change
          </TableHead>
          <TableHead className="w-10 pr-0">
            <span className="sr-only">Menu</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="[&_tr:last-child]:border-b">
        {entries.map(({ row, owner, joinLine }) => (
          <TableRow key={row.id}>
            <TableCell className={cn(CELL, "pl-0")}>
              <Status tone={row.status.tone} className="text-row">
                {row.status.word}
              </Status>
            </TableCell>
            <TableCell className={cn(CELL, "max-w-110")}>
              <Link
                {...sessionLink(row.id)}
                className="block truncate font-medium outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <Highlighted value={row.title} query={search.q} />
              </Link>
              <span className="block truncate text-2xs text-muted-foreground">
                {row.model === null ? row.agent : `${row.agent} · ${row.model}`}
              </span>
            </TableCell>
            <TableCell className={cn(CELL, "max-w-64")}>
              <span className="block truncate font-mono text-meta text-muted-foreground">
                <Highlighted value={row.worktree} query={search.q} />
              </span>
              {row.handedOffFrom === null ? null : (
                <span className="block truncate text-2xs text-muted-foreground">
                  handed off from {row.handedOffFrom}
                </span>
              )}
            </TableCell>
            <TableCell className={CELL}>
              <OwnerName owner={owner} />
            </TableCell>
            <TableCell className={cn(CELL, "text-muted-foreground tabular-nums")}>
              {age(row.updatedAt, now)}
            </TableCell>
            <TableCell className={cn(CELL, "text-right")}>
              <ChangeSize row={row} />
            </TableCell>
            <TableCell className={cn(CELL, "w-10 pr-0")}>
              <SessionRowMenu projectId={projectId} row={row} joinLine={joinLine} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function OwnerName({ owner }: { readonly owner: string | null | undefined }) {
  if (owner === undefined) return null;
  if (owner === null) return <span className="text-muted-foreground">A former member</span>;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden
        className="grid size-5.5 shrink-0 place-items-center rounded-full bg-muted text-2xs font-medium"
      >
        {initialsOf(owner)}
      </span>
      <span className="truncate">{owner}</span>
    </span>
  );
}

/**
 * `+84 −12`: the change's size, read once the row is on screen and the page has settled; nothing
 * while it loads or when it can't be read. A change with no files says so without a read.
 */
function ChangeSize({ row }: { readonly row: ProjectSessionRow }) {
  const trpc = useTRPC();
  const box = useRef<HTMLSpanElement>(null);
  const seen = useSeenAfterIdle(box);
  const changeId = row.changeId;
  const stats = useQuery({
    ...trpc.changes.stats.queryOptions({ id: changeId ?? "" }, { staleTime: 60_000 }),
    enabled: seen && changeId !== null && row.fileCount !== 0,
  });
  return (
    <span ref={box} className="text-meta whitespace-nowrap">
      {changeId === null || row.fileCount === 0 ? (
        <span className="text-muted-foreground">No changes</span>
      ) : stats.isPending || stats.isError ? null : stats.data.files === 0 ? (
        <span className="text-muted-foreground">No changes</span>
      ) : (
        <span
          aria-label={`${stats.data.additions} lines added, ${stats.data.deletions} removed`}
          className="font-mono"
        >
          <span className="text-success">+{stats.data.additions}</span>{" "}
          <span className="text-destructive">−{stats.data.deletions}</span>
        </span>
      )}
    </span>
  );
}

/** The phone's list (Doop "Phone · Project · sessions filtered"): one row per session. */
function SessionsList({
  projectId,
  entries,
  search,
  now,
}: {
  readonly projectId: string;
  readonly entries: ReadonlyArray<RowEntry>;
  readonly search: ProjectSessionsSearch;
  readonly now: Date;
}) {
  return (
    <ul aria-label="Sessions" className="border-t">
      {entries.map(({ row, owner, joinLine }) => (
        <li key={row.id} className="relative flex items-start border-b">
          <Link
            {...sessionLink(row.id)}
            className="flex min-h-16 min-w-0 flex-1 flex-col gap-0.5 py-3 pl-4 outline-none focus-visible:bg-muted"
          >
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-lead">
                <Highlighted value={row.title} query={search.q} />
              </span>
              <Status tone={row.status.tone} className="shrink-0 text-sm">
                {row.status.word}
              </Status>
            </span>
            <span className="flex min-w-0 items-baseline gap-1 truncate text-prose text-muted-foreground">
              {[
                owner ?? null,
                age(row.updatedAt, now),
                row.handedOffFrom === null ? null : `handed off from ${row.handedOffFrom}`,
              ]
                .filter((part) => part !== null)
                .join(" · ")}
              {row.changeId === null ? null : (
                <>
                  <span aria-hidden>·</span>
                  <ChangeSize row={row} />
                </>
              )}
            </span>
          </Link>
          <PhoneSessionActions projectId={projectId} row={row} joinLine={joinLine} />
        </li>
      ))}
    </ul>
  );
}
