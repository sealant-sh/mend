import type { ModelSelection, ProviderOptionSelection } from "@mend/t3-contracts";

import {
  effortLabelOf,
  effortOptionIdOf,
  FAST_SERVICE_TIER,
  harnessOfInstance,
  harnessOwnModelOf,
  harnessProvider,
  SERVICE_TIER_OPTION_ID,
  STANDARD_SERVICE_TIER,
} from "./server-config.ts";

/**
 * A thread's model, reasoning effort and service tier against what Mend can honour. Mend sets all
 * three per launch of the agent, never per turn. It records the model and the effort with the
 * session and reuses them on every later launch (mend#493), and a relaunch on another model resumes
 * the same conversation, so a change of either waits for the agent's next start. It records no tier
 * and a protocol agent takes none, so a change of tier on a started thread is refused.
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
  /** The model the session runs on; the harness's own choice reads as `harnessOwnModelOf`. */
  readonly runningModel: string;
  /** The model the person chose for the agent's next start; null when none waits. */
  readonly nextModel: string | null;
  /** The effort the agent recorded (or its launch names); null when Mend has none. */
  readonly runningEffort: string | null;
  /** The effort the person chose for the agent's next start; null when none waits. */
  readonly nextEffort: string | null;
  /** `fast` when the thread's launch asked for it; Mend records no tier. */
  readonly tier: "fast" | null;
}

export const shownModelOf = (thread: ThreadModelOptions): string =>
  thread.nextModel ?? thread.runningModel;

/** The options t3code shows on the thread's picker: the effort it will run on, and the tier. */
export const modelOptionsOf = (
  thread: ThreadModelOptions,
): ReadonlyArray<ProviderOptionSelection> | undefined => {
  const options: Array<ProviderOptionSelection> = [];
  const effortId = effortOptionIdOf(thread.harness);
  const effort = thread.nextEffort ?? thread.runningEffort;
  if (effortId !== null && effort !== null) options.push({ id: effortId, value: effort });
  if (thread.tier === "fast")
    options.push({ id: SERVICE_TIER_OPTION_ID, value: FAST_SERVICE_TIER });
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
  const tier = selections.find((option) => option.id === SERVICE_TIER_OPTION_ID)?.value;
  const shownTier = thread.tier === "fast" ? FAST_SERVICE_TIER : STANDARD_SERVICE_TIER;
  if (tier !== undefined && tier !== shownTier) {
    return refusal(
      shownTier === FAST_SERVICE_TIER
        ? "This thread runs on the Fast tier, set when it started; Mend cannot change a running thread's tier. Start a new thread for Standard."
        : "Mend sets the service tier when a thread starts and cannot change it on this one. Start a new thread on the Fast tier.",
    );
  }
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

export const nextModelLineOf = (thread: ThreadModelOptions, next: string): string =>
  `From the agent's next start: ${next} · it runs ${
    thread.runningModel === harnessOwnModelOf(thread.harness)
      ? "as it started"
      : `on ${thread.runningModel}`
  } until then`;

/** What a thread says while the effort chosen for its agent's next start is not yet the running one. */
export const nextEffortLineOf = (next: string, running: string | null): string =>
  `From the agent's next start: ${effortLabelOf(next)} reasoning effort · it runs ${
    running === null ? "as it started" : `on ${effortLabelOf(running)}`
  } until then`;
