import { useBlocker } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Button } from "./button";
import { ModalDialog } from "./modal";

/**
 * Asks before a draft is lost. While `dirty`, leaving the page through the router (another tab,
 * the rail, Back) opens a dialog: Keep editing stays, Discard leaves. Closing or reloading the
 * browser tab, and the walk to sign-in after a session expires (`window.location.assign`), get
 * the browser's own "Leave site?" prompt instead, since nothing in the page can show one then.
 *
 * ```tsx
 * <UnsavedGuard dirty={dirty} summary="2 unsaved changes in Workspace." />
 * ```
 */
export function UnsavedGuard({
  dirty,
  summary,
}: {
  readonly dirty: boolean;
  /** What would be lost, said in the dialog. */
  readonly summary: ReactNode;
}) {
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });
  return (
    <ModalDialog
      open={blocker.status === "blocked"}
      onOpenChange={(open) => {
        if (!open && blocker.status === "blocked") blocker.reset();
      }}
      title="Leave without saving?"
      description={summary}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={() => blocker.proceed?.()}>
            Discard
          </Button>
          <Button variant="primary" autoFocus onClick={() => blocker.reset?.()}>
            Keep editing
          </Button>
        </>
      }
    />
  );
}
