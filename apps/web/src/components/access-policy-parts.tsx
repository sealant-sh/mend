import { cn } from "@mend/ui/lib/utils";
import type { ReactNode } from "react";

import { enforcementWords, ruleRows } from "#/lib/access-policies";

/**
 * Pieces Organization → Access policies, a project's Workspace page and a worktree's Details share:
 * a policy's rules as label and value lines, and each running workspace's answer to a revocation
 * or an applied policy.
 */

/** A label and its value in a policy's rules: a label column beside the value on the desk. */
function RuleLine({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[148px_minmax(0,1fr)] items-baseline gap-3 max-lg:grid-cols-1 max-lg:gap-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** A policy's rules, as label and value lines; hosts and addresses in mono under their line. */
export function RuleList({ rules }: { readonly rules: Parameters<typeof ruleRows>[0] }) {
  return (
    <dl className="grid gap-2 text-row">
      {ruleRows(rules).map((row) => (
        <RuleLine key={row.label} label={row.label}>
          <span>{row.value}</span>
          {row.list.length === 0 ? null : (
            <ul className="mt-1 grid gap-0.5 font-mono text-meta wrap-anywhere">
              {row.list.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </RuleLine>
      ))}
    </dl>
  );
}

/** What each running workspace answered, one line each. */
export function EnforcementList({
  workspaces,
}: {
  readonly workspaces: ReadonlyArray<{
    readonly workspaceId: string;
    readonly enforcement: "enforced" | "pending" | "next-start" | "failed";
    readonly message: string | null;
  }>;
}) {
  return (
    <ul aria-label="Running workspaces" className="grid gap-1.5 text-row">
      {workspaces.map((workspace) => (
        <li key={workspace.workspaceId} className="grid gap-0.5">
          <span className="font-mono text-meta wrap-anywhere">{workspace.workspaceId}</span>
          <span
            className={cn(
              "text-pretty",
              workspace.enforcement === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {enforcementWords(workspace)}
          </span>
        </li>
      ))}
    </ul>
  );
}
