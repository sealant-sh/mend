import type { GitAccessView, SealantIdentity } from "@mend/api-contracts";
import type { QueryClient } from "@tanstack/react-query";

import { commandLineState } from "./command-line.ts";
import { gitAccessOptions } from "./git-access.ts";
import { skippedCommandLine } from "./setup-skips.ts";
import { signedInOptions } from "./sign-in.ts";
import type { TrpcProxy } from "./trpc.ts";

/**
 * Where setup sends a signed-in person. The server keeps no "setup finished" flag, so Mend reads
 * it from what the person has: a computer's command line signed in (or this browser remembering
 * they skipped that step), Git access in place, an agent login, a project they can see. (The
 * old app showed its first-run steps until a project existed, and made the Mend key on the Git
 * access step.)
 *
 * Two questions, with two answers:
 * - `/welcome`, opened by the first account, a new member, or the person themselves, shows Git
 *   access until the steps after it are done too, so reloading it never throws the person out of
 *   setup (`welcomeEntry`).
 * - Signing in with no page to return to opens setup only for someone who never got past it: no
 *   Git access, or no project. Someone who skipped the agent login and has a project opens Mend
 *   (`signInEntry`).
 */

/** The setup steps' pages, in order (Account is the sign-up form itself). */
export const SETUP_PATHS = {
  commandLine: "/welcome/command-line",
  gitAccess: "/welcome",
  agentLogin: "/welcome/agent-login",
  organization: "/welcome/organization",
  firstProject: "/welcome/first-project",
} as const;

/**
 * Git access is in place once the person has a Mend key, or chose their computer's key (only the
 * person picks that mode; Mend's default is the Mend key).
 */
export const gitAccessChosen = (access: Pick<GitAccessView, "mode" | "key">): boolean =>
  access.mode === "bridge" || access.key.exists;

/** Whether the person has connected Claude or Codex (GitHub is a credential, not an agent login). */
export const hasAgentLogin = (identity: Pick<SealantIdentity, "accounts">): boolean =>
  identity.accounts.some((account) => account.provider !== "github" && account.status === "active");

/**
 * Whether the person names the organization during setup (the Organization step). The first
 * account is the server's operator and the owner of its first organization (docs/adr/0003);
 * nobody who joins from an invitation is both, so they have five steps. Read from who the person
 * is, not from what they did, so the step list stays the same on every page of setup.
 */
export const namesOrganization = (viewer: {
  readonly operator: boolean;
  readonly role: "owner" | "member";
}): boolean => viewer.operator && viewer.role === "owner";

/** What setup observed about the person. */
export interface SetupObserved {
  readonly access: Pick<GitAccessView, "mode" | "key">;
  /** Whether the person has the Organization step (`namesOrganization`). */
  readonly namesOrganization: boolean;
  /**
   * Whether the Command line step is still owed: no computer's command line is signed in for the
   * person, and they didn't skip the step in this browser.
   */
  readonly commandLineOwed: boolean;
  readonly hasProject: boolean;
  /**
   * Asked only when it decides something: it reads the platform, which may be slow or down. A
   * failed read counts as no agent login.
   */
  readonly hasAgentLogin: () => Promise<boolean>;
}

/** Where setup sends the person: one of its steps' pages, or Mend itself. */
export type SetupEntry = "command-line" | "git-access" | "organization" | "first-project" | "home";

/** The step after Agent login: Organization for the first account, First project for others. */
const afterAgentLogin = (observed: Pick<SetupObserved, "namesOrganization">): SetupEntry =>
  observed.namesOrganization ? "organization" : "first-project";

/**
 * What `/welcome` does with a person. Git access stays on screen until there is an agent login, so
 * a member who joins an organization that already has projects still goes through it. With an
 * agent login and no project, the step left is Organization (the first account) or First project;
 * with both, setup is done. It never sends anyone back to Command line: that step's Continue and
 * Skip both lead here.
 */
export const welcomeEntry = async (observed: SetupObserved): Promise<SetupEntry> => {
  if (!gitAccessChosen(observed.access)) return "git-access";
  if (!(await observed.hasAgentLogin())) return "git-access";
  return observed.hasProject ? "home" : afterAgentLogin(observed);
};

/**
 * Where signing in with no page to return to goes: setup for someone who never got past it, Mend
 * for anyone with Git access and a project (an agent login is the one step a person may skip).
 * Someone who left before choosing Git access starts again at Command line, unless a computer is
 * signed in or they skipped it in this browser.
 */
export const signInEntry = async (observed: SetupObserved): Promise<SetupEntry> => {
  if (!gitAccessChosen(observed.access)) {
    return observed.commandLineOwed ? "command-line" : "git-access";
  }
  if (observed.hasProject) return "home";
  return (await observed.hasAgentLogin()) ? afterAgentLogin(observed) : "git-access";
};

/**
 * What `/welcome/first-project` does with a person. It comes after Git access; an agent login is
 * not needed, since that step may be skipped. Someone who can already see a project has nothing
 * to add, so a member who joins an organization with a shared project goes on to Mend.
 */
export const firstProjectEntry = (
  observed: Pick<SetupObserved, "access" | "hasProject">,
): SetupEntry => {
  if (!gitAccessChosen(observed.access)) return "git-access";
  return observed.hasProject ? "home" : "first-project";
};

/**
 * Whether First project offers "Skip for now". A person who sees no project yet, in an
 * organization with other members, may be waiting for one of them to share a project, so they may
 * go on without one. The first account, alone in its organization, adds a project.
 */
export const firstProjectSkippable = (memberCount: number): boolean => memberCount > 1;

/** The page each answer opens. */
export const ENTRY_PATHS: Readonly<Record<SetupEntry, string>> = {
  "command-line": SETUP_PATHS.commandLine,
  "git-access": SETUP_PATHS.gitAccess,
  organization: SETUP_PATHS.organization,
  "first-project": SETUP_PATHS.firstProject,
  home: "/",
};

/** Reads what setup decides on, for the signed-in person. */
export const readSetup = async ({
  queryClient,
  trpc,
}: {
  readonly queryClient: QueryClient;
  readonly trpc: TrpcProxy;
}): Promise<SetupObserved & { readonly access: GitAccessView }> => {
  const [access, projects, viewer, signedIn] = await Promise.all([
    queryClient.fetchQuery(gitAccessOptions(trpc)),
    queryClient.fetchQuery(trpc.projects.list.queryOptions()),
    queryClient.fetchQuery(signedInOptions(trpc)),
    // A list that can't be read doesn't hold setup up: the person goes on to Git access.
    queryClient.fetchQuery(trpc.devices.list.queryOptions()).then(
      (devices) => commandLineState(devices).kind === "signed-in",
      () => true,
    ),
  ]);
  return {
    access,
    namesOrganization: namesOrganization(viewer),
    commandLineOwed: !signedIn && !skippedCommandLine(viewer.userId),
    hasProject: projects.length > 0,
    hasAgentLogin: () =>
      queryClient
        .fetchQuery(trpc.platform.sealantIdentity.queryOptions())
        .then(hasAgentLogin, () => false),
  };
};

/**
 * Where signing in goes: the page the person was sent from, or, with none, the answer of
 * `signInEntry`. Setup that can't be read opens Mend, whose pages say what failed.
 */
export const afterSignIn = async (
  next: string,
  read: () => Promise<SetupEntry>,
): Promise<string> => {
  if (next !== "/") return next;
  try {
    return ENTRY_PATHS[await read()];
  } catch {
    return "/";
  }
};
