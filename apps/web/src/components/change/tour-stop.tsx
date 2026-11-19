import { Button } from "@mend/ui/components/ui/button";
import { cn } from "@mend/ui/lib/utils";
import { RouteIcon, XIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

/**
 * One stop of Mend's review tour (Doop "Tour stop"), shown in the Change view while the tour is on.
 * It reads as Mend's, not as a person's comment: the cobalt "Tour · 1 of 4" label, the stop's
 * title, the narration, then either "From the session" with links into the session (`kind:
 * "session"`) or one muted line saying it is Mend's own reading of the code (`kind: "reading"`).
 * End tour sits top right; Previous and Next (or Finish tour) go in `actions`.
 *
 * `place: "line"` sits between a file's rows, indented to the code; `"file"` under a file's
 * header; `"change"` under the Description, for a stop with no file. `size: "touch"` on a phone.
 */
export function TourStop({
  kind,
  place,
  size = "default",
  step,
  title,
  onEnd,
  links,
  actions,
  children,
  className,
  ...props
}: {
  readonly kind: "session" | "reading";
  readonly place: "line" | "file" | "change";
  readonly size?: "default" | "touch";
  /** "Tour · 1 of 4"; in a narrow tile, "2 of 4". */
  readonly step: string;
  readonly title: string;
  readonly onEnd: () => void;
  readonly links?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
} & Omit<ComponentProps<"section">, "title" | "children">) {
  const touch = size === "touch";
  return (
    <section
      data-slot="tour-stop"
      data-kind={kind}
      data-place={place}
      data-size={size}
      aria-label={`${step}: ${title}`}
      className={cn(
        "border-y bg-band pt-3.5 pb-4 text-left font-sans tracking-normal whitespace-normal text-foreground",
        // Between rows the note starts beside the line numbers: its words line up with the code.
        touch ? "px-4" : place === "line" ? "pr-6 pl-4" : "px-6",
        className,
      )}
      {...props}
    >
      <div className="flex min-h-7 items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-meta font-medium text-info">
          <RouteIcon aria-hidden className="size-3.5" />
          {step}
        </span>
        <Button
          variant="ghost"
          size={touch ? "touch" : "sm"}
          onClick={onEnd}
          className={cn("ml-auto text-muted-foreground", touch && "-mr-2 px-2")}
        >
          <XIcon aria-hidden />
          End tour
        </Button>
      </div>
      <h3 className="mt-1 text-lead font-semibold">{title}</h3>
      <p className="mt-1 max-w-[760px] text-prose text-pretty [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-px [&_code]:font-mono [&_code]:text-meta">
        {children}
      </p>
      {kind === "session" ? (
        <div className="mt-2.5">
          <p className="text-meta text-muted-foreground">From the session</p>
          <div className="mt-1 flex flex-col items-start gap-0.5">{links}</div>
        </div>
      ) : (
        <p className="mt-2.5 text-control text-muted-foreground">
          Mend's reading of the code. Nothing in the session backs this up.
        </p>
      )}
      {actions === undefined ? null : (
        <div className={cn("mt-3.5 flex items-center gap-2", touch && "*:flex-1")}>{actions}</div>
      )}
    </section>
  );
}
