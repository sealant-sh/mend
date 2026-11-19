import type { GitAccessMode, GitAccessView } from "@mend/api-contracts";
import { InlineAlert } from "@mend/ui/components/banner";
import { CopyField } from "@mend/ui/components/copy-field";
import { Button } from "@mend/ui/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@mend/ui/components/ui/radio-group";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useId, useState } from "react";

import { agentLoginState } from "#/lib/agent-login";
import { accountNameOptions } from "#/lib/auth-client";
import {
  continueNote,
  gitAccessOptions,
  GITHUB_SSH_KEYS_URL,
  gitAccessWorks,
  type KeyCheckState,
  keyCheckView,
  MODE_NAMES,
  modeInSentence,
  requestFailure,
  SHARE_KEY_COMMAND,
  waitedFor,
  whenSince,
} from "#/lib/git-access";
import { usePhone } from "#/lib/phone";
import { useTRPC } from "#/lib/trpc";
import { useSecond } from "#/lib/use-second";
import { useWorkbenchEvents } from "#/lib/workbench-events";

import { CommandLineBlock } from "./command-line-block.tsx";
import { GithubConnect } from "./github-connect.tsx";
import {
  SectionTitle,
  SetupActions,
  SetupFrame,
  TOUCH,
  skippedSteps,
  useSetupProgress,
  WorksLine,
} from "./setup-frame.tsx";

const DESCRIPTIONS: Readonly<Record<GitAccessMode, ReactNode>> = {
  "mend-key":
    "Mend creates a key and keeps it on this server. Sessions keep going when your laptop is closed, and you can use Mend from your phone.",
  bridge: (
    <>
      Mend signs with the ssh-agent on your computer, so your key stays there. This only works while
      a <code className="font-mono text-meta">mend</code> command runs on that computer.
    </>
  ),
};

/**
 * Setup's Git access step: how Mend reaches the person's repositories. They pick a Mend key (made for them
 * before the page opens, shown to copy into GitHub, then checked against GitHub) or their
 * computer's key (shared by `mend keys share` on that computer). The choice is saved as it is
 * picked; Continue waits until GitHub accepts the key or the computer connects. Under it, the
 * person may connect their own GitHub login, which Mend lists their repositories with; it is
 * optional, and Continue doesn't wait for it.
 */
export function GitAccessStep() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const phone = usePhone();
  const now = useSecond();
  const access = useSuspenseQuery(gitAccessOptions(trpc)).data;
  const accountName = useSuspenseQuery(accountNameOptions()).data;
  const progress = useSetupProgress();
  const identity = useQuery(trpc.platform.sealantIdentity.queryOptions());
  // Until the logins answer, or if they can't, the note about GitHub isn't shown.
  const githubConnected =
    identity.isPending || identity.isError
      ? null
      : agentLoginState(identity.data.accounts, "github").kind === "connected";
  // `mend login`, `mend keys share` and `mend connect github` in a terminal land without a reload.
  useWorkbenchEvents();

  const setAccess = useMutation(
    trpc.git.setAccess.mutationOptions({
      onSuccess: (view) => queryClient.setQueryData(gitAccessOptions(trpc).queryKey, view),
    }),
  );
  const checkKey = useMutation(trpc.git.checkKey.mutationOptions());
  const initKey = useMutation(
    trpc.git.initKey.mutationOptions({
      onSuccess: async () => {
        checkKey.reset();
        await queryClient.invalidateQueries(gitAccessOptions(trpc));
      },
    }),
  );

  const check: KeyCheckState = checkKey.isPending
    ? { kind: "checking", since: new Date(checkKey.submittedAt) }
    : checkKey.isError
      ? { kind: "failed", message: requestFailure(checkKey.error) }
      : checkKey.isSuccess
        ? { kind: "answered", answer: checkKey.data }
        : { kind: "idle" };
  const works = gitAccessWorks(access, check);
  // While a choice saves, the radio shows it; a failed save goes back to the saved one.
  const mode = setAccess.isPending ? setAccess.variables.mode : access.mode;

  return (
    <SetupFrame
      title="Git access"
      step="git"
      steps={progress.steps}
      saved={{ account: accountName, ...progress.saved }}
      skipped={skippedSteps(progress.skippedCli)}
      back={{ to: "/welcome/command-line", label: "Back to Command line" }}
    >
      <div className="flex flex-col">
        <p className="text-prose text-pretty text-foreground max-lg:text-sm">
          Mend signs in to GitHub to clone your repositories and push branches. Choose how. You can
          change this later in Settings.
        </p>
        <ModeChoice
          mode={mode}
          disabled={setAccess.isPending}
          onChoose={(next) => {
            if (next !== access.mode) setAccess.mutate({ mode: next });
          }}
        />
        {setAccess.isError ? (
          <InlineAlert
            title="Mend couldn't save your choice."
            size={phone ? "touch" : "default"}
            className="mt-4"
            actions={
              <Button
                variant="outline"
                size={phone ? "touch" : "sm"}
                onClick={() => setAccess.mutate(setAccess.variables)}
              >
                Try again
              </Button>
            }
          >
            {requestFailure(setAccess.error)} Mend still uses {modeInSentence(access.mode)}.
          </InlineAlert>
        ) : null}
        {access.mode === "mend-key" ? (
          <MendKey
            access={access}
            check={check}
            now={now}
            phone={phone}
            onCheck={() => checkKey.mutate()}
            creatingKey={initKey.isPending}
            createKeyFailed={initKey.isError ? requestFailure(initKey.error) : null}
            onCreateKey={() => initKey.mutate()}
          />
        ) : (
          <YourComputer access={access} now={now} phone={phone} />
        )}
        <SectionTitle>GitHub account</SectionTitle>
        {/* Mend's command line is introduced once: here, unless "Your computer's key" shows it. */}
        <GithubConnect phone={phone} commandLine={access.mode !== "bridge"} />
      </div>
      {/* What Continue waits for changes as the page does, so it is announced, and on a phone it
          sits over the button in the pinned bar. */}
      <SetupActions
        status={
          works && githubConnected === false
            ? "Without GitHub, you paste a repository's address in the last step."
            : continueNote(access, check)
        }
      >
        <Button
          size={phone ? "touch" : "default"}
          disabled={!works || setAccess.isPending}
          onClick={() => void navigate({ to: "/welcome/agent-login" })}
        >
          Continue
        </Button>
      </SetupActions>
    </SetupFrame>
  );
}

