import { HttpApi } from "effect/unstable/httpapi";

import { accountsGroup } from "./accounts.ts";
import { sessionChangesGroup } from "./changes.ts";
import { cliAuthGroup, devicesGroup, userDevicesGroup, pairGroup } from "./devices.ts";
import { githubGroup } from "./github.ts";
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
import { issuesGroup, briefsGroup, runsGroup } from "./queue.ts";
import { sessionsGroup } from "./sessions.ts";
import { settingsGroup, dotfilesGroup } from "./settings.ts";
import { skillsGroup } from "./skills.ts";
import {
  healthGroup,
  instanceGroup,
  machineGroup,
  sealantGroup,
  workspaceSshGroup,
} from "./system.ts";
import { worktreesGroup } from "./worktrees.ts";

export const MendApi = HttpApi.make("mend")
  .add(healthGroup)
  .add(instanceGroup)
  .add(machineGroup)
  .add(sealantGroup)
  .add(workspaceSshGroup)
  .add(accountsGroup)
  .add(settingsGroup)
  .add(dotfilesGroup)
  .add(skillsGroup)
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
  .add(referencesGroup)
  .add(sessionsGroup)
  .add(worktreesGroup)
  .add(sessionChangesGroup)
  .add(githubGroup)
  .add(devicesGroup)
  .add(userDevicesGroup)
  .add(pairGroup)
  .add(cliAuthGroup)
  .prefix("/api");
