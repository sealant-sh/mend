import { Switch } from "@base-ui/react/switch";
import { cn } from "@mend/ui/lib/utils";
import { useId, type ReactNode } from "react";

import { focusRing } from "./button";

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
  /** A quiet line under the label: what the setting does, or where its value comes from. */
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
          "relative h-5 w-9 shrink-0 rounded-full bg-rule transition-colors duration-150 motion-reduce:transition-none data-checked:bg-primary data-disabled:opacity-50",
          focusRing,
        )}
      >
        <Switch.Thumb className="absolute top-[3px] left-[3px] size-3.5 rounded-full bg-white shadow-xs transition-[translate] duration-150 motion-reduce:transition-none data-checked:translate-x-4" />
      </Switch.Root>
    </div>
  );
}
