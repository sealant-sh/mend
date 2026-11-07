import { turnSelectionOf, type InteractionMode, type TurnSelection } from "@mend/domain/workbench";
import type { ModelSelection, ProviderOptionSelection } from "@mend/t3-contracts";

import type { MendHarnessCatalog } from "./mend-client.ts";
import {
  effortLabelOf,
  effortOptionIdOf,
  harnessOfInstance,
  harnessOwnModelOf,
} from "./server-config.ts";
import { speedOfOptions } from "./service-tier.ts";

/** Model and effort apply to new native turns; active steering retains its running selection. */
export const DEFAULT_EFFORT = "default";

/** The reasoning efforts Mend's launch takes (`LaunchRequest.effort` in @mend/api-contracts). */
export const MEND_EFFORTS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

/** What the thread runs with, or will on its next new turn. */
export interface ThreadModelOptions {
  readonly interactionMode?: InteractionMode;
  /** The Mend harness, which names t3code's provider and effort option. */
  readonly harness: string;
  /** Launch-model fallback, not an observation of the latest live turn. */
  readonly runningModel: string;
  /** The model the person chose for the next new turn; null when none waits. */
  readonly nextModel: string | null;
  /** The effort the agent recorded (or its launch names); null when Mend has none. */
  readonly runningEffort: string | null;
  /** The effort the person chose for the next new turn; null when none waits. */
  readonly nextEffort: string | null;
  /** The person's choice for new turns, independent of an already running turn. */
  readonly speed?: "standard" | "fast";
}

export const shownModelOf = (thread: ThreadModelOptions): string =>
  thread.nextModel ?? thread.runningModel;

/** The options t3code shows on the thread's picker: the effort it will run on. */
export const modelOptionsOf = (
  thread: ThreadModelOptions,
): ReadonlyArray<ProviderOptionSelection> | undefined => {
  const options: Array<ProviderOptionSelection> = [];
  const effortId = effortOptionIdOf(thread.harness);
  const effort = thread.nextEffort ?? thread.runningEffort;
  if (effortId !== null && effort !== null && effort !== DEFAULT_EFFORT)
    options.push({ id: effortId, value: effort });
  if (thread.harness === "codex" && thread.speed === "fast")
    options.push({ id: "serviceTier", value: "fast" });
  return options.length === 0 ? undefined : options;
};

export type NextChoice =
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Chosen"; readonly value: string }
  | { readonly _tag: "Cleared" };

const UNCHANGED: NextChoice = { _tag: "Unchanged" };

const choiceOf = (value: string, _running: string | null): NextChoice => ({
  _tag: "Chosen",
  value,
});

export type OptionsChange =
  | {
      readonly _tag: "Next";
      readonly model: NextChoice;
      readonly effort: NextChoice;
      readonly speed?: "standard" | "fast";
    }
  | { readonly _tag: "Refused"; readonly reason: string };

const refusal = (reason: string): OptionsChange => ({ _tag: "Refused", reason });

/**
 * What a model selection asks of the thread, from a message or from the model picker
 * (`thread.model-selection.set`). t3code sends only the options the picker holds explicitly, so an
 * option it leaves out explicitly restores the provider default.
 */
export const optionsChangeOf = (
  thread: ThreadModelOptions,
  selection: ModelSelection | undefined,
): OptionsChange => {
  if (selection === undefined) return { _tag: "Next", model: UNCHANGED, effort: UNCHANGED };
  if (harnessOfInstance(selection.instanceId)?.harness !== thread.harness) {
    return refusal(
      "Mend keeps a thread on the agent it started with and cannot hand it to another provider. Start a new thread.",
    );
  }
  const model = choiceOf(selection.model, thread.runningModel);
  const selections = selection.options ?? [];
  const speed = speedOfOptions(selections);
  if (speed === null) return refusal("Mend supports Standard and Fast service tiers.");
  if (speed === "fast" && thread.harness !== "codex")
    return refusal("Fast is available for Codex turns only.");
  const tier = thread.harness === "codex" ? { speed } : {};
  const effortId = effortOptionIdOf(thread.harness);
  const effort =
    effortId === null
      ? undefined
      : (selections.find((option) => option.id === effortId)?.value ?? DEFAULT_EFFORT);
  if (effort === undefined) {
    return { _tag: "Next", model, effort: UNCHANGED, ...tier };
  }
  if (typeof effort !== "string" || (!MEND_EFFORTS.has(effort) && effort !== DEFAULT_EFFORT)) {
    return refusal(`Mend has no ${String(effort)} reasoning effort.`);
  }
  return { _tag: "Next", model, effort: choiceOf(effort, thread.runningEffort), ...tier };
};

