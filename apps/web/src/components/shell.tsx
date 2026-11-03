import { cn } from "@mend/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useHydrated, useLocation, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { WorkspacesRefusedLine } from "#/components/host-user-namespaces";
import { Button, Eyebrow, focusRing, IconButton } from "#/components/kit/button";
import { Icon, type IconName } from "#/components/kit/icons";
import { Dot } from "#/components/kit/status";
import { InfoPopover, Tip } from "#/components/kit/tip";
import { forgetSignedInPerson } from "#/components/session-message-input";
import { authClient } from "#/lib/auth-client";
import { needsYouCount } from "#/lib/inbox";
import { inboxQuery } from "#/lib/inbox-live";
import { useInboxMarks } from "#/lib/inbox-marks";
import { useTRPC } from "#/lib/trpc";
import { railExpanded } from "#/lib/ui-prefs";
import { useWorkbenchEvents } from "#/lib/workbench-events";
import { LIVE_STATES } from "#/lib/workbench-menus";

/**
 * The app shell: the icon rail on the left of every signed-in page, beside the page itself.
 * The rail expands to show labels and the projects; the choice is kept per browser.
 *
 * `layout="frame"` centres a page that has not moved to the redesign yet in the old content
 * column. `layout="bare"` hands the whole area to the page, which lays out its own columns (the
 * Sessions inbox, a `Page` with a `PageHeader`). `projectId` marks the project the page belongs to
 * in the expanded rail. `rail={false}` hides the rail (a session full screen) and keeps the page
 * where it was in the tree, so nothing beside it remounts.
 *
 * Below `md` (a phone) the page is one column the height of the visible viewport, and the rail is
 * a bar along its foot. The breakpoint is CSS alone, so the server's HTML is already a phone's.
 * `phoneBar={false}` leaves the bar out where the page takes the whole screen (an open session).
 */
export function AppShell({
  children,
  projectId,
  layout = "frame",
  rail = true,
  phoneBar = true,
}: {
  readonly children: ReactNode;
  readonly projectId?: string | undefined;
  readonly layout?: "frame" | "bare";
  readonly rail?: boolean;
  readonly phoneBar?: boolean;
}) {
  // Every signed-in page hears the tab's events through the shell, Settings included: an
  // account removed from its organization is told why wherever it is (docs/adr/0003).
  useWorkbenchEvents();
  const expanded = railExpanded.use();
  return (
    <div className="flex min-h-dvh bg-background max-md:h-dvh max-md:flex-col">
      {!rail ? null : expanded ? <ExpandedRail currentProjectId={projectId} /> : <Rail />}
      {layout === "bare" ? (
        <div className="flex min-w-0 flex-1 max-md:min-h-0 max-md:flex-col">{children}</div>
      ) : (
        <main className="min-w-0 flex-1 px-6 py-8 max-md:min-h-0 max-md:overflow-y-auto max-md:px-4 max-md:py-6 lg:px-12 lg:py-12">
          <div className="mx-auto w-full max-w-[1180px] min-w-0">{children}</div>
        </main>
      )}
      {phoneBar ? <PhoneBar /> : null}
    </div>
  );
}

type Area = "sessions" | "projects" | "skills" | "settings";

const AREAS: ReadonlyArray<{
  readonly area: Area;
  readonly label: string;
  readonly icon: IconName;
  readonly to: "/" | "/projects" | "/skills" | "/settings";
}> = [
  { area: "sessions", label: "Sessions", icon: "sessions", to: "/" },
  { area: "projects", label: "Projects", icon: "projects", to: "/projects" },
  { area: "skills", label: "Skills", icon: "skills", to: "/skills" },
  { area: "settings", label: "Settings", icon: "settings", to: "/settings" },
];

/** Which rail entry a path belongs to: a session and its review live under Sessions. */
const areaOf = (pathname: string): Area | null => {
  if (pathname === "/" || pathname.startsWith("/sessions") || pathname.startsWith("/changes"))
    return "sessions";
  if (pathname.startsWith("/projects")) return "projects";
  if (pathname.startsWith("/skills")) return "skills";
  if (pathname.startsWith("/settings")) return "settings";
  return null;
};

