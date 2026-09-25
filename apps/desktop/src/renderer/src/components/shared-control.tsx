import { cn } from "@mend/ui/lib/utils";
import { useMutation } from "@tanstack/react-query";

import { setSharedControl, type SessionControlDto, type SessionDto } from "#/lib/api";
import { queryClient } from "#/lib/queries";

/** The web app's words for what turning shared control on lends (docs/adr/0003). */
export const SHARED_CONTROL_LENDS =
  "On lets everyone who can see this project send turns, answer approvals, interrupt, and type in the terminal, using your provider logins and Git access. Every action is recorded with who sent it.";

const useToggle = (session: SessionDto) =>
  useMutation({
    mutationFn: (enabled: boolean) => setSharedControl(session.id, enabled),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["session", session.id] });
      void queryClient.invalidateQueries({ queryKey: ["project", session.projectId] });
    },
  });

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : "shared control did not change";

/**
 * The owner's switch, sized for the terminal's header strip. Turning it on lends the owner's
 * credentials, so it confirms with the sentence the web app shows beside the same switch.
 */
export function SharedControlSwitch({ session }: { readonly session: SessionDto }) {
  const toggle = useToggle(session);
  const shared = session.sharedControlEnabledAt !== null;
  return (
    <span className="flex shrink-0 items-center gap-1.5" title={SHARED_CONTROL_LENDS}>
      {toggle.isError && (
        <span className="max-w-64 truncate font-mono text-[11.5px] text-danger">
          {errorText(toggle.error)}
        </span>
      )}
      <span className="font-sans text-[12px] text-label">Shared control</span>
      <span role="group" aria-label="Shared control" className="flex rounded-md bg-wash p-0.5">
        {([false, true] as const).map((enabled) => (
          <button
            key={String(enabled)}
            type="button"
            aria-pressed={shared === enabled}
            disabled={toggle.isPending}
            onClick={() => {
              if (shared === enabled) return;
              if (enabled && !window.confirm(SHARED_CONTROL_LENDS)) return;
              toggle.mutate(enabled);
            }}
            className={cn(
              "rounded-[5px] px-2 py-px font-sans text-[11.5px] font-medium transition-colors disabled:opacity-50",
              shared === enabled
                ? "bg-panel text-foreground shadow-[var(--shadow-xs)]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {enabled ? "On" : "Off"}
          </button>
        ))}
      </span>
    </span>
  );
}

/**
 * What someone who is not the owner is told, in the web app's words: who steers, or that the
 * owner shares control (with Turn off for an organization owner). Null for the owner, and for a
 * session nobody owns.
 */
export function SharedControlFact({
  session,
  control,
  ownerName,
}: {
  readonly session: SessionDto;
  readonly control: SessionControlDto;
  readonly ownerName: string | null;
}) {
  const toggle = useToggle(session);
  if (control.own || ownerName === null) return null;
  const shared = session.sharedControlEnabledAt !== null;
  if (!shared && control.steer) return null;
  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-b border-rule-faint bg-background px-3">
      <span className="truncate font-sans text-[12.5px] text-ink-2">
        {shared
          ? `${ownerName} shares control of this session.`
          : `Only ${ownerName} steers this session. You can read the record and review the change.`}
      </span>
      {shared && control.toggleSharedControl && (
        <button
          type="button"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate(false)}
          className="shrink-0 font-sans text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          {toggle.isPending ? "Turning off…" : "Turn off"}
        </button>
      )}
      {toggle.isError && (
        <span className="truncate font-mono text-[11.5px] text-danger">
          {errorText(toggle.error)}
        </span>
      )}
    </div>
  );
}
