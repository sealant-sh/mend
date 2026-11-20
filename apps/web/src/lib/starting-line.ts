import type { LaunchPhase } from "@mend/domain/workbench";

/** What a starting session says while it gets ready: the same words however it was started. */
export const STARTING_LINE = "Getting the session ready";

/**
 * The starting line for where the launch has got to (SLNT-1196). The usual steps (the workspace
 * booting, or being prepared) say nothing more; a wait a person may notice says what it waits for,
 * in plain words.
 */
export const startingLine = (phase: LaunchPhase | null): string => {
  if (phase === null) return STARTING_LINE;
  switch (phase.kind) {
    case "booting":
    case "preparing":
      return STARTING_LINE;
    case "queued":
      return `${STARTING_LINE} · waiting for a free machine`;
    case "building":
      return `${STARTING_LINE} · ${phase.words.replace(/ · step (\d+)\/(\d+)$/, ", step $1 of $2").replace(/ · step (\d+)$/, ", step $1")}`;
    case "waiting-previous":
      return `${STARTING_LINE} · ${phase.words.replace(/^waiting · /, "")}`;
  }
};
