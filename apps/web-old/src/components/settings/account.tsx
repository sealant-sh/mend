import type { ConnectLogin } from "@mend/api-contracts";
import {
  CREDENTIAL_PROVIDER_LABELS,
  loginChoiceOf,
  unchosenLoginSummary,
} from "@mend/domain/default-login";
import { keyDisconnectWords, keyRefusedWords, loginWords } from "@mend/domain/workbench";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Button, IconButton } from "#/components/kit/button";
import { Menu, MenuItem } from "#/components/kit/menu";
import { Panel, SettingsSection } from "#/components/kit/section";
import { Segment } from "#/components/kit/segment";
import { ErrorNote, errorText, StatusWord, type Tone } from "#/components/kit/status";
import { SwitchRow } from "#/components/kit/switch";
import { DataTable } from "#/components/kit/table";
import { forgetSignedInPerson } from "#/components/session-message-input";
import type { AgentLoginsDto, ConnectedAccountDto, ConnectedAccountProviderDto } from "#/lib/api";
import { authClient } from "#/lib/auth-client";
import { fieldWriter } from "#/lib/optimistic";
import { setThemePreference, useThemePreference, type ThemePreference } from "#/lib/theme";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

import { LoginDialog, PROVIDER_LOGINS, type LoginTarget } from "./account-login-dialog.tsx";
import { PersonBoatKeySection } from "./boat-key.tsx";

/**
 * Settings · You · Account: how Mend looks, the person's own agent logins, their own Boat key in
 * the active organization, and Sign out.
 */
export function AccountSettings() {
  return (
    <Panel>
      <AppearanceSection />
      <AgentLoginsSection />
      <PersonBoatKeySection />
      <SignOutSection />
    </Panel>
  );
}

