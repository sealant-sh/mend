/**
 * The look of one choice among a worktree's resource uses, for the composer's resource line. The
 * Resources tab itself lives in `components/project/tabs/resources.tsx`.
 */
export const choiceToggle = (on: boolean): string =>
  `rounded-lg border px-2 py-1 font-mono text-[11px] transition-colors disabled:opacity-50 ${on ? "border-border bg-wash text-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground"}`;