function ModeChoice({
  mode,
  disabled,
  onChoose,
}: {
  readonly mode: GitAccessMode;
  readonly disabled: boolean;
  readonly onChoose: (mode: GitAccessMode) => void;
}) {
  const id = useId();
  return (
    <RadioGroup
      aria-label="How Mend signs in to GitHub"
      value={mode}
      disabled={disabled}
      onValueChange={(value) => {
        if (value === "mend-key" || value === "bridge") onChoose(value);
      }}
      className="mt-6 gap-0 divide-y border-y"
    >
      {(["mend-key", "bridge"] as const).map((choice) => (
        <label
          key={choice}
          htmlFor={`${id}-${choice}-radio`}
          className="flex cursor-pointer items-start gap-3 py-4 has-disabled:cursor-default max-lg:min-h-11"
        >
          <RadioGroupItem
            id={`${id}-${choice}-radio`}
            value={choice}
            aria-describedby={`${id}-${choice}`}
            className="mt-0.5 size-4.5"
          />
          <span className="grid min-w-0 gap-1">
            <span className="flex flex-wrap items-baseline gap-x-2 text-lead font-semibold text-foreground max-lg:text-base">
              {MODE_NAMES[choice]}
              {choice === "mend-key" ? (
                <span className="text-row font-medium text-muted-foreground">Recommended</span>
              ) : null}
            </span>
            <span
              id={`${id}-${choice}`}
              className="text-row text-pretty text-muted-foreground max-lg:text-sm"
            >
              {DESCRIPTIONS[choice]}
            </span>
          </span>
        </label>
      ))}
    </RadioGroup>
  );
}

