/**
 * Whose login a turn ran on, as the conversation says it (docs/adr/0013-whoever-sends-a-turn-pays.md,
 * "Every turn records its payer"). Each client places the words in its own turn line.
 */

import type { AgentTurnDto } from "./feed.ts";

/**
 * The payer, when that is worth saying: only when a person sent the turn and someone else's login
 * paid for it. "billed to Yiannis's default", "billed to your default" when the viewer paid, and
 * "billed to Yiannis" when the account's name was not recorded. Null for a turn its sender paid
 * for, one Mend or the agent opened, and one whose payer was not recorded.
 */
export const turnPayerWords = (
  turn: Pick<AgentTurnDto, "author" | "billedUserId" | "billedAccountName">,
  viewerId: string | null,
  names: ReadonlyMap<string, string>,
): string | null => {
  const author = turn.author ?? null;
  const payer = turn.billedUserId ?? null;
  if (author === null || payer === null || author === payer) return null;
  const account = turn.billedAccountName ?? null;
  if (payer === viewerId) return account === null ? "billed to you" : `billed to your ${account}`;
  const name = names.get(payer) ?? "a member";
  return account === null ? `billed to ${name}` : `billed to ${name}'s ${account}`;
};

/**
 * The whole line for a client that does not know who is looking: "sent by Maria · billed to
 * Yiannis's default · observed". Null where `turnPayerWords` says nothing.
 */
export const turnPayerLine = (
  turn: Pick<AgentTurnDto, "author" | "billedUserId" | "billedAccountName">,
  names: ReadonlyMap<string, string>,
): string | null => {
  const billed = turnPayerWords(turn, null, names);
  const author = turn.author ?? null;
  if (billed === null || author === null) return null;
  return `sent by ${names.get(author) ?? "a member"} · ${billed} · observed`;
};
