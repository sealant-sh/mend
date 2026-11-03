import type { ResourceDefinition, WorktreeChoice } from "./resource.ts";

// Which level a worktree runs a resource at: plain rules, free of Effect, so a client that reads
// them loads no Schema (`./resource.ts` holds the Schemas and re-exports these).

/** The levels a worktree selects, or off. */
export const WORKTREE_CHOICES = ["project", "worktree", "off"] as const;

/** Every definition supports both levels. */
export const choicesFor = (
  _def: Pick<ResourceDefinition, "preset">,
): ReadonlyArray<WorktreeChoice> => WORKTREE_CHOICES;

/** A preset change cannot reinterpret existing own Postgres databases. */
export const changesWhatOwnIs = (
  held: Pick<ResourceDefinition, "preset">,
  next: Pick<ResourceDefinition, "preset">,
): boolean => held.preset === "postgres" && next.preset !== "postgres";

/** Project visibility is the default until a worktree stores a choice. */
export const choiceInEffect = (
  stored: WorktreeChoice | null,
  usesProjectResources = true,
): WorktreeChoice => stored ?? (usesProjectResources ? "project" : "off");
