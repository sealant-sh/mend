import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { BriefView } from "#/components/brief";
import { FailureBriefCard } from "#/components/failure-brief";
import { ReviewConversation } from "#/components/review-conversation";
import { AppShell } from "#/components/shell";
import { RunStatusDot } from "#/components/status";
import {
  type BriefDetailDto,
  type BriefVersionDto,
  type MendEventDto,
  type RunDto,
} from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

export const Route = createFileRoute("/issues/$issueId")({
  ssr: false,
  loader: async ({ context: { queryClient, trpc }, params }) => {
    const [detail, brief] = await Promise.all([
      queryClient.ensureQueryData(trpc.queue.issueDetail.queryOptions({ id: params.issueId })),
      queryClient.ensureQueryData(
        trpc.queue.briefByIssue.queryOptions({ issueId: params.issueId }),
      ),
    ]);
    const [comments, versions] =
      brief === null
        ? [[], []]
        : await Promise.all([
            queryClient.ensureQueryData(
              trpc.queue.listBriefComments.queryOptions({ issueId: params.issueId }),
            ),
            queryClient.ensureQueryData(
              trpc.queue.briefVersions.queryOptions({ issueId: params.issueId }),
            ),
          ]);
    return { ...detail, brief, comments, versions };
  },
  component: IssuePage,
});

function IssuePage() {
  const { issueId } = Route.useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  // The loader pre-warmed these; reading through live observers means an
  // invalidation refreshes the page — loader data alone would stay frozen
  // (ensureQueryData serves the cache even after it goes stale).
  const { data: detail } = useSuspenseQuery(trpc.queue.issueDetail.queryOptions({ id: issueId }));
  const { data: brief } = useSuspenseQuery(trpc.queue.briefByIssue.queryOptions({ issueId }));
  const { issue, runs } = detail;
  const commentsQuery = useQuery({
    ...trpc.queue.listBriefComments.queryOptions({ issueId }),
    enabled: brief !== null,
  });
  const versionsQuery = useQuery({
    ...trpc.queue.briefVersions.queryOptions({ issueId }),
    enabled: brief !== null,
  });
  const comments = commentsQuery.data ?? [];
  const versions = versionsQuery.data ?? [];

  // A live subscription has a real lifecycle — refresh when this issue's runs
  // settle or its brief recompiles.
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("message", (message) => {
      const event: MendEventDto = JSON.parse(message.data);
      if (event.type === "run-progress") return;
      if (event.issueId !== issue.id) return;
      void queryClient.invalidateQueries(trpc.queue.pathFilter());
    });
    return () => source.close();
  }, [queryClient, trpc, issue.id]);

  // The failure the card carried back to triage, when its recording was summed.
  const failureRun = runs.find((run) => run.id === issue.lastFailureRunId);
  const failure =
    failureRun === undefined || failureRun.failureBrief === null
      ? null
      : { run: failureRun, brief: failureRun.failureBrief };

  return (
    <AppShell>
      <div className="mb-8">
        <p className="ev-eyebrow">
          issue · {issue.source} · {issue.stage}
        </p>
        <h1 className="mt-2 max-w-[40ch] font-display text-3xl font-semibold tracking-[-0.02em]">
          {issue.title}
        </h1>
        <p className="mt-2 font-mono text-[12.5px] text-faint">
          {issue.externalRef ?? issue.repository}
        </p>
      </div>

      {brief === null ? (
        issue.stage === "mending" || issue.stage === "queued" ? (
          <p className="mb-8 max-w-[60ch] text-[13px] leading-relaxed text-muted-foreground">
            The brief compiles from the recording once a run completes.
          </p>
        ) : null
      ) : (
        <div className="mb-8 space-y-6">
          <VersionedBrief brief={brief} versions={versions} runs={runs} />
          <ReviewConversation
            issueId={issue.id}
            document={brief.brief.document}
            comments={comments}
          />
        </div>
      )}

      {failure === null ? null : (
        <div className="mb-8">
          <FailureBriefCard run={failure.run} brief={failure.brief} />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <section className="rounded-2xl bg-panel p-6 shadow-[var(--shadow-sm)]">
          <h2 className="font-sans text-sm font-semibold">The issue as filed</h2>
          {issue.body === "" ? (
            <p className="mt-3 text-[13px] text-muted-foreground">No body — the title is all.</p>
          ) : (
            <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-ink-2">
              {issue.body}
            </p>
          )}
        </section>

        <section className="rounded-2xl bg-panel p-6 shadow-[var(--shadow-sm)]">
          <div className="flex items-baseline justify-between">
            <h2 className="font-sans text-sm font-semibold">Runs</h2>
            <span className="font-mono text-xs text-faint">{runs.length}</span>
          </div>
          {runs.length === 0 ? (
            <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
              No runs yet. Drag the issue into the queue to start one.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-[var(--sw-faint-rule)]">
              {runs.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </AppShell>
  );
}

/**
 * The living brief with its history visible: prior versions stay readable, so
 * "what did the brief claim when I approved" has an answer on screen.
 */
function VersionedBrief({
  brief,
  versions,
  runs,
}: {
  readonly brief: BriefDetailDto;
  readonly versions: ReadonlyArray<BriefVersionDto>;
  readonly runs: ReadonlyArray<RunDto>;
}) {
  const [viewing, setViewing] = useState<number | null>(null);
  const current = brief.brief.currentVersion;
  const selected =
    viewing === null ? null : (versions.find((version) => version.version === viewing) ?? null);

  return (
    <div>
      {versions.length > 1 ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-label">
            version
          </span>
          <select
            className="rounded-lg border border-input bg-background px-2 py-1 font-mono text-[12px] outline-none focus:border-[var(--sw-accent)]"
            value={viewing ?? current}
            onChange={(event) => {
              const version = Number(event.target.value);
              setViewing(version === current ? null : version);
            }}
          >
            {versions.map((version) => (
              <option key={version.version} value={version.version}>
                v{version.version}
                {version.version === current ? " · current" : ""} ·{" "}
                {new Date(version.createdAt).toLocaleString()}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {selected === null ? null : (
        <p className="mb-3 border-l-2 border-[var(--sw-amber)] pl-3 text-[13px] leading-relaxed text-warning">
          Viewing version {selected.version}, superseded by version {current}. The living brief is
          the current one.
        </p>
      )}
      <BriefView
        detail={
          selected === null
            ? brief
            : { ...brief, brief: { ...brief.brief, document: selected.document } }
        }
        runs={runs}
      />
    </div>
  );
}

function RunRow({ run }: { readonly run: RunDto }) {
  return (
    <li>
      <Link
        to="/runs/$runId"
        params={{ runId: run.id }}
        className="block px-1 py-3 no-underline transition-colors duration-150 hover:bg-sunken/60"
      >
        <div className="flex items-center justify-between gap-3">
          <RunStatusDot status={run.status} />
          <span className="font-mono text-[11.5px] text-faint">{run.kind}</span>
        </div>
        {run.summary === null ? null : (
          <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">
            {run.summary}
          </p>
        )}
        <p className="mt-1.5 font-mono text-[11.5px] text-faint">
          {new Date(run.createdAt).toLocaleString()}
        </p>
      </Link>
    </li>
  );
}
