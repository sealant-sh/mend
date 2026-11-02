import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { cn } from "@mend/ui/lib/utils";
import { useId, type ReactNode } from "react";

import { focusRing } from "./button";

export interface ChoiceCard<T extends string> {
  readonly value: T;
  readonly title: string;
  /** A mono line under the title ("recommended", "through the bridge"). */
  readonly tag?: ReactNode;
  /** The tag in cobalt, for the recommended choice. */
  readonly tagAccent?: boolean;
  readonly detail: ReactNode;
  /** What was observed about this choice, under the detail (a `StatusWord`). */
  readonly status?: ReactNode;
}

/**
 * One choice among a few, each a card with a sentence and what was observed about it (Git access:
 * Mend's key or your computer's key). A Base UI radio group: arrow keys move and pick, and each
 * card is a radio named by its title and described by its detail.
 *
 * ```tsx
 * <ChoiceCards label="Git access" value={mode} onChange={choose} options={[
 *   { value: "mend-key", title: "Mend's key", tag: "recommended", tagAccent: true, detail: "…", status: <StatusWord tone="ok">…</StatusWord> },
 *   { value: "bridge", title: "Your computer's key", tag: "through the bridge", detail: "…" },
 * ]} />
 * ```
 */
export function ChoiceCards<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  readonly label: string;
  readonly options: ReadonlyArray<ChoiceCard<T>>;
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly disabled?: boolean;
}) {
  const id = useId();
  return (
    <RadioGroup
      aria-label={label}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const picked = options.find((option) => option.value === next);
        if (picked !== undefined && picked.value !== value) onChange(picked.value);
      }}
      className="grid grid-cols-2 items-stretch gap-2.5 data-disabled:opacity-60"
    >
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          value={option.value}
          aria-labelledby={`${id}-${option.value}-title`}
          aria-describedby={`${id}-${option.value}-detail`}
          className={cn(
            "grid content-start rounded-[22px] border border-rule bg-panel p-3.5 text-left transition-colors motion-reduce:transition-none hover:border-input data-checked:border-primary",
            focusRing,
          )}
        >
          <b id={`${id}-${option.value}-title`} className="font-sans text-[13.5px] font-semibold">
            {option.title}
          </b>
          {option.tag === undefined ? null : (
            <span
              className={cn(
                "mt-0.5 mb-1.5 font-mono text-[11px]",
                option.tagAccent === true ? "text-info" : "text-muted-foreground",
              )}
            >
              {option.tag}
            </span>
          )}
          <span
            id={`${id}-${option.value}-detail`}
            className="mb-2 font-sans text-[12.5px] text-ink-2"
          >
            {option.detail}
          </span>
          {option.status}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}
