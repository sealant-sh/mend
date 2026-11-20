import { Button } from "@mend/ui/components/ui/button";
import { cn } from "@mend/ui/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { screenTitle } from "#/lib/how-mend-fits";
import { type FitsScreen, screenCount } from "#/lib/how-mend-fits-screen";
import { usePhone } from "#/lib/phone";
import { rememberNounsEnd } from "#/lib/setup-skips";

import { FitsScreenBody, useFitsNames } from "./how-mend-fits.tsx";
import { SetupFrame, useSetupProgress } from "./setup-frame.tsx";

/**
 * Setup's last step, How Mend fits together (SLNT-1203): three short screens on one page,
 * `?screen=1` to `3`, so Back, Next and the browser's own back all work. Skip for now (on the first
 * two) and Continue to Mend (on the last) both open Mend; neither saves anything on the server.
 * This browser remembers which, only so the steps beside the sheet say so if the person goes back.
 * The column is 960px, so the pictures stay readable.
 */
export function HowMendFitsStep({ screen }: { readonly screen: FitsScreen }) {
  const navigate = useNavigate();
  const phone = usePhone();
  const progress = useSetupProgress();
  const names = useFitsNames();
  const open = (next: FitsScreen) => {
    void navigate({ to: "/welcome/how-mend-fits", search: { screen: next } });
    window.scrollTo({ top: 0 });
  };
  const leave = (end: "seen" | "skipped") => {
    rememberNounsEnd(progress.userId, end);
    void navigate({ to: phone ? "/new" : "/" });
  };
  const size = phone ? "touch" : "default";
  return (
    <SetupFrame
      title={screenTitle(screen, phone)}
      step="nouns"
      steps={progress.steps}
      saved={progress.saved}
      skipped={progress.skipped}
      reached={progress.reached}
      ended={progress.ended}
      wide
    >
      <FitsScreenBody screen={screen} names={names} phone={phone} place="step" />
      <FitsActions
        screen={screen}
        skip={
          screen === 3 ? undefined : (
            <Button variant="ghost" size={size} onClick={() => leave("skipped")}>
              Skip for now
            </Button>
          )
        }
        back={
          screen === 1 ? undefined : (
            <Button variant="outline" size={size} onClick={() => open(screen === 3 ? 2 : 1)}>
              Back
            </Button>
          )
        }
        next={
          screen === 3 ? (
            <Button size={size} onClick={() => leave("seen")}>
              Continue to Mend
            </Button>
          ) : (
            <Button size={size} onClick={() => open(screen === 1 ? 2 : 3)}>
              Next
            </Button>
          )
        }
      />
    </SetupFrame>
  );
}

/**
 * The foot of a screen (Doop frames' buttons). On a desktop, under a hairline: Skip for now on the
 * left, then "1 of 3", Back and Next on the right. On a phone, pinned to the bottom: "1 of 3", Next
 * at full width, then Back and Skip for now side by side.
 */
export function FitsActions({
  screen,
  skip,
  back,
  next,
}: {
  readonly screen: FitsScreen;
  readonly skip?: ReactNode;
  readonly back?: ReactNode;
  readonly next: ReactNode;
}) {
  return (
    <div className="mt-6 lg:mt-8 lg:flex lg:items-center lg:gap-3 lg:border-t lg:pt-7">
      <div className="fixed inset-x-0 bottom-0 z-10 grid gap-2 border-t bg-background px-4 pt-3 pb-[max(env(safe-area-inset-bottom),--spacing(3))] lg:contents">
        <p className="text-center text-sm text-muted-foreground lg:order-2 lg:ml-auto lg:text-row">
          {screenCount(screen)}
        </p>
        <div className="grid lg:order-4 lg:flex">{next}</div>
        {skip === undefined && back === undefined ? null : (
          <div
            className={cn(
              "flex gap-2 max-lg:*:flex-1 lg:contents",
              // A desktop shows Skip first, on the left, and Back just before Next.
              "lg:[&>[data-skip]]:order-1 lg:[&>[data-back]]:order-3",
            )}
          >
            {back === undefined ? null : (
              <span data-back className="grid lg:flex">
                {back}
              </span>
            )}
            {skip === undefined ? null : (
              <span data-skip className="grid lg:flex">
                {skip}
              </span>
            )}
          </div>
        )}
      </div>
      {/* On a phone the pinned buttons are taller than the room setup's pages leave under them. */}
      <div aria-hidden className="h-16 lg:hidden" />
    </div>
  );
}
