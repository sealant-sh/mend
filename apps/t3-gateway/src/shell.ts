import type { OrchestrationV2ShellSnapshot } from "@mend/t3-contracts";

/**
 * The orchestration projection's schema version at the pinned tag
 * (`ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION` in t3:apps/server/src/orchestration-v2/ProjectionStore.ts;
 * the contracts carry only its type).
 */
export const PROJECTION_SCHEMA_VERSION = 2;

/**
 * The shell before phase 1 projects Mend into it: no projects, no threads. Valid on its own, and a
 * client treats any later snapshot as a reset, so phase 1 can replace it without a protocol step.
 */
export const EMPTY_SHELL_SNAPSHOT: OrchestrationV2ShellSnapshot = {
  schemaVersion: PROJECTION_SCHEMA_VERSION,
  snapshotSequence: 0,
  projects: [],
  threads: [],
  archivedThreads: [],
};
