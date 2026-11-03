import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@mend/ui/components/ui/combobox";
import { Plus } from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";

import type { TargetChoice } from "./composer-target-picker";

/** The picker itself, which `./composer-target-picker` loads on first use. */
export function ComposerTargetPicker({
  label,
  choices,
  selectedId,
  disabled,
  onSelect,
  status,
  onCreate,
  trigger,
  defaultOpen,
  triggerRef,
}: {
  readonly label: "Project" | "Worktree";
  readonly choices: ReadonlyArray<TargetChoice>;
  readonly selectedId: string | null;
  readonly disabled: boolean;
  readonly onSelect: (id: string) => void;
  readonly status?: ReactNode;
  readonly onCreate?: () => void;
  /** Drawn before the value, such as the project's dot. */
  readonly lead?: ReactNode;
  /** The value in the mono voice, for a worktree or branch name. */
  readonly mono?: boolean;
  /** What happens with nothing picked, when that is a choice of its own ("New worktree from main"). */
  readonly emptyLabel?: string;
  readonly trigger: ReactElement;
  readonly defaultOpen: boolean;
  readonly triggerRef: ((element: HTMLElement | null) => void) | undefined;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const selected = choices.find((choice) => choice.id === selectedId) ?? null;
  const noun = label.toLowerCase();

  return (
    <Combobox
      items={choices}
      value={selected}
      itemToStringLabel={(choice) => choice.label}
      isItemEqualToValue={(choice, value) => choice.id === value.id}
      open={open}
      onOpenChange={setOpen}
      onValueChange={(choice) => {
        if (choice !== null) onSelect(choice.id);
        setOpen(false);
      }}
      autoHighlight
      disabled={disabled}
    >
      <ComboboxPrimitive.Trigger ref={triggerRef} render={trigger} />
      <ComboboxContent
        aria-label={`Choose ${noun}`}
        className="flex w-80 min-w-0 max-w-[calc(100vw-2rem)] flex-col motion-reduce:data-closed:animate-none motion-reduce:data-open:animate-none"
      >
        <ComboboxInput
          className="shrink-0"
          aria-label={`Search ${noun}s`}
          placeholder={`Find a ${noun}…`}
          showTrigger={false}
          autoFocus
          onKeyDown={(event) => {
            // The search lives in a portal, but Enter must not submit the composer behind it.
            if (event.key === "Enter") event.stopPropagation();
          }}
        />
        {status ? (
          <div className="px-3 py-4 text-xs text-muted-foreground">{status}</div>
        ) : (
          <>
            <ComboboxEmpty className="px-3 py-5 text-xs">
              {choices.length === 0 ? `No ${noun}s yet.` : `No matching ${noun}s.`}
            </ComboboxEmpty>
            <ComboboxList className="min-h-0">
              {(choice: TargetChoice) => (
                <ComboboxItem key={choice.id} value={choice} className="gap-3 px-2.5 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{choice.label}</span>
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                      {choice.detail}
                    </span>
                  </span>
                </ComboboxItem>
              )}
            </ComboboxList>
          </>
        )}
        {onCreate !== undefined && (
          <div className="shrink-0 border-t border-rule-faint p-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onCreate();
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Plus aria-hidden="true" className="size-3.5" />
              New {noun}
            </button>
          </div>
        )}
      </ComboboxContent>
    </Combobox>
  );
}
