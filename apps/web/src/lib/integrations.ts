import type { inferRouterOutputs } from "@trpc/server";

import type { AppRouter } from "../server/routers/index.ts";
import { AGENTS } from "./new-session.ts";

/** The organization's Executor settings, as an owner reads them. */
export type ExecutorConfigurationDto = inferRouterOutputs<AppRouter>["executor"]["configuration"];

/**
 * Settings → the organization → Integrations (docs/adr/0006 Slack, docs/adr/0022 Executor,
 * docs/adr/0025): the organization's Slack app and its Executor, which everyone in it shares and
 * its owners set up. A person's own Slack and Executor links are on Connected apps. No part of a
 * Slack token is ever shown once it is entered.
 */

/** The Slack app's thread settings an owner turns on or off, with what each side means. */
export const SLACK_SWITCHES = [
  {
    key: "showAgentMessages",
    label: "Agent messages",
    on: "Mend posts the agent's plan, closing messages and questions in the thread.",
    off: "Mend posts status, reactions and links only.",
  },
  {
    key: "showDiffs",
    label: "Diffs",
    on: "Mend posts each changed file's diff in the thread, up to 3,000 characters.",
    off: "Mend posts the changed files and line counts only.",
  },
  {
    key: "externalChannels",
    label: "Channels shared with other workspaces",
    on: "Agent messages and diffs follow the two switches above in Slack Connect channels too.",
    off: "In Slack Connect channels Mend posts status and links only.",
  },
  {
    // docs/adr/0007-landing.md, "Automatic landing": on by default.
    key: "landAutomatically",
    label: "Land automatically",
    on: "When a turn completes and its request asked for a change, Mend pushes mend/<name> and opens or updates its pull request, as the person who asked.",
    off: "A completed turn pushes nothing; the thread offers its owner “Push and open pull request”.",
  },
] as const;

export type SlackSwitch = (typeof SLACK_SWITCHES)[number]["key"];

/** What removing the Slack app does, said before it happens. */
export const SLACK_REMOVAL_FACTS = [
  "Mend deletes both tokens and stops reading mentions.",
  "Every Slack link and every channel's default project go with them.",
  "Sessions started from Slack stay, with their record.",
] as const;

/** The Slack app's line: the workspace, and how many people linked their account. */
export const slackAppLine = (
  app: {
    readonly teamName: string;
    readonly installedByName: string | null;
  },
  links: number | null,
): string => {
  const people =
    links === null
      ? ""
      : links === 0
        ? " Nobody has linked their account yet."
        : ` ${links} ${links === 1 ? "person has" : "people have"} linked their account.`;
  return `Connected to ${app.teamName}${app.installedByName === null ? "" : ` by ${app.installedByName}`}.${people}`;
};

/** Only an observed missing grant asks the owner to update the app. */
export const slackUploadNotice = (scopes: ReadonlyArray<string> | null): string | null =>
  scopes === null || scopes.includes("files:write")
    ? null
    : "This Slack app can't upload files. Add the files:write scope in the app's settings, or paste the current manifest, then reinstall it to the workspace.";

/** The Executor Mend runs, in a few words: its state and image version. */
export const managedLine = (status: {
  readonly state: string;
  readonly image: string | null;
}): string => {
  const state = status.state.charAt(0).toUpperCase() + status.state.slice(1).replaceAll("-", " ");
  const version = status.image === null ? null : versionOf(status.image);
  return version === null ? state : `${state} · ${version}`;
};

/** `v1.4.2` from `ghcr.io/…/executor:v1.4.2`; null for an image named by digest only. */
export const versionOf = (image: string): string | null => {
  const tag = /:([^:@/]+)$/.exec(image.split("@")[0] ?? "")?.[1];
  return tag === undefined ? null : tag;
};

/** A harness as people call it ("Claude Code"), for one the composer knows; its id otherwise. */
export const harnessLabel = (harness: string): string =>
  AGENTS.find((agent) => agent.id === harness)?.label ?? harness;
