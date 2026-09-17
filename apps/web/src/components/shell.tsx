import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { authClient } from "#/lib/auth-client";
import { useTRPC } from "#/lib/trpc";
import { LIVE_STATES } from "#/lib/workbench-menus";

/**
 * The workbench shell: a persistent left sidebar (brand, primary nav, an
 * optional page-contextual rail, the adopted projects with a liveness dot,
 * the machine block) beside one centered content frame. The shell owns its
 * width and gutters for every page. The sidebar is the
 * ambient view of the machine — which repos have agents alive, whether this
 * box is reachable off-box — and stays put while you move between Now, a
 * session, and a review. Below `lg` it folds into a top strip.
 *
 * `projectId` marks the project the page belongs to — a session or review
 * page is inside a project even though its URL isn't under /projects. `rail`
 * is the slot for whatever the current page wants at hand (a session's
 * checkpoints, a review's file list); it renders under the primary nav.
 */
export function AppShell({
  children,
  rail,
  projectId,
}: {
  readonly children: ReactNode;
  readonly rail?: ReactNode;
  readonly projectId?: string | undefined;
}) {
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col gap-7 overflow-y-auto border-r border-rule bg-panel px-5 py-6 lg:flex">
        <Brand />
        <PrimaryNav />
        {rail === undefined ? null : <div className="flex flex-col gap-2.5">{rail}</div>}
        <ProjectsBlock currentId={projectId} />
        <div className="mt-auto flex flex-col gap-5">
          <MachineBlock />
          <SignOut />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-rule bg-panel px-5 py-3 lg:hidden">
          <Brand compact />
          <PrimaryNav horizontal />
          <SignOut />
        </header>
        <main className="min-w-0 flex-1 px-6 py-8 lg:px-12 lg:py-12">
          <div className="mx-auto w-full min-w-0 max-w-[1180px]">{children}</div>
        </main>
      </div>
    </div>
  );
}

function Brand({ compact = false }: { readonly compact?: boolean }) {
  return (
    <Link
      to="/"
      className={
        compact ? "flex items-baseline gap-2 no-underline" : "flex flex-col gap-[3px] no-underline"
      }
      aria-label="Mend — what needs you"
    >
      <span className="font-display text-[21px] leading-none font-medium tracking-[-0.02em] text-foreground">
        Mend
      </span>
      <span className="ev-eyebrow">by sealant</span>
    </Link>
  );
}

function PrimaryNav({ horizontal = false }: { readonly horizontal?: boolean }) {
  return (
    <nav
      className={
        horizontal
          ? "order-last flex w-full items-center justify-between gap-1 sm:order-none sm:w-auto"
          : "flex w-full flex-col gap-0.5"
      }
      aria-label="Primary"
    >
      <NavItem to="/">Now</NavItem>
      <NavItem to="/projects">Projects</NavItem>
      <NavItem to="/teams">Teams</NavItem>
      <NavItem to="/skills">Skills</NavItem>
      <NavItem to="/settings">Settings</NavItem>
    </nav>
  );
}

function NavItem({ to, children }: { readonly to: string; readonly children: ReactNode }) {
  return (
    <Link
      to={to}
      className="rounded-[10px] px-2 py-2 font-sans text-[13px] font-medium text-ink-2 no-underline transition-colors duration-200 hover:bg-secondary hover:text-foreground data-[status=active]:bg-wash data-[status=active]:text-info sm:px-3"
      activeOptions={{ exact: to === "/" }}
    >
      {children}
    </Link>
  );
}

/**
 * Every adopted project, with a dot that is filled green while any session in
 * it is live and hollow otherwise — the "which repos have agents alive right
 * now" glance, always in view. The current project (the page's, not just the
 * URL's) takes the same cobalt wash as the active nav item.
 */
function ProjectsBlock({ currentId }: { readonly currentId: string | undefined }) {
  const trpc = useTRPC();
  const projects = useQuery(trpc.projects.list.queryOptions()).data ?? [];
  const active = useQuery(trpc.sessions.listActive.queryOptions()).data ?? [];
  if (projects.length === 0) return null;
  const liveProjects = new Set(
    active.filter((session) => LIVE_STATES.has(session.status)).map((session) => session.projectId),
  );
  return (
    <div className="flex flex-col gap-2.5">
      <p className="ev-eyebrow">projects</p>
      <ul className="flex flex-col gap-0.5">
        {projects.map((project) => {
          const live = liveProjects.has(project.id);
          const current = project.id === currentId;
          return (
            <li key={project.id}>
              <Link
                to="/projects/$projectId"
                params={{ projectId: project.id }}
                className={`flex items-center gap-2 rounded-[10px] px-3 py-1.5 font-mono text-[12px] no-underline transition-colors duration-200 ${
                  current
                    ? "bg-wash text-info"
                    : "text-ink-2 hover:bg-secondary hover:text-foreground"
                }`}
                aria-current={current ? "page" : undefined}
                title={live ? `${project.name} · a session is live` : project.name}
              >
                <span
                  className={`size-[5px] shrink-0 rounded-full ${
                    live ? "bg-success-dot" : "border-[1.5px] border-faint bg-transparent"
                  }`}
                  aria-hidden="true"
                />
                <span className="truncate">{project.name}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** hostname · platform, and whether a tailnet address is bound (plan §7.5). */
function MachineBlock() {
  const trpc = useTRPC();
  const machine = useQuery(
    trpc.platform.machine.queryOptions(undefined, { staleTime: 30_000, refetchInterval: 30_000 }),
  ).data;
  if (machine === undefined) return null;
  const reachable = machine.tailnet.status === "reachable";
  return (
    <div className="flex flex-col gap-2">
      <p className="ev-eyebrow">machine</p>
      <p className="truncate font-mono text-[12px] text-ink-2">
        {machine.hostname} · {machine.platform}
      </p>
      <p
        className={`flex items-center gap-[7px] font-mono text-[11.5px] ${
          reachable ? "text-success" : "text-ink-2"
        }`}
        title={machine.tailnet.address ?? undefined}
      >
        <span
          className={`size-1.5 shrink-0 rounded-full ${
            reachable ? "bg-success-dot" : "border-[1.5px] border-faint bg-transparent"
          }`}
          aria-hidden="true"
        />
        {reachable ? "tailnet · reachable" : "tailnet · not detected"}
      </p>
    </div>
  );
}

function SignOut() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="self-start font-sans text-xs font-medium text-muted-foreground transition-colors duration-200 hover:text-foreground"
      onClick={() => {
        void authClient.signOut().then(() => navigate({ to: "/login" }));
      }}
    >
      Sign out
    </button>
  );
}
