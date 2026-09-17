import { Link } from "@tanstack/react-router";

import {
  adoptedLabel,
  sourceLabel,
  type ProjectsDirectoryProps,
} from "#/components/projects-index/model";
import { LiveMark } from "#/components/projects-index/parts";

/** Compact project rows with source, default branch, adoption date and live sessions. */
export function ProjectsDirectory({ entries, onProjectMenu }: ProjectsDirectoryProps) {
  return (
    <div className="overflow-hidden rounded-2xl border border-rule bg-card shadow-xs">
      <div className="hidden items-center gap-4 border-b border-rule px-4 py-2 md:flex">
        <span className="ev-eyebrow min-w-0 flex-1">repository</span>
        <span className="ev-eyebrow w-[168px] shrink-0">default branch</span>
        <span className="ev-eyebrow w-[112px] shrink-0">visible to</span>
        <span className="ev-eyebrow w-[92px] shrink-0">adopted</span>
        <span className="ev-eyebrow w-[136px] shrink-0">sessions</span>
      </div>
      {entries.map(({ project, live, scope }, index) => {
        const source = project.originUrl ?? project.storePath;
        return (
          <Link
            key={project.id}
            to="/projects/$projectId"
            params={{ projectId: project.id }}
            onContextMenu={(event) => onProjectMenu(event, project)}
            className={`flex items-center gap-4 px-4 py-2.5 no-underline transition-colors outline-offset-[-2px] hover:bg-secondary ${
              index === 0 ? "" : "border-t border-rule-faint"
            }`}
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate font-sans text-[13px] font-medium text-foreground">
                {project.name}
              </span>
              <span className="truncate font-mono text-[11.5px] text-faint" title={source}>
                {sourceLabel(project)}
              </span>
            </span>
            <span
              className="hidden w-[168px] shrink-0 truncate font-mono text-[11.5px] text-ink-2 md:block"
              title={project.defaultBranch}
            >
              {project.defaultBranch}
            </span>
            <span
              className="hidden w-[112px] shrink-0 truncate font-mono text-[11.5px] text-ink-2 md:block"
              title={scope}
            >
              {scope}
            </span>
            <span className="hidden w-[92px] shrink-0 font-mono text-[11.5px] text-faint md:block">
              {adoptedLabel(project)}
            </span>
            <span className="flex shrink-0 justify-end md:w-[136px] md:justify-start">
              <LiveMark live={live} quiet />
            </span>
          </Link>
        );
      })}
    </div>
  );
}
