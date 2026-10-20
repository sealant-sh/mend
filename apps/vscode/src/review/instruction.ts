import { lfOnly } from "../line-endings.js";
import { maySteer, ownsSession } from "../session-capability.js";
import type { Session } from "../types.js";
import type { LiveAgent, PastePlan, TerminalInput } from "./delivery.js";
import type { ChangeFile, RecordLink } from "./review-wire.js";
import { filesLine } from "./slices.js";

/**
 * What Send review sends (story d, step 6): an editor with the instruction Mend will send, her
 * comments in order with each one's file and line, which she may edit; and who may send it.
 */

/** One comment as the instruction lists it. */
export interface InstructionComment {
  readonly path: string | null;
  readonly line: number | null;
  readonly endLine: number | null;
  readonly body: string;
  readonly evidence: ReadonlyArray<RecordLink>;
  readonly createdAt: string;
}

/** The one line of the editor that is about the text, not part of it: it is not sent. */
export const mendNote = (sessionName: string): string =>
  `<!-- Mend sends this text to ${sessionName} once. Edit it freely. -->`;

const where = (comment: InstructionComment): string => {
  if (comment.path === null) return "the change as a whole";
  if (comment.line === null) return comment.path;
  return comment.endLine !== null && comment.endLine > comment.line
    ? `${comment.path}:${comment.line}-${comment.endLine}`
    : `${comment.path}:${comment.line}`;
};

/** The comments in the diff's file order, then by line, then by when she wrote them. */
export const instructionOrder = (
  comments: ReadonlyArray<InstructionComment>,
  files: ReadonlyArray<ChangeFile>,
): ReadonlyArray<InstructionComment> => {
  const order = (path: string | null): number => {
    if (path === null) return Number.MAX_SAFE_INTEGER;
    const at = files.findIndex((file) => file.newPath === path || file.oldPath === path);
    return at === -1 ? files.length : at;
  };
  return comments.toSorted(
    (left, right) =>
      order(left.path) - order(right.path) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.createdAt.localeCompare(right.createdAt),
  );
};

const commentLines = (
  comments: ReadonlyArray<InstructionComment>,
  files: ReadonlyArray<ChangeFile>,
  from: number,
): ReadonlyArray<string> =>
  instructionOrder(comments, files).flatMap((comment, index) => {
    const evidence = comment.evidence
      .map((link) => ` (seq ${link.sequence} · ${link.excerpt})`)
      .join("");
    return [`## ${from + index} · ${where(comment)}`, `${comment.body}${evidence}`, ""];
  });

export const composeInstruction = (input: {
  readonly sessionName: string;
  readonly baseName: string;
  readonly headOrdinal: number;
  readonly files: ReadonlyArray<ChangeFile>;
  readonly comments: ReadonlyArray<InstructionComment>;
}): string => {
  const lines = [
    `# Review for ${input.sessionName}`,
    "",
    mendNote(input.sessionName),
    "",
    `Slice: ${input.baseName} → checkpoint ${input.headOrdinal} · ${filesLine(input.files).replace("−", "-")}`,
    "",
    ...commentLines(input.comments, input.files, 1),
    "## What to do",
    "Address each comment above, then say what you changed for each one.",
  ];
  return `${lines.join("\n")}\n`;
};

/**
 * A review on top of one already pasted into the agent's terminal and not yet entered: the text
 * she sent then, kept as she edited it, and below it only the comments that are new, numbered on
 * from hers. Send to session pastes only what follows the earlier text.
 */
export const composeAddition = (input: {
  readonly sessionName: string;
  /** The earlier review as she sent it. */
  readonly sent: string;
  /** How many comments the earlier review lists. */
  readonly sentCount: number;
  readonly files: ReadonlyArray<ChangeFile>;
  readonly comments: ReadonlyArray<InstructionComment>;
}): string =>
  [
    mendNote(input.sessionName),
    "",
    input.sent,
    "",
    "## More comments",
    "",
    ...commentLines(input.comments, input.files, input.sentCount + 1),
    "Address these too, then say what you changed for each one.",
    "",
  ].join("\n");

