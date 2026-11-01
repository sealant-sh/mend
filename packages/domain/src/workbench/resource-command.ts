import type { WorktreeChoice, ResourceLevel } from "./resource.ts";

/** Only selectors and load flags consume a following argument. Level flags are bare. */
export const RESOURCE_VALUE_FLAGS: ReadonlyArray<string> = [
  "--project-id",
  "--worktree-id",
  "--target",
  "--from",
  "--pull",
];
/** Positional resource command arguments, excluding selector values. */
export const resourcePositionals = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args.filter(
    (arg, index) => !arg.startsWith("--") && !RESOURCE_VALUE_FLAGS.includes(args[index - 1] ?? ""),
  );
/** Explicit level, or none. Callers refuse conflicting level flags. */
export const resourceLevelFlag = (args: ReadonlyArray<string>): ResourceLevel | null =>
  args.includes("--project") ? "project" : args.includes("--worktree") ? "worktree" : null;
/** Postgres's shared/own words are accepted aliases for the two levels. */
export const resourceChoiceOf = (value: string): WorktreeChoice | null =>
  value === "shared"
    ? "project"
    : value === "own"
      ? "worktree"
      : value === "project" || value === "worktree" || value === "off"
        ? value
        : null;
/** Non-interactive starts must make their level explicit. */
export const resourceLevelHint = (name: string): string =>
  `choose a level: mend resource start ${name} --project or --worktree`;
/** Writing resource tables is supplied by a later build. */
export const resourceAdditionOf = (
  _args: ReadonlyArray<string>,
): { readonly ok: false; readonly message: string } => ({
  ok: false,
  message: "not available in this build",
});
