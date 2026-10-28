/**
 * Test doubles other packages' tests compose over: the in-memory pointer store and the capture
 * world (a real bare project repository, a directory bucket, memory refs, the runner).
 */
export * from "./capture-store-memory.ts";
export * from "./capture-world.ts";
export * from "./fake-workspace.ts";
export * from "./forward-fixture.ts";
export {
  previewsRepoOf,
  sealantLaunchLayer,
  servedSocketApis,
  setup,
  withEngine,
  type World,
} from "./engine/fixture.ts";
