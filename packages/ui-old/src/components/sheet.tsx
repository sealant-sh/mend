import type { ReactNode } from "react";

/**
 * A full-height side sheet (DESIGN.md §5 — drawers are raised panels): edge
 * to edge vertically, hairline against the content it covers, resting on the
 * overlay shadow. The host positions it inside a `relative` container.
 */
export function Sheet({
  side = "right",
  width = 400,
  label,
  header,
  footer,
  children,
}: {
  readonly side?: "left" | "right";
  readonly width?: number;
  /** Accessible name for the region. */
  readonly label: string;
  readonly header?: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <aside
      aria-label={label}
      style={{ width }}
      className={`absolute inset-y-0 z-20 flex flex-col overflow-hidden bg-panel shadow-overlay ${
        side === "right" ? "right-0 border-l" : "left-0 border-r"
      } border-rule`}
    >
      {header}
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      {footer}
    </aside>
  );
}

/** The sheet's standard header: title + mono meta left, quiet actions right. */
export function SheetHeader({
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
