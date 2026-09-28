import type { RunStatus, SessionStatusDto } from "#/lib/api";

/** Dot + word, never a glowing badge (DESIGN.md §4). */
export function StatusDot({
  tone,
  word,
  pulse,
}: {
  readonly tone: "green" | "red" | "amber" | "accent" | "hollow";
  readonly word: string;
  readonly pulse?: boolean;
}) {
  const dot =
    tone === "green"
      ? "bg-success-dot"
      : tone === "red"
        ? "bg-danger-dot"
        : tone === "amber"
          ? "bg-[var(--sw-amber)]"
          : tone === "accent"
            ? "bg-[var(--sw-accent)]"
            : "border-[1.5px] border-faint bg-transparent";
  const text =
    tone === "green"
      ? "text-success"
      : tone === "red"
        ? "text-danger"
        : tone === "amber"
          ? "text-warning"
          : tone === "accent"
            ? "text-info"
            : "text-ink-2";
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={`size-2 shrink-0 rounded-full ${dot} ${pulse === true ? "mend-status-running" : ""}`}
        aria-hidden="true"
      />
      <span className={`font-sans text-[13px] font-medium ${text}`}>{word}</span>
    </span>
  );
}

/**
 * Session lifecycle as dot + word (plan §16.4). `recorded` keeps the words
 * honest: "recording"/"observed" are claims about the record and are only
 * made when a Sealant run stands behind the session.
 */
export function SessionStatusDot({
  status,
  recorded,
}: {
  readonly status: SessionStatusDto;
  readonly recorded: boolean;
}) {
  switch (status) {
    case "starting":
      return <StatusDot tone="hollow" word="Starting" />;
    case "running":
      return (
        <StatusDot
          tone="accent"
          word={recorded ? "Running · recording" : "Running · unrecorded"}
          pulse
        />
      );
    case "waiting":
      return <StatusDot tone="amber" word="Waiting for input" />;
    case "idle":
      return <StatusDot tone="hollow" word="Idle" />;
    case "stopping":
      return <StatusDot tone="hollow" word="Stopping" />;
    case "completed":
      return <StatusDot tone="green" word={recorded ? "Completed · observed" : "Completed"} />;
    case "failed":
      return <StatusDot tone="red" word="Failed" />;
    case "stopped":
      return <StatusDot tone="hollow" word="Stopped" />;
  }
}

export function RunStatusDot({ status }: { readonly status: RunStatus }) {
  switch (status) {
    case "queued":
      return <StatusDot tone="hollow" word="Queued" />;
    case "running":
      return <StatusDot tone="accent" word="Running · recording" pulse />;
    case "completed":
      return <StatusDot tone="green" word="Completed · observed" />;
    case "failed":
      return <StatusDot tone="red" word="Failed · observed" />;
    case "cancelled":
      return <StatusDot tone="hollow" word="Cancelled" />;
  }
}
