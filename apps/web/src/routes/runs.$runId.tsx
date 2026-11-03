import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { AppShell } from "#/components/shell";
import { RunStatusDot } from "#/components/status";
import { type RunSourceDto, type TraceEntryDto } from "#/lib/api";
import { orLogin, useTRPC, useTRPCClient } from "#/lib/trpc";

export const Route = createFileRoute("/runs/$runId")({
  ssr: false,
  loader: async ({ context: { queryClient, trpc }, params }) => {
    const [detail, trace, sources] = await Promise.all([
      queryClient.ensureQueryData(trpc.queue.runDetail.queryOptions({ id: params.runId })),
      queryClient.ensureQueryData(trpc.queue.runTrace.queryOptions({ id: params.runId })),
      queryClient.ensureQueryData(trpc.queue.runSources.queryOptions({ id: params.runId })),
    ]);
    return { ...detail, trace, sources };
  },
  component: RunPage,
});

function RunPage() {
  const { runId } = Route.useParams();
  const trpc = useTRPC();
  // Loader pre-warms; live observers keep a revisit from serving a
  // gcTime-old trace with nothing to refresh it.
  const { data: detail } = useSuspenseQuery(trpc.queue.runDetail.queryOptions({ id: runId }));
  const { data: trace } = useSuspenseQuery(trpc.queue.runTrace.queryOptions({ id: runId }));
  const { data: sources } = useSuspenseQuery(trpc.queue.runSources.queryOptions({ id: runId }));
  const { run, commands, transcript, loss, recordError } = detail;

  return (
    <AppShell>
      <div className="mb-8">
        <p className="ev-eyebrow">run audit · {run.kind}</p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-[-0.02em]">The run</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The deep view behind the brief: milestones · full trace · sources. Every event was
          observed by the runtime.
        </p>
      </div>

      <div className="space-y-6">
        {/* The run-record motif: lifted panel, mono facts, hairline rows. */}
        <section className="rounded-2xl bg-panel p-6 shadow-[var(--shadow-sm)]">
          <div className="flex items-center justify-between gap-4">
            <RunStatusDot status={run.status} />
            <span className="font-mono text-[11.5px] text-faint">{run.id.slice(0, 8)}</span>
          </div>
          <div className="mt-5 space-y-2.5 border-t border-[var(--sw-faint-rule)] pt-5">
            <Fact label="issue">
              <Link
                to="/issues/$issueId"
                params={{ issueId: run.issueId }}
                className="text-[var(--sw-accent)] no-underline hover:underline"
              >
                {run.issueId.slice(0, 8)}
              </Link>
            </Fact>
            <Fact label="sealant run">{run.sealantRunId ?? "never started"}</Fact>
            <Fact label="started">
              {run.startedAt === null ? "—" : new Date(run.startedAt).toLocaleString()}
            </Fact>
            <Fact label="settled">
              {run.settledAt === null ? "—" : new Date(run.settledAt).toLocaleString()}
            </Fact>
            {loss === null ? null : (
              <Fact label="record">
                {loss.complete ? (
                  <span className="text-success">complete · no telemetry lost</span>
                ) : (
                  <span className="text-warning">
                    {loss.spans.length} telemetry gap{loss.spans.length === 1 ? "" : "s"}
                    {loss.spans
                      .map((span) =>
                        span.fromSequence === null && span.toSequence === null
                          ? ""
                          : ` · ${span.fromSequence ?? "?"}–${span.toSequence ?? "?"}`,
                      )
                      .join("")}
                  </span>
                )}
              </Fact>
            )}
          </div>
          {run.summary === null ? null : (
            <p className="mt-5 border-t border-[var(--sw-faint-rule)] pt-5 text-sm leading-relaxed text-ink-2">
              {run.summary}
            </p>
          )}
        </section>

        {recordError === null ? null : (
          <p className="border-l-2 border-[var(--sw-amber)] pl-3 text-[13px] leading-relaxed text-warning">
            The recording could not be read: <span className="font-mono">{recordError}</span>
          </p>
        )}

        {commands.length === 0 ? null : (
          <section className="rounded-2xl bg-panel shadow-[var(--shadow-sm)]">
            <div className="rounded-t-2xl border-b border-[var(--sw-soft-rule)] bg-sunken px-6 py-3">
              <h2 className="font-sans text-[13px] font-semibold">Milestones</h2>
              <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                The commands the run executed, reconstructed from the record.
              </p>
            </div>
            <ul className="divide-y divide-[var(--sw-faint-rule)] px-6">
              {commands.map((command, index) => (
                <li key={index} className="flex items-baseline justify-between gap-4 py-3">
                  <code className="min-w-0 font-mono text-[12.5px] break-all text-ink-2">
                    {command.command}
                  </code>
                  <span
                    className={`shrink-0 font-mono text-[11.5px] ${
                      command.exitCode === 0
                        ? "text-success"
                        : command.exitCode === null
                          ? "text-faint"
                          : "text-danger"
                    }`}
                  >
                    {command.exitCode === null ? "—" : `exit ${command.exitCode}`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <FullTrace runId={run.id} initial={trace} />

        <section className="rounded-2xl bg-panel shadow-[var(--shadow-sm)]">
          <div className="rounded-t-2xl border-b border-[var(--sw-soft-rule)] bg-sunken px-6 py-3">
            <h2 className="font-sans text-[13px] font-semibold">Sources</h2>
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">
              Every network source the run touched, from the record's source events.
            </p>
          </div>
          {sources.length === 0 ? (
            <p className="px-6 py-4 text-[13px] text-muted-foreground">
              No network sources in the record.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--sw-faint-rule)] px-6">
              {sources.map((source) => (
                <SourceRow
                  key={`${source.host}${source.path}${source.firstSequence}`}
                  source={source}
                />
              ))}
            </ul>
          )}
        </section>

        {transcript === null ? null : (
          <section className="rounded-2xl bg-panel shadow-[var(--shadow-sm)]">
            <div className="rounded-t-2xl border-b border-[var(--sw-soft-rule)] bg-sunken px-6 py-3">
              <h2 className="font-sans text-[13px] font-semibold">Transcript</h2>
            </div>
            <pre className="max-h-[32rem] overflow-auto px-6 py-4 font-mono text-[12px] leading-relaxed text-ink-2">
              {transcript}
            </pre>
          </section>
        )}
      </div>
    </AppShell>
  );
}

function FullTrace({
  runId,
  initial,
}: {
  readonly runId: string;
  readonly initial: { entries: ReadonlyArray<TraceEntryDto>; nextFrom: string | null };
}) {
  const [entries, setEntries] = useState(initial.entries);
  const [nextFrom, setNextFrom] = useState(initial.nextFrom);
  const [loading, setLoading] = useState(false);
  const client = useTRPCClient();

  const loadMore = async () => {
    if (nextFrom === null || loading) return;
    setLoading(true);
    try {
      const page = await orLogin(client.queue.runTrace.query({ id: runId, from: nextFrom }));
      setEntries((current) => [...current, ...page.entries]);
      setNextFrom(page.nextFrom);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="rounded-2xl bg-panel shadow-[var(--shadow-sm)]">
      <div className="rounded-t-2xl border-b border-[var(--sw-soft-rule)] bg-sunken px-6 py-3">
        <h2 className="font-sans text-[13px] font-semibold">Full trace</h2>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">
          The timeline as recorded, one summary line per event.
        </p>
      </div>
      {entries.length === 0 ? (
        <p className="px-6 py-4 text-[13px] text-muted-foreground">Nothing recorded yet.</p>
      ) : (
        <ul className="max-h-[32rem] divide-y divide-[var(--sw-faint-rule)] overflow-auto px-6">
          {entries.map((entry) => (
            <li key={entry.sequence} id={`seq-${entry.sequence}`} className="flex gap-4 py-2">
              <span className="w-16 shrink-0 text-right font-mono text-[11px] text-faint">
                {entry.sequence}
              </span>
              <span className="w-40 shrink-0 truncate font-mono text-[11px] text-label">
                {entry.kind}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">
                {entry.summary}
              </span>
            </li>
          ))}
        </ul>
      )}
      {nextFrom === null ? null : (
        <div className="border-t border-[var(--sw-faint-rule)] px-6 py-3">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loading}
            className="font-mono text-[12px] text-primary hover:underline disabled:opacity-50"
          >
            {loading ? "Loading…" : `Load more (from ${nextFrom})`}
          </button>
        </div>
      )}
    </section>
  );
}

function SourceRow({ source }: { readonly source: RunSourceDto }) {
  return (
    <li className="flex items-baseline justify-between gap-4 py-3">
      <code className="min-w-0 font-mono text-[12.5px] break-all text-ink-2">
        {source.method === null ? "" : `${source.method} `}
        {source.host}
        {source.path ?? ""}
      </code>
      <span className="shrink-0 font-mono text-[11.5px] text-faint">
        {source.status === null ? "" : `${source.status} · `}
        {source.count === 1 ? "once" : `×${source.count}`}
      </span>
    </li>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-28 shrink-0 font-mono text-xs tracking-[0.06em] uppercase text-label">
        {label}
      </span>
      <span className="font-mono text-[12.5px] break-all text-ink-2">{children}</span>
    </div>
  );
}
