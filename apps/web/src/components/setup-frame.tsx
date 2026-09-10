import type { ReactNode } from "react";

import { MendMark } from "#/components/logo";
import { SETUP_STEPS } from "#/lib/onboarding";

/**
 * The one page shape for first contact — sign-in, registration, and the git
 * access step share it: the mark, one lifted card, and (while setting up) the
 * three-step strip so a visitor knows registration is a part, not the whole.
 */
export function SetupFrame({
  step,
  width = "narrow",
  children,
}: {
  /** The active setup step; omitted for plain sign-in. */
  readonly step?: 1 | 2 | 3 | undefined;
  readonly width?: "narrow" | "wide";
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className={`w-full ${width === "wide" ? "max-w-2xl" : "max-w-sm"}`}>
        <div className="mb-8 flex items-baseline gap-2.5">
          <MendMark className="size-7 self-center" aria-hidden="true" />
          <span className="font-display text-xl font-semibold tracking-[-0.01em]">Mend</span>
          <span className="font-mono text-xs text-faint">by Sealant</span>
        </div>
        <div className="rounded-3xl bg-panel p-7 shadow-[var(--shadow-md)]">
          {step === undefined ? null : <SetupSteps step={step} />}
          {children}
        </div>
      </div>
    </div>
  );
}

/** `01 Account · 02 Git access · 03 First run` — the current step in ink, the rest quiet. */
export function SetupSteps({ step }: { readonly step: 1 | 2 | 3 }) {
  return (
    <ol className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11.5px]">
      {SETUP_STEPS.map((label, index) => {
        const number = index + 1;
        const state = number === step ? "current" : number < step ? "done" : "ahead";
        return (
          <li key={label} className="flex items-center gap-3">
            <span
              aria-current={state === "current" ? "step" : undefined}
              className={
                state === "current"
                  ? "text-foreground"
                  : state === "done"
                    ? "text-muted-foreground"
                    : "text-faint"
              }
            >
              0{number} {label}
            </span>
            {number < SETUP_STEPS.length ? (
              <span aria-hidden="true" className="text-faint">
                ·
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
