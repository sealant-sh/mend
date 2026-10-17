import type { ModelSelection, ProviderOptionSelection } from "@mend/t3-contracts";

import type { MendHarnessCatalog } from "./mend-client.ts";
import {
  effortLabelOf,
  effortOptionIdOf,
  asksForFast,
  FAST_TIER_REFUSAL,
  harnessOfInstance,
  harnessOwnModelOf,
  harnessProvider,
} from "./server-config.ts";

/**
 * A thread's model and reasoning effort against what Mend can honour. Mend sets both per launch of
 * the agent, never per turn. It records them with the agent and reuses them on every later launch
 * (mend#493), and a relaunch on another model resumes the same conversation, so a change of either
 * waits for the next launch the gateway makes: the one a message makes once the agent has stopped.
 * Mend's own restarts, such as a hand-over to another person's login, reuse what the agent ran on.
 * A protocol agent takes no service tier, so the gateway offers none and refuses Fast.
 */

/** The reasoning efforts Mend's launch takes (`LaunchRequest.effort` in @mend/api-contracts). */
export const MEND_EFFORTS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

/** What the thread runs with, or will from its agent's next start. */
export interface ThreadModelOptions {
  /** The Mend harness, which names t3code's provider and effort option. */
  readonly harness: string;
  /** The model the agent ran on; the harness's own choice reads as `harnessOwnModelOf`. */
  readonly runningModel: string;
  /** The model the person chose for the agent's next start; null when none waits. */
  readonly nextModel: string | null;
  /** The effort the agent recorded (or its launch names); null when Mend has none. */
  readonly runningEffort: string | null;
  /** The effort the person chose for the agent's next start; null when none waits. */
  readonly nextEffort: string | null;
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
  if (effortId !== null && effort !== null) options.push({ id: effortId, value: effort });
  return options.length === 0 ? undefined : options;
};

export type NextChoice =
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Chosen"; readonly value: string }
  | { readonly _tag: "Cleared" };

const UNCHANGED: NextChoice = { _tag: "Unchanged" };

const choiceOf = (value: string, running: string | null): NextChoice =>
  value === running ? { _tag: "Cleared" } : { _tag: "Chosen", value };

export type OptionsChange =
  | { readonly _tag: "Next"; readonly model: NextChoice; readonly effort: NextChoice }
  | { readonly _tag: "Refused"; readonly reason: string };

const refusal = (reason: string): OptionsChange => ({ _tag: "Refused", reason });

/**
 * What a model selection asks of the thread, from a message or from the model picker
 * (`thread.model-selection.set`). t3code sends only the options the picker holds explicitly, so an
 * option it leaves out changes nothing.
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
  let model: NextChoice = UNCHANGED;
  if (selection.model !== shownModelOf(thread)) {
    if (
      selection.model === harnessOwnModelOf(thread.harness) &&
      selection.model !== thread.runningModel
    ) {
      return refusal(
        `Mend keeps a started thread on the model it names and cannot hand it back to ${
          harnessProvider(thread.harness)?.displayName ?? thread.harness
        }'s own default. Pick a model.`,
      );
    }
    model = choiceOf(selection.model, thread.runningModel);
  }
  const selections = selection.options ?? [];
  if (asksForFast(selections)) return refusal(FAST_TIER_REFUSAL);
  const effortId = effortOptionIdOf(thread.harness);
  const effort =
    effortId === null ? undefined : selections.find((option) => option.id === effortId)?.value;
  if (effort === undefined || effort === (thread.nextEffort ?? thread.runningEffort)) {
    return { _tag: "Next", model, effort: UNCHANGED };
  }
  if (typeof effort !== "string" || !MEND_EFFORTS.has(effort)) {
    return refusal(`Mend has no ${String(effort)} reasoning effort.`);
  }
  return { _tag: "Next", model, effort: choiceOf(effort, thread.runningEffort) };
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
  if (taken === null || effort === null || taken.includes(effort)) return change;
  const highest = taken.at(-1);
  return highest === undefined
    ? change
    : { ...change, effort: choiceOf(highest, thread.runningEffort) };
};

const NEXT_LAUNCH = "From your next message after the agent stops";

export const nextModelLineOf = (thread: ThreadModelOptions, next: string): string =>
  `${NEXT_LAUNCH}: ${next} · it runs ${
    thread.runningModel === harnessOwnModelOf(thread.harness)
      ? "as it started"
      : `on ${thread.runningModel}`
  } until then`;

/** What a thread says while the effort chosen for its agent's next start is not yet the running one. */
export const nextEffortLineOf = (next: string, running: string | null): string =>
  `${NEXT_LAUNCH}: ${effortLabelOf(next)} reasoning effort · it runs ${
    running === null ? "as it started" : `on ${effortLabelOf(running)}`
  } until then`;

/** Mend's own words for its permission modes, as its session composer shows them. */
const MODE_WORDS: Readonly<Record<"bypass" | "ask", string>> = {
  ask: "ask before acting",
  bypass: "skip permission prompts",
};

/** What a thread says while the mode chosen for its agent's next start is not yet the running one. */
export const nextModeLineOf = (next: "bypass" | "ask"): string =>
  `${NEXT_LAUNCH}: ${MODE_WORDS[next]} · it runs as it started until then`;
