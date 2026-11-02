import { Combobox } from "@base-ui/react/combobox";
import { cn } from "@mend/ui/lib/utils";
import { useState } from "react";

import { Chevron, focusRing } from "#/components/kit/button";
import { finderInput } from "#/components/kit/finder";
import { Icon } from "#/components/kit/icons";
import {
  CheckBox,
  Menu,
  MenuRadioGroup,
  MenuSubmenu,
  menuPanel,
  menuRow,
} from "#/components/kit/menu";
import { Dot } from "#/components/kit/status";
import type { ProjectDto } from "#/lib/api";
import type { InboxFilters, InboxRow } from "#/lib/inbox";
import { inboxFilters } from "#/lib/ui-prefs";

interface ProjectChoice {
  readonly id: string;
  readonly name: string;
}
const ALL: ProjectChoice = { id: "", name: "All projects" };

const pickClass =
  "inline-flex items-center gap-1.5 rounded-[9px] border px-[9px] py-1 font-sans text-[12px] leading-[1.3] font-medium whitespace-nowrap transition-colors";
const quietPick = "border-rule text-ink-2 hover:bg-secondary hover:text-foreground";
const activePick = "border-transparent bg-wash text-info";

/**
 * The inbox's one filter line: a project picker, a removable chip per active filter, and Filter
 * for who started it, which agent and which branch. The choices are kept per browser.
 */
export function InboxFilterLine({
  filters,
  projects,
  rows,
  viewerKnown,
}: {
  readonly filters: InboxFilters;
  readonly projects: ReadonlyArray<ProjectDto>;
  readonly rows: ReadonlyArray<InboxRow>;
  readonly viewerKnown: boolean;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const update = (change: Partial<InboxFilters>) => inboxFilters.set({ ...filters, ...change });
  const agents = [...new Set(rows.map((row) => row.session.harness))].toSorted();
  const branches = [...new Set(rows.map((row) => row.session.branch))].toSorted();
  const chips = [
    ...(filters.startedBy === "me" && viewerKnown
      ? [{ key: "mine", label: "Mine", clear: { startedBy: "anyone" as const } }]
      : []),
    ...(filters.agent === null
      ? []
      : [{ key: "agent", label: filters.agent, clear: { agent: null } }]),
    ...(filters.branch === null
      ? []
      : [{ key: "branch", label: filters.branch, clear: { branch: null } }]),
  ];
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-1.5" role="group" aria-label="Filter sessions">
      <ProjectPicker
        projects={projects}
        rows={rows}
        selected={filters.projectIds}
        onChange={(projectIds) => update({ projectIds })}
        moreFilters={[
          { label: "Started by", value: filters.startedBy === "me" ? "me" : "anyone" },
          { label: "Agent", value: filters.agent ?? "any" },
          { label: "Branch", value: filters.branch ?? "any" },
        ]}
        onMoreFilters={() => setFilterOpen(true)}
      />
      {chips.map((chip) => (
        <span key={chip.key} className={cn(pickClass, activePick, "pr-1.5")}>
          <span className={chip.key === "branch" ? "max-w-[110px] truncate font-mono" : ""}>
            {chip.label}
          </span>
          <button
            type="button"
            aria-label={`Remove the filter ${chip.label}`}
            onClick={() => update(chip.clear)}
            className={cn("rounded px-0.5 text-faint hover:text-foreground", focusRing)}
          >
            ×
          </button>
        </span>
      ))}
      <Menu
        open={filterOpen}
        onOpenChange={setFilterOpen}
        width={200}
        trigger={
          <button type="button" className={cn(pickClass, quietPick, focusRing)}>
            <Icon name="filter" size={13} />
            Filter
          </button>
        }
      >
        <MenuSubmenu label="Started by" meta={filters.startedBy === "me" ? "me" : "anyone"}>
          <MenuRadioGroup
            label="Started by"
            value={filters.startedBy}
            options={[
              { value: "anyone", label: "Anyone" },
              { value: "me", label: "Me" },
            ]}
            onChange={(startedBy) => update({ startedBy })}
          />
        </MenuSubmenu>
        <MenuSubmenu label="Agent" meta={filters.agent ?? "any"}>
          <MenuRadioGroup
            label="Agent"
            value={filters.agent ?? ""}
            options={[
              { value: "", label: "Any" },
              ...agents.map((agent) => ({ value: agent, label: agent })),
            ]}
            onChange={(agent) => update({ agent: agent === "" ? null : agent })}
          />
        </MenuSubmenu>
        <MenuSubmenu label="Branch" meta={filters.branch ?? "any"}>
          <MenuRadioGroup
            label="Branch"
            value={filters.branch ?? ""}
            options={[
              { value: "", label: "Any" },
              ...branches.map((branch) => ({
                value: branch,
                label: <span className="font-mono text-[12px]">{branch}</span>,
              })),
            ]}
            onChange={(branch) => update({ branch: branch === "" ? null : branch })}
          />
        </MenuSubmenu>
      </Menu>
    </div>
  );
}

/**
 * `All projects ⌄` (S2): pick one or several projects by typing a few letters. A Base UI combobox
 * that keeps several values; All projects clears the choice.
 */
function ProjectPicker({
  projects,
  rows,
  selected,
  onChange,
  moreFilters,
  onMoreFilters,
}: {
  readonly projects: ReadonlyArray<ProjectDto>;
  readonly rows: ReadonlyArray<InboxRow>;
  readonly selected: ReadonlyArray<string>;
  readonly onChange: (projectIds: ReadonlyArray<string>) => void;
  readonly moreFilters: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly onMoreFilters: () => void;
}) {
  const [open, setOpen] = useState(false);
  const choices: ReadonlyArray<ProjectChoice> = [ALL, ...projects];
  const value = selected.length === 0 ? [ALL] : projects.filter((row) => selected.includes(row.id));
  const openRows = new Map<string, number>();
  for (const row of rows)
    if (row.place !== "snoozed" && row.place !== "settled")
      openRows.set(row.project.id, (openRows.get(row.project.id) ?? 0) + 1);
  const label =
    selected.length === 0
      ? "All projects"
      : selected.length === 1
        ? (projects.find((row) => row.id === selected[0])?.name ?? "1 project")
        : `${selected.length} projects`;
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
      <Combobox.Trigger
        aria-label={`Projects: ${label}`}
        className={cn(
          pickClass,
          selected.length === 0 ? quietPick : activePick,
          "data-popup-open:border-transparent data-popup-open:bg-wash data-popup-open:text-info",
          focusRing,
        )}
      >
        <span className="max-w-[120px] truncate">{label}</span>
        <Chevron />
      </Combobox.Trigger>
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
