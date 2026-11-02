import { Combobox } from "@base-ui/react/combobox";
import { cn } from "@mend/ui/lib/utils";
import { useState, type ReactElement } from "react";

import { focusRing } from "#/components/kit/button";
import { finderInput } from "#/components/kit/finder";
import { CheckBox, menuPanel, menuRow } from "#/components/kit/menu";
import { Dot } from "#/components/kit/status";
import type { ProjectDto } from "#/lib/api";
import type { InboxRow } from "#/lib/inbox";

import { ALL, type ProjectChoice } from "./filter-line";

/** The project picker itself, which `./filter-line` loads on first use. */
export function ProjectPicker({
  projects,
  rows,
  selected,
  onChange,
  moreFilters,
  onMoreFilters,
  trigger,
  defaultOpen,
  triggerRef,
}: {
  readonly projects: ReadonlyArray<ProjectDto>;
  readonly rows: ReadonlyArray<InboxRow>;
  readonly selected: ReadonlyArray<string>;
  readonly onChange: (projectIds: ReadonlyArray<string>) => void;
  readonly moreFilters: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly onMoreFilters: () => void;
  readonly trigger: ReactElement;
  readonly defaultOpen: boolean;
  readonly triggerRef: ((element: HTMLElement | null) => void) | undefined;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const choices: ReadonlyArray<ProjectChoice> = [ALL, ...projects];
  const value = selected.length === 0 ? [ALL] : projects.filter((row) => selected.includes(row.id));
  const openRows = new Map<string, number>();
  for (const row of rows)
    if (row.place !== "snoozed" && row.place !== "settled")
      openRows.set(row.project.id, (openRows.get(row.project.id) ?? 0) + 1);
  return (
    <Combobox.Root
      multiple
      autoHighlight
      items={[...choices]}
      value={value}
      open={open}
      onOpenChange={(next) => setOpen(next)}
      itemToStringLabel={(choice: ProjectChoice) => choice.name}
      isItemEqualToValue={(choice: ProjectChoice, current: ProjectChoice) =>
        choice.id === current.id
      }
      onValueChange={(next: ProjectChoice[]) => {
        const pickedAll = next.some((choice) => choice.id === ALL.id) && selected.length > 0;
        onChange(
          pickedAll ? [] : next.filter((choice) => choice.id !== ALL.id).map((choice) => choice.id),
        );
      }}
    >
      <Combobox.Trigger ref={triggerRef} render={trigger} />
      <Combobox.Portal>
        <Combobox.Positioner align="start" sideOffset={6} className="z-50">
          <Combobox.Popup aria-label="Pick projects" className={cn(menuPanel, "w-[236px]")}>
            <Combobox.Input
              placeholder="Find a project"
              aria-label="Find a project"
              className={cn(finderInput, "mx-1 mt-1 w-auto")}
            />
            <Combobox.Empty className="px-2.5 py-2 font-mono text-[12px] text-faint empty:hidden">
              No project matches
            </Combobox.Empty>
            <Combobox.List className="max-h-[260px] overflow-y-auto">
              {(choice: ProjectChoice) => {
                const checked =
                  choice.id === ALL.id ? selected.length === 0 : selected.includes(choice.id);
                const count = openRows.get(choice.id) ?? 0;
                return (
                  <Combobox.Item
                    key={choice.id === ALL.id ? "all" : choice.id}
                    value={choice}
                    className={cn(menuRow, checked ? "bg-wash text-foreground" : "")}
                  >
                    <CheckBox checked={checked} />
                    {choice.id === ALL.id ? null : <Dot tone={count > 0 ? "ok" : "off"} />}
                    <span className="truncate">{choice.name}</span>
                    {count > 0 && choice.id !== ALL.id ? (
                      <span className="ml-auto font-mono text-[11px] text-faint">{count}</span>
                    ) : null}
                  </Combobox.Item>
                );
              }}
            </Combobox.List>
            <div className="mt-1.5 border-t border-rule pt-1.5">
              <p className="px-2.5 py-1 font-mono text-[10.5px] font-medium tracking-[0.06em] text-label uppercase">
                More filters
              </p>
              {moreFilters.map((filter) => (
                <button
                  key={filter.label}
                  type="button"
                  aria-label={`${filter.label}: ${filter.value}. Change it in Filter`}
                  className={cn(menuRow, "w-full hover:bg-secondary", focusRing)}
                  onClick={() => {
                    setOpen(false);
                    onMoreFilters();
                  }}
                >
                  {filter.label}
                  <span className="ml-auto font-mono text-[11px] text-faint">{filter.value}</span>
                </button>
              ))}
            </div>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
