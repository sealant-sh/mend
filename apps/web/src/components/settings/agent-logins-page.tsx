import type {
  ConnectedAccount,
  GitAccessMode,
  GitAccessView,
  GitAuthorView,
} from "@mend/api-contracts";
import { gitAuthorIssue, normalizeGitAuthor } from "@mend/domain/workbench";
import { InlineAlert } from "@mend/ui/components/banner";
import { CopyField } from "@mend/ui/components/copy-field";
import { Segmented } from "@mend/ui/components/segmented";
import { Button } from "@mend/ui/components/ui/button";
import { Input } from "@mend/ui/components/ui/input";
import { Switch } from "@mend/ui/components/ui/switch";
import { toast } from "@mend/ui/components/ui/toast";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { InfoIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import {
  AGENT_FACTS,
  AGENTS,
  type Agent,
  agentLoginState,
  type AgentLoginState,
  arrivedToast,
  connectCommand,
  loginArrived,
  loginLine,
} from "#/lib/agent-login";
import {
  gitAccessOptions,
  GITHUB_SSH_KEYS_URL,
  type KeyCheckState,
  keyCheckView,
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

import {
  ApiKeyField,
  ConnectCommands,
  KeyConsoleLink,
  useApiKeySave,
} from "../agent-login-panels.tsx";
import { Overlay } from "../projects/overlay.tsx";
import { SettingRow, SettingSection } from "./setting-row.tsx";
import { SettingsPage } from "./settings-page.tsx";

/** A button's height: the frames' 32px on the desk, a 44px touch target on a phone. */
const CONTROL = "max-lg:h-11 max-lg:text-base";
const FIELD = "h-9 w-90 max-lg:h-11 max-lg:w-full max-lg:text-base";

/**
 * Settings → Account → Agent logins and Git (Doop "Settings · Account · Agent logins and Git"):
 * the logins the person's sessions use, who their commits name, the Mend key and which login gh
 * uses, and how sessions sign when they fetch and push. All of it is the person's own and applies
 * in every organization (docs/adr/0025). Logins are connected by a command the person runs on
 * their own computer, or with an API key; Mend's app takes no part in a provider's sign-in
 * (Yiannis, 17 Nov 2026). The route's loader read everything the page shows.
 */
export function AgentLoginsPage() {
  const trpc = useTRPC();
  // `mend connect` in a terminal sends the `user` event, which reads the logins again.
  useWorkbenchEvents();
  const identity = useSuspenseQuery(trpc.platform.sealantIdentity.queryOptions()).data;
  const now = useSecond();
  const phone = usePhone();
  return (
    <SettingsPage
      page="a-logins"
      intro="These are the logins your sessions use, and how they commit and push. They're saved to your account and apply in every organization you're in."
    >
      <p className="-mt-5 mb-7 flex items-center gap-1.5 text-row text-muted-foreground max-lg:px-4 [&_svg]:size-3.5">
        <InfoIcon aria-hidden />
        Switches save as soon as you change them. Text fields save when you click Save.
      </p>
      <SettingSection
        title="Agent logins"
        description="Mend keeps your subscriptions and API keys. Each message uses the login of the person who sent it."
      >
        {AGENTS.map((agent) => (
          <LoginRow
            key={agent}
            provider={agent}
            accounts={identity.accounts}
            apiKeys={identity.apiKeys}
            now={now}
            phone={phone}
          />
        ))}
        <SettingRow
          label="opencode"
          description="It uses your Claude Code and Codex logins."
          control={<span className="text-row text-muted-foreground">No login of its own</span>}
        />
        <SettingRow
          label="pi"
          description="It runs on your Codex login."
          control={<span className="text-row text-muted-foreground">No login of its own</span>}
        />
        <SelectedOnlyRow />
      </SettingSection>
      <SettingSection
        title="Git"
        description="This sets who your sessions commit as, how they push and fetch, and which GitHub login gh uses. Changes apply to sessions you start after you save."
      >
        <AuthorRows phone={phone} />
        <PublicKeyRow phone={phone} />
        <LoginRow
          provider="github"
          accounts={identity.accounts}
          apiKeys={false}
          now={now}
          phone={phone}
        />
      </SettingSection>
      <SettingSection
        title="Git access"
        description="How your sessions sign when they fetch and push. It applies in every project."
      >
        <GitAccessRows now={now} phone={phone} />
      </SettingSection>
    </SettingsPage>
  );
}

const PROVIDER_NAMES: Readonly<Record<ConnectedAccount["provider"], string>> = {
  claude: AGENT_FACTS.claude.name,
  codex: AGENT_FACTS.codex.name,
  github: "GitHub",
};

/**
 * One login: Claude Code, Codex, or GitHub's for gh. What it is, and Connect or Replace, which
 * open the dialog with the command to run; Disconnect removes it at once.
 */
function LoginRow({
  provider,
  accounts,
  apiKeys,
  now,
  phone,
}: {
  readonly provider: ConnectedAccount["provider"];
  readonly accounts: ReadonlyArray<ConnectedAccount>;
  readonly apiKeys: boolean;
  readonly now: Date;
  readonly phone: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const login = agentLoginState(accounts, provider);
  const name = PROVIDER_NAMES[provider];
  const disconnect = useMutation(
    trpc.platform.disconnectAccount.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries(trpc.platform.sealantIdentity.queryFilter());
        toast.add({ description: `Disconnected your ${name} login.`, priority: "low" });
      },
    }),
  );
  const label = provider === "github" ? "GitHub login for gh" : name;
  const opener =
    login.kind === "none"
      ? provider === "github"
        ? "Add login…"
        : "Connect…"
      : login.kind === "refused"
        ? "Reconnect…"
        : "Replace login…";
  return (
    <>
      <SettingRow
        layout="stack"
        label={label}
        description={loginLine(provider, login, (date) => whenSince(date, now))}
        note={
          disconnect.isError ? (
            <span role="alert" className="text-destructive">
              Mend didn't disconnect it. {requestFailure(disconnect.error)}
            </span>
          ) : null
        }
        control={
          <>
            {login.kind === "none" ? null : (
              <Button
                variant="ghost"
                className={CONTROL}
                disabled={disconnect.isPending}
                aria-label={`Disconnect your ${name} login`}
                onClick={() => disconnect.mutate({ id: login.account.id })}
              >
                {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
              </Button>
            )}
            <Button
              variant="outline"
              className={CONTROL}
              aria-label={
                login.kind === "none"
                  ? provider === "github"
                    ? "Add a GitHub login for gh"
                    : `Connect ${name}`
                  : login.kind === "refused"
                    ? `Reconnect ${name}`
                    : `Replace your ${name} login`
              }
              onClick={() => setOpen(true)}
            >
              {opener}
            </Button>
          </>
        }
      />
      {open ? (
        <LoginDialog
          provider={provider}
          login={login}
          apiKeys={apiKeys}
          now={now}
          phone={phone}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * Connect or replace a login: the commands to run on the person's computer and the wait for the
 * login to land, or, for Claude Code and Codex, an API key. It closes by itself once the login
 * arrives, with a toast saying whose it is.
 */
function LoginDialog({
  provider,
  login,
  apiKeys,
  now,
  phone,
  onClose,
}: {
  readonly provider: ConnectedAccount["provider"];
  readonly login: AgentLoginState;
  readonly apiKeys: boolean;
  readonly now: Date;
  readonly phone: boolean;
  readonly onClose: () => void;
}) {
  const [opened] = useState(() => ({ login, at: new Date() }));
  const openedAt = opened.at;
  const [mode, setMode] = useState<"command" | "key">("command");
  const formId = useId();
  const name = PROVIDER_NAMES[provider];
  const agent: Agent | null = provider === "github" ? null : provider;
  const announced = useRef(false);
  const announce = (words: string) => {
    if (announced.current) return;
    announced.current = true;
    toast.add({ description: words, priority: "low" });
    onClose();
  };
  const save = useApiKeySave(agent ?? "claude", () =>
    announce(
      agent === null
        ? `${name} is connected.`
        : `${AGENT_FACTS[agent].name} is connected with an ${AGENT_FACTS[agent].issuer} API key.`,
    ),
  );
  const arrived = login.kind === "connected" && loginArrived(login, opened) ? login.account : null;

  // The login lands from outside the page (a terminal on another computer, or the key just
  // saved): close, and say whose it is.
  useEffect(() => {
    if (arrived !== null) announce(arrivedToast(provider, arrived));
  });

  const replacing = login.kind !== "none";
  const title = replacing ? `Replace ${name} login` : `Connect ${name}`;
  const service = agent === null ? "GitHub" : AGENT_FACTS[agent].service;
  const command = provider === "github" ? "mend connect github" : connectCommand(provider);
  return (
    <Overlay
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="md"
      title={title}
      description={
        replacing
          ? `New ${provider === "github" ? "sessions" : `${name} sessions`} use the new login. Sessions that are already running keep the old one until they finish.`
          : provider === "github"
            ? "gh in your sessions uses this login, written into your own home in each workspace."
            : `${name} sessions run on this login. Each message you send uses it.`
      }
      footer={
        <>
          <Button variant="outline" className={CONTROL} onClick={onClose}>
            Cancel
          </Button>
          {mode === "key" && agent !== null ? (
            <Button
              type="submit"
              form={formId}
              className={CONTROL}
              disabled={save.key === "" || save.pending}
            >
              {save.pending ? "Saving…" : replacing ? "Replace login" : "Save key"}
            </Button>
          ) : null}
        </>
      }
    >
      {mode === "command" || agent === null ? (
        <>
          <p className="text-prose text-pretty text-foreground">
            {provider === "github" ? (
              <>
                On a computer where gh is signed in, sign Mend's command line in to this server
                once, then run the second command. It sends gh's login to Mend.
              </>
            ) : (
              <>
                On your computer, sign Mend's command line in to this server once, then run the
                second command. It opens {service}'s sign-in in your browser and passes the login to
                Mend when you finish.
              </>
            )}
          </p>
          <ConnectCommands command={command} phone={phone} />
          <div className="grid gap-3 border-t pt-4">
            <p role="status" className="text-row text-muted-foreground">
              Waiting for {name} to connect · {waitedFor(openedAt, now)}
            </p>
            {agent !== null && apiKeys ? (
              <p className="text-row text-muted-foreground">
                {phone ? "No computer with you? " : null}
                <Button
                  variant="link"
                  className="h-auto p-0 text-row"
                  onClick={() => setMode("key")}
                >
                  Use an API key instead
                </Button>
              </p>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <ApiKeyField
            agent={agent}
            save={save}
            phone={phone}
            now={now}
            focus
            formId={formId}
            help={
              <>
                Mend checks the key with {AGENT_FACTS[agent].issuer} before saving it. After that,
                nobody can read it back, you included. Create a key in{" "}
                <KeyConsoleLink agent={agent} />.
              </>
            }
          />
          <p className="text-row">
            <Button
              variant="link"
              className="h-auto p-0 text-row"
              onClick={() => setMode("command")}
            >
              Run a command instead
            </Button>
          </p>
        </>
      )}
    </Overlay>
  );
}

/**
 * Whether a Claude Code session also gets the person's Codex login and a Codex session their
 * Claude Code login (off, the default), or only its own agent's. Saved as it is switched; a
 * failure puts the switch back and says so.
 */
function SelectedOnlyRow() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const setting = useSuspenseQuery(trpc.platform.agentLogins.queryOptions()).data;
  const save = useMutation(
    trpc.platform.setAgentLogins.mutationOptions({
      onSuccess: (saved) => queryClient.setQueryData(trpc.platform.agentLogins.queryKey(), saved),
    }),
  );
  const id = useId();
  const checked = save.isPending ? save.variables.selectedOnly : setting.selectedOnly;
  return (
    <SettingRow
      label="Selected agent's login only"
      labelFor={id}
      description="When this is off, a Claude Code session also gets your Codex login, so the agent can run codex as you. Codex sessions get your Claude Code login the same way."
      note={
        save.isError ? (
          <span role="alert" className="text-destructive">
            {requestFailure(save.error)} This wasn't saved, so the switch is back to{" "}
            {setting.selectedOnly ? "On" : "Off"}.{" "}
            <button
              type="button"
              className="font-medium text-info underline-offset-2 hover:underline"
              onClick={() => save.mutate(save.variables)}
            >
              Try again
            </button>
          </span>
        ) : null
      }
      control={
        <Switch
          id={id}
          aria-label="Selected agent's login only"
          checked={checked}
          disabled={save.isPending}
          onCheckedChange={(selectedOnly) => save.mutate({ ...setting, selectedOnly })}
        />
      }
    />
  );
}

/**
 * The name and email the person's commits carry. Edited as a pair and saved with Save; Discard
 * puts the saved pair back. A value that git can't store is refused before anything is sent.
 * When the person saved their own, "Use my account's" returns to the account's name and email.
 */
function AuthorRows({ phone }: { readonly phone: boolean }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const saved = useSuspenseQuery(trpc.git.author.queryOptions()).data;
  const [draft, setDraft] = useState<{ readonly name: string; readonly email: string } | null>(
    null,
  );
  const [said, setSaid] = useState<string | null>(null);
  const keep = (view: GitAuthorView) => queryClient.setQueryData(trpc.git.author.queryKey(), view);
  const save = useMutation(
    trpc.git.setAuthor.mutationOptions({
      onSuccess: (view) => {
        keep(view);
        setDraft(null);
        setSaid("Saved. Sessions you start from now on commit as this.");
      },
    }),
  );
  const clear = useMutation(
    trpc.git.clearAuthor.mutationOptions({
      onSuccess: (view) => {
        keep(view);
        setDraft(null);
        setSaid("Your commits use your account's name and email again.");
      },
    }),
  );
  const shown = draft ?? saved;
  const normalized = normalizeGitAuthor(shown);
  const dirty = normalized.name !== saved.name || normalized.email !== saved.email;
  const issue = dirty ? gitAuthorIssue(normalized) : null;
  const nameId = useId();
  const emailId = useId();
  const from = saved.source === "account" ? "This comes from your account." : "You set this.";
  const edit = (next: { readonly name: string; readonly email: string }) => {
    setDraft(next);
    setSaid(null);
    save.reset();
  };
  return (
    <>
      <SettingRow
        layout="stack"
        label="Author name"
        labelFor={nameId}
        description={
          draft !== null && normalized.name !== saved.name
            ? `It was ${saved.name}.`
            : `${from} A .gitconfig in your dotfiles still overrides it.`
        }
        control={
          <Input
            id={nameId}
            value={shown.name}
            autoComplete="name"
            spellCheck={false}
            className={FIELD}
            onChange={(event) => edit({ ...shown, name: event.target.value })}
          />
        }
      />
      <SettingRow
        layout="stack"
        label="Author email"
        labelFor={emailId}
        description={
          draft !== null && normalized.email !== saved.email ? `It was ${saved.email}.` : from
        }
        note={
          dirty ? null : (
            <>
              {said === null ? null : (
                <span role="status" className="block text-muted-foreground">
                  {said}
                </span>
              )}
              {saved.source === "setting" ? (
                <Button
                  variant="link"
                  className="h-auto p-0 text-row"
                  disabled={clear.isPending}
                  onClick={() => clear.mutate()}
                >
                  {clear.isPending ? "Saving…" : "Use my account's name and email"}
                </Button>
              ) : null}
              {clear.isError ? (
                <span role="alert" className="block text-destructive">
                  Mend didn't save this. {requestFailure(clear.error)}
                </span>
              ) : null}
            </>
          )
        }
        control={
          <Input
            id={emailId}
            type="email"
            value={shown.email}
            autoComplete="email"
            spellCheck={false}
            className={FIELD}
            onChange={(event) => edit({ ...shown, email: event.target.value })}
          />
        }
      />
      {dirty ? (
        <SettingRow
          layout={phone ? "stack" : "row"}
          label="Unsaved changes"
          description={
            issue !== null
              ? `Mend can't save this: ${issue}.`
              : save.isError
                ? `Mend didn't save it. ${requestFailure(save.error)}`
                : undefined
          }
          control={
            <>
              <Button
                variant="outline"
                className={CONTROL}
                disabled={save.isPending}
                onClick={() => {
                  setDraft(null);
                  save.reset();
                }}
              >
                Discard
              </Button>
              <Button
                className={CONTROL}
                disabled={issue !== null || save.isPending}
                onClick={() => save.mutate(normalized)}
              >
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            </>
          }
        />
      ) : null}
    </>
  );
}

/** The person's Mend key, to copy into GitHub; Create key when they have none yet. */
function PublicKeyRow({ phone }: { readonly phone: boolean }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const access = useSuspenseQuery(gitAccessOptions(trpc)).data;
  const create = useMutation(
    trpc.git.initKey.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries(gitAccessOptions(trpc)),
    }),
  );
  const publicKey = access.key.publicKey;
  const description = (
    <>
      Add it to the SSH keys on your{" "}
      <a
        href={GITHUB_SSH_KEYS_URL}
        target="_blank"
        rel="noreferrer"
        className="text-info underline-offset-4 hover:underline"
      >
        GitHub account
      </a>{" "}
      once. Mend keeps the private key, so you can push from detached sessions and from your phone.
    </>
  );
  return (
    <SettingRow
      layout="stack"
      label="Your public SSH key"
      description={publicKey === null ? "You don't have a Mend key yet." : description}
      note={
        create.isError ? (
          <span role="alert" className="text-destructive">
            Mend didn't create the key. {requestFailure(create.error)}
          </span>
        ) : null
      }
      control={
        publicKey === null ? (
          <Button
            variant="outline"
            className={CONTROL}
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Creating key…" : "Create key"}
          </Button>
        ) : (
          <CopyField
            value={publicKey}
            label="Copy public key"
            size={phone ? "touch" : "default"}
            className="w-90 max-lg:w-full [&_p]:truncate"
          />
        )
      }
    />
  );
}

const MODE_OPTIONS: ReadonlyArray<{ readonly value: GitAccessMode; readonly label: string }> = [
  { value: "mend-key", label: "Mend key" },
  { value: "bridge", label: "Your computer's key" },
];

/**
 * The Git access mode, which is the person's alone and applies in every project (D11): a Mend
 * key, checked against GitHub here, or their computer's key, shared by `mend keys share`.
 */
function GitAccessRows({ now, phone }: { readonly now: Date; readonly phone: boolean }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const access = useSuspenseQuery(gitAccessOptions(trpc)).data;
  const setAccess = useMutation(
    trpc.git.setAccess.mutationOptions({
      onSuccess: (view) => queryClient.setQueryData(gitAccessOptions(trpc).queryKey, view),
    }),
  );
  const mode = setAccess.isPending ? setAccess.variables.mode : access.mode;
  return (
    <>
      <SettingRow
        layout="stack"
        label="Git access"
        description="With the Mend key, sessions keep pushing when your laptop is closed, and you can push from your phone. With your computer's key, Mend uses the ssh-agent on your computer, so sessions can only push while mend is running there."
        note={
          setAccess.isError ? (
            <span role="alert" className="text-destructive">
              {requestFailure(setAccess.error)} This wasn't saved: Mend still uses{" "}
              {modeInSentence(access.mode)}.{" "}
              <button
                type="button"
                className="font-medium text-info underline-offset-2 hover:underline"
                onClick={() => setAccess.mutate(setAccess.variables)}
              >
                Try again
              </button>
            </span>
          ) : null
        }
        control={
          <Segmented
            aria-label="How your sessions sign"
            value={mode}
            options={MODE_OPTIONS}
            disabled={setAccess.isPending}
            size={phone ? "touch" : "default"}
            // Each choice as wide as its words on the desk; halves of the width on a phone.
            className="max-lg:w-full lg:[&_[data-slot=segmented-item]]:flex-auto"
            onValueChange={(next) => setAccess.mutate({ mode: next })}
          />
        }
      />
      {access.mode === "mend-key" ? (
        <KeyCheckRow access={access} now={now} phone={phone} />
      ) : (
        <ComputerRow access={access} now={now} phone={phone} />
      )}
    </>
  );
}

/** Asks GitHub whether it accepts the Mend key (`git.checkKey`), and shows its answer. */
function KeyCheckRow({
  access,
  now,
  phone,
}: {
  readonly access: GitAccessView;
  readonly now: Date;
  readonly phone: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
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
  const view = keyCheckView(check);
  const description: ReactNode =
    view.kind === "ask"
      ? access.key.publicKey === null
        ? "Create your Mend key above, add it to GitHub, then check it."
        : "Check that GitHub accepts your Mend key."
      : view.kind === "checking"
        ? `Checking the key with GitHub · ${waitedFor(view.since, now)}`
        : view.kind === "works"
          ? `${view.line} Checked ${whenSince(view.checkedAt, now)}.`
          : undefined;
  return (
    <SettingRow
      layout="stack"
      label="Last check"
      description={description}
      note={
        view.kind === "problem" ? (
          <InlineAlert
            tone={view.tone}
            title={view.title}
            size={phone ? "touch" : "default"}
            className="mt-2"
            actions={
              view.action.kind === "create-key" ? (
                <Button
                  variant="outline"
                  size={phone ? "touch" : "sm"}
                  disabled={initKey.isPending}
                  onClick={() => initKey.mutate()}
                >
                  {initKey.isPending ? "Creating key…" : view.action.label}
                </Button>
              ) : null
            }
          >
            {view.observed === null ? null : (
              <>
                {view.observed.by} answered{" "}
                <code>{view.observed.text.trim().replace(/\.$/, "")}</code>.{" "}
              </>
            )}
            {view.advice}
            {initKey.isError ? ` Creating the key failed: ${requestFailure(initKey.error)}` : null}
          </InlineAlert>
        ) : null
      }
      control={
        <Button
          variant="outline"
          className={CONTROL}
          disabled={checkKey.isPending}
          onClick={() => checkKey.mutate()}
        >
          {view.kind === "ask" ? "Check access" : "Check again"}
        </Button>
      }
    />
  );
}

/** With the computer's key: the commands that share it, and whether a computer is connected. */
function ComputerRow({
  access,
  now,
  phone,
}: {
  readonly access: GitAccessView;
  readonly now: Date;
  readonly phone: boolean;
}) {
  const bridge = access.bridge;
  return (
    <SettingRow
      label="Your computer"
      description={
        bridge.connected
          ? `${bridge.clientName ?? "Your computer"} is connected. Mend signs with its ssh-agent${bridge.since === null ? "" : `, connected ${whenSince(bridge.since, now)}`}.`
          : "No computer is connected, so sessions can't fetch or push. On the computer that holds your SSH key, sign Mend's command line in to this server once, then share the key and leave that command running."
      }
      note={
        bridge.connected ? null : (
          <div className="mt-2 max-w-xl">
            <ConnectCommands command={SHARE_KEY_COMMAND} phone={phone} />
          </div>
        )
      }
    />
  );
}
