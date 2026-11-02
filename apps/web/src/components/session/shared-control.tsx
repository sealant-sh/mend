import { sharedControlLine } from "@mend/domain/workbench";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { setSharedControl } from "#/lib/api";
import { sharedControlClick } from "#/lib/shared-workspace";
import { useTRPC } from "#/lib/trpc";

import { SharedControlConfirmDialog } from "../shared-workspace";

/**
 * Shared control (docs/adr/0003): the owner lets everyone who can see the project steer. Turning it
 * on asks first, in words true to whose login a steered turn runs on (docs/adr/0016, decisions 6
 * and 13): its sender's, or the owner's. An organization owner may take it back. Everyone else is
 * told who steers.
 */
export function SharedControl({
  sessionId,
  ownerSteers,
  shared,
  canToggle,
  steer,
  ownerName,
  turnsOnSendersLogin,
}: {
  readonly sessionId: string;
  /** The viewer owns the session. */
  readonly ownerSteers: boolean;
  readonly shared: boolean;
  readonly canToggle: boolean;
  readonly steer: boolean;
  /** Null for a session nobody owns; undefined while the roster is read, which says nothing yet. */
  readonly ownerName: string | null | undefined;
  /** A steered turn runs on its sender's login (docs/adr/0016, decision 6), not the owner's. */
  readonly turnsOnSendersLogin: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Turning it on asks first, in both layouts (docs/adr/0016, decision 13); turning it off never
  // does.
  const [confirming, setConfirming] = useState(false);

  const toggle = (enabled: boolean) => {
    setPending(true);
    setError(null);
    void setSharedControl(sessionId, enabled)
      .then(() => queryClient.invalidateQueries(trpc.sessions.pathFilter()))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        setPending(false);
        setConfirming(false);
      });
  };

  // Everyone else's lines name the owner: nothing until the roster says who that is.
  if (!ownerSteers && ownerName === undefined) return null;
  if (!ownerSteers && !canToggle) {
    if (steer || ownerName === null) return null;
    return (
      <p className="max-w-[760px] border-l-2 border-[var(--sw-accent)] pl-3 text-[13px] leading-relaxed text-ink-2">
        Only {ownerName} steers this session. You can read the record and review the change.
      </p>
    );
  }

  return (
    <div className="max-w-[760px]">
      {ownerSteers ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-medium text-label">Shared control</span>
          <div role="group" aria-label="Shared control" className="flex rounded-lg bg-wash p-0.5">
            {([false, true] as const).map((enabled) => (
              <button
                key={String(enabled)}
                type="button"
                aria-pressed={shared === enabled}
                disabled={pending}
                onClick={() => {
                  if (shared === enabled) return;
                  if (sharedControlClick(enabled) === "confirm") {
                    setConfirming(true);
                  } else toggle(enabled);
                }}
                className={`rounded-md px-2.5 py-1 font-sans text-xs font-medium transition-colors ${
                  shared === enabled
                    ? "bg-panel text-foreground shadow-[var(--shadow-xs)]"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {enabled ? "On" : "Off"}
              </button>
            ))}
          </div>
          <p className="basis-full text-[12.5px] leading-relaxed text-muted-foreground">
            On lets everyone who can see this project send turns, answer approvals and interrupt.{" "}
            {sharedControlLine(turnsOnSendersLogin)} They can read the terminal; only you type in
            it. Every action is recorded with who sent it.
          </p>
          <SharedControlConfirmDialog
            open={confirming}
            turnsOnSendersLogin={turnsOnSendersLogin}
            pending={pending}
            onConfirm={() => toggle(true)}
            onCancel={() => setConfirming(false)}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[13px] text-ink-2">
            {ownerName ?? "Its owner"} shares control of this session.
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={() => toggle(false)}
            className="font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            {pending ? "Turning off…" : "Turn off"}
          </button>
        </div>
      )}
      {error === null ? null : (
        <p
          role="alert"
          className="mt-2 border-l-2 border-[var(--sw-red)] pl-3 text-[13px] leading-relaxed text-danger"
        >
          {error}
        </p>
      )}
    </div>
  );
}
