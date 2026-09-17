/** What decides who hears about a session (docs/adr/0003-organizations-and-tenancy.md). */
export interface RecipientInput {
  /** Whose credentials the session runs on. Null only for pre-organizations sessions. */
  readonly ownerUserId: string | null;
  /** Whether the owner lets others steer the session. */
  readonly sharedControl: boolean;
  /** The account that sent the latest turn, when known. */
  readonly latestTurnSenderUserId: string | null;
}

/**
 * The accounts a session notification goes to: its owner, plus whoever sent the latest turn when
 * the owner shares control. Never every device on the instance, and nobody for a session with no
 * owner.
 */
export const notificationRecipients = (input: RecipientInput): ReadonlySet<string> => {
  const recipients = new Set<string>();
  if (input.ownerUserId === null) return recipients;
  recipients.add(input.ownerUserId);
  if (input.sharedControl && input.latestTurnSenderUserId !== null) {
    recipients.add(input.latestTurnSenderUserId);
  }
  return recipients;
};
