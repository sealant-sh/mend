// The brief — the compiled review, rendered from the living document. The
// canonical anatomy (the marketing mock's) at working scale: a main reading
// column (the issue → the account → the review questions) beside a rail
// carrying what the reviewer acts on (attention callouts, evidence used).
// Machine facts stay mono, dispositions stay earned, gaps stay first-class,
// and every evidence pointer clicks through to the run it came from, labeled
// by which run that was. The compiler's content contract (one fact, one
// place, one sentence) is what keeps this geometry honest.

import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";

import type {
  BriefDetailDto,
  BriefDocumentDto,
  DispositionDto,
  EvidencePointerDto,
  RunDto,
} from "#/lib/api";

const DISPOSITION: Record<DispositionDto, { word: string; dot: string; text: string }> = {
  "direct-evidence": {
    word: "Direct evidence",
    dot: "bg-[var(--sw-green-dot)]",
    text: "text-success",
  },
  "not-executed": { word: "Not executed", dot: "bg-[var(--sw-amber)]", text: "text-warning" },
  "unrelated-change": { word: "Unrelated change", dot: "bg-[var(--sw-red)]", text: "text-danger" },
};

/** Which run a pointer belongs to, by kind — "initial · seq 2" over a bare "seq 2". */
export type RunLabels = ReadonlyMap<string, string>;

export const runLabelsFrom = (runs: ReadonlyArray<RunDto>): RunLabels => {
  const kindCounts = new Map<string, number>();
  for (const run of runs) kindCounts.set(run.kind, (kindCounts.get(run.kind) ?? 0) + 1);
  return new Map(
    runs.map((run) => [
      run.id,
      (kindCounts.get(run.kind) ?? 0) > 1 ? `${run.kind} ${run.id.slice(0, 8)}` : run.kind,
    ]),
  );
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shortRef = (value: string) => (UUID_RE.test(value) ? value.slice(0, 8) : value);

export function SectionLabel({ children }: { readonly children: ReactNode }) {
  return <p className="text-[0.78rem] font-medium text-label">{children}</p>;
}

function Dot({ tone }: { readonly tone: "green" | "amber" | "red" | "accent" | "hollow" }) {
  const fill =
    tone === "green"
      ? "bg-[var(--sw-green-dot)]"
      : tone === "amber"
        ? "bg-[var(--sw-amber)]"
        : tone === "red"
          ? "bg-[var(--sw-red)]"
          : tone === "accent"
            ? "bg-primary"
            : "border-[1.5px] border-[var(--sw-faint)] bg-transparent";
  return <span className={`size-2 shrink-0 rounded-full ${fill}`} aria-hidden="true" />;
}

/** A pointer's link back to the recording: run + sequence, excerpt on hover. */
function EvidenceLink({ pointer }: { readonly pointer: EvidencePointerDto }) {
  return (
    <Link
      to="/runs/$runId"
      params={{ runId: pointer.runId }}
      title={pointer.excerpt}
      className="font-mono text-[0.72rem] text-primary no-underline hover:underline"
    >
      seq {pointer.sequence}
    </Link>
  );
}

export function EvidenceList({
  evidence,
  runLabels,
}: {
  readonly evidence: ReadonlyArray<EvidencePointerDto>;
  readonly runLabels?: RunLabels | undefined;
}) {
  if (evidence.length === 0) return null;
  const groups = new Map<string, Array<EvidencePointerDto>>();
  for (const pointer of evidence) {
    const entries = groups.get(pointer.runId) ?? [];
    entries.push(pointer);
    groups.set(pointer.runId, entries);
  }
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-4 gap-y-1">
      {[...groups.entries()].map(([runId, pointers]) => (
        <span key={runId} className="inline-flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-[0.72rem] text-faint">
            {runLabels?.get(runId) ?? `run ${runId.slice(0, 8)}`}
          </span>
          {pointers.map((pointer) => (
            <EvidenceLink key={`${pointer.runId}:${pointer.sequence}`} pointer={pointer} />
          ))}
        </span>
      ))}
    </span>
  );
}

