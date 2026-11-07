import type { UsersRepo } from "@mend/db";
import { Layer } from "effect";

import type { OrganizationExecutor } from "../executor/executor.ts";
import type { Screens } from "../screen/screens.ts";
import { ExecutorToolsLive } from "./executor-tools.ts";
import { HtmlRenderToolkitLive } from "./html-render.ts";
import type { ProofCaptures } from "./proof-captures.ts";
import { ProofToolsLive } from "./proof-tools.ts";
import { ScreenToolsElsewhereLive, ScreenToolsLive } from "./screen-tools.ts";
import type { SessionPages } from "./session-pages.ts";

export const MEND_TOOLKITS: Layer.Layer<
  never,
  never,
  SessionPages | Screens | UsersRepo | ProofCaptures | OrganizationExecutor
> = Layer.mergeAll(HtmlRenderToolkitLive, ScreenToolsLive, ProofToolsLive, ExecutorToolsLive);

/** A process that builds no `Screens`: its screen tools say where screens are driven. */
export const MEND_TOOLKITS_WITHOUT_SCREENS: Layer.Layer<
  never,
  never,
  SessionPages | OrganizationExecutor
> = Layer.mergeAll(HtmlRenderToolkitLive, ScreenToolsElsewhereLive, ExecutorToolsLive);

export type MendMcpServices = Layer.Services<typeof MEND_TOOLKITS>;
