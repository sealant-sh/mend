import { createContext, use } from "react";

import type { StopTarget } from "./session-stop.ts";

/**
 * Opens the Stop session dialog the inbox layout holds (`StopSessionHost`), for a sidebar or phone
 * inbox row's Stop session…. Null outside that layout, where rows offer no Stop.
 */
export const StopSessionContext = createContext<((target: StopTarget) => void) | null>(null);

export const useOpenStop = (): ((target: StopTarget) => void) | null => use(StopSessionContext);