const THEME_OPTIONS: ReadonlyArray<{ readonly value: ThemePreference; readonly label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Light and dark are one structure (DESIGN.md §1); System tracks the OS live. Kept per browser. */
function AppearanceSection() {
  const preference = useThemePreference();
  return (
    <SettingsSection title="Appearance" why="Follows your system unless you pick one.">
      <Segment
        label="Appearance"
        value={preference}
        onChange={setThemePreference}
        options={THEME_OPTIONS}
      />
    </SettingsSection>
  );
}

const PROVIDERS: ReadonlyArray<ConnectedAccountProviderDto> = ["claude", "codex", "github"];

const isKey = (account: ConnectedAccountDto) => account.login?.kind === "api-key";

/**
 * The one line a row shows about a login: the platform's non-secret metadata, and with `classes`
 * the login's class in ADR 0018's words. A provider names classes only once one of its logins is a
 * key, so a person with only subscriptions sees the line they always have.
 */
export const loginHint = (account: ConnectedAccountDto, classes: boolean): string => {
  const meta = account.metadata;
  const pick = (key: string) => {
    const value = meta[key];
    return typeof value === "string" ? value : null;
  };
  const identity = pick("login") ?? pick("email") ?? pick("accountEmail") ?? pick("accountId");
  const suffix = isKey(account) ? null : pick("tokenSuffix");
  const refused =
    account.status !== "invalid"
      ? null
      : isKey(account) && account.provider !== "github"
        ? `${keyRefusedWords(account.provider)} · replace the key`
        : "refused by the provider · replace it";
  const parts = [
    classes && account.login !== undefined
      ? loginWords(account.provider, account.login, "added-it")
      : null,
    identity,
    suffix === null ? null : `…${suffix}`,
    refused,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? account.kind : parts.join(" · ");
};

interface LoginRow {
  readonly key: string;
  readonly tone: Tone;
  readonly hint: string;
  /** The login this row shows; null when the provider has none, or none is chosen. */
  readonly account: ConnectedAccountDto | null;
  /** Logins of this agent none of which is chosen, and what to do about it. */
  readonly unchosen: {
    readonly accounts: ReadonlyArray<ConnectedAccountDto>;
    readonly remedy: string;
  } | null;
  /** What Replace or Connect on this row opens. */
  readonly target: LoginTarget;
  /** The class of login the provider lacks, offered under the table. */
  readonly addable: { readonly label: string; readonly target: LoginTarget } | null;
}

/**
 * A provider's rows: its default, and once it holds a key every login it holds, the default first
 * and marked (ADR 0018 decisions 1 and 5), or one row saying none is connected or chosen. With
 * `apiKeys`, a Claude or Codex provider offers the class it lacks: a key beside a subscription, or
 * the other way round.
 */
export const loginRowsOf = (
  provider: ConnectedAccountProviderDto,
  accounts: ReadonlyArray<ConnectedAccountDto>,
  apiKeys: boolean,
): ReadonlyArray<LoginRow> => {
  const choice = loginChoiceOf(accounts, provider);
  const fresh: LoginTarget = { provider, replacing: null, login: null, otherDefault: null };
  switch (choice._tag) {
    case "none":
      return [
        {
          key: provider,
          tone: "off",
          hint: "not connected",
          account: null,
          unchosen: null,
          target: fresh,
          addable: null,
        },
      ];
    case "unchosen": {
      const summary = unchosenLoginSummary(provider, choice.accounts.length);
      return [
        {
          key: provider,
          tone: "wait",
          hint: summary.words,
          account: null,
          unchosen: { accounts: choice.accounts, remedy: summary.remedy },
          target: fresh,
          addable: null,
        },
      ];
    }
    case "chosen": {
      const chosen = choice.account;
      const held = [
        chosen,
        ...accounts.filter(
          (account) =>
            account.provider === provider &&
            account.status !== "archived" &&
            account.id !== chosen.id,
        ),
      ];
      const classes = held.some(isKey);
      const shown = classes ? held : [chosen];
      const missing: { readonly login: ConnectLogin; readonly label: string } | null =
        !apiKeys || provider === "github"
          ? null
          : !classes
            ? { login: "api-key", label: `Add a ${CREDENTIAL_PROVIDER_LABELS[provider]} API key` }
            : held.some((account) => account.login?.kind === "subscription")
              ? null
              : {
                  login: "subscription",
                  label: `Add a ${CREDENTIAL_PROVIDER_LABELS[provider]} subscription`,
                };
      return shown.map((account) => ({
        key: account.id,
        tone: account.status === "active" ? "ok" : "wait",
        hint:
          shown.length > 1 && account === chosen
            ? `${loginHint(account, classes)} · default`
            : loginHint(account, classes),
        account,
        unchosen: null,
        target: {
          provider,
          replacing: account,
          login: account.login?.kind ?? null,
          otherDefault: account === chosen ? null : chosen,
        },
        addable:
          missing === null || account !== chosen
            ? null
            : {
                label: missing.label,
                target: { provider, replacing: null, login: missing.login, otherDefault: chosen },
              },
      }));
    }
  }
};

/** What a row's Disconnect is called: a key by its class, anything else as the login. */
const loginNoun = (account: ConnectedAccountDto) => (isKey(account) ? "API key" : "login");

/**
 * The signed-in person's own agent logins (docs/SEALANT-IDENTITY.md). Each person connects their
 * own; the login goes to the platform under their Sealant user and is never shown again.
 */
export function AgentLoginsSection() {
  const trpc = useTRPC();
  const identity = useSuspenseQuery(trpc.platform.sealantIdentity.queryOptions()).data;
  const [target, setTarget] = useState<LoginTarget | null>(null);
  const disconnect = useMutation(
    trpc.platform.disconnectAccount.mutationOptions({
      onSuccess: (_removed, _variables, _result, { client }) =>
        client.invalidateQueries(trpc.platform.sealantIdentity.queryFilter()),
    }),
  );
  const rows = PROVIDERS.flatMap((provider) =>
    loginRowsOf(provider, identity.accounts, identity.apiKeys).map((row) => ({ provider, row })),
  );
  const remedies = rows.flatMap(({ row }) => (row.unchosen === null ? [] : [row.unchosen.remedy]));
  const additions = rows.flatMap(({ row }) => (row.addable === null ? [] : [row.addable]));
  const disconnecting = (account: ConnectedAccountDto) =>
    disconnect.isPending && disconnect.variables.id === account.id;
  const removed = disconnect.data;

  return (
    <SettingsSection
      title="Agent logins"
      why="Your own subscriptions and API keys. Each turn spends the default login of whoever sent it."
    >
      <DataTable
        label="Agent logins"
        columns={[
          { head: "Agent", width: "0.8fr" },
          { head: "Login", width: "1.6fr" },
          { head: "", width: "auto" },
        ]}
        rows={rows.map(({ provider, row }) => {
          const label = PROVIDER_LOGINS[provider].label;
          const removable = row.account === null ? (row.unchosen?.accounts ?? []) : [row.account];
          const noun = row.account === null ? "login" : loginNoun(row.account);
          return {
            key: row.key,
            cells: [
              <StatusWord key="agent" tone={row.tone} className="text-[12px] text-ink-2">
                {label}
              </StatusWord>,
              <span key="login" className="font-mono text-[12px] text-ink-2">
                {removable.some(disconnecting) ? "disconnecting…" : row.hint}
              </span>,
              <span key="actions" className="flex items-center justify-end gap-0.5">
                <Button
                  size="sm"
                  variant={row.account === null ? "default" : "ghost"}
                  aria-label={`${row.account === null ? "Connect" : "Replace"} your ${label} ${noun}`}
                  onClick={() => {
                    disconnect.reset();
                    setTarget(row.target);
                  }}
                >
                  {row.account === null ? "Connect" : "Replace"}
                </Button>
                {removable.length === 0 ? null : (
                  <Menu
                    align="end"
                    trigger={
                      <IconButton icon="more" size="sm" label={`More for your ${label} ${noun}`} />
                    }
                  >
                    {removable.map((account) => (
                      <MenuItem
                        key={account.id}
                        disabled={disconnect.isPending}
                        onClick={() => disconnect.mutate({ id: account.id })}
                      >
                        {row.account === null
                          ? `Disconnect ${account.name} · ${loginHint(account, false)}`
                          : `Disconnect your ${label} ${noun}`}
                      </MenuItem>
                    ))}
                  </Menu>
                )}
              </span>,
            ],
          };
        })}
      />
      {additions.length === 0 ? null : (
        <div className="mt-2 flex flex-wrap gap-1 px-2.5">
          {additions.map((addition) => (
            <Button
              key={addition.label}
              size="sm"
              variant="ghost"
              onClick={() => {
                disconnect.reset();
                setTarget(addition.target);
              }}
            >
              {addition.label}
            </Button>
          ))}
        </div>
      )}
      {remedies.map((remedy) => (
        <p key={remedy} className="mt-2 px-4 text-[12.5px] text-muted-foreground">
          {remedy}
        </p>
      ))}
      {removed?.login?.kind !== "api-key" || removed.provider === "github" ? null : (
        <p role="status" className="mt-2 px-4 text-[12.5px] text-muted-foreground">
          {`Disconnected your ${PROVIDER_LOGINS[removed.provider].label} API key ····${removed.login.suffix}. ${keyDisconnectWords(removed.provider)}`}
        </p>
      )}
      {disconnect.error === null ? null : (
        <ErrorNote className="mt-3">{errorText(disconnect.error)}</ErrorNote>
      )}
      <p className="mt-2 px-4 font-mono text-[11px] text-faint">
        platform user {identity.sealantUserId} · logins go straight to Sealant, not kept by Mend
      </p>
      <div className="mt-3">
        <AgentLoginsSwitch />
      </div>
      <LoginDialog target={target} apiKeys={identity.apiKeys} onClose={() => setTarget(null)} />
    </SettingsSection>
  );
}

/**
 * Which of the person's own logins their Claude and Codex sessions receive (docs/adr/0016,
 * decision 5): every connected one by default, so a Claude session can run `codex` on the same
 * person's login; on, only the session's own agent's.
 */
/** The agent-logins switch, flipped again before the last flip answered. */
const agentLoginsWriter = fieldWriter<AgentLoginsDto>((_server, saved) => saved);

function AgentLoginsSwitch() {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const server = useSuspenseQuery(trpc.platform.agentLogins.queryOptions()).data;
  const setting = agentLoginsWriter.useVisible(server) ?? server;
  const save = useMutation(
    agentLoginsWriter.options({
      queryClient,
      documentKey: trpc.platform.agentLogins.queryKey(),
      mutationKey: trpc.platform.setAgentLogins.mutationKey(),
      send: (patch, latest) => client.platform.setAgentLogins.mutate({ ...latest, ...patch }),
    }),
  );
  return (
    <>
      <SwitchRow
        label="Give my sessions only the selected agent's login"
        checked={setting.selectedOnly}
        onCheckedChange={(selectedOnly) => save.mutate({ selectedOnly })}
      />
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">
        Off: a Claude session also gets your Codex login and a Codex session your Claude login, so
        the agent can run <code className="font-mono text-[11.5px]">codex</code> or{" "}
        <code className="font-mono text-[11.5px]">claude</code> as you. Only ever yours. Shells, pi
        and opencode get every login you connected either way. A change applies the next time your
        logins are written into a workspace.
      </p>
      {save.error === null ? null : (
        <ErrorNote className="mt-2">
          {`Not saved, the switch is back where it was · ${errorText(save.error)}`}
        </ErrorNote>
      )}
    </>
  );
}

/** Signs this browser out; sessions keep running. The same walk as the rail's person menu. */
function SignOutSection() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const signOut = useMutation({
    mutationFn: async () => {
      const result = await authClient.signOut();
      if (result.error !== null) throw new Error(result.error.message ?? "Could not sign out.");
      forgetSignedInPerson(queryClient);
      await navigate({ to: "/login" });
    },
  });
  return (
    <SettingsSection title="Sign out" why="Signs this browser out. Your sessions keep running.">
      <Button size="sm" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
        {signOut.isPending ? "Signing out…" : "Sign out"}
      </Button>
      {signOut.error === null ? null : (
        <ErrorNote className="mt-3">{errorText(signOut.error)}</ErrorNote>
      )}
    </SettingsSection>
  );
}
