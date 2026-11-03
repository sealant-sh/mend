import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Page, PageHeader } from "#/components/kit/page";
import {
  TabGroup,
  TabGroupClose,
  TabGroupLink,
  TabGroupToggle,
  TabLine,
  TabLink,
} from "#/components/kit/tab-line";
import type { ProjectDetailDto, ProjectDto } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

import { OpenInVsCode } from "./open-in-vscode";
import { OpenShellMenu } from "./open-shell-menu";
import { SETTINGS_TABS } from "./settings-sections";
import { projectResourcesOptions } from "./tabs/resources";

/** The origin as people say it: `github.com/sealant-sh/mend`, without scheme, user or `.git`. */
export const originWords = (project: Pick<ProjectDto, "originUrl" | "storePath">): string => {
  const origin = project.originUrl;
  if (origin === null) return project.storePath;
  return origin
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\d)/, "$1/")
    .replace(/\.git$/, "");
};

/** "shared with Mend" or "private": who sees the project, in the organization's own name. */
export const useVisibilityWords = (visibility: ProjectDto["visibility"]): string => {
  const trpc = useTRPC();
  const organization = useQuery(
    trpc.organization.current.queryOptions(undefined, { retry: false, staleTime: 60_000 }),
  ).data;
  if (visibility === "private") return "private";
  return `shared with ${organization?.organization.name ?? "the organization"}`;
};

/**
 * Every project page (screens K1 to K11, L1 to L8): the header with Open a shell and Open in VS
 * Code, then the tab line. Settings sits at the end of the line and opens its own tabs on the same
 * line. The layout route owns this frame, so moving between tabs swaps only the content below.
 */
export function ProjectFrame({
  detail,
  children,
}: {
  readonly detail: ProjectDetailDto;
  readonly children: ReactNode;
}) {
  const { project } = detail;
  const visibility = useVisibilityWords(project.visibility);
  return (
    <Page
      className="pt-[30px]"
      head={
        <>
          <PageHeader
            eyebrow="project"
            title={project.name}
            className="mb-5"
            description={
              <span className="font-mono text-[12px]">
                {originWords(project)} · {project.defaultBranch} · {visibility}
              </span>
            }
            actions={
              <>
                <OpenShellMenu detail={detail} />
                <OpenInVsCode detail={detail} />
              </>
            }
          />
          <ProjectTabs detail={detail} />
        </>
      }
    >
      <div className="pt-[22px]">{children}</div>
    </Page>
  );
}

function ProjectTabs({ detail }: { readonly detail: ProjectDetailDto }) {
  const trpc = useTRPC();
  const projectId = detail.project.id;
  const params = { projectId };
  const inSettings = useLocation({
    select: (location) => location.pathname.startsWith(`/projects/${projectId}/settings`),
  });
  // The counts ride reads the tabs make anyway; a count not read yet shows nothing.
  const resources = useQuery(projectResourcesOptions(trpc, projectId, null)).data;
  const skills = useQuery(trpc.skills.forProject.queryOptions({ id: projectId })).data;

  return (
    <TabLine label={`${detail.project.name} project`}>
      <TabLink
        to="/projects/$projectId"
        params={params}
        activeOptions={{ exact: true }}
        count={detail.sessions.length}
      >
        Sessions
      </TabLink>
      <TabLink to="/projects/$projectId/worktrees" params={params} count={detail.worktrees.length}>
        Worktrees
      </TabLink>
      <TabLink
        to="/projects/$projectId/resources"
        params={params}
        count={resources?.settings.length}
      >
        Resources
      </TabLink>
      <TabLink to="/projects/$projectId/skills" params={params} count={skills?.length}>
        Skills
      </TabLink>
      {inSettings ? (
        <TabGroup
          label="Settings"
          close={<TabGroupClose to="/projects/$projectId" params={params} label="Close settings" />}
        >
          {SETTINGS_TABS.map((tab) => (
            <TabGroupLink
              key={tab.slug}
              to="/projects/$projectId/settings/$section"
              params={{ projectId, section: tab.slug }}
            >
              {tab.label}
            </TabGroupLink>
          ))}
        </TabGroup>
      ) : (
        <TabGroupToggle
          to="/projects/$projectId/settings/$section"
          params={{ projectId, section: "general" }}
          icon="settings"
        >
          Settings
        </TabGroupToggle>
      )}
    </TabLine>
  );
}
