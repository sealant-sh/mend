import type { GitAccessView, SealantIdentity } from "@mend/api-contracts";
import type { QueryClient } from "@tanstack/react-query";

import { commandLineState } from "./command-line.ts";
import { gitAccessOptions } from "./git-access.ts";
import { type SetupStepKey, setupSteps } from "./onboarding.ts";
import { rememberReached, setupEnded, skippedCommandLine } from "./setup-skips.ts";
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
 * - Signing in with no page to return to, or opening Mend at `/`, opens setup only for someone who
 *   never got past it: no Git access, or no project, unless this browser saw them reach setup's
 *   last step. Someone who skipped the agent login and has a project opens Mend (`signInEntry`,
 *   `homeEntry`).
 */

/**
 * The pages setup sends a person to (Account is the sign-up form itself). `/welcome` is the way
 * into setup: it opens Git access while that step is owed and sends anyone past it on
 * (`welcomeEntry`). Each step's own page, which opens whatever the person has done, is in
 * `STEP_PAGES`.
 */
export const SETUP_PATHS = {
  commandLine: "/welcome/command-line",
  gitAccess: "/welcome",
  agentLogin: "/welcome/agent-login",
  organization: "/welcome/organization",
  firstProject: "/welcome/first-project",
  nouns: "/welcome/how-mend-fits",
} as const;

/**
 * Each step's own page: the links beside the sheet, the phone's back arrow and each step's
 * Continue open these. None of them sends a person on because the step is done, so going back to
 * a step shows it with what was saved. Account has no page here: the account exists, and its page
 * is sign-up.
 */
export const STEP_PAGES = {
  cli: "/welcome/command-line",
  git: "/welcome/git-access",
  agent: "/welcome/agent-login",
  organization: "/welcome/organization",
  project: "/welcome/first-project",
  nouns: "/welcome/how-mend-fits",
} as const satisfies Readonly<Record<Exclude<SetupStepKey, "account">, string>>;

export type StepPage = (typeof STEP_PAGES)[keyof typeof STEP_PAGES];

const pageOf = (key: SetupStepKey): StepPage | null => (key === "account" ? null : STEP_PAGES[key]);

/**
 * Where a step's Continue (and Skip for now) goes: the next step's own page, whether the person is
 * there for the first time or came back to change something. How Mend fits together has no next
 * step: it opens Mend itself.
 */
export const nextStepPage = (
  steps: ReadonlyArray<SetupStepKey>,
  step: SetupStepKey,
): StepPage | null => {
  const next = steps[steps.indexOf(step) + 1];
  return next === undefined ? null : pageOf(next);
};

/**
 * On a phone, the header's back arrow: the step before this one, for every step after Command
 * line (the step before Command line is Account, which has no page to go back to).
 */
export const previousStep = (
  steps: ReadonlyArray<SetupStepKey>,
  step: SetupStepKey,
): { readonly key: SetupStepKey; readonly page: StepPage } | null => {
  const index = steps.indexOf(step);
  const previous = index > 0 ? steps[index - 1] : undefined;
  if (previous === undefined) return null;
  const page = pageOf(previous);
  return page === null ? null : { key: previous, page };
};

/**
 * A step beside the sheet: `done` or `skipped` once the person is past it, `current` for the page
 * they are on, `left` for the furthest step they reached when they went back to an earlier one
 * (where they left off, not finished yet), and `later` for a step they haven't reached.
 */
export type RailState = "done" | "skipped" | "current" | "left" | "later";

export interface RailStep {
  readonly key: SetupStepKey;
  readonly state: RailState;
  /** The step's page, for a step the person may go back to; null for Account and for steps not reached. */
  readonly page: StepPage | null;
}

/**
 * How the person left setup's last step, which has no next page to remember them reaching: they
 * read it to the end (`seen`), skipped it, or neither yet (null).
 */
export type LastStepEnd = "seen" | "skipped" | null;

/**
 * The steps beside the sheet. A step is past once it comes before the page the person is on or
 * before the furthest step they reached (`reached`, which this browser remembers), so going back
 * to Git access keeps Agent login and Organization as links. Past steps and the step the person
 * left off at link to their pages; Account, the current step and steps not reached yet don't.
 * The last step reads done or skipped once the person left it that way (`ended`).
 */
export const railSteps = ({
  steps,
  step,
  reached,
  skipped,
  ended = null,
}: {
  readonly steps: ReadonlyArray<SetupStepKey>;
  readonly step: SetupStepKey;
  readonly reached: SetupStepKey | null;
  readonly skipped: ReadonlyArray<SetupStepKey>;
  readonly ended?: LastStepEnd;
}): ReadonlyArray<RailStep> => {
  const current = steps.indexOf(step);
  const furthest = Math.max(current, reached === null ? -1 : steps.indexOf(reached));
  const last = steps.length - 1;
  return steps.map((key, index) => {
    const state: RailState =
      index === current
        ? "current"
        : index > furthest
          ? "later"
          : index === furthest
            ? index === last && ended !== null
              ? ended === "seen"
                ? "done"
                : "skipped"
              : "left"
            : skipped.includes(key)
              ? "skipped"
              : "done";
    return { key, state, page: state === "current" || state === "later" ? null : pageOf(key) };
  });
};

