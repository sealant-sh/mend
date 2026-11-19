import type { SealantIdentity } from "@mend/api-contracts";
import { InlineAlert } from "@mend/ui/components/banner";
import { CopyField } from "@mend/ui/components/copy-field";
import { Button } from "@mend/ui/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@mend/ui/components/ui/tabs";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";

import {
  AGENT_FACTS,
  AGENTS,
  type Agent,
  agentLoginNote,
  agentLoginState,
  type AgentLoginState,
  accountFacts,
  anyAgentConnected,
  connectCommand,
  connectedLine,
  initialAgent,
  refusedWords,
} from "#/lib/agent-login";
import { accountNameOptions } from "#/lib/auth-client";
import { savedModeLine, waitedFor, whenSince } from "#/lib/git-access";
import { usePhone } from "#/lib/phone";
import { useTRPC } from "#/lib/trpc";
import { useSecond } from "#/lib/use-second";
import { useWorkbenchEvents } from "#/lib/workbench-events";

import { ApiKeyField, KeyConsoleLink, useApiKeySave } from "./agent-login-panels.tsx";
import { CommandLineBlock } from "./command-line-block.tsx";
import {
  SectionTitle,
  SetupActions,
  SetupFrame,
  skippedSteps,
  useSetupProgress,
  WorksLine,
} from "./setup-frame.tsx";

type Mode = "command" | "key";

/**
 * Setup's Agent login step: a Claude Code or Codex login for the person's sessions. Mend's app
 * takes no part in a provider's sign-in. The page introduces Mend's command line once, above the
 * agents, and each agent's tab shows its own command (`mend connect claude|codex`), then waits: the `user` event the server sends
 * when a login is connected makes the page read the person's logins again, so it lands without a
 * reload. An API key, pasted here, is the second choice. The step can be skipped.
 */
