import { ToggleGroup, ToggleGroupItem } from "@mend/ui/components/ui/toggle-group";
import { cn } from "@mend/ui/lib/utils";
import { GitCompareArrowsIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { DiffLayout } from "#/lib/ui-prefs";

/**
 * The Change view's top row (Doop "Change toolbar"): what the change is measured over, Unified or
 * Split, one muted note, and the `actions` slot. Narrow (a tile beside a conversation, or a phone)
 * it keeps the range and the actions; the diffs are unified there, so the switch goes.
 *
 * The range is a chip with no menu while the server opens a review only over the whole change; a
 * range picker (S6) makes it a menu. Land… goes in `actions` (`land-dialog.tsx`), and Send
 * comments beside it (PR 24).
 */
export function ChangeToolbar({
  range,
  detail,
  layout,
  onLayoutChange,
  note,
  actions,
}: {
  /** "Whole change". */
  readonly range: string;
  /** The range in words: "main to checkpoint 7". */
  readonly detail: string;
  readonly layout: DiffLayout;
  readonly onLayoutChange: (layout: DiffLayout) => void;
  /** One muted line or two on the right; hidden when narrow. */
  readonly note?: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="flex h-[50px] shrink-0 items-center gap-2.5 border-b bg-background pr-4 pl-[18px] @max-3xl/change:h-auto @max-3xl/change:min-h-12 @max-3xl/change:px-4 @max-3xl/change:py-2">
      <span className="inline-flex h-8 min-w-0 items-center gap-[7px] rounded-lg border border-input px-2.5 text-control font-medium whitespace-nowrap @max-3xl/change:h-auto @max-3xl/change:border-0 @max-3xl/change:px-0 @max-3xl/change:text-lead">
        <GitCompareArrowsIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span>{range}</span>
        <span className="truncate font-normal text-muted-foreground">· {detail}</span>
      </span>
      <ToggleGroup
        aria-label="Diff layout"
        value={[layout]}
        onValueChange={(value: ReadonlyArray<unknown>) => {
          const next = value[0];
          if (next === "unified" || next === "split") onLayoutChange(next);
        }}
        spacing={0.5}
        className="shrink-0 rounded-lg bg-muted p-0.5 @max-3xl/change:hidden"
      >
        {(["unified", "split"] as const).map((value) => (
          <ToggleGroupItem
            key={value}
            value={value}
            size="sm"
            className="h-[26px] rounded-md px-2.5 text-meta font-medium text-muted-foreground aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-[0_0_0_1px_var(--color-input)] hover:bg-transparent"
          >
            {value === "unified" ? "Unified" : "Split"}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <span
        className={cn(
          "mr-1 ml-auto max-w-[340px] text-right text-meta leading-[1.35] text-muted-foreground @max-3xl/change:hidden",
          note === undefined && "invisible",
        )}
      >
        {note}
      </span>
      {actions === undefined ? null : (
        <span className="flex shrink-0 items-center gap-2 @max-3xl/change:ml-auto">{actions}</span>
      )}
    </div>
  );
}
