import { cn } from "@mend/ui/lib/utils";
import { useState, type ComponentProps } from "react";

import { Chevron, focusRing, touchTarget } from "#/components/kit/button";
import { Deferred, firstUse } from "#/components/kit/first-use";
import { fuzzyFilter, type FuzzyMatch } from "#/components/kit/fuzzy";
import { Icon } from "#/components/kit/icons";
import { Menu, MenuRadioGroup, MenuSubmenu } from "#/components/kit/menu";
import type { ProjectDto } from "#/lib/api";
import type { InboxFilters, InboxRow } from "#/lib/inbox";
import { inboxFilters } from "#/lib/ui-prefs";

import type * as Picker from "./project-picker";

/** Base UI's combobox for the project picker, loaded on first use (`#/components/kit/first-use`). */
const pickers = firstUse(() => import("./project-picker"));

export interface ProjectChoice {
  readonly id: string;
  readonly name: string;
}
export const ALL: ProjectChoice = { id: "", name: "All projects" };

const pickClass = cn(
  "inline-flex items-center gap-1.5 rounded-[9px] border px-[9px] py-1 font-sans text-[12px] leading-[1.3] font-medium whitespace-nowrap transition-colors",
  touchTarget,
);
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
            className={cn(
              "rounded px-0.5 text-faint hover:text-foreground",
              touchTarget,
              focusRing,
            )}
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
 * The picker's list for what was typed: every project the letters match in order, best first,
 * as the kit's finders match (`confg` finds `configs`); with nothing typed, All projects and then
 * every project in its own order.
 */
export const projectChoices = (
  projects: ReadonlyArray<ProjectChoice>,
  query: string,
): ReadonlyArray<{ readonly choice: ProjectChoice; readonly match: FuzzyMatch | undefined }> =>
  query.trim() === ""
    ? [ALL, ...projects].map((choice) => ({ choice, match: undefined }))
    : fuzzyFilter(projects, query, (project) => project.name).map(({ item, match }) => ({
        choice: item,
        match,
      }));

/**
 * `All projects ⌄` (S2): pick one or several projects by typing a few letters. A Base UI combobox
 * that keeps several values; All projects clears the choice.
 */
function ProjectPicker(
  props: Omit<
    ComponentProps<typeof Picker.ProjectPicker>,
    "trigger" | "defaultOpen" | "triggerRef"
  >,
) {
  const { projects, selected } = props;
  const label =
    selected.length === 0
      ? "All projects"
      : selected.length === 1
        ? (projects.find((row) => row.id === selected[0])?.name ?? "1 project")
        : `${selected.length} projects`;
  const trigger = (
    <button
      type="button"
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
    </button>
  );
  return (
    <Deferred code={pickers} trigger={trigger} popup="listbox">
      {(code, woken) => (
        <code.ProjectPicker
          {...props}
          trigger={trigger}
          defaultOpen={woken.pressed}
          triggerRef={woken.triggerRef}
        />
      )}
    </Deferred>
  );
}
