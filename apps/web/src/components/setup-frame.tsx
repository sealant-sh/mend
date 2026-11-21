import { cn } from "@mend/ui/lib/utils";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, ChevronLeft, CircleCheck, Minus } from "lucide-react";
import { type ReactNode, useState, useSyncExternalStore } from "react";

import { savedAgentLine } from "#/lib/agent-login";
import { accountNameOptions } from "#/lib/auth-client";
import { commandLineState } from "#/lib/command-line";
import { useDesktopBadgeCount, useMacDesktopTitlebarInset } from "#/lib/desktop";
import { savedModeLine } from "#/lib/git-access";
import {
  SETUP_STEP_NAMES,
  type SetupStepKey,
  setupSteps,
  stepLine as stepLineOf,
} from "#/lib/onboarding";
import {
  hasAgentLogin,
  type LastStepEnd,
  namesOrganization,
  previousStep,
  railSteps,
} from "#/lib/setup";
import { nounsEnd, reachedStep, skippedCommandLine } from "#/lib/setup-skips";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";

/**
 * The page a person sees before the app opens: sign-in, a reset link, the first account and the
 * setup steps after it, joining from an invitation, authorizing a terminal. On a desktop it is
 * Sheet's desk with Mend and this server's address on it (and the setup steps, during setup), and
 * the sheet holding one 560px column (960px for How Mend fits together, whose pictures need room). Under 1024px it is the phone layout: a header with the title
 * and a muted line under it, the page, and the main action pinned at the foot (`SetupActions`).
 */

/** On a phone, a control is a 44px touch target (DESIGN.md). */
export const TOUCH = "max-lg:h-11 max-lg:px-4 max-lg:text-lead";

const noChange = () => () => {};

/** The address people reach this server at, as the browser has it; empty while rendering on the server. */
export const useServerHost = (): string =>
  useSyncExternalStore(
    noChange,
    () => window.location.host,
    () => "",
  );

/**
 * What each finished step saved, shown under its name once the person is past it: the account's
 * name, the organization's, the Git access mode, the agent login, the project.
 */
export type SetupSaved = Partial<Readonly<Record<SetupStepKey, string>>>;

const NOTHING_SAVED: SetupSaved = {};

/** A step the person may skip: Command line, Agent login and How Mend fits together. */
export type SkippableStep = "cli" | "agent" | "nouns";

/** Someone who joins from an invitation: six steps, no Organization. */
export const JOINER_STEPS = setupSteps(false);

/** What the steps beside the sheet need, for the signed-in person (`useSetupProgress`). */
export interface SetupProgress {
  readonly steps: ReadonlyArray<SetupStepKey>;
  readonly userId: string;
  /** What each step saved: the account's name, the computer, the Git access mode, the agent login, the organization's name. */
  readonly saved: SetupSaved;
  /** Steps the person skipped. A step only reads as skipped once the person is past it. */
  readonly skipped: ReadonlyArray<SkippableStep>;
  /** Whether this browser remembers the person skipping Command line, with no computer signed in since. */
  readonly skippedCli: boolean;
  /** The furthest step the person opened in this browser (`railSteps`). */
  readonly reached: SetupStepKey | null;
  /** How the person left the last step, How Mend fits together, in this browser (`railSteps`). */
  readonly ended: LastStepEnd;
}

/**
 * The signed-in person's setup steps and what each saved, so every step's page draws the same
 * steps beside the sheet, whichever step it is. The route's loader has read who is signed in and
 * the account's name; the devices, Git access and agent logins are read beside the page
 * (`useWorkbenchEvents` reads them again when something changes in a terminal).
 */
