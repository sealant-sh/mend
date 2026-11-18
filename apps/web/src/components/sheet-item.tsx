import { cn } from "@mend/ui/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The parts of a phone's action sheet (Doop "Phone sheet", "Action sheet item"), shared by the
 * sheets that open from a row: a session's actions, the account, the organizations.
 */

/** One 52px row of a phone's action sheet, as a button or a link. */
export const sheetItemClass =
  "flex h-13 w-full items-center gap-3.5 pr-4 pl-5 text-left text-lead text-foreground outline-none focus-visible:bg-muted active:bg-accent disabled:opacity-60 [&_svg]:size-4.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

/** What sits inside a row: its icon, its words, a value on the right and a chevron. */
export function SheetItemBody({
  icon,
  value,
  chevron = false,
  end,
  children,
}: {
  readonly icon?: ReactNode;
  readonly value?: string;
  readonly chevron?: boolean;
  /** Anything else on the right, after the value: a check, an arrow. */
  readonly end?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {value === undefined ? null : (
        <span className="shrink-0 text-sm text-muted-foreground tabular-nums">{value}</span>
      )}
      {end}
      {chevron ? <ChevronRightIcon aria-hidden className="size-4" /> : null}
    </>
  );
}

/** One row that acts when pressed. */
export function SheetItem({
  onClick,
  disabled = false,
  className,
  ...body
}: Parameters<typeof SheetItemBody>[0] & {
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={cn(sheetItemClass, className)}
    >
      <SheetItemBody {...body} />
    </button>
  );
}

/** The grab handle at the top of a sheet that rises from the foot of the screen. */
export function SheetHandle() {
  return (
    <span
      aria-hidden
      className="mx-auto mt-1.5 mb-0.5 block h-1.25 w-9 rounded-full bg-muted-foreground/35"
    />
  );
}
