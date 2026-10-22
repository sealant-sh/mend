import type { LiveAgent, SendRecord } from "./delivery.js";

/**
 * What the agent's input holds as VS Code pasted it, not entered: the text, exactly, and the
 * comments whose words are in it. Mend's follow-up can hold more, after a paste that was skipped.
 */
export interface TerminalInput {
  readonly text: string;
  readonly ids: ReadonlyArray<string>;
}

/**
 * What one agent process's input holds, as VS Code pasted it: another process's input holds none of
 * it.
 */
export interface HeldInput {
  readonly input: TerminalInput;
  readonly agent: string;
  readonly processId: string;
}

/**
 * What Send to session pastes into the agent's terminal (G12 fallback): the whole text; only what
 * she added onto what its input holds; or nothing, with why, when she changed the part already
 * there. `onto` is what the input of the agent process `processId` held when she composed it: a
 * paste into any other process is the whole text.
 */
export type PastePlan =
  | { readonly kind: "all" }
  | {
      readonly kind: "added";
      readonly text: string;
      readonly onto: TerminalInput;
      readonly processId: string;
    }
  | {
      readonly kind: "none";
      readonly words: string;
      readonly onto: TerminalInput;
      readonly processId: string;
    };

/**
 * The plan for a paste into the agent process `processId`: one composed onto another process's
 * input is the whole text, since this process's input holds none of it.
 */
export const planFor = (plan: PastePlan, processId: string): PastePlan =>
  plan.kind !== "all" && plan.processId !== processId ? { kind: "all" } : plan;

/**
 * What the agent's input holds after this record's paste step, in the process it was pasted into:
 * what it was pasted onto, and the paste of the comments `ids`.
 */
export const inputAfter = (
  record: SendRecord,
  ids: ReadonlyArray<string>,
  processId: string,
  pasted: boolean,
): TerminalInput => {
  const plan = planFor(record.paste, processId);
  switch (plan.kind) {
    case "all":
      return pasted ? { text: record.instruction, ids } : { text: "", ids: [] };
    case "added":
      return pasted ? { text: `${plan.onto.text}${plan.text}`, ids } : plan.onto;
    case "none":
      return plan.onto;
  }
};

/**
 * What an agent process's input holds, by the newest review not refused; null when nothing of hers
 * is.
 */
const recordedInput = (records: ReadonlyArray<SendRecord>): HeldInput | null => {
  const latest = records.findLast((record) => record.phase.kind !== "refused");
  if (latest?.phase.kind !== "in-terminal") return null;
  const { agent, processId, paste } = latest.phase;
  if (paste.kind === "done") return { input: paste.input, agent, processId };
  return paste.kind === "failed" && latest.paste.kind !== "all"
    ? { input: latest.paste.onto, agent, processId: latest.paste.processId }
    : null;
};

/**
 * What the input of her live agent holds; null when nothing of hers is, or when the agent is a
 * process other than the one VS Code pasted into, as after a stop and a resume.
 */
export const terminalInput = (
  records: ReadonlyArray<SendRecord>,
  agent: LiveAgent | null,
): HeldInput | null => {
  const held = recordedInput(records);
  return held !== null && agent?.kind === "terminal" && agent.processId === held.processId
    ? held
    : null;
};

/**
 * The reviews a composition was made after: the newest one kept, and what an agent's input holds.
 * One composed before another review went out, in any window, no longer says what it would send.
 */
export const sendGeneration = (records: ReadonlyArray<SendRecord>): string =>
  JSON.stringify([records.at(-1)?.key ?? null, recordedInput(records)]);
