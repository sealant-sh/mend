import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { cn } from "@mend/ui/lib/utils";

import { focusRing } from "./button";
import { Icon } from "./icons";

/**
 * `.chk` as a control: the square check, a Base UI checkbox. Space toggles it; `label` is its
 * accessible name when no visible label sits beside it (a table row's first cell).
 *
 * ```tsx
 * <Checkbox label={`Use ${reference.name} here`} checked={used} onCheckedChange={toggle} />
 * ```
 */
export function Checkbox({
  label,
  checked,
  onCheckedChange,
  disabled = false,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}) {
  return (
    <CheckboxPrimitive.Root
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(next) => onCheckedChange(next)}
      className={cn(
        "inline-grid size-[15px] shrink-0 place-items-center rounded-[4px] border-[1.5px] border-input transition-colors data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground data-disabled:opacity-50",
        focusRing,
      )}
    >
      <CheckboxPrimitive.Indicator>
        <Icon name="check" size={11} strokeWidth={2.6} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
