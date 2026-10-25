import { Layer } from "effect";

import { HtmlRenderToolkitLive } from "./html-render.ts";
import type { SessionPages } from "./session-pages.ts";

export const MEND_TOOLKITS: Layer.Layer<never, never, SessionPages> =
  Layer.mergeAll(HtmlRenderToolkitLive);

export type MendMcpServices = Layer.Services<typeof MEND_TOOLKITS>;
