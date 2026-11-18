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
import { cn } from "@mend/ui/lib/utils";

import { usePhone } from "#/lib/phone";

/**
 * The signed-in pages' toasts (Doop "Toast"): one sentence that says what just happened, and an
 * action such as Undo, which closes the toast once used. On the desk a toast sits centred at the
 * bottom of the sheet; on a phone it takes the width, above the tab bar. Anything calls
 * `toast.add` from `@mend/ui/components/ui/toast` to show one.
 */
export function Toaster() {
  const phone = usePhone();
  return (
    <ToastProvider toastManager={toast}>
      <ToastPortal>
        <ToastViewport
          size={phone ? "touch" : "default"}
          // Centred on the sheet, right of the 264px sidebar; on a phone, above the tab bar.
          className={cn(phone ? "bottom-18" : "left-66")}
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