/**
 * The efforts a model takes in Mend's catalog: its own when it lists fewer, else its harness's
 * (`catalogEfforts` in @mend/domain). Null when the catalog does not know the harness.
 */
export const effortsTakenBy = (
  catalogs: ReadonlyArray<MendHarnessCatalog>,
  harness: string,
  model: string,
): ReadonlyArray<string> | null => {
  const catalog = catalogs.find((entry) => entry.harness === harness);
  if (catalog === undefined) return null;
  return catalog.models.find((entry) => entry.id === model)?.efforts ?? catalog.efforts;
};

export const nextLaunchModelOf = (
  thread: ThreadModelOptions,
  change: Extract<OptionsChange, { _tag: "Next" }>,
): string =>
  change.model._tag === "Chosen"
    ? change.model.value
    : change.model._tag === "Cleared"
      ? thread.runningModel
      : shownModelOf(thread);

/**
 * The change with its effort brought within what the next launch's model takes, the way Mend
 * clamps a launch's effort (`clampEffort` in @mend/domain): the highest the model takes.
 */
export const withEffortTaken = (
  thread: ThreadModelOptions,
  change: Extract<OptionsChange, { _tag: "Next" }>,
  taken: ReadonlyArray<string> | null,
): Extract<OptionsChange, { _tag: "Next" }> => {
  const effort =
    change.effort._tag === "Chosen"
      ? change.effort.value
      : change.effort._tag === "Cleared"
        ? thread.runningEffort
        : (thread.nextEffort ?? thread.runningEffort);
  if (taken === null || effort === null || effort === DEFAULT_EFFORT || taken.includes(effort))
    return change;
  const highest = taken.at(-1);
  return highest === undefined
    ? change
    : { ...change, effort: choiceOf(highest, thread.runningEffort) };
};

const NEXT_LAUNCH = "From your next message after the agent stops";

export const nextModelLineOf = (_thread: ThreadModelOptions, next: string): string =>
  `Selected for your next new turn: ${next}`;

/** A picker preference is requested, not an observation of the active turn. */
export const nextEffortLineOf = (next: string, _running: string | null): string =>
  `Selected for your next new turn: ${next === DEFAULT_EFFORT ? "default" : effortLabelOf(next)} reasoning effort`;

/** Capture the person's entire choice, including explicit provider defaults. */
export const turnSelectionOfOptions = (thread: ThreadModelOptions): TurnSelection | null =>
  turnSelectionOf(
    thread.harness,
    shownModelOf(thread) === harnessOwnModelOf(thread.harness) ? null : shownModelOf(thread),
    (thread.nextEffort ?? thread.runningEffort) === DEFAULT_EFFORT
      ? null
      : (thread.nextEffort ?? thread.runningEffort),
    thread.interactionMode ?? "default",
    thread.speed === "fast" ? "fast" : undefined,
  );

/** Mend's own words for its permission modes, as its session composer shows them. */
const MODE_WORDS: Readonly<Record<"bypass" | "ask", string>> = {
  ask: "ask before acting",
  bypass: "skip permission prompts",
};

/** What a thread says while the permission mode waits for the next process launch. */
export const nextModeLineOf = (next: "bypass" | "ask"): string =>
  `${NEXT_LAUNCH}: ${MODE_WORDS[next]} · it runs as it started until then`;
