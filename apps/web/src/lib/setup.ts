import type { GitAccessView, SealantIdentity } from "@mend/api-contracts";
import type { QueryClient } from "@tanstack/react-query";

import { gitAccessOptions } from "./git-access.ts";
import type { TrpcProxy } from "./trpc.ts";

/**
 * Where setup sends a signed-in person. The server keeps no "setup finished" flag, so Mend reads
 * it from what the person has: Git access in place, an agent login, a project they can see. (The
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
  gitAccess: "/welcome",
  agentLogin: "/welcome/agent-login",
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

/** What setup observed about the person. */
export interface SetupObserved {
  readonly access: Pick<GitAccessView, "mode" | "key">;
  readonly hasProject: boolean;
  /**
   * Asked only when it decides something: it reads the platform, which may be slow or down. A
   * failed read counts as no agent login.
   */
  readonly hasAgentLogin: () => Promise<boolean>;
}

/** Where setup sends the person: Git access, First project, or Mend itself. */
export type SetupEntry = "git-access" | "first-project" | "home";

/**
 * What `/welcome` does with a person. Git access stays on screen until there is an agent login, so
 * a member who joins an organization that already has projects still goes through it. With an
 * agent login and no project, the step left is First project; with both, setup is done.
 */
export const welcomeEntry = async (observed: SetupObserved): Promise<SetupEntry> => {
  if (!gitAccessChosen(observed.access)) return "git-access";
  if (!(await observed.hasAgentLogin())) return "git-access";
  return observed.hasProject ? "home" : "first-project";
};

/**
 * Where signing in with no page to return to goes: setup for someone who never got past it, Mend
 * for anyone with Git access and a project (an agent login is the one step a person may skip).
 */
export const signInEntry = async (observed: SetupObserved): Promise<SetupEntry> => {
  if (!gitAccessChosen(observed.access)) return "git-access";
  if (observed.hasProject) return "home";
  return (await observed.hasAgentLogin()) ? "first-project" : "git-access";
};

/** The page each answer opens. */
export const ENTRY_PATHS: Readonly<Record<SetupEntry, string>> = {
  "git-access": SETUP_PATHS.gitAccess,
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
  const [access, projects] = await Promise.all([
    queryClient.fetchQuery(gitAccessOptions(trpc)),
    queryClient.fetchQuery(trpc.projects.list.queryOptions()),
  ]);
  return {
    access,
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
