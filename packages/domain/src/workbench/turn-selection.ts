import { Effect, Schema } from "effect";

import { EFFORT_LEVELS, HARNESS_EFFORTS, SPEED_MODES, type SpeedMode } from "./harness-launch.ts";

/** Native interaction for a new turn, independent of permission authorization. */
export const InteractionMode = Schema.Literals(["default", "plan"]);
export type InteractionMode = typeof InteractionMode.Type;

/** The harnesses that take a choice of model, effort, Plan and permission for each turn. */
export const SelectableHarness = Schema.Literals(["codex", "claude", "antigravity"]);
export type SelectableHarness = typeof SelectableHarness.Type;

export const isSelectableHarness = (harness: string): harness is SelectableHarness =>
  harness === "codex" || harness === "claude" || harness === "antigravity";

/** A complete choice for one new native turn. Inner nulls explicitly restore provider defaults. */
export const TurnSelection = Schema.Struct({
  harness: SelectableHarness,
  model: Schema.NullOr(Schema.String.check(Schema.isPattern(/\S/))),
  effort: Schema.NullOr(Schema.Literals(EFFORT_LEVELS)),
  interactionMode: InteractionMode.pipe(Schema.withDecodingDefaultKey(Effect.succeed("default"))),
  /** Omitted and `standard` both explicitly restore Standard on a new turn. */
  speed: Schema.optionalKey(Schema.Literals(SPEED_MODES)),
  /** Missing on legacy turns, which use their process's launch mode. */
  permissionMode: Schema.optionalKey(Schema.Literals(["bypass", "ask"])),
});
export type TurnSelection = typeof TurnSelection.Type;

/**
 * Capture launch defaults once at admission. Claude Code, Codex and Antigravity take a choice per
 * turn; other harnesses have no live selection contract.
 */
export function turnSelectionOf(
  harness: string,
  model: string | null | undefined,
  effort: string | null | undefined,
  interactionMode: InteractionMode = "default",
  speed?: SpeedMode,
): TurnSelection | null {
  if (!isSelectableHarness(harness)) return null;
  const level = EFFORT_LEVELS.find((value) => value === effort) ?? null;
  return {
    harness,
    model: model ?? null,
    effort: level,
    interactionMode,
    ...(speed === undefined ? {} : { speed }),
  };
}

/** Whether a keyed retry supplied a different complete choice. Omission replays the first receipt. */
export function selectionMatches(
  requested: TurnSelection | undefined,
  recorded: TurnSelection | null,
): boolean {
  return (
    requested === undefined ||
    (recorded !== null &&
      requested.harness === recorded.harness &&
      requested.model === recorded.model &&
      requested.effort === recorded.effort &&
      requested.interactionMode === recorded.interactionMode &&
      (requested.speed ?? "standard") === (recorded.speed ?? "standard") &&
      requested.permissionMode === recorded.permissionMode)
  );
}

/** Refuse a provider change or unsupported effort before any provider controls or prompt. */
export function turnSelectionRefusal(harness: string, selection: TurnSelection): string | null {
  if (selection.harness !== harness) return "A turn cannot switch this conversation's provider.";
  if (selection.speed === "fast" && harness !== "codex")
    return "Fast is available for Codex turns only.";
  if (selection.effort !== null && !HARNESS_EFFORTS[harness]?.includes(selection.effort))
    return `${harness} does not accept ${selection.effort} reasoning effort.`;
  return null;
}
