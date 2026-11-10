import { cn } from "@mend/ui/lib/utils";
import type { ReactNode } from "react";

export interface TableColumn {
  readonly head: ReactNode;
  /**
   * A grid track: `2fr` becomes `minmax(0,2fr)`, `auto` a fixed 112 px column aligned to the
   * end (for row actions), anything else (`120px`, `minmax(…)`) is used as written.
   */
  readonly width: string;
  readonly align?: "start" | "end";
}

export interface TableRow {
  readonly key: string;
  /** One per column; null for a cell with nothing to say, which a card leaves out. */
  readonly cells: ReadonlyArray<ReactNode>;
}

const track = (width: string) =>
  width === "auto" ? "112px" : /^[\d.]+fr$/.test(width) ? `minmax(0,${width})` : width;

/** One column template shared by the header and every row, so each head sits over its values. */
export const gridTemplate = (columns: ReadonlyArray<TableColumn>) =>
  columns.map((column) => track(column.width)).join(" ");

const endAligned = (column: TableColumn | undefined) =>
  column !== undefined && (column.align === "end" || column.width === "auto");

/** A column with no head holds a row's controls: a card puts it in its foot. */
const inFoot = (column: TableColumn) => column.head === "";

const LABEL =
  "font-mono text-[10.5px] leading-[1.3] font-medium tracking-[0.06em] text-label uppercase";

/**
 * `table`: a grid table. Header and rows share one column template; the roles make it read as a
 * table to assistive technology. Put it inside a `Panel` with `className="px-1 py-1.5"`.
 *
 * ```tsx
 * <DataTable label="Projects"
 *   columns={[{ head: "Repository", width: "2.2fr" }, { head: "Sessions", width: "0.9fr" }, { head: "", width: "auto" }]}
 *   rows={projects.map((p) => ({ key: p.id, cells: [p.name, p.sessions, <Button size="sm" variant="ghost">Open</Button>] }))} />
 * ```
 *
 * `onPhone="cards"`: below `md`, each row is a card instead of a sideways-scrolling row: the first
 * cell is its title line, each other cell sits under its column's head, and the cells of columns
 * with no head (a switch, row actions) share the card's foot. From `md` up it is the same table.
 */
export function DataTable({
  label,
  columns,
  rows,
  empty,
  onPhone = "scroll",
  className,
}: {
  readonly label: string;
  readonly columns: ReadonlyArray<TableColumn>;
  readonly rows: ReadonlyArray<TableRow>;
  /** What the table says when it has no rows. */
  readonly empty?: ReactNode;
  /** Below `md`: scroll the table sideways in its own box (the default), or stack rows as cards. */
  readonly onPhone?: "scroll" | "cards";
  readonly className?: string;
}) {
  const cards = onPhone === "cards";
  const template = gridTemplate(columns);
  const cellClass = (column: TableColumn, index: number, value: ReactNode) =>
    cn(
      "min-w-0",
      endAligned(column) ? "justify-self-end text-right" : "",
      !cards
        ? ""
        : index === 0
          ? "max-md:basis-full"
          : inFoot(column)
            ? cn("max-md:mt-1 max-md:text-left", endAligned(column) ? "max-md:ml-auto" : "")
            : value === null || value === undefined
              ? "max-md:hidden"
              : "max-md:grid max-md:basis-full max-md:gap-0.5 max-md:text-left",
    );
  const cells = (values: ReadonlyArray<ReactNode>, role: "columnheader" | "cell") =>
    columns.map((column, index) => (
      <span key={index} role={role} className={cellClass(column, index, values[index])}>
        {cards && role === "cell" && index > 0 && !inFoot(column) ? (
          <span className={cn("md:hidden", LABEL)}>{column.head}</span>
        ) : null}
        {values[index]}
      </span>
    ));
  const rowClass = cn(
    "grid items-center gap-3 px-4 py-3 font-sans text-[13.5px]",
    cards
      ? "max-md:flex max-md:flex-wrap max-md:gap-x-3 max-md:gap-y-2.5 max-md:rounded-2xl max-md:bg-card max-md:p-4 max-md:shadow-sm"
      : "max-md:min-w-[36rem]",
  );
  const rule = cards ? "md:border-t md:border-rule-faint" : "border-t border-rule-faint";
  return (
    // On a phone a table wider than the screen scrolls sideways in its own box, never the page.
    <div
      role="table"
      aria-label={label}
      className={cn(cards ? "" : "max-md:overflow-x-auto", className)}
    >
      <div role="rowgroup" className={cards ? "max-md:hidden" : undefined}>
        <div
          role="row"
          className={cn(rowClass, "py-1", LABEL)}
          style={{ gridTemplateColumns: template }}
        >
          {cells(
            columns.map((column) => column.head),
            "columnheader",
          )}
        </div>
      </div>
      <div role="rowgroup" className={cards ? "max-md:grid max-md:gap-3" : undefined}>
        {rows.length === 0 && empty !== undefined ? (
          <div role="row" className="px-4 py-3">
            <span role="cell" className="font-mono text-[12px] text-faint">
              {empty}
            </span>
          </div>
        ) : (
          rows.map((row) => (
            <div
              key={row.key}
              role="row"
              className={cn(rowClass, rule)}
              style={{ gridTemplateColumns: template }}
            >
              {cells(row.cells, "cell")}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
