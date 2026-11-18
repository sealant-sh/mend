import type { GitAccessMode, GitAccessView, GitKeyCheck } from "@mend/api-contracts";
import { TRPCClientError } from "@trpc/client";

import type { TrpcProxy } from "./trpc.ts";

/**
 * How Mend reaches a person's repositories, as the Git access step and Settings show it: their
 * choice of mode, their Mend key and GitHub's answer about it, or their computer's ssh-agent.
 * Pure, so what each answer puts on the screen is testable without one.
 */

/**
 * The person's Git access, read fresh on each visit. With their computer's key it is read again
 * every few seconds until the computer connects (the bridge sends no event when it does), then
 * now and then, so a computer that goes away shows.
 */
export const gitAccessOptions = (trpc: TrpcProxy) =>
  trpc.git.access.queryOptions(undefined, {
    staleTime: 0,
    refetchInterval: (query) => {
      const access = query.state.data;
      if (access?.mode !== "bridge") return false;
      return access.bridge.connected ? 10_000 : 2_000;
    },
  });

/** Where a person adds an SSH key to their GitHub account. */
export const GITHUB_SSH_KEYS_URL = "https://github.com/settings/keys";

/** The command that shares a computer's ssh-agent with Mend (`apps/cli`, `mend keys share`). */
export const SHARE_KEY_COMMAND = "mend keys share";

/** Signs the CLI in to this server first: `mend keys share` needs a signed-in CLI. */
export const signInCommand = (origin: string): string => `mend login --url ${origin}`;

/** Each mode's name, as the choice and the setup steps say it. */
export const MODE_NAMES: Readonly<Record<GitAccessMode, string>> = {
  "mend-key": "A Mend key",
  bridge: "Your computer's key",
};

/** What the setup steps say was saved, once Git access is behind the person. */
export const savedModeLine = (mode: GitAccessMode): string =>
  mode === "mend-key" ? "Mend key" : "Your computer's key";

/**
 * Where the key check stands on the page: not asked yet, asking, GitHub's answer, or the request
 * itself failed (the server didn't answer, so nothing is known about the key).
 */
export type KeyCheckState =
  | { readonly kind: "idle" }
  | { readonly kind: "checking"; readonly since: Date }
  | { readonly kind: "answered"; readonly answer: GitKeyCheck }
  | { readonly kind: "failed"; readonly message: string };

/** What the page shows for a check: one line, or an alert with its own words and one action. */
export type KeyCheckView =
  | { readonly kind: "ask" }
  | { readonly kind: "checking"; readonly since: Date }
  | {
      readonly kind: "works";
      /** The sentence beside the tick: who GitHub took the key for. */
      readonly line: string;
      readonly checkedAt: Date;
    }
  | {
      readonly kind: "problem";
      readonly tone: "error" | "warning";
      readonly title: string;
      /** What GitHub or ssh printed, with who printed it; null when there is nothing to quote. */
      readonly observed: { readonly by: "GitHub" | "ssh"; readonly text: string } | null;
      /** The sentences after the quote: what it means and what to do. */
      readonly advice: string;
      /** The alert's one button: check the key again, or make the key first. */
      readonly action: { readonly kind: "check" | "create-key"; readonly label: string };
    };

/** "Mend reached GitHub as linus-p.", or the repository a deploy key is for. */
const worksLine = (answer: Extract<GitKeyCheck, { state: "accepted" }>): string => {
  if (answer.githubLogin !== null) return `Mend reached GitHub as ${answer.githubLogin}.`;
  if (answer.deployKeyRepository !== null) {
    return `Mend reached GitHub with the deploy key for ${answer.deployKeyRepository}.`;
  }
  // GitHub greeted the key without naming anyone: say so, and keep its words.
  return "Mend reached GitHub with your key.";
};

export const keyCheckView = (state: KeyCheckState): KeyCheckView => {
  switch (state.kind) {
    case "idle":
      return { kind: "ask" };
    case "checking":
      return { kind: "checking", since: state.since };
    case "failed":
      return {
        kind: "problem",
        tone: "error",
        title: "Mend couldn't check the key.",
        observed: null,
        advice: `${state.message} Nothing is known about the key yet. Try again in a moment.`,
        action: { kind: "check", label: "Try again" },
      };
    case "answered": {
      const answer = state.answer;
      switch (answer.state) {
        case "accepted":
          return { kind: "works", line: worksLine(answer), checkedAt: answer.checkedAt };
        case "refused":
          return {
            kind: "problem",
            tone: "error",
            title: "GitHub refused the key.",
            observed: { by: "GitHub", text: answer.observed },
            advice:
              "Check that you copied the whole key, starting with ssh-ed25519, and added it under SSH keys in your GitHub settings, not GPG keys. A new key can take a minute to work.",
            action: { kind: "check", label: "Check again" },
          };
        case "unreachable":
          return {
            kind: "problem",
            tone: "warning",
            title: "Mend couldn't reach GitHub.",
            observed: { by: "ssh", text: answer.observed },
            advice:
              "This says nothing about your key. Check that this server can reach github.com, then try again.",
            action: { kind: "check", label: "Try again" },
          };
        case "no-key":
          return {
            kind: "problem",
            tone: "warning",
            title: "You don't have a Mend key yet.",
            observed: null,
            advice: "Create one, add it to GitHub, then check it.",
            action: { kind: "create-key", label: "Create key" },
          };
      }
    }
  }
};

/**
 * Whether the person can go on to the next step: GitHub accepted their Mend key, or, with their
 * computer's key, that computer is connected.
 */
export const gitAccessWorks = (
  access: Pick<GitAccessView, "mode" | "bridge">,
  check: KeyCheckState,
): boolean =>
  access.mode === "bridge"
    ? access.bridge.connected
    : check.kind === "answered" && check.answer.state === "accepted";

/** The note beside Continue: what Continue waits for, or what to keep in mind once it doesn't. */
export const continueNote = (
  access: Pick<GitAccessView, "mode" | "bridge">,
  check: KeyCheckState,
): string => {
  if (access.mode === "bridge") {
    if (!access.bridge.connected) return "Continue once your computer connects.";
    const machine = access.bridge.clientName ?? "your computer";
    return `Mend can't clone or push while ${machine} is offline.`;
  }
  return gitAccessWorks(access, check)
    ? "Mend saves your choice as soon as you pick it."
    : "Continue once GitHub accepts the key.";
};

/**
 * What a request this page made says when it fails: the server's own sentence when it answered,
 * or that it didn't answer (the browser couldn't reach it, so there is no sentence to show).
 */
export const requestFailure = (error: unknown): string => {
  if (error instanceof TRPCClientError && error.data !== undefined && error.data !== null) {
    return error.message;
  }
  return "Mend's server didn't answer.";
};

/** The mode as a sentence names it: "your Mend key", "your computer's key". */
export const modeInSentence = (mode: GitAccessMode): string =>
  mode === "mend-key" ? "your Mend key" : "your computer's key";

/** "3s", "1m 05s": how long Mend has been waiting, beside a line that says what for. */
export const waitedFor = (since: Date, now: Date): string => {
  const seconds = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};

/** "just now", "12s ago", "4m ago", "2h ago": when something was checked or connected. */
export const whenSince = (date: Date, now: Date): string => {
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
};
