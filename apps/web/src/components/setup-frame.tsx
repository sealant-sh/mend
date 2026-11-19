import { cn } from "@mend/ui/lib/utils";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, ChevronLeft, CircleCheck, Minus } from "lucide-react";
import { type ReactNode, useState, useSyncExternalStore } from "react";

import { commandLineState } from "#/lib/command-line";
import {
  SETUP_STEP_NAMES,
  type SetupStepKey,
  setupSteps,
  stepLine as stepLineOf,
} from "#/lib/onboarding";
import { namesOrganization } from "#/lib/setup";
import { skippedCommandLine } from "#/lib/setup-skips";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";

/**
 * The page a person sees before the app opens: sign-in, a reset link, the first account and the
 * setup steps after it, joining from an invitation, authorizing a terminal. On a desktop it is
 * Sheet's desk with Mend and this server's address on it (and the setup steps, during setup), and
 * the sheet holding one 560px column. Under 1024px it is the phone layout: a header with the title
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

/** A step the person may skip: Command line and Agent login. */
export type SkippableStep = "cli" | "agent";

/** Someone who joins from an invitation: five steps, no Organization. */
export const JOINER_STEPS = setupSteps(false);

/**
 * The signed-in person's setup steps, what the steps that aren't a page's own saved (the
 * organization's name, the computer the command line is signed in on), and whether they skipped
 * Command line. The root route has already read who is signed in; the devices are read beside
 * the page (`useWorkbenchEvents` reads them again when a computer signs in).
 */
export const useSetupProgress = (): {
  readonly steps: ReadonlyArray<SetupStepKey>;
  readonly userId: string;
  readonly saved: Pick<SetupSaved, "organization" | "cli">;
  readonly skippedCli: boolean;
} => {
  const trpc = useTRPC();
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const devices = useQuery(trpc.devices.list.queryOptions());
  const [skipped] = useState(() => skippedCommandLine(viewer.userId));
  // Until the list answers, or if it can't, no computer is named and nothing reads as skipped.
  const state = devices.isPending || devices.isError ? null : commandLineState(devices.data);
  const computer = state?.kind === "signed-in" ? state.computer : undefined;
  return {
    steps: setupSteps(namesOrganization(viewer)),
    userId: viewer.userId,
    saved: {
      organization: viewer.organization.name,
      ...(computer === undefined ? {} : { cli: computer }),
    },
    // A computer that signed in since the skip makes it no longer a skip.
    skippedCli: skipped && state?.kind === "waiting",
  };
};

/** The steps a person skipped, from what each page knows. */
export const skippedSteps = (
  skippedCli: boolean,
  skippedAgent = false,
): ReadonlyArray<SkippableStep> => [
  ...(skippedCli ? (["cli"] as const) : []),
  ...(skippedAgent ? (["agent"] as const) : []),
];

const NO_SKIPS: ReadonlyArray<SkippableStep> = [];

/**
 * The person's setup steps beside the sheet: earlier ones checked, with what they saved under
 * them, or a dash and "Skipped" for one the person skipped; the current one marked.
 */
