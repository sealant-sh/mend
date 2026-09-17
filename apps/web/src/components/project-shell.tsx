import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@mend/ui/components/ui/popover";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ProjectNavigation } from "#/components/project-navigation";
import { AppShell } from "#/components/shell";
import type { ProjectDto } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";
import { startSession } from "#/lib/workbench-menus";

/** All project tabs share one frame; their content cannot reposition the header or navigation. */
export function ProjectShell({
  project,
  children,
}: {
  readonly project: ProjectDto;
  readonly children: ReactNode;
}) {
  const navigate = useNavigate();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [shellStarting, setShellStarting] = useState(false);

  return (
    <AppShell projectId={project.id}>
      <div className="min-w-0">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <Link to="/projects" className="ev-eyebrow no-underline hover:text-foreground">
              Projects
            </Link>
            <h1 className="mt-2 font-display text-3xl font-medium tracking-tight text-foreground break-words">
              {project.name}
            </h1>
            <p className="mt-2 font-mono text-xs text-muted-foreground break-all">
              {project.defaultBranch} · {project.originUrl ?? "No origin recorded"} ·{" "}
              {project.visibility}
            </p>
            <Popover>
              <PopoverTrigger className="mt-2 inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground">
                Repository details <ChevronDown className="size-3" aria-hidden="true" />
              </PopoverTrigger>
              <PopoverContent align="start" className="w-80 max-w-[calc(100vw-48px)] p-4">
                <PopoverTitle>Repository details</PopoverTitle>
                <dl className="grid gap-1 font-mono text-[11.5px] break-all">
                  <dt className="text-label">Store</dt>
                  <dd>{project.storePath}</dd>
                  {project.adoptedSha !== null && (
                    <>
                      <dt className="mt-2 text-label">SHA at adoption</dt>
                      <dd>{project.adoptedSha}</dd>
                    </>
                  )}
                </dl>
              </PopoverContent>
            </Popover>
          </div>
          <button
            type="button"
            disabled={shellStarting}
            onClick={() => {
              setShellStarting(true);
              void startSession(navigate, { queryClient, trpc }, project.id, "shell").finally(() =>
                setShellStarting(false),
              );
            }}
            className="rounded-xl border border-border bg-panel px-3.5 py-2 text-[13px] font-medium text-foreground shadow-xs transition-transform hover:-translate-y-0.5 disabled:opacity-50"
          >
            {shellStarting ? "Starting…" : "Open a shell"}
          </button>
        </header>
        <ProjectNavigation projectId={project.id} />
        {children}
      </div>
    </AppShell>
  );
}
