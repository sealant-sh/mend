import type { BoatFailure, BoatFailureKind } from "./boat-failure.ts";

/**
 * Every way a Boat launch or a Boat key check can go wrong, in words a person can act on
 * (SLNT-793): what happened, then who can fix it and what to do. One table, keyed by sealant's
 * closed set of Boat failure kinds plus the refusals sealant answers before anything is attempted.
 * Boat's own code and request id never appear here: they are for the server log.
 */

/**
 * Whose Boat key the call spent, which decides who can fix a key or account problem: the
 * organization's, the server's, or the session owner's own (SLNT-797, `Session.boatKey`). A
 * session's words are one sentence every viewer reads, so a person's own key is named as its
 * owner's: anyone sees whose key it is, and only its owner is told what to do.
 */
export type BoatKeyHolder = "organization" | "server" | "person";

/**
 * Where the words are read: on a session whose launch failed, or on the Boat key page or CLI, after
 * a check of the key or at a step of a full check of it, or on a status line (`mend server status`,
 * `mend doctor`, the instance page) about what Sealant last observed of a key.
 */
export type BoatWordsPlace = "launch" | "key-check" | "full-check" | "status";

export interface BoatWordsContext {
  readonly holder: BoatKeyHolder;
  readonly place: BoatWordsPlace;
}

/**
 * sealant's refusals of a Boat workspace before anything was attempted in Boat (no VM, no build):
 * they read `launch refused`, not `launch failed`. sealant's message is part of the words.
 */
export const BOAT_LAUNCH_REFUSAL_CODES = [
  "unsupported-runtime",
  "boat-account-required",
  "gateway-unavailable",
  "runtime-requirement-unsupported",
  "runtime-os-unsupported",
  /**
   * The key was connected before sealant pinned keys to the wallet they bill, and sealant has not
   * seen yet which wallet it bills (sealant#641): usually a minute after an upgrade, or for good
   * when the key lacks `account.read`. Sessions already running are not affected.
   */
  "boat-account-wallet-unresolved",
] as const;
export type BoatLaunchRefusalCode = (typeof BOAT_LAUNCH_REFUSAL_CODES)[number];

const REFUSAL_CODES: ReadonlySet<string> = new Set(BOAT_LAUNCH_REFUSAL_CODES);
export const isBoatLaunchRefusalCode = (code: string): code is BoatLaunchRefusalCode =>
  REFUSAL_CODES.has(code);

export type BoatProblem =
  | { readonly kind: BoatFailureKind; readonly failure: BoatFailure }
  | { readonly kind: BoatLaunchRefusalCode; readonly coreMessage: string };

/** `happened` stands alone (the dashboard shows only a session's first line); `todo` follows it. */
export interface BoatProblemWords {
  readonly happened: string;
  readonly todo: string;
}

const PAGE = "Settings, Organization, Boat";
/** Where a person connects, replaces and checks their own key. */
const OWN_PAGE = "Settings, Account";

/** Where the reader makes and connects a new key on the key's own page or CLI. */
const pageOf = (context: BoatWordsContext): string =>
  context.holder === "person" ? OWN_PAGE : PAGE;

const LAUNCH_KEYS: Readonly<Record<BoatKeyHolder, string>> = {
  organization: "the organization's Boat key",
  server: "this server's Boat key",
  person: "the session owner's own Boat key",
};

const keyOf = (context: BoatWordsContext): string =>
  context.place === "status" && context.holder === "server"
    ? "this server's Boat key"
    : context.place !== "launch"
      ? "this Boat key"
      : LAUNCH_KEYS[context.holder];

const capital = (words: string): string => `${words.charAt(0).toUpperCase()}${words.slice(1)}`;

/** The Boat account the key belongs to, and so whose wallet, plan and limits these are. */
const accountOf = (context: BoatWordsContext): string => `the Boat account of ${keyOf(context)}`;

const SNAPSHOT_OPERATIONS: ReadonlySet<string> = new Set([
  "saveSnapshot",
  "getSnapshot",
  "deleteSnapshot",
]);

/** What the refusal stopped, as a clause. */
const blocked = (operation: string | null, context: BoatWordsContext): string =>
  context.place === "status"
    ? "so new Boat sessions cannot start with it"
    : context.place === "key-check"
      ? "so nothing changed"
      : context.place === "full-check"
        ? "so the full check stopped there"
        : operation !== null && SNAPSHOT_OPERATIONS.has(operation)
          ? "so this session's image could not be saved"
          : "so this session's VM did not start";

const again = (context: BoatWordsContext): string =>
  context.place === "status"
    ? "start a Boat session again"
    : context.place === "key-check"
      ? "try again"
      : context.place === "full-check"
        ? "run the full check again"
        : "start the session again";

