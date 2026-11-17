import type { ReactNode } from "react";

import { Dialog, DialogContent } from "./ui/dialog";

/**
 * A centered modal (DESIGN.md §5), composed from the shadcn Dialog parts —
 * Base UI carries focus management, Escape, and the scrim; this wrapper keeps
 * the house API: an always-open controlled dialog whose panel is a rounded
 * card sizing to its content up to the given bounds.
 */
export function Modal({
  label,
  onClose,
  maxWidth = 720,
  header,
  children,
}: {
  /** Accessible name for the dialog. */
  readonly label: string;
  readonly onClose: () => void;
  readonly maxWidth?: number;
  readonly header?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-label={label}
        showCloseButton={false}
        style={{ maxWidth }}
        className="flex max-h-[85vh] w-full flex-col gap-0 overflow-hidden p-0"
      >
        {header}
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

/** The modal's standard header: title + mono meta left, quiet actions right. */
export function ModalHeader({
  title,
  meta,
  children,
}: {
  readonly title: string;
  readonly meta?: string;
  readonly children?: ReactNode;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-rule px-4">
      <div className="min-w-0">
        <p className="truncate font-sans text-[13px] font-semibold text-foreground">{title}</p>
        {meta !== undefined && (
          <p className="truncate font-mono text-[10.5px] text-faint">{meta}</p>
        )}
      </div>
      <span className="flex-1" />
      {children}
    </header>
  );
}