/**
 * Every session the person can see that has not ended, from the inbox's read: the event stream
 * patches its rows one by one, so the rail's counts never read a list again for an event.
 */
const useOpenSessions = () => {
  const trpc = useTRPC();
  return useQuery({ ...inboxQuery(trpc), select: (rows) => rows.map((row) => row.session) }).data;
};

/** Waiting sessions this person has not snoozed or settled; zero until both reads arrive. */
const useNeedsYou = () => {
  const active = useOpenSessions();
  const marks = useInboxMarks().data;
  return active === undefined || marks === undefined ? 0 : needsYouCount(active, marks, new Date());
};

const sessionsLabel = (needsYou: number) =>
  needsYou === 0 ? "Sessions" : `Sessions, ${needsYou} need${needsYou === 1 ? "s" : ""} you`;

function Rail() {
  const area = areaOf(useLocation({ select: (location) => location.pathname }));
  const needsYou = useNeedsYou();
  return (
    <aside
      aria-label="Mend"
      className="sticky top-0 flex h-dvh w-[60px] shrink-0 max-md:hidden flex-col items-center gap-1.5 border-r border-rule pt-4 pb-3.5"
    >
      <Link to="/" aria-label="Mend · sessions" className={cn("mb-3.5 rounded-[9px]", focusRing)}>
        <Mark />
      </Link>
      <nav aria-label="Primary" className="flex flex-col items-center gap-1.5">
        {AREAS.map((entry) => {
          const current = entry.area === area;
          const label = entry.area === "sessions" ? sessionsLabel(needsYou) : entry.label;
          return (
            <Tip key={entry.area} content={label} side="right" align="center" delay={300}>
              <Link
                to={entry.to}
                aria-label={label}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "relative grid size-9 place-items-center rounded-[10px] transition-colors",
                  current
                    ? "bg-wash text-info"
                    : "text-ink-2 hover:bg-secondary hover:text-foreground",
                  focusRing,
                )}
              >
                <Icon name={entry.icon} />
                {entry.area === "sessions" && needsYou > 0 ? (
                  <span
                    aria-hidden="true"
                    className="absolute top-[7px] right-[7px] size-1.5 rounded-full bg-warning-dot shadow-[0_0_0_2px_var(--sw-bg)]"
                  />
                ) : null}
              </Link>
            </Tip>
          );
        })}
      </nav>
      <span className="flex-1" />
      <IconButton
        icon="expand"
        label="Expand sidebar"
        aria-expanded={false}
        onClick={() => railExpanded.set(true)}
      />
      <PersonMenu place="rail" />
    </aside>
  );
}

/**
 * The rail on a phone: the four areas and the person, along the foot of the page, each at least
 * 44 px tall for a thumb. Hidden from `md` up, where the rail takes its place.
 */
function PhoneBar() {
  const area = areaOf(useLocation({ select: (location) => location.pathname }));
  const needsYou = useNeedsYou();
  return (
    <nav
      aria-label="Primary"
      className="flex shrink-0 items-stretch border-t border-rule bg-background px-1 pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {AREAS.map((entry) => {
        const current = entry.area === area;
        return (
          <Link
            key={entry.area}
            to={entry.to}
            aria-current={current ? "page" : undefined}
            aria-label={entry.area === "sessions" ? sessionsLabel(needsYou) : undefined}
            className={cn(
              "relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-[10px] font-sans text-[11px] leading-none font-medium no-underline transition-colors",
              current ? "text-info" : "text-ink-2 hover:text-foreground",
              focusRing,
            )}
          >
            <span className="relative">
              <Icon name={entry.icon} />
              {entry.area === "sessions" && needsYou > 0 ? (
                <span
                  aria-hidden="true"
                  className="absolute -top-0.5 -right-1 size-1.5 rounded-full bg-warning-dot shadow-[0_0_0_2px_var(--sw-bg)]"
                />
              ) : null}
            </span>
            {entry.label}
          </Link>
        );
      })}
      <span className="grid min-h-14 flex-1 place-items-center">
        <PersonMenu place="bar" />
      </span>
    </nav>
  );
}

