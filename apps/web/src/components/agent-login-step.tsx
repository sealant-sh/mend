import type { SealantIdentity } from "@mend/api-contracts";
import { InlineAlert } from "@mend/ui/components/banner";
import { CopyField } from "@mend/ui/components/copy-field";
import { Button } from "@mend/ui/components/ui/button";
import { Input } from "@mend/ui/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@mend/ui/components/ui/tabs";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ClipboardEvent, useId, useState, useSyncExternalStore } from "react";

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
  keyProblem,
  refusedWords,
  rejectedAdvice,
} from "#/lib/agent-login";
import { accountNameOptions } from "#/lib/auth-client";
import {
  requestFailure,
  savedModeLine,
  signInCommand,
  waitedFor,
  whenSince,
} from "#/lib/git-access";
import { laterPage } from "#/lib/later-pages";
import { usePhone } from "#/lib/phone";
import { useTRPC } from "#/lib/trpc";
import { useSecond } from "#/lib/use-second";
import { useWorkbenchEvents } from "#/lib/workbench-events";

import { SectionTitle, SetupActions, SetupFrame, WorksLine } from "./setup-frame.tsx";

const noChange = () => () => {};

/** This server's address as the browser reached it, for `mend login --url`. */
const useOrigin = (): string =>
  useSyncExternalStore(
    noChange,
    () => window.location.origin,
    () => "",
  );

type Mode = "command" | "key";

/**
 * Step 3 of setup: a Claude Code or Codex login for the person's sessions. Mend's app takes no
 * part in a provider's sign-in. The page shows the commands to run on the person's computer
 * (`mend login`, then `mend connect claude|codex`) and waits: the `user` event the server sends
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
  const [agent, setAgent] = useState<Agent>(() => initialAgent(identity.accounts));
  const [mode, setMode] = useState<Mode>("command");
  // Only "Use an API key instead" moves focus into the key field; switching agents leaves it on
  // the agent the person picked.
  const [focusKey, setFocusKey] = useState(false);
  const connected = anyAgentConnected(identity.accounts);
  const agentLabel = useId();
  const onward = () => void navigate(laterPage("welcome/first-project"));

  return (
    <SetupFrame
      title="Agent login"
      step={3}
      saved={{ account: accountName, git: savedModeLine(access.mode) }}
    >
      <p className="text-prose text-pretty text-foreground max-lg:text-sm">
        Sessions run on your own Claude Code or Codex account. Mend doesn't come with one. Each
        message you send to a session uses your login. You can add the other agent later in
        Settings.
      </p>
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
          <TabsList aria-labelledby={agentLabel} className="max-lg:h-11 max-lg:w-full">
            {AGENTS.map((choice) => (
              <TabsTrigger key={choice} value={choice} className="px-3 max-lg:text-base">
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
  const origin = useOrigin();
  // How long the page has waited: from when this agent's commands appeared.
  const [waitingSince] = useState(() => new Date());
  return (
    <>
      <SectionTitle>{`Connect ${facts.name}`}</SectionTitle>
      <p className="text-prose text-pretty text-foreground max-lg:text-sm">
        On a computer with {facts.name} installed, sign Mend's command line in to this server once,
        then run the second command. It opens {facts.service}'s sign-in in that computer's browser
        and passes the login to Mend when you finish.
      </p>
      <div className="mt-3 grid gap-2">
        <CopyField
          value={signInCommand(origin)}
          label="Copy command"
          size={phone ? "touch" : "default"}
        />
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
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const id = useId();
  const facts = AGENT_FACTS[agent];
  const [key, setKey] = useState("");
  const [problem, setProblem] = useState<ReturnType<typeof keyProblem>>(null);
  const connect = useMutation(
    trpc.platform.connectAccount.mutationOptions({
      // Its variables carry the key: gone from the mutation cache once nothing shows its result.
      gcTime: 0,
      onSuccess: () => queryClient.invalidateQueries(trpc.platform.sealantIdentity.queryFilter()),
    }),
  );

  const send = (typed: string) => {
    const secret = typed.trim();
    setKey("");
    connect.reset();
    const found = keyProblem(agent, secret);
    setProblem(found);
    if (found === null) connect.mutate({ provider: agent, secret, login: "api-key" });
  };

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

  const rejected =
    problem ??
    (connect.isError
      ? {
          title: "Mend couldn't save this key.",
          advice: `${requestFailure(connect.error)} ${rejectedAdvice(agent)}`,
        }
      : null);
  const refused = login.kind === "refused" ? refusedWords(agent, login.key) : null;

  return (
    <form
      noValidate
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        if (!connect.isPending) send(key);
      }}
    >
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
      <label
        htmlFor={id}
        className="mt-6 mb-2 block text-lead font-medium text-foreground max-lg:text-base"
      >
        {facts.issuer} API key
      </label>
      <Input
        id={id}
        type="password"
        value={key}
        placeholder={facts.keyPlaceholder}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
        // Kept focusable while the key is sent, so focus stays here for another try.
        readOnly={connect.isPending}
        autoFocus={focus}
        aria-invalid={rejected !== null}
        aria-describedby={`${id}-help`}
        className="h-10 font-mono text-meta max-lg:h-11"
        onChange={(event) => setKey(event.target.value)}
        onPaste={(event: ClipboardEvent<HTMLInputElement>) => {
          event.preventDefault();
          if (!connect.isPending) send(event.clipboardData.getData("text"));
        }}
      />
      {rejected === null ? null : (
        <InlineAlert title={rejected.title} size={phone ? "touch" : "default"} className="mt-3">
          {rejected.advice}
        </InlineAlert>
      )}
      <p
        id={`${id}-help`}
        className="mt-2 text-row text-pretty text-muted-foreground max-lg:text-sm"
      >
        Create a key in {facts.console.words}{" "}
        <a
          href={facts.console.url}
          target="_blank"
          rel="noreferrer"
          className="text-info underline-offset-4 hover:underline"
        >
          {facts.console.link}
        </a>
        . {facts.name} sessions bill that {facts.issuer} account. Mend saves the key as soon as you
        paste it, or when you press Enter.
      </p>
      {connect.isPending ? (
        <p role="status" className="mt-3 text-row text-muted-foreground max-lg:text-sm">
          Saving the key · {waitedFor(new Date(connect.submittedAt), now)}
        </p>
      ) : null}
      <div className="mt-4">{runCommand}</div>
    </form>
  );
}