const thenAgain = (context: BoatWordsContext): string => `Then ${again(context)}`;

/** Who makes and connects a new key, and where. */
const keyFixer = (context: BoatWordsContext, which = "a new key"): string => {
  if (context.place === "status" && context.holder === "server")
    return `The person who runs this Mend server gives it ${which} with mend server setup --boat-api-key-stdin, or drops its key with --no-boat-api-key so each organization connects its own.`;
  if (context.place !== "launch")
    return context.holder === "person"
      ? `Create ${which} using the command in ${OWN_PAGE} and connect that one there, or with mend boat connect --mine.`
      : `Create ${which} using the command on Mend's Boat page (${pageOf(context)}) and connect that one.`;
  switch (context.holder) {
    case "person":
      return `The session's owner creates ${which} using the command in ${OWN_PAGE} and replaces their key there, or with mend boat connect --mine. Then they start the session again.`;
    case "organization":
      return `An owner of this organization creates ${which} using the command in ${PAGE} and replaces the key there. Then start the session again.`;
    case "server":
      return `The person who runs this Mend server gives it ${which} with mend server setup --boat-api-key-stdin. An owner of this organization can instead connect the organization's own key in ${PAGE}. Then start the session again.`;
  }
};

/** Who manages the Boat account the key bills. */
const accountFixer = (context: BoatWordsContext): string => {
  if (context.place !== "launch" && context.place !== "status")
    return "Whoever manages that Boat account";
  switch (context.holder) {
    case "person":
      return "The session's owner, or whoever manages that Boat account,";
    case "organization":
      return "An owner of this organization, or whoever manages that Boat account,";
    case "server":
      return "The person who runs this Mend server";
  }
};

const minutes = (seconds: number): string => {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} seconds`;
  const count = Math.ceil(seconds / 60);
  return `${count} minutes`;
};

/** `after 14:05 UTC`, `in about 2 minutes`, or null when Boat gave no time. */
const whenToRetry = (failure: BoatFailure): string | null => {
  if (failure.retryAt !== null)
    return `after ${failure.retryAt.toISOString().slice(11, 16)} UTC, when Boat said it allows the next start`;
  if (failure.retryAfterSeconds !== null)
    return `in about ${minutes(failure.retryAfterSeconds)}, as Boat asked`;
  return null;
};

type Failure = (failure: BoatFailure, context: BoatWordsContext) => BoatProblemWords;
type Refusal = (coreMessage: string, context: BoatWordsContext) => BoatProblemWords;

/**
 * The table. A sealant pin that adds a failure kind fails to compile here until it has words.
 */
const FAILURE_WORDS: { readonly [K in BoatFailureKind]: Failure } = {
  "key-expired": (failure, context) => ({
    happened: `${capital(keyOf(context))} has expired, so Boat refused it and ${blocked(failure.operation, context).replace(/^so /, "")}.`,
    todo: `${keyFixer(context)} Boat keys last 90 days unless made to last longer; the command on the Boat page makes one that lasts a year.`,
  }),
  "key-refused": (failure, context) => ({
    happened: `Boat does not accept ${keyOf(context)}: Boat does not know it, or it was revoked, ${blocked(failure.operation, context)}.`,
    todo: keyFixer(context),
  }),
  "permission-missing": (failure, context) => ({
    happened: `${capital(keyOf(context))} lacks the Boat permission ${failure.permission ?? "this call needs"}, ${blocked(failure.operation, context)}.`,
    todo: keyFixer(context, "a key with every permission Mend needs"),
  }),
  "sandbox-outside-key": (failure, context) => ({
    happened: `${capital(keyOf(context))} is limited to some Boat VMs, and Mend's are not among them, ${blocked(failure.operation, context)}.`,
    todo: keyFixer(context, "a key that is not limited to some VMs"),
  }),
  "organization-mismatch": (failure, context) => ({
    happened: `${capital(keyOf(context))} belongs to a different Boat organization than the one it was asked to bill, ${blocked(failure.operation, context)}.`,
    todo: keyFixer(context, "a key for the Boat organization that should pay"),
  }),
  "account-suspended": (failure, context) => ({
    happened: `Boat has suspended ${accountOf(context)}, ${blocked(failure.operation, context)}.`,
    todo: `${accountFixer(context)} sorts it out with Boat. ${thenAgain(context)}.`,
  }),
  "billing-required": (failure, context) => ({
    happened: `The Boat wallet of ${keyOf(context)} needs paying before Boat starts another VM, ${blocked(failure.operation, context)}.`,
    todo: `${accountFixer(context)} pays or tops it up ${failure.billingUrl === null ? "in Boat" : `at ${failure.billingUrl}`}. ${thenAgain(context)}.`,
  }),
  "running-limit": (failure, context) => ({
    happened: `${capital(accountOf(context))} is running as many VMs as its Boat plan allows, ${blocked(failure.operation, context)}.`,
    todo:
      context.place === "launch" && context.holder === "person"
        ? "The session's owner stops a Boat session of theirs that is no longer needed and starts this one again. They, or whoever manages that Boat account, can also raise the plan's limit in Boat."
        : `Stop a Boat session that is no longer needed and ${again(context)}. ${accountFixer(context)} can also raise the plan's limit in Boat.`,
  }),
  "member-cap": (failure, context) => ({
    happened: `The Boat organization that ${keyOf(context)} bills has reached its member limit, ${blocked(failure.operation, context)}.`,
    todo: `${accountFixer(context)} adds seats or frees one in Boat. ${thenAgain(context)}.`,
  }),
  "rate-limited": (failure, context) => ({
    happened:
      context.place === "key-check"
        ? "Boat asked Sealant to wait before asking about this Boat key again, so nothing changed."
        : `Boat is limiting how often VMs start in ${accountOf(context)}, ${blocked(failure.operation, context)}.`,
    todo: `${capital(again(context))} ${whenToRetry(failure) ?? "in a minute"}. Nothing needs changing.`,
  }),
  "trial-restricted": (failure, context) => ({
    happened: `${capital(accountOf(context))} is on a Boat trial that does not allow this, ${blocked(failure.operation, context)}.`,
    todo: `${accountFixer(context)} moves it to a paid Boat plan. ${thenAgain(context)}.`,
  }),
  "no-machine": (failure, context) => ({
    happened: `Boat had no machine free when asked, ${blocked(failure.operation, context)}.`,
    todo: `${capital(again(context))} ${whenToRetry(failure) ?? "in a few minutes"}. Nothing needs changing.`,
  }),
  "snapshot-allowance-full": (failure, context) => ({
    happened: `Every saved snapshot slot of ${accountOf(context)} is used and its wallet cannot pay for another, ${blocked(failure.operation, context)}.`,
    todo: `${accountFixer(context)} tops up the wallet or deletes saved snapshots it no longer needs in Boat. ${thenAgain(context)}.`,
  }),
  "no-answer": (failure, context) => ({
    happened: `Boat did not answer, ${blocked(failure.operation, context)}.`,
    todo: `${capital(again(context))} in a minute. If it keeps happening, the person who runs this Mend server can read what Boat answered in the server log.`,
  }),
  refused: (failure, context) => ({
    happened: `Boat refused for a reason Mend does not recognise, ${blocked(failure.operation, context)}.`,
    todo: "The person who runs this Mend server can read Boat's own reason and request id in the server log, to fix it or to give Boat's support.",
  }),
};

