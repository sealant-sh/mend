// The failure mini-brief — a failed run summed from its recording: what was
// tried, what was observed, reproduction status, and the way into the run
// audit. Failures are evidence too; the card reports, it never softens.

import { Link } from "@tanstack/react-router";

import type { FailureBriefDto, RunDto } from "#/lib/api";

import { EvidenceList, SectionLabel } from "./brief";

export function FailureBriefCard({
  run,
  brief,
}: {
  readonly run: RunDto;
  readonly brief: FailureBriefDto;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-panel shadow-[var(--shadow-sm)]">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-rule bg-[var(--sw-sunken)] px-5 py-3">
        <span className="inline-flex items-center gap-1.5 font-mono text-[0.72rem] text-ink-2">
          <span className="size-1.5 rounded-full bg-[var(--sw-red)]" aria-hidden="true" />
          Run failed · summed from the recording
        </span>
        <Link
          to="/runs/$runId"
          params={{ runId: run.id }}
          className="font-mono text-[0.68rem] text-primary no-underline hover:underline"
        >
          Run audit
        </Link>
      </div>

      <div className="space-y-5 px-5 py-5">
        <div>
          <SectionLabel>What was tried</SectionLabel>
          <p className="mt-1.5 max-w-[58ch] text-[0.86rem] leading-relaxed text-foreground">
            {brief.whatWasTried}
          </p>
        </div>
        <div>
          <SectionLabel>What was observed</SectionLabel>
          <p className="mt-1.5 max-w-[58ch] text-[0.86rem] leading-relaxed text-foreground">
            {brief.whatWasObserved}
          </p>
        </div>
        <div>
          <SectionLabel>Reproduction</SectionLabel>
          <p className="mt-1.5 max-w-[58ch] text-[0.86rem] leading-relaxed text-foreground">
            {brief.reproductionStatus}
          </p>
        </div>
        {brief.evidence.length === 0 ? null : (
          <p>
            <EvidenceList evidence={brief.evidence} />
          </p>
        )}
      </div>
    </section>
  );
}
