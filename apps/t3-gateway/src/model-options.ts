import type { ModelSelection, ProviderOptionSelection } from "@mend/t3-contracts";

import {
  effortLabelOf,
  effortOptionIdOf,
  FAST_SERVICE_TIER,
  SERVICE_TIER_OPTION_ID,
  STANDARD_SERVICE_TIER,
} from "./server-config.ts";

/**
 * A thread's reasoning effort and service tier, as t3code's traits picker reads and sends them
 * (`modelSelection.options`), against what Mend can honour. Mend sets both per launch of the
 * agent, never per turn:
 *
 * - The effort is recorded with the agent and reused by every later launch (mend#493). One the
 *   person changes on a started thread is kept for the agent's next start, as the runtime mode is,
 *   and the thread says so until then.
 * - The tier is named by a launch and recorded nowhere, so Mend cannot carry a change of it from
 *   one start to the next. A change on a started thread is refused, so the picker never shows a
 *   tier the agent does not run on; a thread a t3code client launched keeps the tier it asked for.
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
  /** The Mend harness, which names t3code's effort option. */
  readonly harness: string;
  /** The effort the agent recorded (or its launch names); null when Mend has none. */
  readonly runningEffort: string | null;
  /** The effort the person chose for the agent's next start; null when none waits. */
  readonly nextEffort: string | null;
  /** `fast` when the thread's launch asked for it; Mend records no tier. */
  readonly tier: "fast" | null;
}

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

export type OptionsChange =
  /** Nothing the message names differs from what the thread shows. */
  | { readonly _tag: "Keep" }
  /** The effort for the agent's next start; null lets go of one chosen before. */
  | { readonly _tag: "NextEffort"; readonly effort: string | null }
  | { readonly _tag: "Refused"; readonly reason: string };

/**
 * What a message's model selection asks of the thread. t3code sends only the options the picker
 * holds explicitly, so an option it leaves out changes nothing.
 */
export const optionsChangeOf = (
  thread: ThreadModelOptions,
  selection: ModelSelection | undefined,
): OptionsChange => {
  const selections = selection?.options ?? [];
  const tier = selections.find((option) => option.id === SERVICE_TIER_OPTION_ID)?.value;
  const shownTier = thread.tier === "fast" ? FAST_SERVICE_TIER : STANDARD_SERVICE_TIER;
  if (tier !== undefined && tier !== shownTier) {
    return {
      _tag: "Refused",
      reason:
        shownTier === FAST_SERVICE_TIER
          ? "This thread runs on the Fast tier, set when it started; Mend cannot change a running thread's tier. Start a new thread for Standard."
          : "Mend sets the service tier when a thread starts and cannot change it on this one. Start a new thread on the Fast tier.",
    };
  }
  const effortId = effortOptionIdOf(thread.harness);
  const effort =
    effortId === null ? undefined : selections.find((option) => option.id === effortId)?.value;
  if (effort === undefined || effort === (thread.nextEffort ?? thread.runningEffort)) {
    return { _tag: "Keep" };
  }
  if (typeof effort !== "string" || !MEND_EFFORTS.has(effort)) {
    return { _tag: "Refused", reason: `Mend has no ${String(effort)} reasoning effort.` };
  }
  return { _tag: "NextEffort", effort: effort === thread.runningEffort ? null : effort };
};

/** What a thread says while the effort chosen for its agent's next start is not yet the running one. */
export const nextEffortLineOf = (next: string, running: string | null): string =>
  `From the agent's next start: ${effortLabelOf(next)} reasoning effort · it runs ${
    running === null ? "as it started" : `on ${effortLabelOf(running)}`
  } until then`;
