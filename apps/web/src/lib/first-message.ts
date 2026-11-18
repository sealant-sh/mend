import { failureWords, refusalTagOf } from "./refusal.ts";

/**
 * A session that holds a conversation the person imported (SLNT-895) and has not started an agent
 * over it waits for its first message (`importedConversationWaiting`, the server's fact): that
 * message starts the agent in conversation mode on the imported conversation. Its status says
 * nothing of this (a session made in a worktree reads `starting`, one a handoff made reads
 * `idle`), so every place that words the session's state reads the fact first.
 */

/**
 * Whether this viewer's composer sends the session's first message: they steer it, it waits for
 * one, and no agent process ever ran in it. Otherwise the composer is the usual one.
 */
export const takesFirstMessage = (
  /** `importedConversationWaiting` is the server's fact; false from older servers. */
  session: { readonly importedConversationWaiting: boolean },
  currentAgent: unknown,
  steer: boolean,
): boolean => steer && currentAgent === null && session.importedConversationWaiting;

/**
 * The launch a first message makes: the session's agent in conversation mode, the message its
 * first turn, over the attempt the page shows (`settledAt`): never settled, or settled before any
 * agent took the conversation (a first message refused for a missing login). A second start of
 * the same session (another tab, the CLI) moves that attempt on, so the server refuses this one,
 * never running it twice.
 */
export const firstMessageLaunch = (prompt: string, settledAt: Date | null) =>
  ({ mode: "protocol", prompt, expected: { settledAt } }) as const;

export type FirstMessageLaunch = ReturnType<typeof firstMessageLaunch>;

/** Where a first message stands once its launch answered, or failed to. */
export type FirstMessageOutcome =
  /** The server took the launch: the agent is starting with this message as its first turn. */
  | { readonly _tag: "Started" }
  /** The server refused it, in its own words; nothing started. */
  | { readonly _tag: "Refused"; readonly words: string }
  /** No answer came back: the agent may or may not be starting. */
  | { readonly _tag: "Unconfirmed" };

/** What the composer says when the launch's answer was lost. */
export const FIRST_MESSAGE_UNCONFIRMED =
  "Start not confirmed. Check the session before sending again.";

/**
 * Send `prompt` as the session's first message through `launch` (the web's launch call). A
 * refusal the API declared comes back in the server's words; anything else is unconfirmed, since
 * the launch may have run.
 */
export const sendFirstMessage = async (
  launch: (request: FirstMessageLaunch) => Promise<unknown>,
  prompt: string,
  settledAt: Date | null,
): Promise<FirstMessageOutcome> => {
  try {
    await launch(firstMessageLaunch(prompt, settledAt));
    return { _tag: "Started" };
  } catch (cause) {
    return refusalTagOf(cause) === null
      ? { _tag: "Unconfirmed" }
      : { _tag: "Refused", words: failureWords(cause, "Mend did not start the session.") };
  }
};
