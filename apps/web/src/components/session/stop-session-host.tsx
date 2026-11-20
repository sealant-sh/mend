import { useSuspenseQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

import type { StopTarget } from "#/lib/session-stop";
import { signedInOptions } from "#/lib/sign-in";
import { StopSessionContext } from "#/lib/stop-session";
import { useTRPC } from "#/lib/trpc";

import { type StopDialogState, StopSessionDialog } from "./session-actions.tsx";

/**
 * The Stop session dialog for the inbox's rows (frame "Session states · row menu by group"): one
 * dialog for the whole layout, so a row that moves to To review as the session stops can't take
 * its dialog with it. It is the same dialog as a session tab's.
 */
export function StopSessionHost({ children }: { readonly children: ReactNode }) {
  const trpc = useTRPC();
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const [state, setState] = useState<StopDialogState>({ open: false, target: null });
  const open = (target: StopTarget) => setState({ open: true, target });
  return (
    <StopSessionContext value={open}>
      {children}
      <StopSessionDialog
        state={state}
        viewerId={viewer.userId}
        onOpenChange={(next) => setState((before) => ({ ...before, open: next }))}
      />
    </StopSessionContext>
  );
}