function MendKey({
  access,
  check,
  now,
  phone,
  onCheck,
  creatingKey,
  createKeyFailed,
  onCreateKey,
}: {
  readonly access: GitAccessView;
  readonly check: KeyCheckState;
  readonly now: Date;
  readonly phone: boolean;
  readonly onCheck: () => void;
  readonly creatingKey: boolean;
  readonly createKeyFailed: string | null;
  readonly onCreateKey: () => void;
}) {
  const view = keyCheckView(check);
  const publicKey = access.key.publicKey;
  return (
    <>
      <SectionTitle>Your Mend key</SectionTitle>
      {publicKey === null ? (
        <p className="text-row text-muted-foreground max-lg:text-sm">
          You don't have a Mend key yet.
        </p>
      ) : (
        <CopyField value={publicKey} label="Copy key" size={phone ? "touch" : "default"} />
      )}
      <p className="mt-3 text-row text-pretty text-muted-foreground max-lg:text-sm">
        Add it to the SSH keys on your{" "}
        <a
          href={GITHUB_SSH_KEYS_URL}
          target="_blank"
          rel="noreferrer"
          className="text-info underline-offset-4 hover:underline"
        >
          GitHub account
        </a>
        . To give Mend one repository only, add it as that repository's deploy key with write
        access.
      </p>
      {/* On a phone, a problem with the key is the first thing on the page. */}
      <div
        className={cn(
          "mt-6",
          view.kind === "problem"
            ? "max-lg:order-first max-lg:mt-0 max-lg:mb-5"
            : "border-t pt-5 lg:pt-6",
        )}
      >
        {view.kind === "ask" ? (
          <div className="flex items-center justify-between gap-4 max-lg:flex-col max-lg:items-stretch">
            <p className="text-row text-muted-foreground max-lg:text-sm">
              Once you've added the key, check that GitHub accepts it.
            </p>
            <Button variant="outline" className={TOUCH} onClick={onCheck}>
              Check access
            </Button>
          </div>
        ) : view.kind === "checking" ? (
          <div className="flex items-center justify-between gap-4 max-lg:flex-col max-lg:items-stretch">
            <p role="status" className="text-row text-muted-foreground max-lg:text-sm">
              Checking the key with GitHub · {waitedFor(view.since, now)}
            </p>
            <Button variant="outline" className={TOUCH} disabled>
              Check access
            </Button>
          </div>
        ) : view.kind === "works" ? (
          <WorksLine
            line={view.line}
            detail={`Checked ${whenSince(view.checkedAt, now)}`}
            action={
              <Button variant="ghost" className={TOUCH} onClick={onCheck}>
                Check again
              </Button>
            }
          />
        ) : (
          <InlineAlert
            tone={view.tone}
            title={view.title}
            size={phone ? "touch" : "default"}
            actions={
              view.action.kind === "create-key" ? (
                <Button
                  variant="outline"
                  size={phone ? "touch" : "sm"}
                  disabled={creatingKey}
                  onClick={onCreateKey}
                >
                  {creatingKey ? "Creating key…" : view.action.label}
                </Button>
              ) : (
                <Button variant="outline" size={phone ? "touch" : "sm"} onClick={onCheck}>
                  {view.action.label}
                </Button>
              )
            }
          >
            {view.observed === null ? null : (
              <>
                {view.observed.by} answered <code>{trimStop(view.observed.text)}</code>.{" "}
              </>
            )}
            {view.advice}
            {createKeyFailed === null ? null : ` Creating the key failed: ${createKeyFailed}`}
          </InlineAlert>
        )}
      </div>
    </>
  );
}

/** GitHub's lines end in a full stop; the sentence around the quote adds its own. */
const trimStop = (line: string): string => line.trim().replace(/\.$/, "");

function YourComputer({
  access,
  now,
  phone,
}: {
  readonly access: GitAccessView;
  readonly now: Date;
  readonly phone: boolean;
}) {
  const bridge = access.bridge;
  // How long the page has waited: from when this section opened, whether by choosing it or by
  // coming back to the page with the mode already chosen.
  const [waitingSince] = useState(() => new Date());
  return (
    <>
      <SectionTitle>Connect your computer</SectionTitle>
      <CommandLineBlock phone={phone} />
      <p className="mt-4 text-prose text-pretty text-foreground max-lg:text-sm">
        On the computer that holds your SSH key, share the key and leave this command running.
      </p>
      <div className="mt-3">
        <CopyField
          value={SHARE_KEY_COMMAND}
          label="Copy command"
          size={phone ? "touch" : "default"}
        />
      </div>
      <div className="mt-6 border-t pt-5 lg:pt-6">
        {bridge.connected ? (
          <WorksLine
            line={`${bridge.clientName ?? "Your computer"} connected. Mend signs with its ssh-agent.`}
            detail={
              bridge.since === null ? "Connected" : `Connected ${whenSince(bridge.since, now)}`
            }
          />
        ) : (
          <p role="status" className="text-row text-muted-foreground max-lg:text-sm">
            Waiting for your computer to connect · {waitedFor(waitingSince, now)}
          </p>
        )}
      </div>
    </>
  );
}
