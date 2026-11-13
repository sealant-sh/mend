import { HttpApi } from "effect/http-api";

import { accessKeysGroup } from "./access-keys.ts";
import { accountsGroup } from "./accounts.ts";
import { agentMemoryGroup } from "./agent-memory.ts";
import { boatKeyGroup, personBoatKeyGroup } from "./boat-key.ts";
import { sessionChangesGroup } from "./changes.ts";
import { cliAuthGroup, devicesGroup, userDevicesGroup, pairGroup } from "./devices.ts";
import { dopplerGroup } from "./doppler.ts";
import { executorGroup } from "./executor.ts";
import { foldersGroup } from "./folders.ts";
import { githubGroup } from "./github.ts";
import { handoffsGroup } from "./handoffs.ts";
import { harnessModelsGroup } from "./harness-models.ts";
import { landingsGroup } from "./landing.ts";
import { projectLocalWorktreesGroup } from "./local-worktrees.ts";
import { mcpAppsGroup } from "./mcp-apps.ts";
import { mcpServersGroup } from "./mcp-servers.ts";
import { operatorGroup } from "./operator.ts";
import { accountOrganizationsGroup, invitationsGroup, organizationGroup } from "./organization.ts";
import { pageViewGroup, pagesGroup } from "./pages.ts";
import { personSettingsGroup } from "./person-settings.ts";
import { piProfileGroup } from "./pi-profile.ts";
import { previewsGroup } from "./previews.ts";
import {
  projectClusterBindingsGroup,
  projectEnvironmentGroup,
  projectSecretsGroup,
  projectRecipesGroup,
} from "./project-environment.ts";
import {
  projectsGroup,
  gitKeysGroup,
  referencesGroup,
  projectMountsGroup,
  projectLinksGroup,
} from "./projects.ts";
import { proofArtifactsGroup } from "./proof-artifacts.ts";
import { pullRequestMergeGroup } from "./pull-request-merge.ts";
import { pullRequestsGroup } from "./pull-requests.ts";
import { issuesGroup, briefsGroup, runsGroup } from "./queue.ts";
import { resourcesGroup } from "./resources.ts";
import { screensGroup } from "./screens.ts";
import { secretFilesGroup } from "./secret-files.ts";
import { sessionsGroup } from "./sessions.ts";
import { settingsGroup, dotfilesGroup } from "./settings.ts";
import { skillsGroup } from "./skills.ts";
import { slackGroup } from "./slack.ts";
import {
  healthGroup,
  instanceGroup,
  machineGroup,
  sealantGroup,
  workspaceSshGroup,
} from "./system.ts";
import { upgradeTicketExchangeGroup, upgradeTicketsGroup } from "./upgrade-tickets.ts";
import { worktreesGroup } from "./worktrees.ts";

export const MendApi = HttpApi.make("mend")
  .add(mcpAppsGroup)
  .add(healthGroup)
  .add(instanceGroup)
  .add(machineGroup)
  .add(sealantGroup)
  .add(workspaceSshGroup)
  .add(accountsGroup)
  .add(personSettingsGroup)
  .add(organizationGroup)
  .add(invitationsGroup)
  .add(accountOrganizationsGroup)
  .add(slackGroup)
  .add(boatKeyGroup)
  .add(personBoatKeyGroup)
  .add(operatorGroup)
  .add(foldersGroup)
  .add(settingsGroup)
  .add(dotfilesGroup)
  .add(skillsGroup)
  .add(piProfileGroup)
  .add(agentMemoryGroup)
  .add(secretFilesGroup)
  .add(mcpServersGroup)
  .add(dopplerGroup)
  .add(executorGroup)
  .add(harnessModelsGroup)
  .add(issuesGroup)
  .add(briefsGroup)
  .add(runsGroup)
  .add(projectsGroup)
  .add(gitKeysGroup)
  .add(projectEnvironmentGroup)
  .add(projectSecretsGroup)
  .add(projectClusterBindingsGroup)
  .add(projectMountsGroup)
  .add(projectLinksGroup)
  .add(projectRecipesGroup)
  .add(resourcesGroup)
  .add(referencesGroup)
  .add(sessionsGroup)
  .add(pagesGroup)
  .add(pageViewGroup)
  .add(worktreesGroup)
  .add(projectLocalWorktreesGroup)
  .add(previewsGroup)
  .add(screensGroup)
  .add(sessionChangesGroup)
  .add(proofArtifactsGroup)
  .add(landingsGroup)
  .add(handoffsGroup)
  .add(githubGroup)
  .add(pullRequestMergeGroup)
  .add(pullRequestsGroup)
  .add(devicesGroup)
  .add(userDevicesGroup)
  .add(accessKeysGroup)
  .add(pairGroup)
  .add(cliAuthGroup)
  .add(upgradeTicketsGroup)
  .add(upgradeTicketExchangeGroup)
  .prefix("/api");
