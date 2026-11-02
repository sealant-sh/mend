import { NumberField } from "@base-ui/react/number-field";
import { Switch } from "@base-ui/react/switch";
import { cn } from "@mend/ui/lib/utils";
import { useId, type ReactNode } from "react";

import { Button, focusRing } from "./button";

/**
 * `.tg` with `.sw`: a setting's label and its on/off switch. A Base UI switch named by the label,
 * so Space toggles it and assistive technology hears "switch, on". `pending` keeps it from being
 * pressed twice while a save is in flight; the checked state the caller passes is what shows, so
 * an optimistic save moves it at once and a refusal moves it back.
 *
 * ```tsx
 * <SwitchRow label="Automatic install" checked={project.installEnabled} onCheckedChange={save} />
 * ```
 */
export function SwitchRow({
  label,
  detail,
  checked,
  onCheckedChange,
  disabled = false,
  pending = false,
}: {
  readonly label: ReactNode;
  /** A quiet line under the label. */
  readonly detail?: ReactNode;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly disabled?: boolean;
  readonly pending?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 font-sans text-[13.5px] [&+&]:border-t [&+&]:border-rule-faint">
      <span className="min-w-0">
        <span id={id} className="block">
          {label}
        </span>
        {detail === undefined ? null : (
          <span className="mt-0.5 block text-[12.5px] text-muted-foreground">{detail}</span>
        )}
      </span>
      <Switch.Root
        aria-labelledby={id}
        aria-busy={pending || undefined}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => {
          if (!pending) onCheckedChange(next);
        }}
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full bg-rule transition-colors duration-150 data-checked:bg-primary data-disabled:opacity-50",
          focusRing,
        )}
      >
        <Switch.Thumb className="absolute top-[3px] left-[3px] size-3.5 rounded-full bg-white shadow-xs transition-[translate] duration-150 data-checked:translate-x-4" />
      </Switch.Root>
    </div>
  );
}

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
    "grid h-full place-items-center px-3 font-mono text-[13px] font-medium text-ink-2 transition-colors hover:text-foreground disabled:opacity-40",
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

/**
 * `.savebar`: the unsaved changes of a draft section and its Discard and Save. Says what saving
 * will do (`1 unsaved change · rebuilds the image`) and stays out of the way when nothing changed.
 */
export function SaveBar({
  summary,
  saveLabel,
  onSave,
  onDiscard,
  pending = false,
  error,
}: {
  readonly summary: ReactNode;
  readonly saveLabel: string;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
  readonly pending?: boolean;
  readonly error?: ReactNode;
}) {
  return (
    <div className="mt-3.5 rounded-[22px] bg-panel py-3 pr-4 pl-5 shadow-sm">
      <div className="flex items-center gap-2.5">
        <span className="font-mono text-[12px] text-muted-foreground">{summary}</span>
        <span className="flex-1" />
        <Button variant="ghost" onClick={onDiscard} disabled={pending}>
          Discard
        </Button>
        <Button variant="primary" onClick={onSave} disabled={pending}>
          {pending ? "Saving…" : saveLabel}
        </Button>
      </div>
      <p role="alert" className="mt-2 font-mono text-[11.5px] text-danger empty:hidden">
        {error}
      </p>
    </div>
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

/** `.codebox`: a line to copy, such as a public key or a command. */
export function CodeBox({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <code
      className={cn(
        "block rounded-[10px] border border-rule bg-panel px-3 py-2 font-mono text-[12.5px] leading-[1.8] break-all text-ink-2",
        className,
      )}
    >
      {children}
    </code>
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
