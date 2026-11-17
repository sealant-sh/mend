import { Input } from "@mend/ui-old/components/ui/input";
import { useState } from "react";

import { StatusDot } from "#/components/status-dot";
import type { InboxRow } from "#/lib/model";
import { statusTone } from "#/lib/words";

/**
 * Ctrl+Shift+P: jump to any session by name, project, or branch. Controlled
 * by the route (the keybinding layer owns the toggle). Picking one focuses
 * that session. The list is the inbox's order, so Enter on an empty query
 * goes to the newest live session.
 */

const matches = (row: InboxRow, query: string): boolean => {
  if (query === "") return true;
  const hay =
    `${row.projectName} ${row.title} ${row.session.branch} ${row.session.status}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== "")
    .every((term) => hay.includes(term));
};

export function CommandPalette({
  rows,
  onPick,
  onClose,
}: {
  readonly rows: ReadonlyArray<InboxRow>;
  readonly onPick: (row: InboxRow) => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  const shown = rows.filter((row) => matches(row, query)).slice(0, 12);
  const active = Math.min(cursor, Math.max(0, shown.length - 1));

  const pick = (index: number) => {
    const row = shown[index];
    if (row === undefined) return;
    onPick(row);
    onClose();
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center bg-[rgba(27,27,29,0.28)] pt-[12vh]"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-label="Sessions"
        onMouseDown={(event) => event.stopPropagation()}
        className="no-drag w-[520px] overflow-hidden rounded-2xl border border-rule bg-panel shadow-overlay"
      >
        <Input
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setCursor((value) => Math.min(value + 1, shown.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setCursor((value) => Math.max(value - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              pick(active);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
          placeholder="Jump to a session — project, harness, branch…"
          className="h-auto w-full rounded-none border-0 border-b border-rule bg-transparent px-4 py-3 text-[14.5px] focus-visible:border-rule focus-visible:ring-0"
        />
        <ul className="max-h-[50vh] overflow-y-auto py-1.5">
          {shown.length === 0 && (
            <li className="px-4 py-3 font-sans text-[12.5px] text-label">no session matches</li>
          )}
          {shown.map((row, index) => (
            <li key={row.session.id}>
              <button
                type="button"
                onMouseEnter={() => setCursor(index)}
                onClick={() => pick(index)}
                className={`flex w-full items-center gap-2.5 px-4 py-2 text-left ${
                  index === active ? "bg-wash" : ""
                }`}
              >
                <StatusDot
                  tone={statusTone(row.session.status)}
                  pulse={row.session.status === "running"}
                />
                <span className="truncate font-sans text-[13.5px] font-medium text-foreground">
                  {row.title}
                </span>
                <span className="flex-1" />
                <span className="truncate font-mono text-[11.5px] text-label">
                  {row.projectName} · {row.slot?.word ?? row.session.status}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
