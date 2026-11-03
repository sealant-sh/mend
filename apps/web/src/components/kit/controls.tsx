import { NumberField } from "@base-ui/react/number-field";
import { cn } from "@mend/ui/lib/utils";
import type { ReactNode } from "react";

import { focusRing } from "./button";

/**
 * `.step3`: − value +, for a small count such as ready workspaces. A Base UI number field: the
 * arrows step it, typing sets it, and it stays inside `min` and `max`.
 */
export function Stepper({
  label,
  value,
  onValueChange,
  min = 0,
  max,
  disabled = false,
}: {
  readonly label: string;
  readonly value: number;
  readonly onValueChange: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
  readonly disabled?: boolean;
}) {
  const step = cn(
    "grid h-full place-items-center px-3 font-mono text-[13px] font-medium text-ink-2 transition-colors motion-reduce:transition-none hover:text-foreground disabled:opacity-40",
    focusRing,
  );
  return (
    <NumberField.Root
      value={value}
      min={min}
      {...(max === undefined ? {} : { max })}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null && next !== value) onValueChange(next);
      }}
    >
      <NumberField.Group className="inline-flex h-[34px] items-stretch rounded-[10px] border border-rule bg-panel">
        <NumberField.Decrement aria-label={`One fewer: ${label}`} className={step}>
          −
        </NumberField.Decrement>
        <NumberField.Input
          aria-label={label}
          className="w-11 border-x border-rule-faint bg-transparent text-center font-mono text-[13px] font-medium text-foreground outline-none focus-visible:bg-wash"
        />
        <NumberField.Increment aria-label={`One more: ${label}`} className={step}>
          +
        </NumberField.Increment>
      </NumberField.Group>
    </NumberField.Root>
  );
}

/** `.chip`: a quiet outlined mono word, such as `shared` or `private`. */
export function Chip({ children }: { readonly children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-rule px-2 py-[3px] font-mono text-[11.5px] text-ink-2">
      {children}
    </span>
  );
}

/** `.panel.list`: rows of a list on one panel, divided by a hairline. */
export function ListPanel({
  label,
  children,
  className,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <ul aria-label={label} className={cn("rounded-[22px] bg-panel p-1.5 shadow-sm", className)}>
      {children}
    </ul>
  );
}

/**
 * `.li`: a title, a mono line under it, and what sits on the right. Pass `title` as the row's link
 * or button so the whole row is one target.
 */
export function ListRow({
  title,
  meta,
  end,
  className,
}: {
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly end?: ReactNode;
  readonly className?: string;
}) {
  return (
    <li
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-3.5 py-3 [&+&]:border-t [&+&]:border-rule-faint",
        className,
      )}
    >
      <span className="min-w-0 truncate font-sans text-[14px] font-medium">{title}</span>
      {end === undefined ? null : (
        <span className="col-start-2 row-span-2 row-start-1 flex items-center gap-3">{end}</span>
      )}
      {meta === undefined ? null : (
        <span className="col-start-1 min-w-0 truncate font-mono text-[11.5px] leading-[1.4] text-muted-foreground">
          {meta}
        </span>
      )}
    </li>
  );
}
