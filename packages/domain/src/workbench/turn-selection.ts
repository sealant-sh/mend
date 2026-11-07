import { Effect, Schema } from "effect";

import { EFFORT_LEVELS, HARNESS_EFFORTS } from "./harness-launch.ts";

/** Native interaction for a new turn, independent of permission authorization. */
export const InteractionMode = Schema.Literals(["default", "plan"]);
export type InteractionMode = typeof InteractionMode.Type;

/** A complete choice for one new native turn. Inner nulls explicitly restore provider defaults. */
export const TurnSelection = Schema.Struct({
  harness: Schema.Literals(["codex", "claude"]),
  model: Schema.NullOr(Schema.String.check(Schema.isPattern(/\S/))),
  effort: Schema.NullOr(Schema.Literals(EFFORT_LEVELS)),
  interactionMode: InteractionMode.pipe(Schema.withDecodingDefaultKey(Effect.succeed("default"))),
});
export type TurnSelection = typeof TurnSelection.Type;

/** Capture launch defaults once at admission; other harnesses have no live selection contract. */
export function turnSelectionOf(
  harness: string,
  model: string | null | undefined,
  effort: string | null | undefined,
  interactionMode: InteractionMode = "default",
): TurnSelection | null {
  if (harness !== "codex" && harness !== "claude") return null;
  const level = EFFORT_LEVELS.find((value) => value === effort) ?? null;
  return { harness, model: model ?? null, effort: level, interactionMode };
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
      requested.interactionMode === recorded.interactionMode)
  );
}

/** Refuse a provider change or unsupported effort before any provider controls or prompt. */
export function turnSelectionRefusal(harness: string, selection: TurnSelection): string | null {
  if (selection.harness !== harness) return "A turn cannot switch this conversation's provider.";
  if (selection.effort !== null && !HARNESS_EFFORTS[harness]?.includes(selection.effort))
    return `${harness} does not accept ${selection.effort} reasoning effort.`;
  return null;
}
