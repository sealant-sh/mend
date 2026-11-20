import { createCookieStore } from "./cookie-store.ts";
import type { SetupStepKey } from "./onboarding.ts";

/**
 * What this browser remembers about a person's setup, per account, that the server doesn't hold.
 *
 * Two facts decide where opening Mend goes (`homeEntry`, lib/setup.ts), so they are kept in a
 * cookie the server reads when it renders `/`:
 * - the person skipped Command line. A computer that never signed in looks the same whether the
 *   person skipped the step or left before finishing it.
 * - the person reached setup's last step, How Mend fits together, so every step they owed is
 *   behind them, done or skipped. Someone who skipped First project, waiting for a teammate to
 *   share a project, looks the same to the server as someone who left before it.
 *
 * Each holds the accounts it is true for, the last few signed in here. A cookie that can't be read
 * counts as nothing remembered.
 */
export interface SetupKept {
  readonly skippedCommandLine: ReadonlyArray<string>;
  readonly ended: ReadonlyArray<string>;
}

const NOTHING_KEPT: SetupKept = { skippedCommandLine: [], ended: [] };

/** How many accounts each fact keeps; the oldest goes first. */
export const KEPT_ACCOUNTS = 8;

const accountsIn = (stored: unknown): ReadonlyArray<string> =>
  Array.isArray(stored)
    ? stored.filter((each): each is string => typeof each === "string").slice(-KEPT_ACCOUNTS)
    : [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** What the cookie holds; anything it can't read is nothing remembered. */
export const parseSetupKept = (stored: unknown): SetupKept => {
  if (!isRecord(stored)) return NOTHING_KEPT;
  return {
    skippedCommandLine: accountsIn(stored["skippedCommandLine"]),
    ended: accountsIn(stored["ended"]),
  };
};

/** `kept` with `userId` added to `fact`, keeping the last `KEPT_ACCOUNTS` accounts. */
export const keptWith = (kept: SetupKept, fact: keyof SetupKept, userId: string): SetupKept => ({
  ...kept,
  [fact]: [...kept[fact].filter((each) => each !== userId), userId].slice(-KEPT_ACCOUNTS),
});

const setupKept = createCookieStore("mend-setup", parseSetupKept, NOTHING_KEPT);

const remember = (fact: keyof SetupKept, userId: string): void => {
  // Written in the browser only: the server never decides a step was skipped or reached.
  if (typeof document === "undefined") return;
  const kept = setupKept.read();
  if (kept[fact].includes(userId)) return;
  setupKept.set(keptWith(kept, fact, userId));
};

/** The localStorage key earlier versions kept the Command line skip under, still honoured here. */
const legacyKeyOf = (userId: string): string => `mend-setup-skipped-command-line:${userId}`;

export const skippedCommandLine = (userId: string): boolean => {
  if (setupKept.read().skippedCommandLine.includes(userId)) return true;
  try {
    return localStorage.getItem(legacyKeyOf(userId)) === "1";
  } catch {
    return false;
  }
};

export const skipCommandLine = (userId: string): void => remember("skippedCommandLine", userId);

/** Whether the person reached setup's last step in this browser: every owed step is behind them. */
export const setupEnded = (userId: string): boolean => setupKept.read().ended.includes(userId);

/** Remembers that the person reached setup's last step (`setupEnded`). */
export const rememberSetupEnded = (userId: string): void => remember("ended", userId);

/**
 * The furthest setup step the person opened in this browser, so the steps beside the sheet keep
 * the steps after the current one as links when they go back to an earlier step. Storage that
 * can't be read counts as nothing reached beyond the page they are on.
 */
const reachedKeyOf = (userId: string): string => `mend-setup-reached:${userId}`;

export const reachedStep = (userId: string): string | null => {
  try {
    return localStorage.getItem(reachedKeyOf(userId));
  } catch {
    return null;
  }
};

/** Remembers `step` as reached, unless the person has already reached a later one. */
export const rememberReached = (
  userId: string,
  steps: ReadonlyArray<SetupStepKey>,
  step: SetupStepKey,
): void => {
  const stored = reachedStep(userId);
  const before = steps.findIndex((key) => key === stored);
  if (steps.indexOf(step) <= before) return;
  try {
    localStorage.setItem(reachedKeyOf(userId), step);
  } catch {
    // Not remembered: going back shows the steps after that page as not reached yet.
  }
};

/**
 * How the person left How Mend fits together, setup's last step, in this browser: read to the end
 * or skipped. Nothing on the server depends on it; it only lets the steps beside the sheet say
 * "Skipped" or tick the step when the person goes back to an earlier one. Storage that can't be
 * read counts as neither.
 */
const nounsKeyOf = (userId: string): string => `mend-setup-nouns:${userId}`;

export const nounsEnd = (userId: string): "seen" | "skipped" | null => {
  try {
    const stored = localStorage.getItem(nounsKeyOf(userId));
    return stored === "seen" || stored === "skipped" ? stored : null;
  } catch {
    return null;
  }
};

export const rememberNounsEnd = (userId: string, end: "seen" | "skipped"): void => {
  try {
    localStorage.setItem(nounsKeyOf(userId), end);
  } catch {
    // Not remembered: going back to an earlier step shows this one as where they left off.
  }
};