function ExpandedRail({ currentProjectId }: { readonly currentProjectId: string | undefined }) {
  const trpc = useTRPC();
  const area = areaOf(useLocation({ select: (location) => location.pathname }));
  const needsYou = useNeedsYou();
  const projects = useQuery(trpc.projects.list.queryOptions());
  const active = useOpenSessions() ?? [];
  const liveCount = new Map<string, number>();
  for (const session of active)
    if (LIVE_STATES.has(session.status))
      liveCount.set(session.projectId, (liveCount.get(session.projectId) ?? 0) + 1);
  return (
    <aside
      aria-label="Mend"
      className="sticky top-0 flex h-dvh w-[220px] shrink-0 max-md:hidden flex-col gap-[22px] overflow-y-auto border-r border-rule px-3.5 py-[22px]"
    >
      <div className="flex items-start">
        <Link to="/" className={cn("rounded-md no-underline", focusRing)}>
          <span className="block font-display text-[21px] leading-none font-medium tracking-[-0.02em] text-foreground">
            Mend
          </span>
          <Eyebrow className="mt-1">by sealant</Eyebrow>
        </Link>
        <span className="flex-1" />
        <IconButton
          icon="collapse"
          label="Collapse sidebar"
          aria-expanded
          onClick={() => railExpanded.set(false)}
        />
      </div>
      <nav aria-label="Primary" className="flex flex-col gap-0.5">
        {AREAS.map((entry) => {
          const current = entry.area === area;
          return (
            <Link
              key={entry.area}
              to={entry.to}
              aria-current={current ? "page" : undefined}
              aria-label={entry.area === "sessions" ? sessionsLabel(needsYou) : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-[10px] px-2.5 py-[7px] font-sans text-[13px] leading-[1.3] font-medium no-underline transition-colors",
                current
                  ? "bg-wash text-info"
                  : "text-ink-2 hover:bg-secondary hover:text-foreground",
                focusRing,
              )}
            >
              <Icon name={entry.icon} />
              {entry.label}
              {entry.area === "sessions" && needsYou > 0 ? (
                <span aria-hidden="true" className="ml-auto font-mono text-[11px] text-warning">
                  {needsYou}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
      <div>
        <Eyebrow className="px-2.5 pb-2">projects</Eyebrow>
        {projects.isPending ? (
          <p className="px-2.5 font-mono text-[11px] text-faint">reading projects…</p>
        ) : projects.isError ? (
          <p className="px-2.5 font-mono text-[11px] text-danger">projects did not load</p>
        ) : projects.data.length === 0 ? (
          <Link
            to="/projects"
            className="px-2.5 font-sans text-[12.5px] text-muted-foreground underline-offset-2 hover:underline"
          >
            Adopt a repository
          </Link>
        ) : (
          <ul className="flex flex-col gap-px">
            {projects.data.map((project) => {
              const live = liveCount.get(project.id) ?? 0;
              const current = project.id === currentProjectId;
              return (
                <li key={project.id}>
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: project.id }}
                    aria-current={current ? "page" : undefined}
                    aria-label={
                      live === 0 ? project.name : `${project.name}, ${live} live sessions`
                    }
                    className={cn(
                      "flex items-center gap-1.5 rounded-[10px] px-2.5 py-1.5 font-sans text-[13px] leading-[1.3] no-underline transition-colors",
                      current
                        ? "bg-wash text-info"
                        : "text-ink-2 hover:bg-secondary hover:text-foreground",
                      focusRing,
                    )}
                  >
                    <Dot tone={live > 0 ? "ok" : "off"} />
                    <span className="truncate">{project.name}</span>
                    {live > 0 ? (
                      <span aria-hidden="true" className="ml-auto font-mono text-[11px] text-faint">
                        {live}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="mt-auto">
        <PersonMenu place="expanded" />
      </div>
    </aside>
  );
}

function Mark() {
  return (
    <span className="grid size-[30px] place-items-center rounded-[9px] bg-foreground font-display text-[17px] leading-none font-semibold tracking-[-0.04em] text-background">
      m
    </span>
  );
}

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter((part) => part !== "")
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

/**
 * The person at the foot of the rail: who is signed in, the machine and how it is reached
 * (docs/adr/0004), and Sign out. `place` is the icon rail, the expanded rail or the phone's bar.
 */
function PersonMenu({ place }: { readonly place: "rail" | "expanded" | "bar" }) {
  const compact = place !== "expanded";
  // The session is the browser's own read: the server renders nobody, so the first client render
  // must too, or a session that arrives mid-hydration mismatches the server's text.
  const session = authClient.useSession().data;
  const user = useHydrated() ? session?.user : undefined;
  const name = user?.name ?? "";
  const avatar = (
    <span className="grid size-[26px] shrink-0 place-items-center rounded-full border border-rule bg-secondary font-sans text-[10.5px] leading-none font-semibold text-ink-2">
      {initialsOf(name === "" ? (user?.email ?? "?") : name)}
    </span>
  );
  return (
    <InfoPopover
      label="Account and machine"
      side={place === "rail" ? "right" : "top"}
      align="end"
      trigger={
        <button
          type="button"
          aria-label={name === "" ? "Account and machine" : `${name}, account and machine`}
          className={cn(
            place === "bar"
              ? "grid size-11 place-items-center rounded-full"
              : compact
                ? "mt-2 rounded-full"
                : "flex w-full items-center gap-[9px] rounded-[10px] px-1.5 py-1 font-sans text-[13px] font-medium text-ink-2 hover:bg-secondary",
            focusRing,
          )}
        >
          {avatar}
          {compact ? null : <span className="truncate">{name}</span>}
        </button>
      }
    >
      <div className="grid gap-3">
        <div>
          <p className="font-sans text-[13.5px] font-semibold">{name}</p>
          {user?.email === undefined ? null : (
            <p className="font-mono text-[12px] text-muted-foreground">{user.email}</p>
          )}
        </div>
        <MachineBlock />
        <SignOut />
      </div>
    </InfoPopover>
  );
}

/** What the footer says about how this instance is reached: facts, in the order they were learned. */
export const exposureLine = (exposure: {
  readonly declared: "loopback" | "private" | "public";
  readonly originScheme: "http" | "https";
  readonly arrivedVia: "direct" | "trusted-proxy";
}): string =>
  [
    `exposure · ${exposure.declared}`,
    exposure.originScheme,
    ...(exposure.arrivedVia === "trusted-proxy" ? ["via proxy"] : []),
  ].join(" · ");

/**
 * hostname · platform, then how this instance is reached: what the operator declared and what the
 * server observed (docs/adr/0004). It is a report, so it carries no colour of success: a server
 * cannot observe who can reach it. A server older than `exposure` shows the machine alone.
 */
function MachineBlock() {
  const trpc = useTRPC();
  const machine = useQuery(
    trpc.platform.machine.queryOptions(undefined, { staleTime: 30_000, refetchInterval: 30_000 }),
  ).data;
  if (machine === undefined) return null;
  const exposure = machine.exposure;
  return (
    <div className="flex flex-col gap-1.5 border-t border-rule-faint pt-3">
      <Eyebrow>machine</Eyebrow>
      <p className="truncate font-mono text-[12px] text-ink-2">
        {machine.hostname} · {machine.platform}
      </p>
      {exposure === undefined ? null : (
        <p
          className="font-mono text-[11.5px] text-ink-2"
          title={`declared by the operator · addresses on the host: ${exposure.addressKinds.join(", ")}`}
        >
          {exposureLine(exposure)}
        </p>
      )}
      <WorkspacesRefusedLine />
    </div>
  );
}

function SignOut() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return (
    <Button
      size="sm"
      variant="ghost"
      className="justify-self-start px-0 hover:bg-transparent hover:text-foreground"
      onClick={() => {
        void authClient
          .signOut()
          .then(() => forgetSignedInPerson(queryClient))
          .then(() => navigate({ to: "/login" }));
      }}
    >
      Sign out
    </Button>
  );
}
