import { useSuspenseQuery } from "@tanstack/react-query";

import { useTRPC } from "#/lib/trpc";
import type { RouterAppContext } from "#/router";

import { FoldersSettings, foldersReads } from "./folders";
import { GeneralSettings, generalReads } from "./general";
import { GitSettings, gitReads } from "./git";
import { LandingSettings, landingReads } from "./landing";
import type { SettingsReads } from "./reads";
import { ReviewSettings, reviewReads } from "./review";
import { SecretsSettings, secretsReads } from "./secrets";
import { ServicesSettings, servicesReads } from "./services";
import { WorkspaceSettings, workspaceReads } from "./workspace";

export type SettingsSection =
  | "general"
  | "workspace"
  | "services"
  | "secrets"
  | "git"
  | "landing"
  | "review"
  | "folders";

const READS: Readonly<Record<SettingsSection, SettingsReads>> = {
  general: generalReads,
  workspace: workspaceReads,
  services: servicesReads,
  secrets: secretsReads,
  git: gitReads,
  landing: landingReads,
  review: reviewReads,
  folders: foldersReads,
};

/**
 * What a Settings tab reads before it shows, started together so the tab never waterfalls. The
 * project detail is already in the cache from the layout, and every tab can say where an
 * inherited value comes from, so the organization's settings start loading too.
 */
export async function settingsLoader(
  context: RouterAppContext,
  projectId: string,
  section: SettingsSection,
): Promise<void> {
  void context.queryClient.prefetchQuery(
    context.trpc.organization.settings.queryOptions(undefined, { retry: false }),
  );
  await Promise.all(READS[section](context, projectId));
}

/** The Settings tab the URL names. */
export function ProjectSettingsSection({
  projectId,
  section,
}: {
  readonly projectId: string;
  readonly section: SettingsSection;
}) {
  const trpc = useTRPC();
  const detail = useSuspenseQuery(trpc.projects.detail.queryOptions({ id: projectId })).data;
  switch (section) {
    case "general":
      return <GeneralSettings detail={detail} />;
    case "workspace":
      return <WorkspaceSettings detail={detail} />;
    case "services":
      return <ServicesSettings detail={detail} />;
    case "secrets":
      return <SecretsSettings detail={detail} />;
    case "git":
      return <GitSettings detail={detail} />;
    case "landing":
      return <LandingSettings detail={detail} />;
    case "review":
      return <ReviewSettings detail={detail} />;
    case "folders":
      return <FoldersSettings detail={detail} />;
  }
}
