import { changesRouter } from "./changes.ts";
import { devicesRouter } from "./devices.ts";
import { environmentRouter } from "./environment.ts";
import { foldersRouter } from "./folders.ts";
import { gitRouter } from "./git.ts";
import { organizationRouter } from "./organization.ts";
import { platformRouter } from "./platform.ts";
import { projectsRouter } from "./projects.ts";
import { queueRouter } from "./queue.ts";
import { servicesRouter } from "./services.ts";
import { sessionsRouter } from "./sessions.ts";
import { settingsRouter } from "./settings.ts";
import { skillsRouter } from "./skills.ts";
import { slackRouter } from "./slack.ts";
import { router } from "./trpc.ts";
import { worktreesRouter } from "./worktrees.ts";

/**
 * The web tier's tRPC surface (plan: the UI never calls the API directly).
 * Every procedure is an Effect program over the contract-derived client
 * (../api) — the contract owns paths, validation and error statuses; superjson
 * carries the Type side to the browser intact.
 *
 * Raw data planes stay OUTSIDE tRPC by design: the terminal WebSocket
 * (/api/tty), the service tunnel, the keys bridge, and the SSE event stream
 * are held connections that tRPC's request/response model does not fit; the
 * web server proxies them verbatim.
 */
export const appRouter = router({
  changes: changesRouter,
  devices: devicesRouter,
  environment: environmentRouter,
  folders: foldersRouter,
  git: gitRouter,
  organization: organizationRouter,
  platform: platformRouter,
  projects: projectsRouter,
  queue: queueRouter,
  services: servicesRouter,
  sessions: sessionsRouter,
  worktrees: worktreesRouter,
  settings: settingsRouter,
  skills: skillsRouter,
  slack: slackRouter,
});

export type AppRouter = typeof appRouter;
