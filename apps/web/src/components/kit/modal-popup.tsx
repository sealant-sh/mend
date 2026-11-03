import { Dialog } from "@base-ui/react/dialog";
import { cn } from "@mend/ui/lib/utils";
import type { ReactElement, ReactNode } from "react";

/** The dialog itself, which `./modal` loads on first use. */
export function ModalDialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  width = 560,
  footer,
  children,
  className,
  defaultOpen,
  triggerRef,
}: {
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /** The element that opens it, when the dialog is not controlled. */
  readonly trigger?: ReactElement;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly width?: number;
  readonly footer?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
  readonly defaultOpen: boolean;
  readonly triggerRef: ((element: HTMLElement | null) => void) | undefined;
}) {
  return (
    <Dialog.Root
      defaultOpen={defaultOpen}
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange: (next) => onOpenChange(next) })}
    >
      {trigger === undefined ? null : <Dialog.Trigger ref={triggerRef} render={trigger} />}
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-[rgba(27,27,29,0.28)] transition-opacity motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          style={{ width }}
          className={cn(
            "fixed top-1/2 left-1/2 z-50 grid max-h-[85dvh] grid-cols-[minmax(0,1fr)] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto overscroll-contain rounded-[22px] bg-panel px-[26px] py-6 text-foreground max-md:max-w-[calc(100vw-24px)] max-md:px-4 max-md:py-5 shadow-md outline-none transition-[opacity,scale] motion-reduce:transition-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
            footer === undefined ? "" : "max-md:pb-0",
            className,
          )}
        >
          <Dialog.Title className="font-display text-[22px] leading-tight font-semibold tracking-[-0.02em]">
            {title}
          </Dialog.Title>
          {description === undefined ? null : (
            <Dialog.Description className="text-[13.5px] text-muted-foreground">
              {description}
            </Dialog.Description>
          )}
          {children}
          {/* On a phone the actions stay pinned at the dialog's foot while its body scrolls. */}
          {footer === undefined ? null : (
            <div className="flex items-center justify-end gap-2.5 max-md:sticky max-md:bottom-0 max-md:-mx-4 max-md:flex-wrap max-md:border-t max-md:border-rule-faint max-md:bg-panel max-md:px-4 max-md:py-3">
              {footer}
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A button that closes the dialog it sits in. */
export const ModalClose = Dialog.Close;