export const useSetupProgress = (): SetupProgress => {
  const trpc = useTRPC();
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const accountName = useSuspenseQuery(accountNameOptions()).data;
  const devices = useQuery(trpc.devices.list.queryOptions());
  const access = useQuery(trpc.git.access.queryOptions());
  const identity = useQuery(trpc.platform.sealantIdentity.queryOptions());
  const steps = setupSteps(namesOrganization(viewer));
  // Read once: the route's loader remembered this page before it opened.
  const [stored] = useState(() => reachedStep(viewer.userId));
  const [skipped] = useState(() => skippedCommandLine(viewer.userId));
  const [ended] = useState(() => nounsEnd(viewer.userId));
  // Until a read answers, or if it can't, its step names nothing under it and nothing reads as
  // skipped.
  const state = devices.isPending || devices.isError ? null : commandLineState(devices.data);
  const computer = state?.kind === "signed-in" ? state.computer : undefined;
  const mode = access.isPending || access.isError ? null : access.data.mode;
  const logins = identity.isPending || identity.isError ? null : identity.data;
  const agentLogin = logins === null ? null : hasAgentLogin(logins);
  // A computer that signed in since the skip makes it no longer a skip.
  const skippedCli = skipped && state?.kind === "waiting";
  return {
    steps,
    userId: viewer.userId,
    saved: {
      account: accountName,
      organization: viewer.organization.name,
      ...(computer === undefined ? {} : { cli: computer }),
      ...(mode === null ? {} : { git: savedModeLine(mode) }),
      ...(logins !== null && agentLogin === true ? { agent: savedAgentLine(logins.accounts) } : {}),
    },
    skipped: [
      ...(skippedCli ? (["cli"] as const) : []),
      ...(agentLogin === false ? (["agent"] as const) : []),
    ],
    skippedCli,
    reached: steps.find((key) => key === stored) ?? null,
    ended,
  };
};

const NO_SKIPS: ReadonlyArray<SkippableStep> = [];

/** What a screen reader hears after a step's name, for a step that is a link. */
const LINK_WORDS = { done: "done", skipped: "skipped", left: "not finished" } as const;

/**
 * The person's setup steps beside the sheet: earlier ones checked, with what they saved under
 * them, or a dash and "Skipped" for one the person skipped; the current one marked. Each step the
 * person is past, and the step they left off at when they went back, is a link to its page
 * (`railSteps`); Account, the current step and steps not reached yet are not.
 */
