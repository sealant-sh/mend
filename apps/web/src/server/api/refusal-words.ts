/**
 * What a person reads when the API refused a call: the server's own sentence when the refusal
 * carries one, else words for the refusal, never its tag (`SealantUnavailable: …` reached alerts,
 * live pass 2026-10-10). The tag goes to the web tier's log and, for the few pages that branch on
 * it, to `data.tag` on the tRPC error (routers/trpc.ts); it is never part of the message.
 */
export interface Refusal {
  readonly _tag: string;
  readonly message?: string;
  readonly [field: string]: unknown;
}

const count = (value: unknown): number | null => (typeof value === "number" ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Words for the refusals the contract declares without a sentence of their own. */
const wordsWithoutMessage = (refusal: Refusal): string | null => {
  switch (refusal._tag) {
    case "NotFound":
      return "Not found. It may have been removed.";
    case "Unauthorized":
      return "Signed out. Sign in again.";
    case "PairingCodeNotFound":
    case "CliAuthNotFound":
      return "This code is not waiting.";
    case "PairingCodeSpent":
    case "CliAuthSpent":
      return "This code was already used.";
    case "PairingRateLimited":
      return "Too many attempts. Try again in a minute.";
    case "CliAuthDenied":
      return "Denied in the browser; nothing was granted.";
    case "InvitationSpent": {
      const state = text(refusal["state"]);
      return state === null ? "This invitation no longer works." : `This invitation is ${state}.`;
    }
    case "ClusterBindingDuplicate":
      return "This project already has that binding.";
    case "HandoffUnsupported":
      return "This session cannot continue in that harness.";
    case "ProtocolSessionNotLive":
      return "The agent is not running.";
    case "AgentRequestResolved":
      return "That request was already answered.";
    case "EnvironmentStaleWrite":
      return "This variable changed meanwhile. Reload to see it, then try again.";
    case "SkillStaleWrite":
      return "This skill changed meanwhile. Reload to see it, then try again.";
    case "WorkspaceSshKeyNotFound":
      return "That SSH key is no longer there.";
    case "UpgradeTicketRefused":
      return "The connection was refused. Reload the page.";
    case "SessionActive":
      return "The session is running. Stop it first.";
    case "SessionNotLive":
      return "The session is not running.";
    case "WorktreeNotFound":
      return "This worktree is no longer in the store.";
    case "WorktreeActive": {
      const live = count(refusal["liveSessions"]);
      return live === null || live === 1
        ? "A session in this worktree is live. Stop it first."
        : `${live} sessions in this worktree are live. Stop them first.`;
    }
    case "WorktreeNameTaken":
      return "That name is already used in this project. Choose another.";
    default:
      return null;
  }
};

/** When nothing more is known: what happened, and where the detail is. */
export const NOT_DONE = "Mend could not do that. Try again; the server log has the detail.";

export const refusalWords = (refusal: Refusal): string => {
  const message = refusal.message?.trim() ?? "";
  if (message !== "") return message;
  return wordsWithoutMessage(refusal) ?? NOT_DONE;
};
