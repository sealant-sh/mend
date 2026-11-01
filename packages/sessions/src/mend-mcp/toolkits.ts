import type { UsersRepo } from "@mend/db";
import { Layer } from "effect";

import type { Screens } from "../screen/screens.ts";
import { HtmlRenderToolkitLive } from "./html-render.ts";
import type { ProofCaptures } from "./proof-captures.ts";
import { ProofToolsLive } from "./proof-tools.ts";
import { ScreenToolsElsewhereLive, ScreenToolsLive } from "./screen-tools.ts";
import type { SessionPages } from "./session-pages.ts";

export const MEND_TOOLKITS: Layer.Layer<
  never,
  never,
  SessionPages | Screens | UsersRepo | ProofCaptures
> = Layer.mergeAll(HtmlRenderToolkitLive, ScreenToolsLive, ProofToolsLive);

/** A process that builds no `Screens`: its screen tools say where screens are driven. */
export const MEND_TOOLKITS_WITHOUT_SCREENS: Layer.Layer<never, never, SessionPages> =
  Layer.mergeAll(HtmlRenderToolkitLive, ScreenToolsElsewhereLive);

export type MendMcpServices = Layer.Services<typeof MEND_TOOLKITS>;
