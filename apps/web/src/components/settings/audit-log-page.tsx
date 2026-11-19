import { Avatar, AvatarFallback } from "@mend/ui/components/ui/avatar";
import { Button } from "@mend/ui/components/ui/button";
import { Spinner } from "@mend/ui/components/ui/spinner";
import {
  infiniteQueryOptions,
  useQuery,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";

import {
  accessKeyNote,
  type AuditEntryView,
  type AuditNames,
  describeAudit,
  nextAuditPage,
  projectOf,
  whenLine,
} from "#/lib/audit-log";
import { initialsOf } from "#/lib/organization";
import { failureWords } from "#/lib/refusal";
import { signedInOptions } from "#/lib/sign-in";
import { type TrpcClient, type TrpcProxy, useTRPC, useTRPCClient } from "#/lib/trpc";

import { SettingsPage } from "./settings-page.tsx";

/**
 * The audit log, a page at a time, newest first. Keyed under `organization.audit`, so whatever
 * invalidates the organization's reads (a member removed, a rename) reads it again.
 */
export const auditPages = (trpc: TrpcProxy, client: TrpcClient) =>
  infiniteQueryOptions({
    queryKey: [...trpc.organization.audit.pathKey(), { pages: true }],
    queryFn: ({ pageParam }): Promise<ReadonlyArray<AuditEntryView>> =>
      client.organization.audit.query(pageParam === undefined ? {} : { before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextAuditPage,
  });

/**
 * Settings → the organization → Audit log (Doop "Settings · Northwind · Audit log"): what people
 * did in the organization, newest first, for its owners. Who acted, what they did in a sentence,
 * the project when the page can name it, and when. Show older events reads the next page. The
 * route's loader read the first page, so a failure to read it is the route's error screen with
 * Try again.
 */
export function AuditLogPage() {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const organization = useSuspenseQuery(signedInOptions(trpc)).data.organization.name;
  const pages = useSuspenseInfiniteQuery(auditPages(trpc, client));
  const roster = useQuery(trpc.organization.members.queryOptions());
  const projects = useQuery(trpc.projects.list.queryOptions());
  // Names the sentences can use; while either read is pending or failed, they say less.
  const names: AuditNames = {
    organization,
    people: new Map(
      roster.status === "success" ? roster.data.map((member) => [member.userId, member.name]) : [],
    ),
    projects: new Map(
      projects.status === "success"
        ? projects.data.map((project) => [project.id, project.name])
        : [],
    ),
  };
  const entries = pages.data.pages.flat();
  const now = new Date();
  return (
    <SettingsPage
      page="o-audit"
      intro={`What people did in ${organization}, newest first. Only owners can see it. Mend keeps it for as long as ${organization} exists.`}
    >
      {entries.length === 0 ? (
        <p className="border-y border-border py-6 text-center text-row text-muted-foreground max-lg:px-4">
          Nothing recorded yet. Invitations, role changes, shared projects and the like show here as
          people make them.
        </p>
      ) : (
        <div role="table" aria-label="Audit log" className="text-row">
          <div
            role="row"
            className="grid grid-cols-[9rem_12rem_minmax(0,1fr)_8rem] gap-4 border-b border-border py-2 text-meta text-muted-foreground max-lg:hidden"
          >
            <span role="columnheader">When</span>
            <span role="columnheader">Who</span>
            <span role="columnheader">What</span>
            <span role="columnheader">Project</span>
          </div>
          {entries.map((entry) => (
            <AuditRow key={entry.event.id} entry={entry} names={names} now={now} />
          ))}
        </div>
      )}
      {pages.hasNextPage ? (
        <div className="mt-4 flex flex-col items-center gap-2 max-lg:px-4">
          <Button
            type="button"
            variant="outline"
            className="h-9 max-lg:h-11 max-lg:w-full max-lg:text-base"
            disabled={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
          >
            {pages.isFetchingNextPage ? <Spinner aria-hidden /> : null}
            {pages.isFetchingNextPage ? "Loading older events…" : "Show older events"}
          </Button>
          {pages.isFetchNextPageError ? (
            <p role="alert" className="text-row text-destructive">
              Mend couldn't read older events.{" "}
              {failureWords(pages.error, "Check your connection and try again.")}
            </p>
          ) : null}
        </div>
      ) : entries.length === 0 ? null : (
        <p className="mt-4 text-center text-meta text-muted-foreground">
          That's everything since {organization} began.
        </p>
      )}
    </SettingsPage>
  );
}

/** One event: when, who (with their initials), what, and the project when there is one. */
function AuditRow({
  entry,
  names,
  now,
}: {
  readonly entry: AuditEntryView;
  readonly names: AuditNames;
  readonly now: Date;
}) {
  const when = whenLine(entry.event.createdAt, now);
  const project = projectOf(entry, names);
  const key = accessKeyNote(entry.event);
  const what = describeAudit(entry, names);
  return (
    <div
      role="row"
      className="grid grid-cols-[9rem_12rem_minmax(0,1fr)_8rem] items-center gap-4 border-b border-border py-3 max-lg:grid-cols-1 max-lg:gap-1 max-lg:px-4"
    >
      <span role="cell" className="text-muted-foreground max-lg:hidden">
        <time dateTime={entry.event.createdAt.toISOString()}>{when}</time>
      </span>
      <span role="cell" className="flex min-w-0 items-center gap-2 max-lg:hidden">
        <Avatar size="sm" aria-hidden>
          <AvatarFallback className="font-medium">
            {initialsOf(entry.actorName, entry.actorName)}
          </AvatarFallback>
        </Avatar>
        <span className="truncate">{entry.actorName}</span>
      </span>
      <span role="cell" className="min-w-0 text-foreground">
        {what}
        {key === null ? null : <span className="text-muted-foreground"> · {key}</span>}
      </span>
      <span role="cell" className="truncate text-muted-foreground max-lg:hidden">
        {project}
      </span>
      <span className="text-meta text-muted-foreground lg:hidden">
        {[entry.actorName, project, when].filter((part) => part !== null).join(" · ")}
      </span>
    </div>
  );
}
