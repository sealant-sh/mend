import { Button } from "@mend/ui-old/components/ui/button";
import { cn } from "@mend/ui-old/lib/utils";
import { Link } from "@tanstack/react-router";

import { useEventsState } from "#/lib/events";

const isMac = window.mend.platform === "darwin";
const palette = isMac ? "⌘⇧P" : "Ctrl+Shift+P";
const alt = isMac ? "⌥" : "Alt+";

/**
 * Frameless window controls for Linux/Windows (macOS keeps its own inset
 * traffic lights). Plain glyph buttons on the right, the way VS Code / Spotify
 * do it — not faux-macOS dots on a non-mac OS. Close reddens on hover; the
 * others just wash.
 */
function WindowControl({ className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant="ghost"
      className={cn(
        "no-drag h-12 w-12 rounded-none text-muted-foreground transition-colors",
        className,
      )}
      {...props}
    />
  );
}

function WindowControls() {
  return (
    <div className="-mr-4 ml-1 flex items-stretch" role="group" aria-label="Window">
      <WindowControl aria-label="Minimize window" onClick={() => window.mend.window.minimize()}>
        <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
          <line x1="1.5" y1="6" x2="9.5" y2="6" stroke="currentColor" strokeWidth="1" />
        </svg>
      </WindowControl>
      <WindowControl
        aria-label="Maximize window"
        onClick={() => window.mend.window.toggleMaximize()}
      >
        <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true" fill="none">
          <rect x="1.5" y="1.5" width="8" height="8" stroke="currentColor" strokeWidth="1" />
        </svg>
      </WindowControl>
      <WindowControl
        aria-label="Close window"
        className="hover:bg-[var(--sw-red)] hover:text-white"
        onClick={() => window.mend.window.close()}
      >
        <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
          <line x1="1.5" y1="1.5" x2="9.5" y2="9.5" stroke="currentColor" strokeWidth="1" />
          <line x1="9.5" y1="1.5" x2="1.5" y2="9.5" stroke="currentColor" strokeWidth="1" />
        </svg>
      </WindowControl>
    </div>
  );
}

/**
 * The window's handle (Figma 82:433): "Mend", a mono fact about the cockpit,
 * and the two shortcuts that matter. On macOS the OS draws the traffic lights
 * (inset, native); on Linux/Windows we draw min/max/close on the right. The
 * event stream's state shows only when it is not simply live — silence is the
 * normal case.
 */
export function Titlebar({
  liveCount,
  mendUnauthorized = false,
}: {
  readonly liveCount: number | null;
  /** The Mend server rejected the saved token — the cockpit still runs on herdr. */
  readonly mendUnauthorized?: boolean;
}) {
  const events = useEventsState();
  const fact =
    liveCount === null
      ? "· cockpit"
      : `· cockpit · ${liveCount} session${liveCount === 1 ? "" : "s"} live`;
  const stream = mendUnauthorized
    ? "mend · token rejected"
    : events === "live" || events === "connecting"
      ? null
      : events === "reconnecting"
        ? "mend · reconnecting"
        : events === "unauthorized"
          ? "mend · signed out"
          : "mend · not connected";
  return (
    <header
      className={`drag-region flex h-12 shrink-0 items-center gap-2.5 border-b border-rule bg-background pr-4 ${
        isMac ? "pl-[76px]" : "pl-4"
      }`}
    >
      <span className="font-display text-[17px] font-semibold tracking-[-0.02em] text-foreground">
        Mend
      </span>
      <span className="font-mono text-[12px] text-label">{fact}</span>
      <span className="flex-1" />
      {stream !== null && (
        <Link
          to="/connect"
          className={`no-drag mr-4 font-mono text-[12px] hover:underline ${
            stream === "mend · not connected" ? "text-label" : "text-warning"
          }`}
        >
          {stream}
        </Link>
      )}
      <span className="font-mono text-[12px] whitespace-pre text-label">
        {`${palette} sessions   ${alt}space summon`}
      </span>
      <Link
        to="/settings"
        aria-label="Settings"
        title="Settings (Ctrl+,)"
        className="no-drag ml-3 grid size-6 place-items-center rounded-md text-label hover:bg-[var(--sw-sunken)] hover:text-foreground"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
            stroke="currentColor"
            strokeWidth="1.6"
          />
        </svg>
      </Link>
      {!isMac && <WindowControls />}
    </header>
  );
}
