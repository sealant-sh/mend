/**
 * What a person reads when the Mend server says no. The server's own sentence (`message`) wins; a
 * tag that carries no sentence gets words of its own; a bare status gets a sentence that never
 * names it. The call, the status and the tag never reach the words: the error keeps the status
 * for code that branches on it. The same map lives in each client (desktop, mobile, VS Code):
 * keep them in step.
 */

export interface Failure {
  /** What a person reads. */
  readonly words: string;
  /** The body's `_tag`, when it carried one: for code that branches on it, and for the log. */
  readonly tag: string | null;
  /** The server's own sentence, when the body carried one. */
  readonly serverWords: string | null;
}

export const GENERIC_FAILURE = "Mend could not do that. Try again; the server log has the detail.";
export const NO_ANSWER = "The Mend server did not answer. Check that it is running and reachable.";

const SIGNED_OUT = "Signed out — sign in again.";
const FORBIDDEN = "This account cannot do that.";
const NOT_FOUND = "Not found — it may have been removed.";

/** Tags the contract returns without a sentence of their own. */
const TAG_WORDS: Readonly<Record<string, string>> = {
  Unauthorized: SIGNED_OUT,
  Forbidden: FORBIDDEN,
  NotFound: NOT_FOUND,
  SessionActive:
    "The session is still active — it has a live process (a supporting shell, a Service) or an unsettled status; stop those first.",
  SessionNotLive: "The session's workspace is not running — resume the session, then retry.",
  ProtocolSessionNotLive: "The agent is not running — resume the session, then retry.",
  AgentRequestResolved: "That request already has an answer.",
  WorktreeNotFound: "Worktree not found — it may have been removed.",
  WorktreeActive: "The worktree still has live sessions — stop them first.",
  WorktreeNameTaken: "A worktree in this project already has that name.",
  WorkspaceSshKeyNotFound: "SSH key not found — it may have been removed.",
  SkillStaleWrite: "The skill changed since it was opened — reload it, then save again.",
  ClusterBindingDuplicate: "That object is already bound to this project.",
  HandoffUnsupported: "This session's agent cannot hand off to that one.",
  InvitationSpent: "That invitation was accepted, revoked or has expired.",
  PairingCodeNotFound: "That pairing code is not known here — check it against the machine.",
  PairingCodeSpent: "That pairing code has expired or was already used — make a new one.",
  PairingRateLimited: "Too many attempts — wait a minute, then try again.",
  CliAuthNotFound: "That sign-in request is not open — sign in again.",
  CliAuthSpent: "That sign-in request expired or was already used — sign in again.",
  CliAuthDenied: "Denied in the browser. Nothing was granted.",
  UpgradeTicketRefused: "The connection was refused — try again.",
};

/** A status with no body to go on. */
const STATUS_WORDS: Readonly<Record<number, string>> = {
  401: SIGNED_OUT,
  403: FORBIDDEN,
  404: NOT_FOUND,
  429: "Too many requests — wait a moment, then try again.",
};

const stringField = (body: unknown, key: string): string | null => {
  if (typeof body !== "object" || body === null) return null;
  const value: unknown = Reflect.get(body, key);
  return typeof value === "string" && value.trim() !== "" ? value : null;
};

/** Words for one refusal. Status 0 is no answer at all. */
export const failureWords = (status: number, body: unknown): Failure => {
  const serverWords = stringField(body, "message");
  const tag = stringField(body, "_tag");
  if (serverWords !== null) return { words: serverWords, tag, serverWords };
  if (status === 0) return { words: NO_ANSWER, tag, serverWords };
  const byTag = tag === null ? undefined : TAG_WORDS[tag];
  return { words: byTag ?? STATUS_WORDS[status] ?? GENERIC_FAILURE, tag, serverWords };
};

/** Whether `MEND_DEBUG` asks for the diagnostics the words leave out. */
export const debugOn = (env: NodeJS.ProcessEnv = process.env): boolean =>
  ["1", "true", "yes"].includes((env["MEND_DEBUG"] ?? "").trim().toLowerCase());

/**
 * The line `MEND_DEBUG=1` writes to stderr for a refused call: the call, the status and the
 * tag, beside the words a person reads. Never written otherwise: stderr is the dashboard's too.
 */
export const refusalDebugLine = (call: string, status: number, failure: Failure): string =>
  `mend: debug · ${call} → ${status}${failure.tag === null ? "" : ` · ${failure.tag}`}`;

/** Writes `refusalDebugLine` when `MEND_DEBUG` asks for it; returns the failure. */
export const noteRefusal = (
  call: string,
  status: number,
  failure: Failure,
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = (line) => void process.stderr.write(`${line}\n`),
): Failure => {
  if (debugOn(env)) write(refusalDebugLine(call, status, failure));
  return failure;
};
