/** An on/off pair for a project switch; the current value is the lit one. */
export function OnOffSwitch({
  value,
  busy,
  onChange,
}: {
  readonly value: boolean;
  readonly busy: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex shrink-0 gap-1">
      {([true, false] as const).map((option) => (
        <button
          key={String(option)}
          type="button"
          disabled={busy}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={`rounded-lg border px-2 py-1 font-mono text-[11px] transition-colors disabled:opacity-50 ${
            value === option
              ? "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash text-foreground"
              : "border-border bg-card text-muted-foreground hover:text-foreground"
          }`}
        >
          {option ? "on" : "off"}
        </button>
      ))}
    </div>
  );
}
