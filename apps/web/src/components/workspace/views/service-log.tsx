import { Button } from "@mend/ui/components/ui/button";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { type ReactNode, useCallback } from "react";

import { Overlay } from "#/components/projects/overlay";
import { QueryError } from "#/components/route-screens";
import { lastLogLine, logLines, type WorkspaceService } from "#/lib/workspace-services";

import { useServiceLog } from "./use-workspace-services.ts";

/**
 * A Service's log: one bar at the foot of the view with its newest line (the frame's "Logs · web
 * GET /checkout 200"), opening upward into the whole log; on a phone or a narrow tile, a sheet.
 */
export function LogBar({
  service,
  open,
  onOpenChange,
  asSheet,
  actions,
}: {
  readonly service: WorkspaceService;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly asSheet: boolean;
  readonly actions: ReactNode;
}) {
  const log = useServiceLog(service.logProcessId, service.live);
  const lines =
    log.isPending || log.isError ? [] : logLines(log.data.pages.flatMap((page) => page.chunks));
  const last = lastLogLine(lines);
  const body = log.isPending ? (
    <p className="px-4 py-3 text-meta text-muted-foreground">Reading the log…</p>
  ) : log.isError ? (
    <div className="px-4 py-3">
      <QueryError error={log.error} retry={() => void log.refetch()} retrying={log.isFetching} />
    </div>
  ) : (
    <LogText lines={lines} name={service.name} live={service.live} />
  );
  const bar = (
    <div className="flex h-10 shrink-0 items-center gap-2 border-t px-3 max-lg:h-11">
      <Button
        variant="ghost"
        size={asSheet ? "touch" : "sm"}
        aria-expanded={asSheet ? undefined : open}
        onClick={() => onOpenChange(!open)}
        className="min-w-0 flex-1 justify-start gap-2 font-normal"
      >
        {open && !asSheet ? <ChevronDownIcon aria-hidden /> : <ChevronUpIcon aria-hidden />}
        <span className="shrink-0">Logs</span>
        <span className="min-w-0 truncate font-mono text-meta text-muted-foreground">
          {service.name}
          {last === null ? "" : ` ${last}`}
        </span>
      </Button>
      {actions}
    </div>
  );
  if (asSheet)
    return (
      <>
        {bar}
        <Overlay
          open={open}
          onOpenChange={onOpenChange}
          title={`${service.name}'s log`}
          description={`What ${service.name} printed, as Mend recorded it.`}
          size="md"
          footer={
            <Button variant="outline" size="touch" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          }
        >
          {body}
        </Overlay>
      </>
    );
  return (
    <>
      {open ? (
        <section
          aria-label={`${service.name}'s log`}
          className="flex max-h-[45%] min-h-40 shrink-0 flex-col border-t"
        >
          {body}
        </section>
      ) : null}
      {bar}
    </>
  );
}

export function LogText({
  lines,
  name,
  live,
}: {
  readonly lines: ReadonlyArray<string>;
  readonly name: string;
  readonly live: boolean;
}) {
  // Kept at the newest line while it follows, as a terminal would.
  const follow = useCallback((element: HTMLPreElement | null) => {
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, []);
  if (lines.length === 0)
    return (
      <p className="px-4 py-3 text-meta text-muted-foreground">
        {live ? `${name} hasn't printed anything yet.` : `${name} printed nothing.`}
      </p>
    );
  return (
    <pre
      ref={follow}
      key={lines.length}
      className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-meta leading-relaxed whitespace-pre-wrap text-foreground"
    >
      {lines.join("\n")}
    </pre>
  );
}
