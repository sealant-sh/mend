import { Button } from "@mend/ui/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { commandLineState } from "#/lib/command-line";
import { usePhone } from "#/lib/phone";
import { nextStepPage, STEP_PAGES } from "#/lib/setup";
import { skipCommandLine } from "#/lib/setup-skips";
import { useTRPC } from "#/lib/trpc";
import { useWorkbenchEvents } from "#/lib/workbench-events";

import { CommandLineBlock } from "./command-line-block.tsx";
import { SetupActions, SetupFrame, useSetupProgress } from "./setup-frame.tsx";

/**
 * Setup's Command line step, right after the account: install Mend's command line on the
 * person's own computer and sign it in to this server, and wait until the server sees it signed
 * in. The steps after it ask for `mend` commands. A Mend key, an API key and a pasted Git address
 * all work without it (someone setting up from a phone has no computer), so it can be skipped;
 * this browser remembers the skip (`lib/setup-skips.ts`).
 */
export function CommandLineStep() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const phone = usePhone();
  // `mend login` in a terminal sends the `user` event that reads the devices again.
  useWorkbenchEvents();
  const progress = useSetupProgress();
  const devices = useQuery(trpc.devices.list.queryOptions());
  // The block says when the list can't be read; Continue then waits, and Skip stays offered.
  const signedIn =
    devices.isPending || devices.isError
      ? false
      : commandLineState(devices.data).kind === "signed-in";
  // Git access's own page, also when the person came back here from a later step.
  const onward = () => void navigate({ to: nextStepPage(progress.steps, "cli") ?? STEP_PAGES.git });

  return (
    <SetupFrame
      title="Mend's command line"
      step="cli"
      steps={progress.steps}
      saved={progress.saved}
      skipped={progress.skipped}
      reached={progress.reached}
      ended={progress.ended}
    >
      <CommandLineBlock phone={phone} page />
      <SetupActions
        status={signedIn || devices.isPending ? null : "Continue once your computer signs in."}
      >
        {signedIn ? null : (
          <Button
            variant="ghost"
            size={phone ? "touch" : "default"}
            onClick={() => {
              skipCommandLine(progress.userId);
              onward();
            }}
          >
            Skip for now
          </Button>
        )}
        <Button size={phone ? "touch" : "default"} disabled={!signedIn} onClick={onward}>
          Continue
        </Button>
      </SetupActions>
    </SetupFrame>
  );
}