/** The proof legs, raw and mono — a dot per leg, observed or not. Never struck through. */
function CausalProof({ document }: { readonly document: BriefDocumentDto }) {
  const { baseFails, headPasses, revertFails } = document.causalProof;
  const legs: ReadonlyArray<readonly [string, EvidencePointerDto | null]> = [
    ["base fails", baseFails],
    ["head passes", headPasses],
    ["revert fails", revertFails],
  ];
  const observed = legs.filter(([, pointer]) => pointer !== null).length;

  return (
    <div className="shrink-0 lg:text-right">
      <SectionLabel>Causal proof</SectionLabel>
      <p className="mt-2 flex items-center gap-2 lg:justify-end">
        <Dot tone={observed === 0 ? "hollow" : "green"} />
        <span
          className={`text-[0.85rem] font-medium ${observed === 0 ? "text-ink-2" : "text-success"}`}
        >
          {observed === 0 ? "Not executed" : `${observed} of 3 legs observed`}
        </span>
      </p>
      <p className="mt-2.5 space-y-1 font-mono text-[0.75rem]">
        {legs.map(([label, pointer]) => (
          <span key={label} className="flex items-center gap-2 lg:justify-end">
            <span className={pointer === null ? "text-faint" : "text-ink-2"}>{label}</span>
            {pointer === null ? (
              <Dot tone="hollow" />
            ) : (
              <Link
                to="/runs/$runId"
                params={{ runId: pointer.runId }}
                title={pointer.excerpt}
                className="inline-flex items-center gap-2 text-success no-underline hover:underline"
              >
                seq {pointer.sequence}
                <Dot tone="green" />
              </Link>
            )}
          </span>
        ))}
      </p>
    </div>
  );
}

