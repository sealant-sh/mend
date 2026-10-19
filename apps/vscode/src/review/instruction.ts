import { maySteer } from "../session-capability.js";
import type { Session } from "../types.js";
import type { LiveAgent } from "./delivery.js";
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
  ];
  instructionOrder(input.comments, input.files).forEach((comment, index) => {
    const evidence = comment.evidence
      .map((link) => ` (seq ${link.sequence} · ${link.excerpt})`)
      .join("");
    lines.push(`## ${index + 1} · ${where(comment)}`, `${comment.body}${evidence}`, "");
  });
  lines.push(
    "## What to do",
    "Address each comment above, then say what you changed for each one.",
  );
  return `${lines.join("\n")}\n`;
};

/** The editor's text as Mend sends it: the note line, and the blank line after it, left out. */
export const textToSend = (editorText: string, sessionName: string): string => {
  const note = mendNote(sessionName);
  const lines = editorText.split("\n");
  const at = lines.findIndex((line) => line.trim() === note);
  if (at === -1) return editorText.trim();
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
 * a live terminal agent takes a follow-up only from its owner, as Mend enforces. Offline it stays,
 * disabled, and her comments with it.
 */
export const sendOffer = (input: {
  readonly session: Pick<Session, "ownerUserId" | "sharedControlEnabledAt">;
  readonly viewer: string | null;
  readonly ownerName: string;
  readonly agent: LiveAgent | null;
  readonly offline: boolean;
  readonly count: number;
  readonly open: "sending" | "failed" | null;
}): SendOffer => {
  const { session, viewer, ownerName, agent, offline, count, open } = input;
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
  if (offline) return { kind: "disabled", why: OFFLINE_WORDS };
  if (open === "sending") return { kind: "busy" };
  if (open === "failed") return { kind: "retry" };
  return count === 0 ? { kind: "nothing" } : { kind: "ready", count };
};
