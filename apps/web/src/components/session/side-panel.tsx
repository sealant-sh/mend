import { cn } from "@mend/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { focusRing } from "#/components/kit/button";
import { Dot, StatusWord } from "#/components/kit/status";
import { serviceIsLive } from "#/components/services-card";
import { SessionPages } from "#/components/session-pages";
import type { SessionTab } from "#/lib/session-view";
import { useTRPC } from "#/lib/trpc";

import { type SessionFacts, screenDriver } from "./facts";

const FILES_SHOWN = 4;

/**
 * A side-panel section: its heading and its lines. The overview's headings are eyebrows; the
 * review's (Comments, Checks, Land) are titles.
 */
export function PanelSection({
  title,
  current = false,
  heading = "eyebrow",
  children,
}: {
  readonly title: ReactNode;
  readonly current?: boolean;
  readonly heading?: "eyebrow" | "title";
  readonly children: ReactNode;
}) {
  return (
    <section className="grid gap-2.5">
      {heading === "title" ? (
        <h2 className="font-sans text-[14.5px] font-semibold text-foreground">{title}</h2>
      ) : (
        <h2
          className={cn(
            "font-mono text-[10.5px] leading-[1.3] font-medium tracking-[0.06em] uppercase",
            current ? "text-info" : "text-label",
          )}
        >
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

const panelLink = cn(
  "flex w-full items-center justify-center rounded-xl border border-input bg-panel px-3.5 py-[9px] font-sans text-[13px] leading-none font-medium text-foreground no-underline shadow-xs transition-[translate,box-shadow] hover:-translate-y-px hover:shadow-sm",
  focusRing,
);

/**
 * The side panel beside every tab but Change (screen P1): the screen and who drives it, the
 * change's files, the Services a preview reaches, the latest checkpoints, and the session's other
 * repositories and pages when it has them. Each section leads to its tab.
 */
export function OverviewPanel({
  facts,
  tab,
}: {
  readonly facts: SessionFacts;
  readonly tab: SessionTab;
}) {
  return (
    <div className="grid gap-[22px]">
      <ScreenSection facts={facts} current={tab === "screen"} />
      <ChangeSection facts={facts} />
      <PreviewSection facts={facts} current={tab === "preview"} />
      <CheckpointsSection facts={facts} current={tab === "record"} />
      <RepositoriesSection facts={facts} />
      <PagesSection facts={facts} />
    </div>
  );
}

function ScreenSection({
  facts,
  current,
}: {
  readonly facts: SessionFacts;
  readonly current: boolean;
}) {
  const { screen } = facts;
  const driver = screenDriver(facts);
  const live = screen?.life._tag === "Live";
  return (
    <PanelSection title={current && live ? "Screen · open" : "Screen"} current={current && live}>
      {screen === null ? (
        <p className="text-[12.5px] text-muted-foreground">
          {facts.agentHarness
            ? `No screen. ${facts.agent} starts one when it needs a browser.`
            : "No screen."}
        </p>
      ) : (
        <>
          <Link
            to="/sessions/$sessionId/screen"
            params={{ sessionId: facts.session.id }}
            search={true}
            aria-label="Open the Screen tab"
            className={cn(
              "relative grid h-[104px] place-items-center overflow-hidden rounded-xl border border-rule bg-[#3a3d42] font-mono text-[10.5px] text-[#b9bbc0] no-underline",
              focusRing,
            )}
          >
            <span>
              screen :{screen.display} · {screen.width} × {screen.height}
            </span>
          </Link>
          <StatusWord tone={live ? "run" : "off"}>
            {driver ?? (screen.life._tag === "Ended" ? "stopped" : "starting")}
          </StatusWord>
        </>
      )}
    </PanelSection>
  );
}

function ChangeSection({ facts }: { readonly facts: SessionFacts }) {
  const trpc = useTRPC();
  const change = facts.detail.change;
  const diff = useQuery({
    ...trpc.changes.diff.queryOptions({ id: change?.id ?? "" }, { staleTime: 30_000 }),
    enabled: change !== null,
    select: (read) => read.files,
  });
  if (change === null)
    return (
      <PanelSection title="Change">
        <p className="text-[12.5px] text-muted-foreground">No change yet.</p>
      </PanelSection>
    );
  const files = diff.data ?? [];
  return (
    <PanelSection title="Change">
      {diff.isPending ? (
        <p role="status" className="font-mono text-[11.5px] text-muted-foreground">
          Reading the change…
        </p>
      ) : diff.isError ? (
        <p role="alert" className="font-mono text-[11.5px] text-danger">
          The change did not load.
        </p>
      ) : files.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">The worktree matches its base.</p>
      ) : (
        <ul className="grid font-mono text-[12px] leading-[2]">
          {files.slice(0, FILES_SHOWN).map((file) => (
            <li key={file.path} className="flex min-w-0 gap-2">
              <span className="min-w-0 flex-1 truncate text-ink-2" title={file.path}>
                {file.path.split("/").at(-1)}
              </span>
              {file.additions > 0 ? <span className="text-success">+{file.additions}</span> : null}
              {file.deletions > 0 ? <span className="text-danger">−{file.deletions}</span> : null}
            </li>
          ))}
          {files.length > FILES_SHOWN ? (
            <li className="text-faint">and {files.length - FILES_SHOWN} more</li>
          ) : null}
        </ul>
      )}
      <Link
        to="/sessions/$sessionId/change"
        params={{ sessionId: facts.session.id }}
        search={true}
        className={cn(panelLink, "mt-1")}
      >
        Review change
      </Link>
    </PanelSection>
  );
}

function PreviewSection({
  facts,
  current,
}: {
  readonly facts: SessionFacts;
  readonly current: boolean;
}) {
  const trpc = useTRPC();
  const services = useQuery(
    trpc.services.list.queryOptions(
      { all: true },
      {
        select: (views) =>
          views.filter(
            (view) => view.service.sessionId === facts.session.id && serviceIsLive(view),
          ),
      },
    ),
  );
  const live = services.data ?? [];
  return (
    <PanelSection title="Preview" current={current}>
      {live.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">
          {services.isPending ? "Reading services…" : "No service running."}
        </p>
      ) : (
        <Link
          to="/sessions/$sessionId/preview"
          params={{ sessionId: facts.session.id }}
          search={true}
          className={cn("rounded-md no-underline", focusRing)}
        >
          <StatusWord tone="ok" className="whitespace-normal">
            {live
              .map((view) => `${view.service.name ?? "service"} :${view.service.workspacePort}`)
              .join(" · ")}
          </StatusWord>
          <span className="sr-only"> · open the Preview tab</span>
        </Link>
      )}
    </PanelSection>
  );
}

function CheckpointsSection({
  facts,
  current,
}: {
  readonly facts: SessionFacts;
  readonly current: boolean;
}) {
  const checkpoints = facts.detail.checkpoints.toSorted((a, b) => b.ordinal - a.ordinal);
  return (
    <PanelSection title="Checkpoints" current={current}>
      {checkpoints.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">None yet.</p>
      ) : (
        <ul className="grid font-mono text-[12px] leading-[1.9] text-ink-2">
          {checkpoints.slice(0, 3).map((checkpoint) => (
            <li key={checkpoint.id} className="truncate">
              <Link
                to="/sessions/$sessionId/record"
                params={{ sessionId: facts.session.id }}
                search={true}
                hash={`checkpoint-${checkpoint.ordinal}`}
                className={cn(
                  "rounded-sm text-ink-2 no-underline hover:text-foreground",
                  focusRing,
                )}
              >
                <span className="text-faint">#{checkpoint.ordinal}</span> {checkpoint.trigger}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PanelSection>
  );
}

/** The repositories the session holds beside its worktree (docs/adr/0010), when it holds any. */
function RepositoriesSection({ facts }: { readonly facts: SessionFacts }) {
  const repositories = facts.detail.repositories;
  if (repositories.length === 0) return null;
  return (
    <PanelSection title="Repositories">
      <ul className="grid gap-2">
        {repositories.map((view) => (
          <li key={view.repository.id} className="grid gap-0.5">
            <span className="flex items-center gap-2 font-mono text-[12px] text-ink-2">
              <Dot
                tone={
                  view.repository.state === "ready"
                    ? "ok"
                    : view.repository.state === "failed"
                      ? "bad"
                      : view.repository.state === "missing"
                        ? "wait"
                        : "off"
                }
              />
              <span className="truncate">{view.repository.path}</span>
            </span>
            <span className="font-mono text-[11px] text-faint">
              {view.projectName ?? "project removed"} · {view.repository.branch} ·{" "}
              {view.repository.error ??
                (view.checkpointsBeyondStart > 0
                  ? `${view.checkpointsBeyondStart} checkpoint${view.checkpointsBeyondStart === 1 ? "" : "s"} beyond start`
                  : view.repository.capture === "nested"
                    ? "saved with the main repository"
                    : "no checkpoints beyond start")}
            </span>
            {view.change !== null && view.checkpointsBeyondStart > 0 ? (
              <Link
                to="/changes/$changeId"
                params={{ changeId: view.change.id }}
                className={cn("w-fit rounded-sm font-mono text-[11px] text-info", focusRing)}
              >
                Review its change
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </PanelSection>
  );
}

/** The pages the agent made in this session, each opened large in a dialog; none, no section. */
function PagesSection({ facts }: { readonly facts: SessionFacts }) {
  const trpc = useTRPC();
  const made = useQuery(
    trpc.sessions.pages.queryOptions({ id: facts.session.id }, { select: (pages) => pages.length }),
  ).data;
  return <SessionPages sessionId={facts.session.id} listed={made !== undefined && made > 0} />;
}
