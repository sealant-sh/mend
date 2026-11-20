import { Alert, AlertDescription, AlertTitle } from "@mend/ui/components/ui/alert";
import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import { cn } from "@mend/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { InfoIcon } from "lucide-react";
import { useState } from "react";

import { QueryError } from "#/components/route-screens";
import { agentLogin } from "#/lib/new-session";
import { usePhone } from "#/lib/phone";
import { setupStart } from "#/lib/project-starts";
import { useTRPC } from "#/lib/trpc";

import { useProjectStart } from "../new-session/instant-start.ts";
import { Overlay } from "../projects/overlay.tsx";

/** The agents a setup session can run, each on the person's own login. */
const SETUP_AGENTS = [
  { id: "claude", label: "Claude Code", login: "Your Claude login", letter: "C" },
  { id: "codex", label: "Codex", login: "Your Codex login", letter: "X" },
] as const;

type SetupAgent = (typeof SETUP_AGENTS)[number]["id"];

/**
 * Set up this project (Doop "Project · set up this project dialog", and its phone sheet): what a
 * setup session does, the agents the person has connected, and Start. A setup session studies the
 * repository and proposes `.mend/` files for the person to review, on their own agent login;
 * writing those files starts no commands, Services or resources. With no agent connected it
 * links to the agent logins and Start stays off.
 */
export function SetupDialog({
  projectId,
  projectName,
  open,
  onOpenChange,
}: {
  readonly projectId: string;
  readonly projectName: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const phone = usePhone();
  const identity = useQuery(
    trpc.platform.sealantIdentity.queryOptions(undefined, { staleTime: 30_000, retry: false }),
  );
  const connected = identity.isSuccess
    ? SETUP_AGENTS.filter((agent) => agentLogin(identity.data.accounts, agent.id) === "ready")
    : [];
  const [picked, setPicked] = useState<SetupAgent | null>(null);
  const agent = connected.find((each) => each.id === picked) ?? connected[0];
  // The session's page opens at once; a refusal is said in a toast (SLNT-1196).
  const start = useProjectStart(projectId);
  const close = (next: boolean) => {
    onOpenChange(next);
  };
  const size = phone ? "touch" : "default";

  return (
    <Overlay
      open={open}
      onOpenChange={close}
      title="Set up this project"
      description={`A setup session reads ${projectName} and proposes .mend/ files for you to review. It runs on your own agent login, and writing the files starts no commands, services or resources.`}
      size="md"
      footer={
        <>
          <Button variant="outline" size={size} onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            size={size}
            disabled={agent === undefined}
            onClick={() => {
              if (agent === undefined) return;
              onOpenChange(false);
              start(setupStart(projectId, agent.id), "The setup session didn't start.");
            }}
          >
            Start setup session
          </Button>
        </>
      }
    >
      {identity.isPending ? (
        <p role="status" className="text-row text-muted-foreground">
          Reading your agent logins…
        </p>
      ) : identity.isError ? (
        <QueryError
          error={identity.error}
          retry={() => void identity.refetch()}
          retrying={identity.isRefetching}
        />
      ) : agent === undefined ? (
        <Alert tone="info">
          <InfoIcon aria-hidden />
          <AlertTitle>No agent connected.</AlertTitle>
          <AlertDescription>
            <p>
              Connect Claude Code or Codex in Settings, under Agent logins and Git. Then start the
              setup session from here.
            </p>
            <Link
              to="/settings/agent-logins"
              className={cn(buttonVariants({ variant: "outline", size }), "mt-2")}
            >
              Open Agent logins and Git
            </Link>
          </AlertDescription>
        </Alert>
      ) : (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-prose font-medium">Agent</legend>
          <div
            role="radiogroup"
            aria-label="Agent"
            className="grid gap-2.5 sm:grid-cols-2 max-lg:grid-cols-1"
          >
            {connected.map((choice) => {
              const checked = choice.id === agent.id;
              return (
                <button
                  key={choice.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => setPicked(choice.id)}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border px-3.5 py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60",
                    phone && "min-h-16",
                    checked ? "border-primary bg-primary/8 ring-1 ring-primary" : "hover:bg-muted",
                  )}
                >
                  <span
                    aria-hidden
                    className="grid size-6 shrink-0 place-items-center rounded-sm bg-foreground text-2xs font-semibold text-background"
                  >
                    {choice.letter}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-prose">{choice.label}</span>
                    <span className="block truncate text-row text-muted-foreground">
                      {choice.login}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-row text-muted-foreground">
            Only the agents you've connected are listed.
          </p>
        </fieldset>
      )}
    </Overlay>
  );
}
