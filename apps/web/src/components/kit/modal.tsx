import { type ComponentProps, lazy, Suspense } from "react";

import { Deferred, firstUse } from "./first-use";
import type * as Popup from "./modal-popup";

/** Base UI's dialog, loaded on first use (`./first-use`). */
const dialogs = firstUse(() => import("./modal-popup"));

/** The dialog for a parent that opens it: its code loads when it first opens. */
const OpenedDialog = lazy(() =>
  dialogs
    .wake()
    .then(() => import("./modal-popup").then((code) => ({ default: code.ModalDialog }))),
);

type ModalDialogProps = Omit<
  ComponentProps<typeof Popup.ModalDialog>,
  "defaultOpen" | "triggerRef"
>;

/**
 * `.modal`: a centered dialog over a dimmed page. Base UI traps focus inside it, closes it on
 * Escape or a click outside, returns focus to what opened it, and names it by its title. Its code
 * loads on first use: when its trigger is reached or pressed, or when its parent first opens it.
 *
 * ```tsx
 * <ModalDialog open={open} onOpenChange={setOpen} title="New worktree" width={480}
 *   footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary">Create</Button></>}>
 *   …fields…
 * </ModalDialog>
 * ```
 */
export function ModalDialog(props: ModalDialogProps) {
  return props.trigger === undefined ? (
    <ParentOpened {...props} />
  ) : (
    <Deferred code={dialogs} trigger={props.trigger} popup="dialog">
      {(code, woken) => (
        <code.ModalDialog {...props} defaultOpen={woken.pressed} triggerRef={woken.triggerRef} />
      )}
    </Deferred>
  );
}

/** Nothing until first opened; from then on, always there, so it closes as it should. */
function ParentOpened(props: ModalDialogProps) {
  const code = dialogs.useLoaded();
  if (code === null && props.open !== true) return null;
  return (
    <Suspense fallback={null}>
      <OpenedDialog {...props} defaultOpen={false} triggerRef={undefined} />
    </Suspense>
  );
}

/** A button that closes the dialog it sits in. */
export function ModalClose(props: ComponentProps<typeof Popup.ModalClose>) {
  const code = dialogs.useLoaded();
  return code === null ? null : <code.ModalClose {...props} />;
}