export function AgentLoginStep() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const phone = usePhone();
  const now = useSecond();
  // The page joins the tab's event stream: `mend connect` in a terminal sends the `user` event
  // that re-reads `platform.sealantIdentity` (lib/workbench-events.ts).
  useWorkbenchEvents();
  const identity = useSuspenseQuery(trpc.platform.sealantIdentity.queryOptions()).data;
  const access = useSuspenseQuery(trpc.git.access.queryOptions()).data;
  const accountName = useSuspenseQuery(accountNameOptions()).data;
  const progress = useSetupProgress();
  const [agent, setAgent] = useState<Agent>(() => initialAgent(identity.accounts));
  const [mode, setMode] = useState<Mode>("command");
  // Only "Use an API key instead" moves focus into the key field; switching agents leaves it on
  // the agent the person picked.
  const [focusKey, setFocusKey] = useState(false);
  const connected = anyAgentConnected(identity.accounts);
  const agentLabel = useId();
  // The first account names its organization before its first project.
  const onward = () =>
    void navigate({
      to: progress.steps.includes("organization")
        ? "/welcome/organization"
        : "/welcome/first-project",
    });

  return (
    <SetupFrame
      title="Agent login"
      step="agent"
      steps={progress.steps}
      saved={{ account: accountName, ...progress.saved, git: savedModeLine(access.mode) }}
      skipped={skippedSteps(progress.skippedCli)}
    >
      <p className="text-prose text-pretty text-foreground max-lg:text-sm">
        Sessions run on your own Claude Code or Codex account. Mend doesn't come with one. Each
        message you send to a session uses your login. You can add the other agent later in
        Settings.
      </p>
      {/* Mend's command line, once for both agents: each tab holds only its own command. */}
      {mode === "command" ? (
        <CommandLineBlock phone={phone} className="mt-6 border-t pt-6" />
      ) : null}
      <Tabs
        value={agent}
        onValueChange={(value) => {
          if (value === "claude" || value === "codex") {
            setAgent(value);
            setFocusKey(false);
          }
        }}
        className="mt-6 gap-0"
      >
        <div className="flex items-center justify-between gap-4 border-y py-3 max-lg:flex-col max-lg:items-stretch max-lg:gap-2 max-lg:border-0 max-lg:py-0">
          <p id={agentLabel} className="text-lead font-semibold text-foreground max-lg:text-base">
            Agent
          </p>
          <TabsList aria-labelledby={agentLabel} className="max-lg:h-auto max-lg:w-full">
            {AGENTS.map((choice) => (
              <TabsTrigger
                key={choice}
                value={choice}
                className="px-3 max-lg:h-11 max-lg:text-base"
              >
                {AGENT_FACTS[choice].name}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {AGENTS.map((choice) => (
          <TabsContent key={choice} value={choice} className="text-base">
            {mode === "command" ? (
              <RunCommand
                agent={choice}
                login={agentLoginState(identity.accounts, choice)}
                now={now}
                phone={phone}
                onUseKey={() => {
                  setMode("key");
                  setFocusKey(true);
                }}
              />
            ) : (
              <ApiKey
                agent={choice}
                login={agentLoginState(identity.accounts, choice)}
                apiKeys={identity.apiKeys}
                now={now}
                phone={phone}
                focus={focusKey}
                onRunCommand={() => setMode("command")}
              />
            )}
          </TabsContent>
        ))}
      </Tabs>
      <SetupActions status={agentLoginNote(identity.accounts, { agent, mode })}>
        {connected ? null : (
          <Button variant="ghost" size={phone ? "touch" : "default"} onClick={onward}>
            Skip for now
          </Button>
        )}
        <Button size={phone ? "touch" : "default"} disabled={!connected} onClick={onward}>
          Continue
        </Button>
      </SetupActions>
    </SetupFrame>
  );
}

/** The commands to run on the person's computer, and what Mend has seen since. */
function RunCommand({
  agent,
  login,
  now,
  phone,
  onUseKey,
}: {
  readonly agent: Agent;
  readonly login: AgentLoginState;
  readonly now: Date;
  readonly phone: boolean;
  readonly onUseKey: () => void;
}) {
  const facts = AGENT_FACTS[agent];
  // How long the page has waited: from when this agent's commands appeared.
  const [waitingSince] = useState(() => new Date());
  return (
    <>
      <SectionTitle>{`Connect ${facts.name}`}</SectionTitle>
      <p className="text-prose text-pretty text-foreground max-lg:text-sm">
        On a computer with {facts.name} installed, run this command. It opens {facts.service}'s
        sign-in in that computer's browser and passes the login to Mend when you finish.
      </p>
      <div className="mt-3">
        <CopyField
          value={connectCommand(agent)}
          label="Copy command"
          size={phone ? "touch" : "default"}
        />
      </div>
      <div className="mt-6 grid gap-4 border-t pt-5 lg:pt-6">
        {login.kind === "connected" ? (
          <WorksLine
            line={connectedLine(agent, login.key)}
            facts={accountFacts(login.account)}
            detail={`Connected ${whenSince(login.account.connectedAt, now)}`}
          />
        ) : login.kind === "refused" ? (
          <InlineAlert
            tone="warning"
            title={refusedWords(agent, login.key).title}
            size={phone ? "touch" : "default"}
          >
            {refusedWords(agent, login.key).advice}
          </InlineAlert>
        ) : (
          <p role="status" className="text-row text-muted-foreground max-lg:text-sm">
            Waiting for {facts.name} to connect · {waitedFor(waitingSince, now)}
          </p>
        )}
        {login.kind === "connected" ? null : (
          <p className="text-row text-muted-foreground max-lg:text-sm">
            {phone ? "No computer with you? " : null}
            <Button variant="link" className="text-row max-lg:text-sm" onClick={onUseKey}>
              Use an API key instead
            </Button>
          </p>
        )}
      </div>
    </>
  );
}

/**
 * An API key for the agent, pasted into one field and saved as soon as it is pasted (or on
 * Enter). The field is emptied the moment a key is sent, so no part of it stays on the page.
 */
function ApiKey({
  agent,
  login,
  apiKeys,
  now,
  phone,
  focus,
  onRunCommand,
}: {
  readonly agent: Agent;
  readonly login: AgentLoginState;
  readonly apiKeys: SealantIdentity["apiKeys"];
  readonly now: Date;
  readonly phone: boolean;
  readonly focus: boolean;
  readonly onRunCommand: () => void;
}) {
  const facts = AGENT_FACTS[agent];
  const save = useApiKeySave(agent);

  const runCommand = (
    <p className="text-row max-lg:text-sm">
      <Button variant="link" className="text-row max-lg:text-sm" onClick={onRunCommand}>
        Run a command instead
      </Button>
    </p>
  );

  // A login that works stays as it is: a key saved here would replace it.
  if (login.kind === "connected") {
    return (
      <>
        <SectionTitle>{`${facts.issuer} API key`}</SectionTitle>
        <WorksLine
          line={
            login.key
              ? `Mend saved your ${facts.issuer} API key. ${facts.name} sessions will use it.`
              : connectedLine(agent, false)
          }
          facts={login.key ? undefined : accountFacts(login.account)}
          detail={`${login.key ? "Saved" : "Connected"} ${whenSince(login.account.connectedAt, now)}`}
        />
        <div className="mt-4">{runCommand}</div>
      </>
    );
  }

  if (!apiKeys) {
    return (
      <>
        <SectionTitle>{`${facts.issuer} API key`}</SectionTitle>
        <p className="text-prose text-pretty text-foreground max-lg:text-sm">
          This Mend server can't run sessions on an API key yet. Whoever runs it can add that by
          upgrading Sealant. Until then, connect {facts.name} with the command.
        </p>
        <div className="mt-4">{runCommand}</div>
      </>
    );
  }

  const refused = login.kind === "refused" ? refusedWords(agent, login.key) : null;

  return (
    <>
      {refused === null ? null : (
        <InlineAlert
          tone="warning"
          title={refused.title}
          size={phone ? "touch" : "default"}
          className="mt-6"
        >
          {refused.advice}
        </InlineAlert>
      )}
      <ApiKeyField
        agent={agent}
        save={save}
        phone={phone}
        now={now}
        focus={focus}
        className="mt-6"
        help={
          <>
            Create a key in <KeyConsoleLink agent={agent} />. {facts.name} sessions bill that{" "}
            {facts.issuer} account. Mend saves the key as soon as you paste it, or when you press
            Enter.
          </>
        }
      />
      <div className="mt-4">{runCommand}</div>
    </>
  );
}