/**
 * What to paste for a review on top of what the agent's input holds: only what she added after
 * that text; nothing, with why, when she changed it, since the input still holds it as it was.
 */
export const addedText = (
  sent: string,
  onto: TerminalInput,
  agent: string,
): Exclude<PastePlan, { readonly kind: "all" }> => {
  if (!sent.startsWith(onto.text))
    return {
      kind: "none",
      words: `You changed the part of this review already in ${agent}'s terminal, so VS Code pasted nothing there: its input still holds the earlier text. Mend holds the review as you sent it.`,
      onto,
    };
  const added = sent.slice(onto.text.length);
  return added.trim() === ""
    ? {
        kind: "none",
        words: `Nothing was added to the review already in ${agent}'s terminal, so VS Code pasted nothing there.`,
        onto,
      }
    : { kind: "added", text: added, onto };
};

/**
 * The editor's text as Mend sends it: the note line, and the blank line after it, left out; each
 * line ending LF, as a paste reads it, so line endings alone never read as an edit.
 */
export const textToSend = (editorText: string, sessionName: string): string => {
  const note = mendNote(sessionName);
  const lines = lfOnly(editorText).split("\n");
  const at = lines.findIndex((line) => line.trim() === note);
  if (at === -1) return lines.join("\n").trim();
  const after = lines[at + 1]?.trim() === "" ? 2 : 1;
  return [...lines.slice(0, at), ...lines.slice(at + after)].join("\n").trim();
};

/** Whether Send review is offered here, and if not, why. */
export type SendOffer =
  | { readonly kind: "ready"; readonly count: number }
  | { readonly kind: "retry" }
  | { readonly kind: "busy" }
  | { readonly kind: "nothing" }
  | { readonly kind: "disabled"; readonly why: string }
  | { readonly kind: "hidden"; readonly why: string };

export const OFFLINE_WORDS = "Mend is offline; your comments are kept";

/**
 * Send review, offered to the session's owner, or to anyone while its owner has shared control on;
 * a terminal agent, live or one a stopped session starts with the review, takes a follow-up only
 * from its owner, as Mend enforces. Offline it stays,
 * disabled, and her comments with it.
 */
export const sendOffer = (input: {
  readonly session: Pick<Session, "ownerUserId" | "sharedControlEnabledAt">;
  readonly viewer: string | null;
  readonly ownerName: string;
  readonly agent: LiveAgent | null;
  /**
   * Whether the follow-up goes to a terminal agent, live or started anew for a stopped session:
   * typing there, the owner's alone, as Mend refuses it to anyone else.
   */
  readonly startsTerminal: boolean;
  readonly offline: boolean;
  readonly count: number;
  readonly open: "sending" | "failed" | null;
}): SendOffer => {
  const { session, viewer, ownerName, agent, startsTerminal, offline, count, open } = input;
  if (viewer === null) return { kind: "hidden", why: "Mend could not read who you are" };
  if (!maySteer(session, viewer))
    return {
      kind: "hidden",
      why: `${ownerName}'s session · only ${ownerName} sends it a review while shared control is off`,
    };
  if (agent?.kind === "terminal" && !agent.hers)
    return {
      kind: "disabled",
      why: `${agent.name} runs in ${ownerName}'s terminal · only ${ownerName} sends it a review`,
    };
  if (startsTerminal && !ownsSession(session, viewer))
    return {
      kind: "disabled",
      why: `${ownerName}'s session starts its agent in a terminal with a review · only ${ownerName} sends it one`,
    };
  if (offline) return { kind: "disabled", why: OFFLINE_WORDS };
  if (open === "sending") return { kind: "busy" };
  if (open === "failed") return { kind: "retry" };
  return count === 0 ? { kind: "nothing" } : { kind: "ready", count };
};
