import { SHARED_CONTROL_CONFIRM } from "@mend/domain/workbench";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mend/ui/components/ui/alert-dialog";
import { cn } from "@mend/ui/lib/utils";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { setSharedControl, type SessionControlDto, type SessionDto } from "#/lib/api";
import { queryClient } from "#/lib/queries";
import { sharedControlSwitchTitle } from "#/lib/shared-workspace";

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
 * The owner's switch, sized for the terminal's header strip. Where each turn runs on its sender's
 * login, turning it on makes the conversation so far visible to whoever steers and takes
 * everyone's personal memory out of the agent, so it asks first, in the domain's words
 * (docs/adr/0016, decision 13). Elsewhere a steered turn spends the owner's logins, as the line
 * beside the switch says, and it turns on at once.
 */
export function SharedControlSwitch({
  session,
  turnsOnSendersLogin,
}: {
  readonly session: SessionDto;
  /** The session view's `control.turnsOnSendersLogin`; false where it has not said. */
  readonly turnsOnSendersLogin: boolean;
}) {
  const toggle = useToggle(session);
  const [confirming, setConfirming] = useState(false);
  const shared = session.sharedControlEnabledAt !== null;
  return (
    <span
      className="flex shrink-0 items-center gap-1.5"
      title={sharedControlSwitchTitle(turnsOnSendersLogin)}
    >
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
              if (enabled && turnsOnSendersLogin) setConfirming(true);
              else toggle.mutate(enabled);
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
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{SHARED_CONTROL_CONFIRM.title}</AlertDialogTitle>
            <AlertDialogDescription>{SHARED_CONTROL_CONFIRM.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{SHARED_CONTROL_CONFIRM.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false);
                toggle.mutate(true);
              }}
            >
              {SHARED_CONTROL_CONFIRM.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
