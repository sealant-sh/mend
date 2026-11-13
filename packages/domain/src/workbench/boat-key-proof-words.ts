import { type BoatKeyHolder, boatProblemWords } from "./boat-failure-words.ts";
import type { BoatKeyTone } from "./boat-key-words.ts";
import type { BoatKeyProof, BoatKeyProofStep } from "./boat-key.ts";

/**
 * A full check of a Boat key in words (SLNT-784), as the Boat page and `mend boat check --full`
 * say it: each step as passed, refused with Boat's reason in the failure table's words, or not
 * reached, and whether everything the check made was confirmed removed.
 */

/** What the owner reads before running one: what it does, and what it costs and uses. */
export const FULL_CHECK_COST =
  "A full check starts the smallest VM in this key's Boat account, runs a command in it, publishes a port and saves a snapshot, then deletes the snapshot and the VM. It uses one VM start, takes about a minute, and holds one saved snapshot slot for that minute.";

/** Why an owner runs one: what the key report alone cannot say. */
export const FULL_CHECK_WHY =
  "Boat does not show every key its own permissions, a Boat organization's key among them. A full check does what a session does, once, to show whether this key can.";

const STEP_LABELS: { readonly [K in BoatKeyProofStep["step"]]: string } = {
  "start-vm": "Start a VM",
  "run-command": "Run a command",
  "publish-port": "Publish a port",
  "save-snapshot": "Save a snapshot",
  "delete-snapshot": "Delete the snapshot",
  "delete-vm": "Delete the VM",
};

export const proofStepLabel = (step: BoatKeyProofStep["step"]): string => STEP_LABELS[step];

export interface ProofStepWords {
  readonly label: string;
  /** `passed`, `refused`, `no answer`, `not reached`. */
  readonly word: string;
  readonly tone: BoatKeyTone | null;
  /** Why, and what to do, for a refused or unanswered step; null otherwise. */
  readonly reason: string | null;
}

const reasonOf = (step: BoatKeyProofStep, holder: BoatKeyHolder): string | null => {
  if (step.outcome !== "refused" && step.outcome !== "no-answer") return null;
  if (step.boat === null)
    return step.outcome === "no-answer"
      ? "Boat did not answer, so the full check stopped there. Run the full check again in a minute."
      : "Boat refused, and Sealant did not say why. The person who runs this Mend server can read Boat's reason in the server log.";
  const words = boatProblemWords(
    { kind: step.boat.kind, failure: step.boat },
    { holder, place: "full-check" },
  );
  return `${words.happened} ${words.todo}`;
};

/** One step's words; `holder` is whose key was checked, which decides who is told to fix it. */
export const proofStepWords = (
  step: BoatKeyProofStep,
  holder: BoatKeyHolder = "organization",
): ProofStepWords => ({
  label: proofStepLabel(step.step),
  word: step.outcome === "no-answer" ? "no answer" : step.outcome.replace("-", " "),
  tone:
    step.outcome === "passed"
      ? null
      : step.outcome === "refused"
        ? "bad"
        : step.outcome === "no-answer"
          ? "wait"
          : "off",
  reason: reasonOf(step, holder),
});

/** The step the check stopped at: the first refused or unanswered one. */
const stoppedAt = (proof: BoatKeyProof): BoatKeyProofStep | undefined =>
  proof.steps.find((step) => step.outcome === "refused" || step.outcome === "no-answer");

/** `passed`, `refused at Publish a port`, `interrupted`: the check's outcome as one phrase. */
export const proofOutcomeWords = (proof: BoatKeyProof): string => {
  if (proof.outcome !== "refused") return proof.outcome;
  const stopped = stoppedAt(proof);
  return stopped === undefined
    ? "refused"
    : `refused at ${proofStepLabel(stopped.step).toLowerCase()}`;
};

export const proofTone = (proof: BoatKeyProof): BoatKeyTone | null =>
  proof.outcome === "passed" ? null : proof.outcome === "refused" ? "bad" : "wait";

/** Whether everything the check made in Boat was confirmed removed, and what is left if not. */
export const proofLeftoverWords = (proof: BoatKeyProof): string => {
  const { vm, snapshot, removalConfirmed } = proof.leftBehind;
  const starts = `It used ${proof.starts === 1 ? "one VM start" : `${proof.starts} VM starts`}.`;
  if (removalConfirmed) return `${starts} Sealant saw Boat delete everything the check made.`;
  const left = [
    vm === null ? "a VM whose id Boat did not answer" : `VM ${vm}`,
    ...(snapshot === null ? [] : [`snapshot ${snapshot}`]),
  ].join(" and ");
  return `${starts} Sealant has not yet seen Boat delete ${left}. It keeps deleting what is left, and the key cannot be replaced or removed until it has.`;
};

/** What a full check says for an interrupted one: Core's sweep finished it. */
export const INTERRUPTED_WORDS =
  "The full check stopped before it finished, and Sealant took over removing what it had made. Run it again.";
