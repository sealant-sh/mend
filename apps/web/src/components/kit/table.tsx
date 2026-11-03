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
  readonly cells: ReadonlyArray<ReactNode>;
}

const track = (width: string) =>
  width === "auto" ? "112px" : /^[\d.]+fr$/.test(width) ? `minmax(0,${width})` : width;

/** One column template shared by the header and every row, so each head sits over its values. */
export const gridTemplate = (columns: ReadonlyArray<TableColumn>) =>
  columns.map((column) => track(column.width)).join(" ");

const endAligned = (column: TableColumn | undefined) =>
  column !== undefined && (column.align === "end" || column.width === "auto");

/**
 * `table`: a grid table. Header and rows share one column template; the roles make it read as a
 * table to assistive technology. Put it inside a `Panel` with `className="px-1 py-1.5"`.
 *
 * ```tsx
 * <DataTable label="Projects"
 *   columns={[{ head: "Repository", width: "2.2fr" }, { head: "Sessions", width: "0.9fr" }, { head: "", width: "auto" }]}
 *   rows={projects.map((p) => ({ key: p.id, cells: [p.name, p.sessions, <Button size="sm" variant="ghost">Open</Button>] }))} />
 * ```
 */
export function DataTable({
  label,
  columns,
  rows,
  empty,
  className,
}: {
  readonly label: string;
  readonly columns: ReadonlyArray<TableColumn>;
  readonly rows: ReadonlyArray<TableRow>;
  /** What the table says when it has no rows. */
  readonly empty?: ReactNode;
  readonly className?: string;
}) {
  const template = gridTemplate(columns);
  const cells = (values: ReadonlyArray<ReactNode>, role: "columnheader" | "cell") =>
    columns.map((column, index) => (
      <span
        key={index}
        role={role}
        className={cn("min-w-0", endAligned(column) ? "justify-self-end text-right" : "")}
      >
        {values[index]}
      </span>
    ));
  const rowClass =
    "grid items-center gap-3 px-4 py-3 font-sans text-[13.5px] [&+&]:border-t [&+&]:border-rule-faint max-md:min-w-[36rem]";
  return (
    // On a phone a table wider than the screen scrolls sideways in its own box, never the page.
    <div role="table" aria-label={label} className={cn("max-md:overflow-x-auto", className)}>
      <div role="rowgroup">
        <div
          role="row"
          className={cn(
            rowClass,
            "py-1 font-mono text-[10.5px] leading-[1.3] font-medium tracking-[0.06em] text-label uppercase",
          )}
          style={{ gridTemplateColumns: template }}
        >
          {cells(
            columns.map((column) => column.head),
            "columnheader",
          )}
        </div>
      </div>
      <div role="rowgroup">
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
              className={cn(rowClass, "border-t border-rule-faint")}
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