/** sealant's sentence as a clause, so Mend's own can follow it. */
const clause = (words: string): string => words.trim().replace(/[.\s]+$/, "");

/** No Boat key can run the session: the organization connected none, and the server has none. */
const NO_KEY: BoatProblemWords = {
  happened:
    "This organization's sessions run on Boat, and it has no Boat key connected, so nothing was started.",
  todo: `An owner of this organization connects the organization's Boat key in ${PAGE}, or with mend boat connect. Then start the session again.`,
};

const REFUSAL_WORDS: { readonly [K in BoatLaunchRefusalCode]: Refusal } = {
  // sealant names no account and no worker has the server's own key: the organization needs its own.
  "boat-account-required": () => NO_KEY,
  // Without the organization's key, sealant says this when the server has no key either and stores
  // none (the commonest case), or when nothing on the server starts Boat VMs at all.
  "unsupported-runtime": (_coreMessage, context) =>
    context.holder === "server"
      ? {
          happened: NO_KEY.happened,
          todo: `${NO_KEY.todo} If the server has a Boat key of its own, the person who runs this Mend server checks its Boat setup with mend server setup.`,
        }
      : {
          happened: `${context.holder === "person" ? "The session owner's own Boat key" : "This organization's Boat key"} is connected, and Sealant says nothing on this server starts Boat VMs right now, so nothing was started.`,
          todo: "The person who runs this Mend server checks its Boat setup with mend server setup, then start the session again.",
        },
  "gateway-unavailable": () => ({
    happened:
      "This server's Boat setup has no resource gateway, so a session whose worktree uses project resources cannot start on Boat.",
    todo: "The person who runs this Mend server configures one. Nothing was started.",
  }),
  "runtime-requirement-unsupported": (coreMessage) => ({
    happened: `Boat cannot run this project's environment: ${clause(coreMessage)}.`,
    todo: `Change the project's environment, or ask an owner of this organization to choose another runtime in Settings, Organization, Defaults where the server offers one.`,
  }),
  "runtime-os-unsupported": (coreMessage) => ({
    happened: `${clause(coreMessage)}.`,
    todo: "Switch the project's environment to one Boat runs, then start the session again.",
  }),
  "boat-account-wallet-unresolved": (_coreMessage, context) => ({
    happened: `The Boat wallet ${keyOf(context)} bills is not known to sealant yet, so nothing was started. sealant looks at a key connected before this server's upgrade within about a minute of it; sessions already running on the key are not affected.`,
    todo: `Start the session again in a minute. If it is refused again, the key lacks Boat's account.read permission, which Boat never adds to an existing key: ${lowerFirst(keyFixer(context, "a key with every permission Mend needs"))}`,
  }),
};

