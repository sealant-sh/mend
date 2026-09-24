import { Button } from "@mend/ui/components/ui/button";

import type { SessionDto, SessionProcessDto } from "#/lib/api";
import { sessionTitle } from "#/lib/words";
import type { Tab } from "#/lib/workbench";

/**
 * Numbered views for the focused project. Session tabs address coding-agent
 * PTYs; shell tabs address named supporting processes in those sessions.
 */
export function TabBar({
  tabs,
  focused,
  sessions,
  processes,
  opening,
  onFocus,
  onClose,
  onNewShell,
  onTabMenu,
  stopsShell,
}: {
  readonly tabs: ReadonlyArray<Tab>;
  readonly focused: number;
  readonly sessions: ReadonlyMap<string, SessionDto>;
  readonly processes: ReadonlyMap<string, SessionProcessDto>;
  readonly opening: boolean;
  readonly onFocus: (index: number) => void;
  readonly onClose: (index: number) => void;
  readonly onNewShell: () => void;
  readonly onTabMenu: (index: number, event: React.MouseEvent) => void;
  /** Whether closing this shell tab stops the shell (the viewer steers) or only detaches it. */
  readonly stopsShell: (tab: Tab) => boolean;
}) {
  const title = (tab: Tab): string => {
    if (tab.kind === "shell") return processes.get(tab.processId)?.label ?? "shell";
    if (tab.kind === "logs") return `${tab.name} · logs`;
    const session = sessions.get(tab.sessionId);
    return session === undefined ? "session" : sessionTitle(session);
  };
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-rule bg-background px-2">
      {tabs.map((tab, index) => {
        const active = index === focused;
        return (
          <div
            key={
              tab.kind === "session"
                ? `s:${tab.sessionId}`
                : tab.kind === "shell"
                  ? `p:${tab.processId}`
                  : `l:${tab.processId}`
            }
            onContextMenu={(event) => onTabMenu(index, event)}
            className={`group/tab flex h-7 max-w-[220px] min-w-0 items-center gap-1.5 rounded-md pr-1 pl-2.5 ${
              active
                ? "bg-panel text-foreground shadow-xs ring-1 ring-[var(--sw-soft-rule)]"
                : "text-muted-foreground hover:bg-[var(--sw-sunken)] hover:text-foreground"
            }`}
          >
            <button
              type="button"
              onClick={() => onFocus(index)}
              className="flex min-w-0 items-center gap-1.5"
            >
              <span className="font-mono text-[11.5px] text-faint">{index + 1}</span>
              <span className="truncate font-sans text-[13px]">{title(tab)}</span>
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Close tab ${index + 1}`}
              title={
                tab.kind === "shell"
                  ? stopsShell(tab)
                    ? "Stop shell"
                    : "Detach shell tab"
                  : tab.kind === "logs"
                    ? "Close logs"
                    : "Detach session tab"
              }
              onClick={() => onClose(index)}
              className="size-4 shrink-0 rounded font-mono text-[12px] text-label opacity-0 transition-opacity group-hover/tab:opacity-100 focus-visible:opacity-100"
            >
              ×
            </Button>
          </div>
        );
      })}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onNewShell}
        disabled={opening}
        title="New shell in focused session (Ctrl+Shift+T)"
        className="shrink-0 rounded-md font-mono text-[15px] text-label"
      >
        {opening ? "…" : "+"}
      </Button>
    </div>
  );
}