/**
 * Remembers in this browser that the person opened a step's page, so the steps beside the sheet
 * keep the later steps they reached as links after they go back (`railSteps`).
 */
export const rememberStepReached = (
  viewer: { readonly userId: string } & Parameters<typeof namesOrganization>[0],
  step: SetupStepKey,
): void => rememberReached(viewer.userId, setupSteps(namesOrganization(viewer)), step);

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
   * The person reached setup's last step in this browser, so every step they owed is behind them,
   * done or skipped (`setupEnded`): such as a member who skipped First project.
   */
  readonly ended: boolean;
  /**
   * Asked only when it decides something: it reads the platform, which may be slow or down. A
   * failed read counts as no agent login.
   */
  readonly hasAgentLogin: () => Promise<boolean>;
}

/** Where setup sends the person: one of its steps' pages, or Mend itself. */
export type SetupEntry =
  | "command-line"
  | "git-access"
  | "organization"
  | "first-project"
  | "nouns"
  | "home";

/** The step after Agent login: Organization for the first account, First project for others. */
const afterAgentLogin = (observed: Pick<SetupObserved, "namesOrganization">): SetupEntry =>
  observed.namesOrganization ? "organization" : "first-project";

/**
 * What `/welcome` does with a person. Git access stays on screen until there is an agent login, so
 * a member who joins an organization that already has projects still goes through it. With an
 * agent login and no project, the step left is Organization (the first account) or First project;
 * with both, setup is done. It never sends anyone back to Command line: that step's Continue and
 * Skip both lead here. Nor does it send anyone to How Mend fits together, which only First
 * project's Continue and Skip open (and the account menu, any time), so a person who finished
 * setup before that step existed is never sent back to it.
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
  if (observed.ended) return "home";
  if (!gitAccessChosen(observed.access)) {
    return observed.commandLineOwed ? "command-line" : "git-access";
  }
  if (observed.hasProject) return "home";
  return (await observed.hasAgentLogin()) ? afterAgentLogin(observed) : "git-access";
};

/**
 * What `/welcome/first-project` does with a person. It comes after Git access; an agent login is
 * not needed, since that step may be skipped. Someone who can already see a project has nothing
 * to add, so a member who joins an organization with a shared project goes on to the step after
 * it, How Mend fits together: only someone walking through setup opens this page.
 */
export const firstProjectEntry = (
  observed: Pick<SetupObserved, "access" | "hasProject">,
): SetupEntry => {
  if (!gitAccessChosen(observed.access)) return "git-access";
  return observed.hasProject ? "nouns" : "first-project";
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
  nouns: SETUP_PATHS.nouns,
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
    ended: setupEnded(viewer.userId),
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

/** What `/` reads first: enough to open Mend for anyone past setup. */
export type QuickSetup = Pick<SetupObserved, "access" | "hasProject" | "ended">;

/**
 * Where opening Mend at `/` goes: the answer signing in gives (`signInEntry`), so someone who
 * closed the tab partway through setup comes back to their next step. Someone past setup opens
 * Mend from `quick` alone, the reads the inbox and the composer already hold, so only a person
 * still in setup waits for the rest (`full`). Setup that can't be read opens Mend, whose pages say
 * what failed, as signing in does (`afterSignIn`).
 */
export const homeEntry = async (
  quick: () => Promise<QuickSetup>,
  full: () => Promise<SetupObserved>,
): Promise<SetupEntry> => {
  try {
    const seen = await quick();
    if (seen.ended || (gitAccessChosen(seen.access) && seen.hasProject)) return "home";
    return await signInEntry(await full());
  } catch {
    return "home";
  }
};

/**
 * `homeEntry` against the caches: who is signed in (the root route read it), Git access and the
 * project list (the inbox's layout reads it) come from what is cached when they are, so moving to
 * `/` within Mend asks the server nothing more.
 */
export const readHomeEntry = ({
  queryClient,
  trpc,
}: {
  readonly queryClient: QueryClient;
  readonly trpc: TrpcProxy;
}): Promise<SetupEntry> =>
  homeEntry(
    async () => {
      const viewer = await queryClient.ensureQueryData(signedInOptions(trpc));
      const [access, projects] = await Promise.all([
        queryClient.ensureQueryData(gitAccessOptions(trpc)),
        queryClient.ensureQueryData(trpc.projects.list.queryOptions()),
      ]);
      return { access, hasProject: projects.length > 0, ended: setupEnded(viewer.userId) };
    },
    () => readSetup({ queryClient, trpc }),
  );