export function SetupSteps({
  steps,
  step,
  saved = NOTHING_SAVED,
  skipped = NO_SKIPS,
  reached = null,
  ended = null,
}: {
  readonly steps: ReadonlyArray<SetupStepKey>;
  readonly step: SetupStepKey;
  readonly saved?: SetupSaved | undefined;
  readonly skipped?: ReadonlyArray<SkippableStep> | undefined;
  readonly reached?: SetupStepKey | null | undefined;
  readonly ended?: LastStepEnd | undefined;
}) {
  return (
    <ol aria-label="Setup steps" className="grid text-sm leading-snug">
      {railSteps({ steps, step, reached, skipped, ended }).map(({ key, state, page }, index) => {
        const name = SETUP_STEP_NAMES[key];
        const past = state === "done" || state === "skipped";
        const savedLine =
          state === "skipped" ? "Skipped" : state === "done" ? saved[key] : undefined;
        const body = (
          <>
            <span
              className={cn(
                "grid size-6 flex-none place-items-center rounded-full border text-xs font-medium",
                state === "current" && "border-primary bg-primary text-primary-foreground",
                (past || state === "left") && "border-input bg-background text-foreground",
                state === "later" && "border-border bg-background text-muted-foreground",
              )}
            >
              {state === "done" ? (
                <Check aria-hidden className="size-3.5" />
              ) : state === "skipped" ? (
                <Minus aria-hidden className="size-3.5" />
              ) : (
                index + 1
              )}
            </span>
            <span className="grid min-w-0 gap-0.5 pt-0.5">
              <span
                className={cn(
                  "font-medium",
                  state === "later" ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {name}
                {state === "done" || state === "skipped" || state === "left" ? (
                  <span className="sr-only">, {LINK_WORDS[state]}</span>
                ) : null}
              </span>
              {savedLine === undefined || savedLine === "" ? null : (
                <span
                  id={`setup-step-${key}-saved`}
                  className="truncate text-xs text-muted-foreground"
                >
                  {savedLine}
                </span>
              )}
            </span>
          </>
        );
        return (
          <li
            key={key}
            aria-current={state === "current" ? "step" : undefined}
            className="relative pb-5 last:pb-0 not-last:after:absolute not-last:after:top-7 not-last:after:bottom-1 not-last:after:left-[11.5px] not-last:after:w-px not-last:after:bg-border"
          >
            {page === null ? (
              <div className="flex items-start gap-3">{body}</div>
            ) : (
              // The kit's sidebar row: the same hover and focus ring, the step where it was.
              <Link
                to={page}
                // Named "Git access, done"; what the step saved is its description.
                aria-label={`${name}, ${LINK_WORDS[state === "skipped" || state === "left" ? state : "done"]}`}
                aria-describedby={
                  savedLine === undefined || savedLine === ""
                    ? undefined
                    : `setup-step-${key}-saved`
                }
                className="-m-1.5 flex items-start gap-3 rounded-md p-1.5 ring-sidebar-ring outline-hidden hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2"
              >
                {body}
              </Link>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function SetupFrame({
  title,
  step,
  steps = JOINER_STEPS,
  saved,
  skipped,
  reached,
  ended,
  wide = false,
  banner,
  children,
}: {
  /** The page's one heading: in the column on a desktop, in the header on a phone. */
  readonly title: string;
  /** During setup, the step this page is; the person's steps show beside the sheet. */
  readonly step?: SetupStepKey;
  /** The person's steps (`setupSteps`); someone who joins from an invitation's, by default. */
  readonly steps?: ReadonlyArray<SetupStepKey>;
  /** What the steps before this one saved (`SetupSteps`). */
  readonly saved?: SetupSaved;
  /** Steps before this one the person skipped (`SetupSteps`). */
  readonly skipped?: ReadonlyArray<SkippableStep> | undefined;
  /** The furthest step the person reached (`SetupSteps`). */
  readonly reached?: SetupStepKey | null | undefined;
  /** How the person left the last step (`SetupSteps`). */
  readonly ended?: LastStepEnd | undefined;
  /** The 960px column, for a page whose pictures need it, in place of 560px. */
  readonly wide?: boolean;
  /** A state that affects the whole page (a `Banner`), across the top of the sheet. */
  readonly banner?: ReactNode;
  readonly children: ReactNode;
}) {
  const host = useServerHost();
  const macInset = useMacDesktopTitlebarInset();
  useDesktopBadgeCount(0);
  const stepLine = step === undefined ? null : stepLineOf(steps, step);
  // On a phone, where the steps aren't beside the sheet, the step before this one.
  const back = step === undefined ? null : previousStep(steps, step);
  return (
    <div className="flex min-h-dvh bg-background lg:bg-canvas lg:p-sheet-inset">
      {macInset ? (
        <div
          aria-hidden
          className="desktop-drag pointer-events-auto fixed top-0 left-0 z-20 h-10 w-sidebar max-lg:hidden"
        />
      ) : null}
      <div
        className={cn(
          "hidden w-sidebar shrink-0 flex-col gap-8 px-3 lg:flex",
          macInset ? "pt-11" : "pt-3",
        )}
      >
        <div>
          <p className="text-lead font-semibold text-foreground">Mend</p>
          <p className="text-row text-muted-foreground">{host}</p>
        </div>
        {step === undefined ? null : (
          <SetupSteps
            steps={steps}
            step={step}
            saved={saved}
            skipped={skipped}
            reached={reached}
            ended={ended}
          />
        )}
      </div>
      <main className="flex min-w-0 flex-1 flex-col bg-background lg:overflow-hidden lg:rounded-xl lg:border lg:border-sheet-border lg:shadow-sheet">
        {/* Phone: the header first, the banner under it. Desktop: the banner across the top of the
            sheet, then the column with the heading in it. */}
        {banner === undefined ? null : <div className="order-2 lg:order-1">{banner}</div>}
        <header
          className={cn(
            "relative order-1 flex min-h-14 flex-col items-center justify-center border-b px-4 py-2 text-center lg:order-2 lg:mx-auto lg:min-h-0 lg:w-full lg:items-start lg:border-0 lg:px-5 lg:pt-16 lg:pb-0 lg:text-left",
            wide ? "lg:max-w-240" : "lg:max-w-140",
          )}
        >
          {back === null ? null : (
            <Link
              to={back.page}
              aria-label={`Back to ${SETUP_STEP_NAMES[back.key]}`}
              className="absolute top-1/2 left-1 grid size-11 -translate-y-1/2 place-items-center rounded-lg text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none lg:hidden"
            >
              <ChevronLeft aria-hidden className="size-5" />
            </Link>
          )}
          <h1 className="text-title font-semibold tracking-tight text-foreground lg:text-2xl">
            {title}
          </h1>
          <p
            className={cn(
              "text-2xs text-muted-foreground lg:text-row",
              stepLine === null ? "lg:hidden" : "lg:order-first lg:mb-2",
            )}
          >
            {stepLine ?? host}
          </p>
        </header>
        <div
          className={cn(
            "order-3 mx-auto w-full flex-1 px-4 pt-4 pb-32 lg:px-5 lg:pt-4 lg:pb-16",
            wide ? "max-w-240" : "max-w-140",
          )}
        >
          {children}
        </div>
      </main>
    </div>
  );
}

/**
 * The foot of a setup page's form: a note and the page's buttons. On a desktop they share a row
 * under a hairline, the note on the left. On a phone the buttons are pinned to the bottom of the
 * screen at full width, and the note stays in the page above them; a `status` (what is left to
 * fix) goes in the pinned bar, over the buttons. A `secondary` button (a way back) sits on the
 * left on a desktop, in place of a note, and first in the pinned row on a phone.
 */
export function SetupActions({
  note,
  status,
  secondary,
  divided = true,
  children,
}: {
  readonly note?: ReactNode;
  readonly status?: string | null;
  readonly secondary?: ReactNode;
  /** The hairline over the row on a desktop; off when a hairline already ends what is above. */
  readonly divided?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "mt-6 lg:flex lg:items-center lg:justify-between lg:gap-4",
        divided ? "lg:mt-8 lg:border-t lg:pt-7" : "lg:mt-6",
      )}
    >
      {note === undefined ? null : (
        <p className="text-row text-pretty text-muted-foreground max-lg:text-sm">{note}</p>
      )}
      <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-background px-4 pt-3 pb-[max(env(safe-area-inset-bottom),--spacing(3))] lg:contents">
        {status === null || status === undefined ? null : (
          <p
            role="status"
            className="mb-3 text-center text-sm text-muted-foreground lg:mb-0 lg:text-left lg:text-row"
          >
            {status}
          </p>
        )}
        <div
          className={cn(
            "flex gap-2 max-lg:*:flex-1",
            secondary === undefined ? "lg:ml-auto" : "lg:flex-1 lg:justify-between",
          )}
        >
          {secondary}
          {children}
        </div>
      </div>
    </div>
  );
}

/** A section's heading inside a setup step, under the page's opening lines. */
export function SectionTitle({ children }: { readonly children: string }) {
  return (
    <h2 className="mt-8 mb-3 text-lead font-semibold text-foreground max-lg:mt-6">{children}</h2>
  );
}

/**
 * A line Mend observed, with a tick: the key works, the computer connected, an agent login
 * connected. `facts` is a second line about what connected (an account); `detail` says when.
 */
export function WorksLine({
  line,
  facts,
  detail,
  action,
}: {
  readonly line: string;
  readonly facts?: string | undefined;
  readonly detail?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div role="status" className="flex items-start gap-3 max-lg:flex-col">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <CircleCheck aria-hidden className="mt-0.5 size-4.5 flex-none text-foreground" />
        <div className="grid min-w-0 gap-0.5">
          <p className="text-prose text-pretty text-foreground max-lg:text-sm">{line}</p>
          {facts === undefined ? null : (
            <p className="text-prose font-medium break-all text-foreground max-lg:text-sm">
              {facts}
            </p>
          )}
          {detail === undefined ? null : <p className="text-row text-muted-foreground">{detail}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}
