import { cn } from "@mend/ui/lib/utils";
import type { ReactNode } from "react";

/**
 * What a dot means (DESIGN.md §4): `run` live, `ok` observed success, `wait` waiting on a
 * person, `bad` observed failure, `off` not started or ended.
 */
export type Tone = "run" | "ok" | "wait" | "bad" | "off";

const DOT: Record<Tone, string> = {
  run: "bg-primary shadow-[0_0_0_3px_rgba(32,82,204,0.15)]",
  ok: "bg-success-dot",
  wait: "bg-warning-dot",
  bad: "bg-danger-dot",
  off: "border-[1.5px] border-[#b3b0a8] bg-transparent",
};

const WORD: Record<Tone, string> = {
  run: "text-ink-2",
  ok: "text-[#3f7d54]",
  wait: "text-warning",
  bad: "text-danger",
  off: "text-ink-2",
};

export function Dot({ tone, className }: { readonly tone: Tone; readonly className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-[7px] shrink-0 rounded-full", DOT[tone], className)}
    />
  );
}

/** `.st`: a dot and a mono word, never a filled badge. */
export function StatusWord({
  tone,
  children,
  className,
}: {
  readonly tone: Tone | null;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 font-mono text-[11px] leading-[1.4] whitespace-nowrap",
        tone === null ? "text-ink-2" : WORD[tone],
        className,
      )}
    >
      {tone === null ? null : <Dot tone={tone} />}
      <span className="truncate">{children}</span>
    </span>
  );
}
