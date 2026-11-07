import type { HistoryNativeBinding } from "@mend/domain/workbench";

import { conversationDirOf, conversationHomeOf } from "./conversation-home.ts";
import { HARNESS_HOME_MOUNT_PATH } from "./harness-state.ts";

/** Resolve durable placement without consulting the current capture or executor layout. */
export const historyBindingPaths = (
  binding: Pick<HistoryNativeBinding, "location" | "ownerId" | "key">,
  sessionId: string,
) => {
  const holder = binding.location === "holderHome";
  const saved = holder
    ? HARNESS_HOME_MOUNT_PATH
    : conversationDirOf(HARNESS_HOME_MOUNT_PATH, binding.ownerId, sessionId, binding.key);
  return {
    saved,
    home: holder ? HARNESS_HOME_MOUNT_PATH : conversationHomeOf(sessionId),
    seed: holder ? `${HARNESS_HOME_MOUNT_PATH}/history/native/${binding.key}` : saved,
  };
};
