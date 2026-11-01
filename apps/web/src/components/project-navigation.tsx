import { Link } from "@tanstack/react-router";

/** Project work and configuration are sibling pages, not competing columns. */
export function ProjectNavigation({ projectId }: { readonly projectId: string }) {
  const className =
    "border-b-2 border-transparent px-1 py-3 text-[13px] font-medium text-muted-foreground no-underline transition-colors hover:text-foreground data-[status=active]:border-primary data-[status=active]:text-foreground";
  return (
    <nav aria-label="Project" className="mt-6 flex gap-6 border-b border-rule">
      <Link
        to="/projects/$projectId"
        params={{ projectId }}
        activeOptions={{ exact: true }}
        className={className}
      >
        Worktrees
      </Link>
      <Link
        to="/projects/$projectId/configuration"
        params={{ projectId }}
        activeOptions={{ exact: true }}
        className={className}
      >
        Configuration
      </Link>
    </nav>
  );
}