export function SetupSteps({
  steps,
  step,
  saved = NOTHING_SAVED,
  skipped = NO_SKIPS,
}: {
  readonly steps: ReadonlyArray<SetupStepKey>;
  readonly step: SetupStepKey;
  readonly saved?: SetupSaved | undefined;
  readonly skipped?: ReadonlyArray<SkippableStep> | undefined;
}) {
  const current = steps.indexOf(step);
  return (
    <ol aria-label="Setup steps" className="grid text-sm leading-snug">
      {steps.map((key, index) => {
        const name = SETUP_STEP_NAMES[key];
        const number = index + 1;
        const state =
          index < current
            ? skipped.some((skip) => skip === key)
              ? "skipped"
              : "done"
            : index === current
              ? "current"
              : "later";
        const savedLine =
          state === "skipped" ? "Skipped" : state === "done" ? saved[key] : undefined;
        return (
          <li
            key={key}
            aria-current={state === "current" ? "step" : undefined}
            className="relative flex items-start gap-3 pb-5 last:pb-0 not-last:after:absolute not-last:after:top-7 not-last:after:bottom-1 not-last:after:left-[11.5px] not-last:after:w-px not-last:after:bg-border"
          >
            <span
              className={cn(
                "grid size-6 flex-none place-items-center rounded-full border text-xs font-medium",
                state === "current" && "border-primary bg-primary text-primary-foreground",
                (state === "done" || state === "skipped") &&
                  "border-input bg-background text-foreground",
                state === "later" && "border-border bg-background text-muted-foreground",
              )}
            >
              {state === "done" ? (
                <Check aria-hidden className="size-3.5" />
              ) : state === "skipped" ? (
                <Minus aria-hidden className="size-3.5" />
              ) : (
                number
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
                {state === "done" || state === "skipped" ? (
                  <span className="sr-only"> ({state})</span>
                ) : null}
              </span>
              {savedLine === undefined || savedLine === "" ? null : (
                <span className="truncate text-xs text-muted-foreground">{savedLine}</span>
              )}
            </span>
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
  back,
  banner,
  children,
}: {
  /** The page's one heading: in the column on a desktop, in the header on a phone. */
  readonly title: string;
  /** During setup, the step this page is; the person's steps show beside the sheet. */
  readonly step?: SetupStepKey;
  /** The person's steps (`setupSteps`); four, someone who joins from an invitation, by default. */
  readonly steps?: ReadonlyArray<SetupStepKey>;
  /** What the steps before this one saved (`SetupSteps`). */
  readonly saved?: SetupSaved;
  /** Steps before this one the person skipped (`SetupSteps`). */
  readonly skipped?: ReadonlyArray<SkippableStep> | undefined;
  /** On a phone, the step before this one, as a back arrow in the header. */
  readonly back?: {
    readonly to:
      | "/welcome/command-line"
      | "/welcome"
      | "/welcome/agent-login"
      | "/welcome/organization";
    readonly label: string;
  };
  /** A state that affects the whole page (a `Banner`), across the top of the sheet. */
  readonly banner?: ReactNode;
  readonly children: ReactNode;
}) {
  const host = useServerHost();
  const stepLine = step === undefined ? null : stepLineOf(steps, step);
  return (
    <div className="flex min-h-dvh bg-background lg:bg-canvas lg:p-sheet-inset">
      <div className="hidden w-sidebar shrink-0 flex-col gap-8 px-3 pt-3 lg:flex">
        <div>
          <p className="text-lead font-semibold text-foreground">Mend</p>
          <p className="text-row text-muted-foreground">{host}</p>
        </div>
        {step === undefined ? null : (
          <SetupSteps steps={steps} step={step} saved={saved} skipped={skipped} />
        )}
      </div>
      <main className="flex min-w-0 flex-1 flex-col bg-background lg:overflow-hidden lg:rounded-xl lg:border lg:border-sheet-border lg:shadow-sheet">
        {/* Phone: the header first, the banner under it. Desktop: the banner across the top of the
            sheet, then the column with the heading in it. */}
        {banner === undefined ? null : <div className="order-2 lg:order-1">{banner}</div>}
        <header className="relative order-1 flex min-h-14 flex-col items-center justify-center border-b px-4 py-2 text-center lg:order-2 lg:mx-auto lg:min-h-0 lg:w-full lg:max-w-140 lg:items-start lg:border-0 lg:px-5 lg:pt-16 lg:pb-0 lg:text-left">
          {back === undefined ? null : (
            <Link
              to={back.to}
              aria-label={back.label}
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
        <div className="order-3 mx-auto w-full max-w-140 flex-1 px-4 pt-4 pb-32 lg:px-5 lg:pt-4 lg:pb-16">
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
