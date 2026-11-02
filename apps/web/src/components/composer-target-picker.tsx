import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { Deferred, firstUse } from "#/components/kit/first-use";

import type * as Popup from "./composer-target-popup";

/** Base UI's combobox for the picker, loaded on first use (`#/components/kit/first-use`). */
const pickers = firstUse(() => import("./composer-target-popup"));

export interface TargetChoice {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

/** A compact destination control with keyboard search and an optional explicit creation action. */
export function ComposerTargetPicker(
  props: Omit<
    ComponentProps<typeof Popup.ComposerTargetPicker>,
    "trigger" | "defaultOpen" | "triggerRef"
  >,
) {
  const { label, choices, selectedId, disabled, lead, mono = false, emptyLabel } = props;
  const selected = choices.find((choice) => choice.id === selectedId) ?? null;
  const unpicked = emptyLabel ?? `Choose ${label.toLowerCase()}`;
  const trigger = (
    <button
      type="button"
      data-slot="combobox-trigger"
      disabled={disabled}
      aria-label={`${label}: ${selected?.label ?? unpicked}`}
      title={selected === null ? unpicked : `${selected.label} · ${selected.detail}`}
      className={`[&_svg:not([class*='size-'])]:size-4 inline-flex min-w-0 max-w-[220px] items-center ${mono ? "shrink" : "shrink-0"} gap-1.5 rounded-[8px] px-2.5 py-[5px] font-sans text-[12.5px] leading-[1.3] font-medium text-ink-2 transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-popup-open:bg-secondary data-popup-open:text-foreground disabled:opacity-50 [&>svg]:size-3 [&>svg]:text-faint`}
    >
      {lead}
      <span
        className={
          selected === null
            ? "truncate text-muted-foreground"
            : mono
              ? "truncate font-mono text-[11.5px] font-normal text-muted-foreground"
              : "truncate"
        }
      >
        {selected?.label ?? unpicked}
      </span>
      <ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />
    </button>
  );
  return (
    <Deferred code={pickers} trigger={trigger} popup="listbox">
      {(code, woken) => (
        <code.ComposerTargetPicker
          {...props}
          trigger={trigger}
          defaultOpen={woken.pressed}
          triggerRef={woken.triggerRef}
        />
      )}
    </Deferred>
  );
}
