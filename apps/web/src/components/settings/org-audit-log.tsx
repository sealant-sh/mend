import { infiniteQueryOptions, useSuspenseInfiniteQuery } from "@tanstack/react-query";

import { Button } from "#/components/kit/button";
import { Panel, SettingsSection } from "#/components/kit/section";
import { ErrorNote, errorText } from "#/components/kit/status";
import { DataTable } from "#/components/kit/table";
import type { AuditEntryDto } from "#/lib/api";
import { describeAudit } from "#/lib/organization";
import { trpcClient, useTRPC, type TrpcProxy } from "#/lib/trpc";

/** The server's audit page size: a shorter page is the last one. */
export const AUDIT_PAGE_SIZE = 50;

/** The first page starts at the newest event. */
const newest = (): string | undefined => undefined;

/**
 * The audit log, a page at a time, newest first. Keyed under `organization.audit`, so whatever
 * invalidates the audit (a Slack change, a member removed) reads it again.
 */
export const auditPages = (trpc: TrpcProxy) =>
  infiniteQueryOptions({
    queryKey: [...trpc.organization.audit.pathKey(), { pages: true }],
    queryFn: ({ pageParam }): Promise<ReadonlyArray<AuditEntryDto>> =>
      trpcClient.organization.audit.query(pageParam === undefined ? {} : { before: pageParam }),
    initialPageParam: newest(),
    getNextPageParam: (page) => (page.length < AUDIT_PAGE_SIZE ? undefined : page.at(-1)?.event.id),
  });

const moment = (at: Date, now: Date): string =>
  at.toDateString() === now.toDateString()
    ? at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : at.toLocaleDateString(undefined, { day: "numeric", month: "short" });

/**
 * O8 · Audit log (owners): every change to who belongs, who sees what and what the organization
 * shares, newest first, kept indefinitely. Load earlier reads the next page.
 */
export function AuditLogTab() {
  const trpc = useTRPC();
  const pages = useSuspenseInfiniteQuery(auditPages(trpc));
  const entries = pages.data.pages.flat();
  const now = new Date();
  return (
    <Panel>
      <SettingsSection title="Audit log" why="Newest first. Kept indefinitely.">
        <DataTable
          label="Audit log"
          columns={[
            { head: "When", width: "0.6fr" },
            { head: "Who", width: "0.8fr" },
            { head: "What", width: "3fr" },
          ]}
          empty="nothing recorded yet"
          rows={entries.map((entry) => ({
            key: entry.event.id,
            cells: [
              <time
                key="when"
                dateTime={entry.event.createdAt.toISOString()}
                title={entry.event.createdAt.toLocaleString()}
                className="font-mono text-[12px] text-muted-foreground"
              >
                {moment(entry.event.createdAt, now)}
              </time>,
              <span key="who">{entry.actorName}</span>,
              <span key="what" className="text-ink-2">
                {describeAudit(entry)}
              </span>,
            ],
          }))}
        />
        {pages.hasNextPage ? (
          <Button
            className="mt-2.5"
            size="sm"
            variant="ghost"
            disabled={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
          >
            {pages.isFetchingNextPage ? "Loading…" : "Load earlier"}
          </Button>
        ) : null}
        {pages.isFetchNextPageError ? (
          <ErrorNote className="mt-3">{errorText(pages.error)}</ErrorNote>
        ) : null}
      </SettingsSection>
    </Panel>
  );
}
