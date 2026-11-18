import { cn } from "@mend/ui/lib/utils";
import { Check } from "lucide-react";
import { type ReactNode, useSyncExternalStore } from "react";

import { SETUP_STEPS } from "#/lib/onboarding";

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

export type SetupStep = 1 | 2 | 3 | 4;

/** The four setup steps beside the sheet: earlier ones checked, the current one marked. */
export function SetupSteps({ step }: { readonly step: SetupStep }) {
  return (
    <ol aria-label="Setup steps" className="grid text-sm leading-snug">
      {SETUP_STEPS.map((name, index) => {
        const number = index + 1;
        const state = number < step ? "done" : number === step ? "current" : "later";
        return (
          <li
            key={name}
            aria-current={state === "current" ? "step" : undefined}
            className="relative flex items-start gap-3 pb-5 last:pb-0 not-last:after:absolute not-last:after:top-7 not-last:after:bottom-1 not-last:after:left-[11.5px] not-last:after:w-px not-last:after:bg-border"
          >
            <span
              className={cn(
                "grid size-6 flex-none place-items-center rounded-full border text-xs font-medium",
                state === "current" && "border-primary bg-primary text-primary-foreground",
                state === "done" && "border-input bg-background text-foreground",
                state === "later" && "border-border bg-background text-muted-foreground",
              )}
            >
              {state === "done" ? <Check aria-hidden className="size-3.5" /> : number}
            </span>
            <span
              className={cn(
                "pt-0.5 font-medium",
                state === "later" ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {name}
              {state === "done" ? <span className="sr-only"> (done)</span> : null}
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
  banner,
  children,
}: {
  /** The page's one heading: in the column on a desktop, in the header on a phone. */
  readonly title: string;
  /** During setup, the step this page is; the steps show beside the sheet. */
  readonly step?: SetupStep;
  /** A state that affects the whole page (a `Banner`), across the top of the sheet. */
  readonly banner?: ReactNode;
  readonly children: ReactNode;
}) {
  const host = useServerHost();
  const stepLine = step === undefined ? null : `Step ${step} of ${SETUP_STEPS.length}`;
  return (
    <div className="flex min-h-dvh bg-background lg:bg-canvas lg:p-sheet-inset">
      <div className="hidden w-sidebar shrink-0 flex-col gap-8 px-3 pt-3 lg:flex">
        <div>
          <p className="text-lead font-semibold text-foreground">Mend</p>
          <p className="text-row text-muted-foreground">{host}</p>
        </div>
        {step === undefined ? null : <SetupSteps step={step} />}
      </div>
      <main className="flex min-w-0 flex-1 flex-col bg-background lg:overflow-hidden lg:rounded-xl lg:border lg:border-sheet-border lg:shadow-sheet">
        {/* Phone: the header first, the banner under it. Desktop: the banner across the top of the
            sheet, then the column with the heading in it. */}
        {banner === undefined ? null : <div className="order-2 lg:order-1">{banner}</div>}
        <header className="order-1 flex min-h-14 flex-col items-center justify-center border-b px-4 py-2 text-center lg:order-2 lg:mx-auto lg:min-h-0 lg:w-full lg:max-w-140 lg:items-start lg:border-0 lg:px-5 lg:pt-16 lg:pb-0 lg:text-left">
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
  children,
}: {
  readonly note?: ReactNode;
  readonly status?: string | null;
  readonly secondary?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="mt-6 lg:mt-8 lg:flex lg:items-center lg:justify-between lg:gap-4 lg:border-t lg:pt-7">
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
