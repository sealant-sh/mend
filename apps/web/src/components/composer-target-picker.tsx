import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@mend/ui/components/ui/combobox";
import { Plus } from "lucide-react";
import { useState, type ReactNode } from "react";

interface TargetChoice {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

/** A compact destination control with keyboard search and an optional explicit creation action. */
export function ComposerTargetPicker({
  label,
  choices,
  selectedId,
  disabled,
  onSelect,
  status,
  onCreate,
  lead,
  mono = false,
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
}) {
  const [open, setOpen] = useState(false);
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
      <ComboboxTrigger
        aria-label={`${label}: ${selected?.label ?? `Choose ${noun}`}`}
        title={selected === null ? `Choose ${noun}` : `${selected.label} · ${selected.detail}`}
        className={`inline-flex min-w-0 max-w-[220px] items-center ${mono ? "shrink" : "shrink-0"} gap-1.5 rounded-[8px] px-2.5 py-[5px] font-sans text-[12.5px] leading-[1.3] font-medium text-ink-2 transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-popup-open:bg-secondary data-popup-open:text-foreground disabled:opacity-50 [&>svg]:size-3 [&>svg]:text-faint`}
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
          {selected?.label ?? `Choose ${noun}`}
        </span>
      </ComboboxTrigger>
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
