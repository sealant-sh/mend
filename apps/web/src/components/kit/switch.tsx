import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@mend/ui/lib/utils";
import { useId, type ReactNode } from "react";

import { focusRing } from "./button";

/**
 * `.sw`: an on/off switch. A Base UI switch: it reports `role="switch"` and `aria-checked`, and
 * Space or Enter flips it. Name it with `label` or point `labelledBy` at the text beside it.
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  labelledBy,
  disabled = false,
  className,
}: {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly label?: string;
  readonly labelledBy?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next)}
      disabled={disabled}
      {...(label === undefined ? {} : { "aria-label": label })}
      {...(labelledBy === undefined ? {} : { "aria-labelledby": labelledBy })}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-rule transition-colors duration-150 data-checked:bg-primary data-disabled:opacity-50 motion-reduce:transition-none",
        focusRing,
        className,
      )}
    >
      <SwitchPrimitive.Thumb className="block size-3.5 translate-x-[3px] rounded-full bg-white shadow-xs transition-transform duration-150 data-checked:translate-x-[19px] motion-reduce:transition-none" />
    </SwitchPrimitive.Root>
  );
}

/**
 * `.tg` with a switch: a setting's label on the left and its switch on the right. The label names
 * the switch. `note` is a quiet mono line under the label (where the value comes from, a refusal).
 *
 * ```tsx
 * <SwitchRow label="Send steers the running turn" checked={steers} onCheckedChange={save} />
 * ```
 */
export function SwitchRow({
  label,
  note,
  checked,
  onCheckedChange,
  disabled,
}: {
  readonly label: ReactNode;
  readonly note?: ReactNode;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 font-sans text-[13.5px] [&+&]:border-t [&+&]:border-rule-faint">
      <div className="min-w-0">
        <span id={id}>{label}</span>
        {note === undefined ? null : (
          <p className="mt-0.5 font-mono text-[11px] text-faint">{note}</p>
        )}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        labelledBy={id}
        disabled={disabled ?? false}
      />
    </div>
  );
}