const lowerFirst = (words: string): string => `${words.charAt(0).toLowerCase()}${words.slice(1)}`;

/**
 * sealant's refusals of a change to a stored Boat key (connect, replace, full check, choosing its
 * wallet) that are not Boat's: a state of the account in sealant, worded here so the page and the
 * CLI say the same.
 * - `unpinned`: sealant answered a full check with `boat-account-in-use` and no count of launches.
 *   It sends that for a key it has not pinned to a wallet yet (connected before the upgrade that
 *   pins keys, or a key without `account.read`), and for a key whose wallet was changed while the
 *   check began; nothing else in its answer tells the two apart, so its own sentence follows.
 * - `key-organization`: a wallet was chosen for a Boat organization's key, which bills that
 *   organization only.
 * - `environment`: the server's own key, which is set where the server is set up.
 */
export const BOAT_KEY_ACCOUNT_REFUSALS = ["unpinned", "key-organization", "environment"] as const;
export type BoatKeyAccountRefusal = (typeof BOAT_KEY_ACCOUNT_REFUSALS)[number];

const ACCOUNT_REFUSAL_WORDS: { readonly [K in BoatKeyAccountRefusal]: Refusal } = {
  unpinned: (coreMessage, context) => ({
    happened: `${context.place === "full-check" ? "No full check of this key was started, so nothing was made in Boat" : "Nothing changed"}. sealant says: ${clause(coreMessage)}.`,
    todo: `A key connected before sealant pinned each key to the wallet it bills is pinned within about a minute of the upgrade; ${again(context)} then. A key without Boat's account.read permission is never pinned, and Boat never adds a permission to an existing key: ${lowerFirst(keyFixer(context, "a key with every permission Mend needs"))}`,
  }),
  "key-organization": (_coreMessage, context) => ({
    happened: `${capital(keyOf(context))} is a Boat organization's key: it bills that Boat organization and nothing else, and has no wallet to choose. Nothing changed.`,
    todo: `To bill another wallet, ${lowerFirst(keyFixer(context, "a key made for that wallet"))}`,
  }),
  environment: () => ({
    happened:
      "This server's own Boat key, and the Boat organization it bills, are set where the server is set up, not here, so nothing changed.",
    todo: "The person who runs this Mend server changes them with mend server setup --boat-api-key-stdin and --boat-organization.",
  }),
};

/** The words for a refusal of a change to a Boat key, from the one table. */
export const boatKeyAccountWords = (
  refusal: BoatKeyAccountRefusal,
  coreMessage: string,
  context: BoatWordsContext,
): BoatProblemWords => ACCOUNT_REFUSAL_WORDS[refusal](coreMessage, context);

/** The words for a Boat problem, from the one table. */
export const boatProblemWords = (
  problem: BoatProblem,
  context: BoatWordsContext,
): BoatProblemWords =>
  "failure" in problem
    ? FAILURE_WORDS[problem.kind](problem.failure, context)
    : REFUSAL_WORDS[problem.kind](problem.coreMessage, context);

/** `happened`, then `todo` on its own line: a session's message, a refusal's sentence. */
export const boatProblemText = (problem: BoatProblem, context: BoatWordsContext): string => {
  const words = boatProblemWords(problem, context);
  return `${words.happened}\n${words.todo}`;
};

/**
 * Boat's own code and request id, for the server log and an operator: never part of the words.
 * `boat refused · key-expired · api_key_expired · request req_123 · create · 403`.
 */
export const boatFailureLogLine = (failure: BoatFailure): string =>
  [
    `boat refused · ${failure.kind}`,
    failure.code ?? "no code",
    `request ${failure.requestId ?? "none"}`,
    failure.operation,
    failure.status === null ? null : String(failure.status),
  ]
    .filter((part) => part !== null)
    .join(" · ");
