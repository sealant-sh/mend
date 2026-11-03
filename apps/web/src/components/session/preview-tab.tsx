import { cn } from "@mend/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { focusRing, IconButton, Pick } from "#/components/kit/button";
import { Icon } from "#/components/kit/icons";
import { Menu, MenuItem, MenuMeta } from "#/components/kit/menu";
import { Segment } from "#/components/kit/segment";
import { Dot } from "#/components/kit/status";
import { ServicesCard, serviceIsLive, useServiceOpens } from "#/components/services-card";
import { useTRPC } from "#/lib/trpc";

import type { SessionFacts } from "./facts";

const DEVICES = [
  { value: "desktop", label: "Desktop", width: null },
  { value: "tablet", label: "Tablet", width: 820 },
  { value: "phone", label: "Phone", width: 390 },
] as const;

type Device = (typeof DEVICES)[number]["value"];

/**
 * A path typed into the bar, opened in the preview. A preview on its own origin takes the path
 * on that origin. A preview Mend serves is opened through Mend's own `/preview-auth?…&path=`
 * link, which is relative: the path goes in its `path` query, and the link stays relative.
 */
export const joinPath = (base: string, path: string): string => {
  const clean =
    path.trim() === "" ? "/" : path.trim().startsWith("/") ? path.trim() : `/${path.trim()}`;
  if (base.startsWith("/")) {
    const link = new URL(base, "http://mend.invalid");
    link.searchParams.set("path", clean);
    return `${link.pathname}${link.search}`;
  }
  return new URL(clean, new URL(base).origin).toString();
};

/**
 * The Preview tab (screens P3, C3, X2): the session's web app, as a Service a browser reaches.
 * Pick a Service, a path and a device width; open it in a tab of its own. Below it, every Service
 * of the session with its controls.
 */
export function PreviewTab({ facts }: { readonly facts: SessionFacts }) {
  const trpc = useTRPC();
  const { session, control } = facts;
  const services = useQuery(
    trpc.services.list.queryOptions(
      { all: true },
      { select: (views) => views.filter((view) => view.service.sessionId === session.id) },
    ),
  );
  const live = (services.data ?? []).filter(serviceIsLive);
  const opens = useServiceOpens(session.id, session.worktreeId, live);
  const openable = live.filter((view) => (opens.get(view.service.id) ?? null) !== null);
  const [picked, setPicked] = useState<string | null>(null);
  const current = openable.find((view) => view.service.id === picked) ?? openable[0] ?? null;
  const base = current === null ? null : (opens.get(current.service.id) ?? null);
  const [path, setPath] = useState("/");
  const [shown, setShown] = useState("/");
  const [reload, setReload] = useState(0);
  const [device, setDevice] = useState<Device>("desktop");
  const src = base === null ? null : joinPath(base, shown);
  const width = DEVICES.find((entry) => entry.value === device)?.width ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 pb-2">
      {current === null || src === null ? (
        <p
          role={services.isPending ? "status" : undefined}
          className="rounded-[18px] border border-dashed border-input px-5 py-6 text-[13.5px] text-muted-foreground"
        >
          {services.isPending
            ? "Reading the session's services…"
            : services.isError
              ? "The services did not load."
              : live.length === 0
                ? "No service is running. A Service the agent starts, or one run below, shows here."
                : "A service is running but does not open in a browser from here yet. Its row below says why."}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Menu
              trigger={
                <Pick aria-label={`Service: ${current.service.name}`}>
                  <Dot tone="ok" />
                  {current.service.name}
                  <span className="font-mono text-[11.5px] text-muted-foreground">
                    :{current.service.workspacePort}
                  </span>
                </Pick>
              }
            >
              {openable.map((view) => (
                <MenuItem
                  key={view.service.id}
                  onClick={() => {
                    setPicked(view.service.id);
                    setPath("/");
                    setShown("/");
                  }}
                >
                  {view.service.name}
                  <MenuMeta>:{view.service.workspacePort}</MenuMeta>
                </MenuItem>
              ))}
            </Menu>
            <form
              className="min-w-[160px] flex-1"
              onSubmit={(event) => {
                event.preventDefault();
                setShown(path);
                setReload(reload + 1);
              }}
            >
              <input
                aria-label="Path"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                className="w-full rounded-[10px] border border-input bg-panel px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none focus-visible:border-primary"
              />
            </form>
            <IconButton
              icon="reload"
              label="Reload"
              bordered
              onClick={() => setReload(reload + 1)}
            />
            <Segment label="Device" value={device} onChange={setDevice} options={DEVICES} />
            <a
              href={src}
              target="_blank"
              rel="noreferrer"
              aria-label="Open in a new tab"
              title="Open in a new tab"
              className={cn(
                "grid size-[30px] shrink-0 place-items-center rounded-[9px] border border-rule bg-panel text-ink-2 shadow-xs hover:text-foreground",
                focusRing,
              )}
            >
              <Icon name="external" size={15} />
            </a>
          </div>
          <div className="flex min-h-[360px] flex-1 justify-center overflow-hidden rounded-[22px] border border-rule bg-panel shadow-sm">
            <iframe
              key={`${src}:${reload}`}
              title={`Preview of ${current.service.name}`}
              src={src}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
              className="h-full min-h-[360px] border-0 bg-white"
              style={{ width: width === null ? "100%" : `${width}px`, maxWidth: "100%" }}
            />
          </div>
        </>
      )}
      <ServicesCard
        sessionId={session.id}
        worktreeId={session.worktreeId}
        sessionLive={["starting", "running", "waiting", "idle"].includes(session.status)}
        steer={control.steer}
        runs={control.terminalInput}
        ownerName={facts.ownerName}
      />
    </div>
  );
}
