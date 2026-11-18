import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mend/ui/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@mend/ui/components/ui/sheet";
import { cn } from "@mend/ui/lib/utils";
import type { ReactNode } from "react";

import { usePhone } from "#/lib/phone";

/**
 * A dialog on a wide screen and a sheet from the bottom on a phone (Doop "Dialog" and "Phone
 * sheet"), with the same title, words, body and buttons. `size` is the dialog's width: `sm` for a
 * confirmation, `md` for a form.
 */
export function Overlay({
  open,
  onOpenChange,
  title,
  description,
  size,
  children,
  footer,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: ReactNode;
  readonly size: "sm" | "md";
  readonly children?: ReactNode;
  readonly footer: ReactNode;
}) {
  const phone = usePhone();
  if (phone)
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          className="max-h-[92dvh] gap-0 rounded-t-xl pb-[env(safe-area-inset-bottom)]"
        >
          <span aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border" />
          <SheetHeader className="border-b px-5 pt-3 pb-3">
            <SheetTitle className="pr-10 text-title font-semibold">{title}</SheetTitle>
            {description === undefined ? null : (
              <SheetDescription className="text-prose">{description}</SheetDescription>
            )}
          </SheetHeader>
          {children === undefined || children === null ? null : (
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4 text-prose">
              {children}
            </div>
          )}
          {footer === null ? null : (
            <SheetFooter className="flex-row border-t px-5 pt-3 pb-4 *:flex-1">
              {footer}
            </SheetFooter>
          )}
        </SheetContent>
      </Sheet>
    );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size={size} className={cn(size === "md" && "gap-5")}>
        <DialogHeader className="pr-8">
          <DialogTitle>{title}</DialogTitle>
          {description === undefined ? null : <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children === undefined || children === null ? null : (
          <div className="flex min-w-0 flex-col gap-4">{children}</div>
        )}
        {/* Sheet's dialog ends with its buttons on the sheet itself, with no band under them. */}
        {footer === null ? null : <div className="flex justify-end gap-2.5 pt-1">{footer}</div>}
      </DialogContent>
    </Dialog>
  );
}
