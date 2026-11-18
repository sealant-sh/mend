import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { cn } from "@mend/ui/lib/utils";
import type * as React from "react";

/**
 * One choice out of a few, side by side on a muted track, the chosen one raised: Shared · Own ·
 * Off, Dump file · Postgres URL. A value, not a view: for switching what a page shows, use Tabs.
 * Exactly one option is always chosen; pressing the chosen one again keeps it. `size="touch"` is
 * the phone size (44px).
 */
function Segmented<V extends string>({
  value,
  options,
  onValueChange,
  disabled = false,
  size = "default",
  className,
  "aria-label": label,
}: {
  value: V;
  options: ReadonlyArray<{ value: V; label: React.ReactNode; disabled?: boolean }>;
  onValueChange: (value: V) => void;
  disabled?: boolean;
  size?: "default" | "touch";
  className?: string;
  "aria-label": string;
}) {
  return (
    <ToggleGroupPrimitive
      data-slot="segmented"
      data-size={size}
      aria-label={label}
      value={[value]}
      disabled={disabled}
      onValueChange={(next: ReadonlyArray<string>) => {
        const picked = options.find((option) => option.value === next[0]);
        if (picked !== undefined && picked.value !== value) onValueChange(picked.value);
      }}
      className={cn(
        "inline-flex h-8 w-fit items-center rounded-lg bg-muted p-[3px] text-muted-foreground data-[size=touch]:h-11 data-disabled:opacity-60",
        className,
      )}
    >
      {options.map((option) => (
        <TogglePrimitive
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          data-slot="segmented-item"
          className={cn(
            "inline-flex h-full min-w-0 flex-1 items-center justify-center rounded-md border border-transparent px-3 text-sm font-medium whitespace-nowrap transition-colors outline-none",
            "hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none",
            "data-pressed:bg-background data-pressed:text-foreground data-pressed:shadow-sm dark:data-pressed:border-input dark:data-pressed:bg-input/30",
            "in-data-[size=touch]:px-4 in-data-[size=touch]:text-base",
          )}
        >
          {option.label}
        </TogglePrimitive>
      ))}
    </ToggleGroupPrimitive>
  );
}

export { Segmented };
