import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A right-click menu, hand-rolled — no headless-UI dependency exists in this
 * repo. One floating panel per page (`useContextMenu`), items supplied at open
 * time, so a list of rows shares a single menu instance. Both apps import
 * this copy.
 */

export interface ContextMenuAction {
  readonly label: string;
  readonly onSelect: () => void;
  /** Second click executes — destructive actions confirm explicitly (plan §15). */
  readonly confirm?: string;
  readonly danger?: boolean;
  /** Shown briefly after selecting (e.g. "Copied") before the menu closes. */
  readonly flash?: string;
  readonly disabled?: boolean;
}

export type ContextMenuEntry = ContextMenuAction | "separator";

export interface ContextMenuSpec {
  /** Mono header naming what was right-clicked. */
  readonly title?: string;
  readonly entries: ReadonlyArray<ContextMenuEntry>;
}

interface OpenState extends ContextMenuSpec {
  readonly x: number;
  readonly y: number;
}

export function useContextMenu() {
  const [state, setState] = useState<OpenState | null>(null);

  const openMenu = (event: React.MouseEvent, spec: ContextMenuSpec) => {
    event.preventDefault();
    // Rows nest inside cards that carry their own menu; innermost wins.
    event.stopPropagation();
    setState({ x: event.clientX, y: event.clientY, ...spec });
  };

  const menuElement =
    state === null
      ? null
      : createPortal(
          // Keyed on position so a second right-click resets armed/flash state.
          <ContextMenu
            key={`${state.x}:${state.y}`}
            state={state}
            onClose={() => setState(null)}
          />,
          document.body,
        );

  return { openMenu, menuElement };
}

function ContextMenu({
  state,
  onClose,
}: {
  readonly state: OpenState;
  readonly onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const [flashed, setFlashed] = useState<number | null>(null);

  // Clamping to the viewport needs the rendered size; the panel is portaled to
  // <body> because ancestor hover transforms would hijack position:fixed.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const rect = panel.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(state.x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(state.y, window.innerHeight - rect.height - 8)),
    });
  }, [state]);

  // Focus once placed: the measuring render is `visibility: hidden`, and a hidden panel takes no
  // focus, so Escape and the arrows (handled on the overlay) would never reach the menu.
  useLayoutEffect(() => {
    if (position !== null) panelRef.current?.focus();
  }, [position]);

  const moveFocus = (delta: 1 | -1) => {
    const panel = panelRef.current;
    if (panel === null) return;
    const items = [...panel.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (items.length === 0) return;
    const current = items.findIndex((item) => item === document.activeElement);
    const next =
      current === -1
        ? delta === 1
          ? 0
          : items.length - 1
        : (current + delta + items.length) % items.length;
    items[next]?.focus();
  };

  const select = (index: number, action: ContextMenuAction) => {
    if (action.confirm !== undefined && armed !== index) {
      setArmed(index);
      return;
    }
    action.onSelect();
    if (action.flash !== undefined) {
      setFlashed(index);
      window.setTimeout(onClose, 700);
      return;
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50"
      onClick={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
        if (event.key === "ArrowDown") {
          event.preventDefault();
          moveFocus(1);
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          moveFocus(-1);
        }
      }}
    >
      <div
        ref={panelRef}
        role="menu"
        aria-orientation="vertical"
        tabIndex={-1}
        style={position ?? { left: state.x, top: state.y, visibility: "hidden" }}
        onClick={(event) => event.stopPropagation()}
        className="fixed min-w-[210px] max-w-[300px] rounded-xl border border-rule bg-popover py-1.5 shadow-[var(--shadow-overlay)] focus:outline-none"
      >
        {state.title !== undefined && (
          <p className="truncate px-3.5 pb-1.5 pt-1 font-mono text-[11px] text-faint">
            {state.title}
          </p>
        )}
        {state.entries.map((entry, index) =>
          entry === "separator" ? (
            <div key={index} role="separator" className="my-1.5 border-t border-rule-faint" />
          ) : (
            <button
              key={index}
              type="button"
              role="menuitem"
              disabled={entry.disabled === true}
              onClick={() => select(index, entry)}
              className={`block w-full px-3.5 py-1.5 text-left font-sans text-[13px] transition-colors focus:outline-none disabled:opacity-50 ${
                armed === index
                  ? "bg-secondary text-danger"
                  : entry.danger === true
                    ? "text-muted-foreground hover:bg-secondary hover:text-danger focus-visible:bg-secondary focus-visible:text-danger"
                    : "text-foreground hover:bg-secondary focus-visible:bg-secondary"
              }`}
            >
              {flashed === index
                ? (entry.flash ?? entry.label)
                : armed === index
                  ? entry.confirm
                  : entry.label}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
