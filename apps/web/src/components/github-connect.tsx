import { InlineAlert } from "@mend/ui/components/banner";
import { CopyField } from "@mend/ui/components/copy-field";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { agentLoginState, githubConnectedLine } from "#/lib/agent-login";
import { waitedFor, whenSince } from "#/lib/git-access";
import { useTRPC } from "#/lib/trpc";
import { useSecond } from "#/lib/use-second";

import { CommandLineBlock } from "./command-line-block.tsx";
import { WorksLine } from "./setup-frame.tsx";

/** Where to get GitHub's command line. */
const GH_URL = "https://cli.github.com";

/** The command that sends `gh`'s login on the person's computer to their Mend account. */
export const CONNECT_GITHUB_COMMAND = "mend connect github";

/**
 * How to give Mend the person's own GitHub login, in setup's Git access and First project steps:
 * what it is for, Mend's command line block (unless the page shows it already), how to get `gh`,
 * `mend connect github`, and whether the login has arrived. It arrives through the `user` event
 * the server sends when `mend connect` saves it (`useWorkbenchEvents`, mounted by the page), which
 * reads the person's logins, and the repositories Mend lists, again.
 */
export function GithubConnect({
  phone,
  commandLine,
}: {
  readonly phone: boolean;
  /** Whether to show Mend's command line block here: false when the page already shows it. */
  readonly commandLine: boolean;
}) {
  const trpc = useTRPC();
  const now = useSecond();
  const identity = useQuery(trpc.platform.sealantIdentity.queryOptions());
  // How long the page has waited: from when this section opened.
  const [waitingSince] = useState(() => new Date());
  // While the logins load, the page waits as if none were connected.
  const login =
    identity.isPending || identity.isError
      ? null
      : agentLoginState(identity.data.accounts, "github");

  return (
    <div className="grid gap-4">
      <p className="text-prose text-pretty text-foreground max-lg:text-sm">
        Connect GitHub and Mend lists your repositories and opens pull requests as you. It uses the
        login of GitHub's command line, <code className="font-mono text-meta">gh</code>, on your
        computer.
      </p>
      {login?.kind === "connected" ? null : (
        <>
          {commandLine ? <CommandLineBlock phone={phone} /> : null}
          <div className="grid gap-2">
            <p className="text-row text-pretty text-muted-foreground max-lg:text-sm">
              No <code className="font-mono text-meta">gh</code> yet? Install it from{" "}
              <a
                href={GH_URL}
                target="_blank"
                rel="noreferrer"
                className="text-info underline-offset-4 hover:underline"
              >
                cli.github.com
              </a>{" "}
              and run <code className="font-mono text-meta">gh auth login</code>.
            </p>
            <CopyField
              value={CONNECT_GITHUB_COMMAND}
              label="Copy command"
              size={phone ? "touch" : "default"}
            />
          </div>
        </>
      )}
      <div className="border-t pt-5 lg:pt-6">
        {identity.isError ? (
          <InlineAlert
            tone="warning"
            title="Mend couldn't read your logins."
            size={phone ? "touch" : "default"}
          >
            The page shows your GitHub login once Mend can read it again.
          </InlineAlert>
        ) : login?.kind === "connected" ? (
          <WorksLine
            line={githubConnectedLine(login.account)}
            detail={`Connected ${whenSince(login.account.connectedAt, now)}`}
          />
        ) : login?.kind === "refused" ? (
          <InlineAlert
            tone="warning"
            title="GitHub refused your login."
            size={phone ? "touch" : "default"}
          >
            Run <code>gh auth login</code> on your computer, then <code>mend connect github</code>{" "}
            again.
          </InlineAlert>
        ) : (
          <p role="status" className="text-row text-muted-foreground max-lg:text-sm">
            Waiting for GitHub to connect · {waitedFor(waitingSince, now)}
          </p>
        )}
      </div>
    </div>
  );
}
