import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { useTRPC } from "#/lib/trpc";

/**
 * The eyebrow as a way back up: projects / <name> / … / leaf. Same mono
 * machine-label voice as the plain eyebrow — the path is a fact, the links
 * are quiet until hovered. The project's crumb waits for the list: no
 * "project" placeholder while its name is on the way.
 */
export function ProjectCrumbs({
  projectId,
  sessionId,
  leaf,
}: {
  readonly projectId: string;
  /** Set when the leaf sits under a session (the review page) — links it. */
  readonly sessionId?: string;
  readonly leaf: string;
}) {
  const trpc = useTRPC();
  const projects = useQuery(trpc.projects.list.queryOptions());
  const name = (projects.data ?? []).find((project) => project.id === projectId)?.name;
  return (
    <p className="ev-eyebrow">
      <Link to="/projects" className="transition-colors hover:text-foreground">
        projects
      </Link>
      <span className="mx-1.5 text-faint">/</span>
      {projects.isPending ? null : (
        <>
          <Link
            to="/projects/$projectId"
            params={{ projectId }}
            className="transition-colors hover:text-foreground"
          >
            {name ?? "project"}
          </Link>
          <span className="mx-1.5 text-faint">/</span>
        </>
      )}
      {sessionId !== undefined && (
        <>
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId }}
            className="transition-colors hover:text-foreground"
          >
            session
          </Link>
          <span className="mx-1.5 text-faint">/</span>
        </>
      )}
      {leaf}
    </p>
  );
}
