import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { cn } from "@mend/ui/lib/utils";
import type { ReactNode } from "react";

import { focusRing } from "./button";
import { Icon, type IconName } from "./icons";
import { Tip } from "./tip";

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
  /** A mono count after the label (`.seg .n`). */
  readonly count?: ReactNode;
  /** A hover and focus note for this option. */
  readonly tip?: ReactNode;
  readonly className?: string;
}

/**
 * `.seg`: one choice among a few, on a sunken track. A Base UI toggle group: arrow keys move
 * between options, Space or Enter picks one, and each option reports `aria-pressed`. One option
 * is always picked; pressing the picked one again keeps it.
 *
 * ```tsx
 * <Segment label="Diff layout" value={layout} onChange={setLayout}
 *   options={[{ value: "unified", label: "Unified" }, { value: "split", label: "Split" }]} />
 * ```
 */
export function Segment<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  className,
}: {
  readonly label: string;
  readonly options: ReadonlyArray<SegmentOption<T>>;
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      disabled={disabled}
      onValueChange={(next) => {
        const picked = options.find((option) => next.includes(option.value));
        if (picked !== undefined && picked.value !== value) onChange(picked.value);
      }}
      className={cn(
        "inline-flex w-fit gap-0.5 rounded-xl bg-secondary p-[3px] data-disabled:opacity-60",
        className,
      )}
    >
      {options.map((option) => {
        const item = (
          <Toggle
            key={option.value}
            value={option.value}
            className={cn(
              "flex items-center gap-[7px] rounded-[9px] px-3 py-1.5 font-sans text-[13px] leading-[1.3] font-medium whitespace-nowrap text-ink-2 transition-colors hover:text-foreground data-pressed:bg-panel data-pressed:text-foreground data-pressed:shadow-xs",
              focusRing,
              option.className,
            )}
          >
            {option.label}
            {option.count === undefined ? null : (
              <span className="font-mono text-[11px] font-normal text-muted-foreground">
                {option.count}
              </span>
            )}
          </Toggle>
        );
        return option.tip === undefined ? (
          item
        ) : (
          <Tip key={option.value} content={option.tip}>
            {item}
          </Tip>
        );
      })}
    </ToggleGroup>
  );
}

/**
 * `.lay`: a few choices drawn as icons on a small sunken track, such as a session's layout. Each
 * option's `label` is its accessible name and its hover title. Arrow keys move between options and
 * Space or Enter picks one, as in `Segment`.
 */
export function IconSegment<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  readonly label: string;
  readonly options: ReadonlyArray<{
    readonly value: T;
    readonly icon: IconName;
    readonly label: string;
  }>;
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly className?: string;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(next) => {
        const picked = options.find((option) => next.includes(option.value));
        if (picked !== undefined && picked.value !== value) onChange(picked.value);
      }}
      className={cn("inline-flex gap-0.5 rounded-[10px] bg-secondary p-0.5", className)}
    >
      {options.map((option) => (
        <Toggle
          key={option.value}
          value={option.value}
          aria-label={option.label}
          title={option.label}
          className={cn(
            "grid h-[26px] w-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:text-foreground data-pressed:bg-panel data-pressed:text-foreground data-pressed:shadow-xs",
            focusRing,
          )}
        >
          <Icon name={option.icon} size={15} />
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
