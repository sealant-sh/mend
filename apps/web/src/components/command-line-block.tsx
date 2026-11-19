import { CopyField } from "@mend/ui/components/copy-field";
import { Button } from "@mend/ui/components/ui/button";
import { cn } from "@mend/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import { commandLineState, INSTALL_COMMAND, signedInLine } from "#/lib/command-line";
import { signInCommand, waitedFor } from "#/lib/git-access";
import { useOrigin } from "#/lib/origin";
import { useTRPC } from "#/lib/trpc";
import { useSecond } from "#/lib/use-second";

import { WorksLine } from "./setup-frame.tsx";

/**
 * Mend's command line, introduced once on any page that asks for a `mend` command: setup's Git
 * access, Agent login and First project, and Settings → Agent logins and Git. Until the server has
 * seen a computer signed in for the person, it says the commands run on their own computer and
 * gives the install and sign-in commands, and waits. Once one is signed in, it is one ticked line
 * naming that computer, and no install or sign-in line shows anywhere on the page.
 *
 * It learns of the sign-in from the `user` event the server sends when `mend login` collects its
 * approval (`useWorkbenchEvents`, mounted by the page), which makes `devices.list` read again.
 */
export function CommandLineBlock({
  phone,
  page = false,
  className,
}: {
  readonly phone: boolean;
  /**
   * The Command line step, where the block is the whole page: the page's title is its heading,
   * and the page says what the command line is for.
   */
  readonly page?: boolean;
  readonly className?: string;
}) {
  const trpc = useTRPC();
  const devices = useQuery(trpc.devices.list.queryOptions());
  const now = useSecond();
  const origin = useOrigin();
  const heading = useId();
  // How long the page has waited: from when the block first showed the commands.
  const [waitingSince] = useState(() => new Date());
  const state = devices.isSuccess ? commandLineState(devices.data) : null;

  if (state?.kind === "signed-in") {
    return (
      <div className={className}>
        <WorksLine line={signedInLine(state)} />
      </div>
    );
  }

  return (
    <section aria-labelledby={heading} className={cn("grid gap-2", className)}>
      <p
        id={heading}
        className={page ? "sr-only" : "text-lead font-semibold text-foreground max-lg:text-base"}
      >
        Mend's command line
      </p>
      {page ? (
        <p className="text-prose text-pretty text-foreground max-lg:text-sm">
          The commands on the next steps run on your own computer. Install Mend's command line there
          and sign it in to this server once.
        </p>
      ) : (
        <p className="text-prose text-pretty text-foreground max-lg:text-sm">
          These commands run on your own computer. Install Mend's command line there and sign it in
          to this server once.
        </p>
      )}
      <div className="mt-1 grid gap-2">
        <CopyField
          value={INSTALL_COMMAND}
          label="Copy command"
          size={phone ? "touch" : "default"}
        />
        <CopyField
          value={signInCommand(origin)}
          label="Copy command"
          size={phone ? "touch" : "default"}
        />
      </div>
      {devices.isPending ? (
        <p role="status" className="text-row text-muted-foreground max-lg:text-sm">
          Checking whether a computer is signed in…
        </p>
      ) : devices.isError ? (
        <p role="status" className="text-row text-muted-foreground max-lg:text-sm">
          Mend couldn't check whether a computer is signed in.{" "}
          <Button
            variant="link"
            className="h-auto p-0 text-row max-lg:text-sm"
            onClick={() => void devices.refetch()}
          >
            Check again
          </Button>
        </p>
      ) : (
        <p role="status" className="text-row text-muted-foreground max-lg:text-sm">
          Waiting for your computer to sign in · {waitedFor(waitingSince, now)}
        </p>
      )}
    </section>
  );
}
