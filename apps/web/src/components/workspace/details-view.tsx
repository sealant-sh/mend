import { sharedWorkspaceLine } from "@mend/domain/workbench";
import { cn } from "@mend/ui/lib/utils";
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useRef } from "react";

import type { SessionDetailDto } from "#/lib/api";
import { observedChecks } from "#/lib/checks";
import { conversationQuery } from "#/lib/conversation";
import { inboxQuery } from "#/lib/inbox-live";
import {
  baseWords,
  checkWords,
  landingLine,
  landingLineFailed,
  layoutFallbackLine,
  pullRequestOf,
  repositoryRows,
  sessionByline,
  sharedControlWords,
  sharedWithWords,
  untestedWords,
  workspaceServiceRows,
} from "#/lib/session-details";
import { sessionDetailQuery } from "#/lib/session-queries";
import { useTRPC, useTRPCClient } from "#/lib/trpc";
import { useMinute } from "#/lib/use-inbox";

import { type SessionFacts, useSessionFacts } from "../session/session-facts.ts";
import { SharedControlRow } from "../session/shared-control.tsx";

/** Where the view lives: the session whose sheet it is in, and its workspace. */
interface DetailsPlace {
  readonly sessionId: string;
  readonly worktreeId: string;
  readonly projectId: string;
}

/** Whether a workspace view is registered, so a line can open its tab. */
export type ViewOpens = (viewId: string) => boolean;

/** Checks the view lists by name; the Checks view (route PR 21) holds the rest. */
const CHECKS_SHOWN = 3;

/** The canvas's link: cobalt text, no box (`.dv-a`). A 44px target on a phone. */
const linkClass =
  "rounded-sm font-medium whitespace-nowrap text-ring outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 max-lg:inline-flex max-lg:min-h-11 max-lg:items-center";

/**
 * The Details view (Doop "Details view", T24, "Session details · shared workspace"): what used to
 * be the right-hand panel and the header's hover, opened as a tab like any other view (ADR 0026).
 * Four groups divided by hairlines: Workspace (worktree, branch, base, pull request), Checks,
 * Services, and Sessions in this workspace (each one's owner, agent and model, status, and who
 * steers it), plus Repositories when the session holds any beside its worktree. The Checks and
 * Preview views own their detail: this view says one line each and opens their tab when that view
 * is there (`opens`).
 */
export function WorkspaceDetails({
  place,
  opens,
}: {
  readonly place: DetailsPlace;
  readonly opens: ViewOpens;
}) {
  const facts = useSessionFacts(place.sessionId);
  const sessionsHeading = useRef<HTMLHeadingElement>(null);
  const workspace = useWorkspaceSessions(place, facts);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full max-w-[680px] px-7 pt-1 pb-6 text-row tabular-nums max-lg:px-4">
        <WorkspaceGroup
          facts={facts}
          place={place}
          opens={opens}
          sessionsInWorkspace={workspace.rows.length}
          onShowSessions={() => sessionsHeading.current?.focus()}
        />
        <ChecksGroup sessionId={place.sessionId} opens={opens} />
        <ServicesGroup place={place} opens={opens} sessionIds={workspace.ids} />
        <RepositoriesGroup facts={facts} />
        <Group title="Sessions in this workspace" headingRef={sessionsHeading}>
          {workspace.rows.map((row) => (
            <div key={row.id} className="grid gap-px py-2 [&+&]:border-t">
              <p className="font-medium">{row.title}</p>
              <p className="text-meta text-muted-foreground">{row.byline}</p>
              {row.id === facts.session.id ? (
                <SharedControlRow facts={facts} />
              ) : (
                <p className="text-meta text-muted-foreground">{row.control}</p>
              )}
            </div>
          ))}
        </Group>
      </div>
    </div>
  );
}

