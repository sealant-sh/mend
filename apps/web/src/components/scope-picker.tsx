import type { ProjectScopeRequestDto, TeamViewDto } from "#/lib/api";

const same = (a: ProjectScopeRequestDto, b: ProjectScopeRequestDto) =>
  a.kind === b.kind && (a.kind !== "team" || b.kind !== "team" || a.teamId === b.teamId);

/**
 * Where a project is visible (docs/adr/0002): only you, one of your teams, or everyone on
 * this Mend. One row of quiet toggles — the same control adoption and Setup use.
 */
export function ScopePicker({
  value,
  onChange,
  teams,
  disabled = false,
}: {
  readonly value: ProjectScopeRequestDto;
  readonly onChange: (scope: ProjectScopeRequestDto) => void;
  readonly teams: ReadonlyArray<TeamViewDto>;
  readonly disabled?: boolean;
}) {
  const choices: ReadonlyArray<{ readonly label: string; readonly scope: ProjectScopeRequestDto }> =
    [
      { label: "only you", scope: { kind: "personal" } },
      ...teams.map((entry) => ({
        label: entry.team.name,
        scope: { kind: "team" as const, teamId: entry.team.id },
      })),
      { label: "everyone here", scope: { kind: "instance" } },
    ];
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Visible to">
      {choices.map((choice) => {
        const active = same(choice.scope, value);
        return (
          <button
            key={choice.label}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(choice.scope)}
            className={`rounded-lg border px-2 py-1 font-mono text-[11px] transition-colors disabled:opacity-50 ${
              active
                ? "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash text-foreground"
                : "border-border bg-card text-muted-foreground hover:text-foreground"
            }`}
          >
            {choice.label}
          </button>
        );
      })}
    </div>
  );
}
