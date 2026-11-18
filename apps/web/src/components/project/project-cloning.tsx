import { Button } from "@mend/ui/components/ui/button";
import { Progress } from "@mend/ui/components/ui/progress";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useSyncExternalStore } from "react";

import { NotFoundScreen, PendingScreen } from "#/components/route-screens";
import { adoptionProgressOptions, clonePercent, useAdoptionAttempt } from "#/lib/adoptions";
import type { AdoptionProgressDto } from "#/lib/api";
import { cloneWords } from "#/lib/clone-state";
import { lastProject } from "#/lib/new-session";
import { usePhone } from "#/lib/phone";
import { repositoryName, visibleToWords } from "#/lib/projects";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";

import { SidebarToggle } from "../app-sidebar.tsx";
import { PhoneHeader } from "../workspace/phone-header.tsx";
import { ProjectFacts } from "./project-frame.tsx";

const subscribeToSeconds = (onChange: () => void) => {
  const timer = setInterval(onChange, 1_000);
  return () => clearInterval(timer);
};
const secondNow = () => Math.floor(Date.now() / 1_000);

/** Whole seconds since `since`, drawn again each second while shown. */
function Elapsed({ since }: { readonly since: Date }) {
  const now = useSyncExternalStore(subscribeToSeconds, secondNow, secondNow);
  return <>{Math.max(0, now - Math.floor(since.getTime() / 1_000))}s</>;
}

/**
 * A project's address that names no project: the clone the person started under that key, while
 * it runs (Doop "Project · cloning"). The server keeps no project until the clone finishes, and
 * none when it fails, so a clone that finished moves to its project and anything else is not
 * found. Projects lists a failed clone as its own row.
 */
export function ProjectOrClone({ id }: { readonly id: string }) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const progress = useQuery(adoptionProgressOptions(trpc, id));
  const adoptedId = progress.data?.state === "adopted" ? (progress.data.projectId ?? null) : null;
  // The clone finished while the page was open: the project is there now. Moving to it follows
  // the server, so it runs as the change is seen.
  useEffect(() => {
    if (adoptedId !== null)
      void navigate({
        to: "/projects/$projectId",
        params: { projectId: adoptedId },
        replace: true,
      });
  }, [adoptedId, navigate]);
  if (progress.isPending) return <PendingScreen />;
  if (progress.isError || progress.data === null || progress.data.state !== "running")
    return adoptedId === null ? <NotFoundScreen /> : <PendingScreen />;
  return <ProjectCloning progress={progress.data} />;
}

function ProjectCloning({ progress }: { readonly progress: AdoptionProgressDto }) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const phone = usePhone();
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  // What this browser asked for: the visibility, which the server's read of a clone leaves out.
  const attempt = useAdoptionAttempt(viewer.userId);
  const visibility = attempt?.id === progress.id ? attempt.visibility : null;
  const percent = clonePercent(progress);
  const organizationName = viewer.organization.name;
  const newSession = () => {
    // The composer offers this clone and queues the session on it until the clone finishes.
    lastProject.set(progress.id);
    void navigate({ to: phone ? "/new" : "/" });
  };
  return (
    <div className="flex min-w-0 flex-col max-lg:min-h-dvh lg:h-[calc(100dvh-2*var(--spacing-sheet-inset))] lg:flex-none">
      <header className="flex h-header shrink-0 items-center gap-2 border-b bg-background pr-2.5 pl-3 max-lg:hidden">
        <SidebarToggle />
        <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
        <h1 className="flex min-w-0 flex-1 items-baseline gap-2 text-prose whitespace-nowrap">
          <Link
            to="/projects"
            className="shrink-0 text-muted-foreground outline-none hover:text-foreground focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Projects
          </Link>
          <span aria-hidden className="shrink-0 text-faint">
            /
          </span>
          <span className="min-w-0 truncate font-medium">{progress.name}</span>
          <span className="shrink-0 text-meta text-muted-foreground">Cloning</span>
        </h1>
        <Button onClick={newSession}>New session</Button>
      </header>
      <PhoneHeader
        title={progress.name}
        sub={visibility === null ? "Cloning" : visibleToWords(visibility, organizationName)}
        back={{ link: { to: "/projects" }, label: "Projects" }}
        className="lg:hidden"
      />
      <ProjectFacts
        project={{ visibility, originUrl: progress.source, defaultBranch: null }}
        organizationName={organizationName}
        className="shrink-0 border-b px-5 py-3 max-lg:px-4"
      />
      <section
        aria-label="Clone"
        className="mx-auto flex w-full max-w-160 flex-1 flex-col gap-3 px-5 py-10 max-lg:px-4 max-lg:py-6"
      >
        <h2 className="text-title font-semibold">Cloning {repositoryName(progress.source)}</h2>
        <div aria-live="polite" className="flex flex-col gap-3">
          <Progress
            value={percent}
            aria-label={percent === null ? "Cloning" : `Cloning, ${percent}%`}
          />
          <p className="flex gap-3 text-prose">
            <span className="min-w-0 flex-1 truncate">{cloneWords(progress)}</span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {percent === null ? "" : `${percent}% · `}
              <Elapsed since={progress.startedAt} />
            </span>
          </p>
        </div>
        <p className="mt-3 text-prose text-muted-foreground">
          You can start a session now. It starts when the clone finishes. The clone keeps going if
          you leave this page.
        </p>
      </section>
      <div className="sticky bottom-0 border-t bg-background px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] lg:hidden">
        <Button size="touch" className="w-full" onClick={newSession}>
          New session
        </Button>
      </div>
    </div>
  );
}
