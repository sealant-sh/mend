import {
  Toast,
  ToastAction,
  ToastContent,
  ToastDescription,
  ToastPortal,
  ToastProvider,
  ToastViewport,
  toast,
  useToastManager,
} from "@mend/ui/components/ui/toast";

import { usePhone } from "#/lib/phone";
import { TOAST_EDGE, toastClearance, useComposerBoxes } from "#/lib/toast-clearance";

/** Above the phone's tab bar: where a phone's toasts sit when nothing else is in the way. */
const PHONE_BOTTOM = 72;

/**
 * The signed-in pages' toasts (Doop "Toast"): one sentence that says what just happened, and an
 * action such as Undo, which closes the toast once used. On the desk a toast sits in the
 * bottom-right corner of the window; on a phone it takes the width, above the tab bar. Either way
 * it never covers a composer: while one reaches into its place, it sits just above the composer
 * (`lib/toast-clearance.ts`). Anything calls `toast.add` from `@mend/ui/components/ui/toast` to
 * show one.
 */
export function Toaster() {
  const phone = usePhone();
  const composers = useComposerBoxes();
  const clearance =
    composers.length === 0
      ? null
      : toastClearance(composers, {
          width: window.innerWidth,
          height: window.innerHeight,
          phone,
          bottom: phone ? PHONE_BOTTOM : TOAST_EDGE,
        });
  return (
    <ToastProvider toastManager={toast}>
      <ToastPortal>
        <ToastViewport
          size={phone ? "touch" : "default"}
          className={phone ? "data-[size=touch]:bottom-18" : undefined}
          style={clearance === null ? undefined : { bottom: clearance }}
        >
          <ToastList />
        </ToastViewport>
      </ToastPortal>
    </ToastProvider>
  );
}

function ToastList() {
  const { toasts, close } = useToastManager();
  return toasts.map((item) => (
    <Toast key={item.id} toast={item}>
      <ToastContent>
        <ToastDescription className="min-w-0 flex-1" />
        {item.actionProps === undefined ? null : (
          // Base UI runs the toast's own `actionProps.onClick` too; this one closes it after.
          <ToastAction onClick={() => close(item.id)} />
        )}
      </ToastContent>
    </Toast>
  ));
}