/** One group: its heading over its rows, a hairline above every group but the first. */
function Group({
  title,
  headingRef,
  children,
}: {
  readonly title: string;
  readonly headingRef?: React.Ref<HTMLHeadingElement>;
  readonly children: ReactNode;
}) {
  return (
    <section className="border-t py-[18px] first:border-t-0" aria-label={title}>
      <h3 ref={headingRef} tabIndex={-1} className="mb-2.5 font-semibold outline-none">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** A label and its value: a 136px label column beside the value. */
function Row({
  label,
  mono = false,
  children,
}: {
  readonly label: ReactNode;
  /** The label is a name in mono (a Service's), not a muted word. */
  readonly mono?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[136px_minmax(0,1fr)] items-baseline gap-3 max-lg:grid-cols-[120px_minmax(0,1fr)]">
      <dt
        className={cn(
          "min-w-0",
          mono ? "font-mono text-meta wrap-anywhere" : "text-muted-foreground",
        )}
      >
        {label}
      </dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">{children}</dd>
    </div>
  );
}

function Mono({ children }: { readonly children: ReactNode }) {
  return <span className="font-mono text-meta wrap-anywhere">{children}</span>;
}

/** A line under a value: muted, wrapping. */
function Note({
  children,
  danger = false,
}: {
  readonly children: ReactNode;
  readonly danger?: boolean;
}) {
  return (
    <span
      className={cn(
        "basis-full text-meta wrap-anywhere",
        danger ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/** A read that hasn't answered: "Reading…", or that it didn't load, with Try again. */
function Unread({
  failed,
  onRetry,
  retrying,
}: {
  readonly failed: boolean;
  readonly onRetry: () => void;
  readonly retrying: boolean;
}) {
  if (!failed)
    return (
      <span role="status" className="text-muted-foreground">
        Reading…
      </span>
    );
  return (
    <span className="flex flex-wrap items-baseline gap-x-3">
      <span role="alert" className="text-muted-foreground">
        This didn't load.
      </span>
      <button type="button" className={linkClass} disabled={retrying} onClick={onRetry}>
        {retrying ? "Trying again…" : "Try again"}
      </button>
    </span>
  );
}

/** A view's tab opened through its address, which focuses the tab or adds it to the sheet. */
function ViewLink({
  sessionId,
  view,
  hash,
  children,
}: {
  readonly sessionId: string;
  readonly view: string;
  readonly hash?: string;
  readonly children: ReactNode;
}) {
  return (
    <Link
      to="/sessions/$sessionId/$view"
      params={{ sessionId, view }}
      {...(hash === undefined ? {} : { hash })}
      className={linkClass}
    >
      {children}
    </Link>
  );
}

/** The sessions in the workspace, as their lines read, the page's own among them. */
const useWorkspaceSessions = (place: DetailsPlace, facts: SessionFacts) => {
  const trpc = useTRPC();
  const inbox = useQuery({
    ...inboxQuery(trpc),
    select: (rows) => rows.filter((row) => row.session.worktreeId === place.worktreeId),
  });
  const listed = inbox.isPending || inbox.isError ? [] : inbox.data;
  const sessions = [
    ...listed.map((row) => ({ title: row.title, session: row.session })),
    // The page's own session is in the workspace even before (or without) its inbox row.
    ...(listed.some((row) => row.session.id === facts.session.id)
      ? []
      : [{ title: facts.title, session: facts.session }]),
  ];
  // The model and effort each recorded are in its detail, read once and kept (the inbox row has
  // neither): until it answers, the line goes without them.
  const details = useQueries({
    queries: sessions.map(({ session }) => ({
      ...sessionDetailQuery(trpc, session.id),
      select: (read: SessionDetailDto) => read.session,
    })),
  });
  const rows = sessions.map(({ title, session }, index) => {
    const read = details[index];
    const detail = read === undefined || read.isPending || read.isError ? null : read.data;
    return {
      id: session.id,
      title,
      byline: sessionByline({ ...session, ...detail }, facts.viewerId, facts.nameOf),
      control: sharedControlWords(session, facts.viewerId, facts.nameOf),
    };
  });
  return { rows, ids: new Set(rows.map((row) => row.id)) };
};

function WorkspaceGroup({
  facts,
  place,
  opens,
  sessionsInWorkspace,
  onShowSessions,
}: {
  readonly facts: SessionFacts;
  readonly place: DetailsPlace;
  readonly opens: ViewOpens;
  readonly sessionsInWorkspace: number;
  readonly onShowSessions: () => void;
}) {
  const { session } = facts;
  const trpc = useTRPC();
  const now = useMinute();
  const landings = useQuery(trpc.landings.forSession.queryOptions({ id: session.id }));
  // A handed-off worktree says where it came from (`handoff-row`): the project's worktree holds it.
  const handoff = useQuery(
    trpc.projects.detail.queryOptions(
      { id: place.projectId },
      {
        select: (project) =>
          project.worktrees.find((worktree) => worktree.id === place.worktreeId)?.handoff
            ?.machine ?? null,
      },
    ),
  );
  const handedOffFrom = handoff.isPending || handoff.isError ? null : handoff.data;
  const shared = sharedWithWords(sessionsInWorkspace);
  // Another person's process live in this workspace (`shared-workspace-line`), and why it runs
  // everyone on one home when an image or runtime forced it (`layout-fallback`).
  const sharing = sharedWorkspaceLine(session.livePeople, facts.viewerId);
  const fallback = layoutFallbackLine(session.summary);
  return (
    <Group title="Workspace">
      <dl className="grid gap-2">
        <Row label="Worktree">
          <Mono>{facts.worktreeName}</Mono>
          {shared === null ? null : (
            <button type="button" className={linkClass} onClick={onShowSessions}>
              {shared}
            </button>
          )}
          {handedOffFrom === null ? null : <Note>handed off from {handedOffFrom}</Note>}
          {sharing === null ? null : <Note>{sharing}</Note>}
          {fallback === null ? null : <Note>{fallback}</Note>}
        </Row>
        <Row label="Branch">
          <Mono>{session.branch}</Mono>
        </Row>
        <Row label="Base">
          <Mono>{baseWords(session)}</Mono>
        </Row>
        <Row label="Pull request">
          {landings.isPending || landings.isError ? (
            <Unread
              failed={landings.isError}
              retrying={landings.isFetching}
              onRetry={() => void landings.refetch()}
            />
          ) : (
            <PullRequestValue
              sessionId={session.id}
              view={landings.data}
              now={now}
              canOpenChange={opens("change")}
            />
          )}
        </Row>
      </dl>
    </Group>
  );
}

/**
 * The change's pull request and its state, a link to it on GitHub; with none, "None yet" and the
 * owner's Land… (the Change view's Land panel). Under it, the latest landing fact
 * (`land-session-line`).
 */
function PullRequestValue({
  sessionId,
  view,
  now,
  canOpenChange,
}: {
  readonly sessionId: string;
  readonly view: {
    readonly land: boolean;
    readonly landings: Parameters<typeof pullRequestOf>[0];
    readonly facts: Parameters<typeof landingLine>[0];
  };
  readonly now: Date;
  readonly canOpenChange: boolean;
}) {
  const pullRequest = pullRequestOf(view.landings);
  const line = landingLine(view.facts, now);
  return (
    <>
      {pullRequest === null ? (
        <span>None yet</span>
      ) : (
        <a href={pullRequest.url} target="_blank" rel="noreferrer" className={linkClass}>
          {pullRequest.words}
        </a>
      )}
      {pullRequest === null && view.land && canOpenChange ? (
        <ViewLink sessionId={sessionId} view="change" hash="land">
          Land…
        </ViewLink>
      ) : null}
      {line === null ? null : <Note danger={landingLineFailed(view.facts)}>{line}</Note>}
    </>
  );
}

/**
 * The checks the agent ran, as the record shows them (the commands that read as a test,
 * typecheck, lint or build), newest first, and the edits made since. The Checks view holds every
 * run; "View checks" opens it once it is there.
 */
function ChecksGroup({
  sessionId,
  opens,
}: {
  readonly sessionId: string;
  readonly opens: ViewOpens;
}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const now = useMinute();
  const conversation = useInfiniteQuery(conversationQuery(trpc, client, sessionId));
  const link = opens("checks") ? (
    <ViewLink sessionId={sessionId} view="checks">
      View checks
    </ViewLink>
  ) : null;
  if (conversation.isPending || conversation.isError)
    return (
      <Group title="Checks">
        <Unread
          failed={conversation.isError}
          retrying={conversation.isFetching}
          onRetry={() => void conversation.refetch()}
        />
      </Group>
    );
  const items = conversation.data.pages.flatMap((page) => page.items);
  const checks = observedChecks(items);
  const untested = untestedWords(
    items.filter((item) => item.kind === "file-change").map((item) => ({ at: item.updatedAt })),
    checks,
  );
  return (
    <Group title="Checks">
      {checks.length === 0 ? (
        <p className="flex flex-wrap items-baseline gap-x-3 text-muted-foreground">
          No test, typecheck, lint or build seen in the record.
          {link}
        </p>
      ) : (
        <dl className="grid gap-2">
          {checks.slice(0, CHECKS_SHOWN).map((check) => (
            <Row key={check.command} label={check.command} mono>
              <span>{checkWords(check, now)}</span>
            </Row>
          ))}
          {checks.length > CHECKS_SHOWN || link !== null ? (
            <Row label="">
              {checks.length > CHECKS_SHOWN ? (
                <span className="text-muted-foreground">
                  and {checks.length - CHECKS_SHOWN} more
                </span>
              ) : null}
              {link}
            </Row>
          ) : null}
        </dl>
      )}
      {untested === null ? null : <p className="mt-2.5 font-medium">{untested}</p>}
    </Group>
  );
}

/**
 * The Services running in the workspace, each with what Mend observed of its port and Preview
 * once the Preview view is there, then the worktree's resources as the server words them.
 */
function ServicesGroup({
  place,
  opens,
  sessionIds,
}: {
  readonly place: DetailsPlace;
  readonly opens: ViewOpens;
  readonly sessionIds: ReadonlySet<string>;
}) {
  const trpc = useTRPC();
  const services = useQuery(trpc.services.list.queryOptions({ all: true }));
  // The read can restore a capture or exec into the workspace: it never holds the view back.
  const resources = useQuery(trpc.sessions.resourceStatus.queryOptions({ id: place.sessionId }));
  const preview = opens("preview");
  const rows =
    services.isPending || services.isError ? [] : workspaceServiceRows(services.data, sessionIds);
  const resourceLines = resources.isPending || resources.isError ? [] : resources.data;
  return (
    <Group title="Services">
      {services.isPending || services.isError ? (
        <Unread
          failed={services.isError}
          retrying={services.isFetching}
          onRetry={() => void services.refetch()}
        />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground">No Service running.</p>
      ) : (
        <dl className="grid gap-2">
          {rows.map((row) => (
            <Row key={row.id} label={row.name} mono>
              <span>{row.state}</span>
              {preview ? (
                <ViewLink sessionId={place.sessionId} view="preview">
                  Preview
                </ViewLink>
              ) : null}
            </Row>
          ))}
        </dl>
      )}
      {resourceLines.length === 0 ? null : (
        <ul className="mt-2.5 grid gap-1 font-mono text-meta wrap-anywhere">
          {resourceLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </Group>
  );
}

/** The repositories the session holds beside its worktree (docs/adr/0011); none, no group. */
function RepositoriesGroup({ facts }: { readonly facts: SessionFacts }) {
  const rows = repositoryRows(facts.detail.repositories);
  if (rows.length === 0) return null;
  return (
    <Group title="Repositories">
      <dl className="grid gap-2">
        {rows.map((row) => (
          <Row key={row.path} label={row.path} mono>
            <Note danger={row.failed}>{row.line}</Note>
            {row.changeId === null ? null : (
              <Link
                to="/changes/$changeId"
                params={{ changeId: row.changeId }}
                className={linkClass}
              >
                Review its change
              </Link>
            )}
          </Row>
        ))}
      </dl>
    </Group>
  );
}