/** The main column: the issue, the account, the review questions. */
function MainColumn({
  document,
  runLabels,
}: {
  readonly document: BriefDocumentDto;
  readonly runLabels?: RunLabels | undefined;
}) {
  const tallies = [
    {
      count: document.questions.filter((q) => q.disposition === "direct-evidence").length,
      label: (n: number) => `${n} directly observed`,
    },
    {
      count: document.questions.filter((q) => q.disposition === "not-executed").length,
      label: (n: number) => `${n} ${n === 1 ? "scenario" : "scenarios"} not run`,
    },
    {
      count: document.questions.filter((q) => q.disposition === "unrelated-change").length,
      label: (n: number) => `${n} unrelated ${n === 1 ? "edit" : "edits"}`,
    },
  ]
    .filter((t) => t.count > 0)
    .map((t) => t.label(t.count))
    .join(" · ");

  return (
    <div className="min-w-0 flex-1 px-6 py-6 sm:px-8">
      <div className="flex flex-col gap-x-12 gap-y-6 lg:flex-row lg:justify-between">
        <div className="min-w-0">
          <SectionLabel>The issue</SectionLabel>
          <p className="mt-2 max-w-[65ch] text-[0.9rem] leading-[1.6] text-foreground">
            {document.issueRestated}
          </p>
          {document.reproduction === null ? null : (
            <p className="mt-2 max-w-[80ch] font-mono text-[0.75rem] leading-[1.6] whitespace-pre-wrap text-muted-foreground">
              {document.reproduction}
            </p>
          )}
        </div>
        <CausalProof document={document} />
      </div>

      <div className="mt-6 border-t border-rule pt-5">
        <SectionLabel>What was done</SectionLabel>
        <p className="mt-2 max-w-[65ch] text-[0.9rem] leading-[1.6] text-foreground">
          {document.whatWasDone}
        </p>
        <p className="mt-2 max-w-[80ch] font-mono text-[0.75rem] leading-[1.6] text-muted-foreground">
          {document.monoFacts}
        </p>
        <div className="mt-5">
          <SectionLabel>Status now</SectionLabel>
          <p className="mt-2 max-w-[65ch] text-[0.9rem] leading-[1.6] text-foreground">
            {document.statusNow}
          </p>
        </div>
      </div>

      <div className="mt-6 border-t border-rule pt-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <SectionLabel>Review questions</SectionLabel>
          {tallies === "" ? null : <p className="font-mono text-[0.7rem] text-faint">{tallies}</p>}
        </div>
        <div className="mt-1.5">
          {document.questions.map((question) => {
            const d = DISPOSITION[question.disposition];
            return (
              <div
                key={question.index}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-rule-faint py-3 last:border-b-0"
              >
                <span className="flex min-w-0 items-baseline gap-3">
                  <span className="font-mono text-[0.72rem] text-faint">
                    {String(question.index).padStart(2, "0")}
                  </span>
                  <span className="min-w-0 max-w-[60ch] text-[0.875rem] leading-[1.5] font-medium text-foreground">
                    {question.question}
                    {question.evidence.length === 0 ? null : (
                      <span className="ml-2.5 font-normal">
                        <EvidenceList evidence={question.evidence} runLabels={runLabels} />
                      </span>
                    )}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Dot
                    tone={
                      question.disposition === "direct-evidence"
                        ? "green"
                        : question.disposition === "not-executed"
                          ? "amber"
                          : "red"
                    }
                  />
                  <span className={`font-mono text-[0.75rem] whitespace-nowrap ${d.text}`}>
                    {d.word}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const SOURCE_KIND: Record<string, string> = {
  read_issue: "Issue",
  read_change: "Change diff",
  read_recording: "Recording",
};

/** The rail: what the reviewer acts on — attention callouts, then the sources. */
function Rail({
  document,
  runLabels,
}: {
  readonly document: BriefDocumentDto;
  readonly runLabels?: RunLabels | undefined;
}) {
  return (
    <aside className="w-full shrink-0 border-t border-rule px-6 py-6 sm:px-8 lg:w-[19rem] lg:border-t-0 lg:border-l lg:px-6">
      <SectionLabel>What needs attention</SectionLabel>
      {document.attention.length === 0 ? (
        <p className="mt-3 flex items-center gap-2">
          <Dot tone="hollow" />
          <span className="text-[0.82rem] text-muted-foreground">
            No amber or red callouts in this compile.
          </span>
        </p>
      ) : (
        <div className="mt-3 space-y-4">
          {document.attention.map((callout) => {
            const d = DISPOSITION[callout.severity];
            return (
              <div
                key={callout.text}
                className={`border-l-2 pl-3 ${
                  callout.severity === "not-executed"
                    ? "border-[var(--sw-amber)]"
                    : "border-[var(--sw-red)]"
                }`}
              >
                <p className="text-[0.82rem] leading-[1.5] text-foreground">{callout.text}</p>
                <p className="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  <span className={`font-mono text-[0.7rem] ${d.text}`}>{d.word}</span>
                  <EvidenceList evidence={callout.evidence} runLabels={runLabels} />
                </p>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-6 border-t border-rule-faint pt-5">
        <SectionLabel>Evidence used</SectionLabel>
        {document.evidenceUsed.length === 0 ? (
          <p className="mt-3 text-[0.82rem] text-muted-foreground">
            No sources beyond the recording itself.
          </p>
        ) : (
          <div className="mt-2.5 space-y-3.5">
            {document.evidenceUsed.map((source) => {
              const [tool, ...rest] = source.source.split(" ");
              const kind = tool === undefined ? undefined : SOURCE_KIND[tool];
              const ref = rest.join(" ");
              return (
                <div key={source.source}>
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[0.82rem] font-medium text-foreground">
                      {kind ?? source.source}
                    </span>
                    {kind === undefined || ref === "" ? null : (
                      <span className="font-mono text-[0.68rem] text-faint">{shortRef(ref)}</span>
                    )}
                  </p>
                  <p className="mt-0.5 text-[0.78rem] leading-[1.5] text-muted-foreground">
                    {source.established}
                  </p>
                  {source.pointers.length === 0 ? null : (
                    <p className="mt-1">
                      <EvidenceList evidence={source.pointers} runLabels={runLabels} />
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}

export function BriefView({
  detail,
  runs,
}: {
  readonly detail: BriefDetailDto;
  readonly runs?: ReadonlyArray<RunDto>;
}) {
  const { brief, change } = detail;
  const document = brief.document;
  const runLabels = runs === undefined ? undefined : runLabelsFrom(runs);
  const tally = {
    total: document.questions.length,
    direct: document.questions.filter((q) => q.disposition === "direct-evidence").length,
  };
  const needJudgment = tally.total - tally.direct;

  return (
    <section aria-label="The brief" className="min-w-0">
      <div className="overflow-hidden rounded-2xl border border-border bg-panel shadow-[var(--shadow-md)]">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-rule bg-[var(--sw-sunken)] px-6 py-3 sm:px-8">
          <span className="min-w-0 truncate font-mono text-[0.78rem] text-ink-2">
            {document.header.repository}
            {document.header.prRef === null ? null : (
              <>
                {" "}
                <span className="text-faint">/</span>{" "}
                <span className="text-primary">{document.header.prRef}</span>
              </>
            )}{" "}
            <span className="text-faint">· issue {shortRef(document.header.issueRef)}</span>
            {document.header.headSha === null ? null : (
              <span className="text-faint"> · {document.header.headSha.slice(0, 7)}</span>
            )}
          </span>
          <span className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1">
            {document.header.checksCount === null ? null : (
              <span className="inline-flex items-center gap-1.5 font-mono text-[0.72rem] text-muted-foreground">
                {document.header.checksCount > 0 ? <Dot tone="green" /> : null}
                Checks {document.header.checksCount}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5 font-mono text-[0.72rem] text-muted-foreground">
              <Dot tone={document.header.freshness === "current" ? "accent" : "amber"} />
              Evidence {document.header.freshness}
            </span>
            <span className="font-mono text-[0.72rem] text-faint">v{brief.currentVersion}</span>
          </span>
        </div>

        <div className="flex flex-col lg:flex-row">
          <MainColumn document={document} runLabels={runLabels} />
          <Rail document={document} runLabels={runLabels} />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule bg-[var(--sw-sunken)] px-6 py-3.5 sm:px-8">
          <span className="font-mono text-[0.75rem] text-muted-foreground">
            {tally.total} review questions · {tally.direct} {tally.direct === 1 ? "has" : "have"}{" "}
            direct evidence · {needJudgment} need judgment
          </span>
          <span className="font-mono text-[0.72rem] text-faint">
            branch {change.branch === "" ? "(workspace)" : change.branch} · compiled{" "}
            {new Date(brief.updatedAt).toLocaleString()}
          </span>
        </div>
      </div>
    </section>
  );
}
