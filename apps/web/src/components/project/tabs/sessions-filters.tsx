import { cn } from "@mend/ui/lib/utils";

import { focusRing } from "#/components/kit/button";
import { Icon } from "#/components/kit/icons";
import { Menu, MenuRadioGroup, MenuSubmenu } from "#/components/kit/menu";
import type { InboxRow } from "#/lib/inbox";

/** The Sessions tab's filters: who started a session, which agent, which branch. */
export interface ProjectSessionFilters {
  readonly startedBy: "anyone" | "me";
  readonly agent: string | null;
  readonly branch: string | null;
}

/**
 * The filters as the URL keeps them: only what differs from the default ("Mine"), so a plain
 * project link opens on your own sessions and a filtered one survives a reload.
 */
export interface ProjectSessionSearch {
  readonly who?: "anyone";
  readonly agent?: string;
  readonly branch?: string;
}

export const parseSessionSearch = (search: Record<string, unknown>): ProjectSessionSearch => ({
  ...(search["who"] === "anyone" ? { who: "anyone" as const } : {}),
  ...(typeof search["agent"] === "string" && search["agent"] !== ""
    ? { agent: search["agent"] }
    : {}),
  ...(typeof search["branch"] === "string" && search["branch"] !== ""
    ? { branch: search["branch"] }
    : {}),
});

export const filtersOfSearch = (search: ProjectSessionSearch): ProjectSessionFilters => ({
  startedBy: search.who ?? "me",
  agent: search.agent ?? null,
  branch: search.branch ?? null,
});

export const searchOfFilters = (filters: ProjectSessionFilters): ProjectSessionSearch => ({
  ...(filters.startedBy === "anyone" ? { who: "anyone" as const } : {}),
  ...(filters.agent === null ? {} : { agent: filters.agent }),
  ...(filters.branch === null ? {} : { branch: filters.branch }),
});

const pickClass =
  "inline-flex items-center gap-1.5 rounded-[9px] border px-2.5 py-[5px] font-sans text-[12.5px] leading-[1.3] font-medium whitespace-nowrap transition-colors motion-reduce:transition-none";

/**
 * `Mine ×  Filter`: a removable chip per active filter, and Filter for who started it, which
 * agent and which branch, from the sessions this project holds.
 */
export function SessionsFilterLine({
  filters,
  rows,
  viewerKnown,
  onChange,
}: {
  readonly filters: ProjectSessionFilters;
  readonly rows: ReadonlyArray<InboxRow>;
  readonly viewerKnown: boolean;
  readonly onChange: (filters: ProjectSessionFilters) => void;
}) {
  const update = (change: Partial<ProjectSessionFilters>) => onChange({ ...filters, ...change });
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
    <div role="group" aria-label="Filter sessions" className="mb-2.5 flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className={cn(pickClass, "border-transparent bg-wash pr-1.5 text-info")}
        >
          <span className={chip.key === "branch" ? "max-w-[160px] truncate font-mono" : ""}>
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
        width={200}
        trigger={
          <button
            type="button"
            className={cn(
              pickClass,
              "border-rule text-ink-2 hover:bg-secondary hover:text-foreground",
              focusRing,
            )}
          >
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
