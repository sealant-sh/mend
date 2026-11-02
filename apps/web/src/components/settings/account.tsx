import { type LoginChoice, loginChoiceOf, unchosenLoginSummary } from "@mend/domain/default-login";
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

/** Settings · You · Account: how Mend looks, the person's own agent logins, and Sign out. */
export function AccountSettings() {
  return (
    <Panel>
      <AppearanceSection />
      <AgentLoginsSection />
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

/** The one line a row shows about a login: the platform's non-secret metadata. */
export const loginHint = (account: ConnectedAccountDto): string => {
  const meta = account.metadata;
  const pick = (key: string) => (typeof meta[key] === "string" ? String(meta[key]) : null);
  const identity = pick("login") ?? pick("email") ?? pick("accountEmail") ?? pick("accountId");
  const suffix = pick("tokenSuffix");
  const parts = [
    identity,
    suffix === null ? null : `…${suffix}`,
    account.status === "invalid" ? "refused by the provider · replace it" : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? account.kind : parts.join(" · ");
};

interface LoginRow {
  readonly tone: Tone;
  readonly hint: string;
  readonly chosen: ConnectedAccountDto | null;
  /** Logins of this agent none of which is chosen, and what to do about it. */
  readonly unchosen: {
    readonly accounts: ReadonlyArray<ConnectedAccountDto>;
    readonly remedy: string;
  } | null;
}

export const loginRowOf = (
  provider: ConnectedAccountProviderDto,
  choice: LoginChoice<ConnectedAccountDto>,
): LoginRow => {
  switch (choice._tag) {
    case "chosen":
      return {
        tone: choice.account.status === "active" ? "ok" : "wait",
        hint: loginHint(choice.account),
        chosen: choice.account,
        unchosen: null,
      };
    case "unchosen": {
      const summary = unchosenLoginSummary(provider, choice.accounts.length);
      return {
        tone: "wait",
        hint: summary.words,
        chosen: null,
        unchosen: { accounts: choice.accounts, remedy: summary.remedy },
      };
    }
    case "none":
      return { tone: "off", hint: "not connected", chosen: null, unchosen: null };
  }
};

/**
 * The signed-in person's own agent logins (docs/SEALANT-IDENTITY.md). Each person connects their
 * own; the login goes to the platform under their Sealant user and is never shown again.
 */
function AgentLoginsSection() {
  const trpc = useTRPC();
  const identity = useSuspenseQuery(trpc.platform.sealantIdentity.queryOptions()).data;
  const [target, setTarget] = useState<LoginTarget | null>(null);
  const disconnect = useMutation(
    trpc.platform.disconnectAccount.mutationOptions({
      onSuccess: (_removed, _variables, _result, { client }) =>
        client.invalidateQueries(trpc.platform.sealantIdentity.queryFilter()),
    }),
  );
  const rows = PROVIDERS.map((provider) => ({
    provider,
    row: loginRowOf(provider, loginChoiceOf(identity.accounts, provider)),
  }));
  const remedies = rows.flatMap(({ row }) => (row.unchosen === null ? [] : [row.unchosen.remedy]));
  const disconnecting = (account: ConnectedAccountDto) =>
    disconnect.isPending && disconnect.variables.id === account.id;

  return (
    <SettingsSection
      title="Agent logins"
      why="Your own subscriptions. Each turn spends the login of whoever sent it."
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
          const removable = row.chosen === null ? (row.unchosen?.accounts ?? []) : [row.chosen];
          return {
            key: provider,
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
                  variant={row.chosen === null ? "default" : "ghost"}
                  aria-label={`${row.chosen === null ? "Connect" : "Replace"} your ${label} login`}
                  onClick={() => {
                    disconnect.reset();
                    setTarget({ provider, replacing: row.chosen });
                  }}
                >
                  {row.chosen === null ? "Connect" : "Replace"}
                </Button>
                {removable.length === 0 ? null : (
                  <Menu
                    align="end"
                    trigger={
                      <IconButton icon="more" size="sm" label={`More for your ${label} login`} />
                    }
                  >
                    {removable.map((account) => (
                      <MenuItem
                        key={account.id}
                        disabled={disconnect.isPending}
                        onClick={() => disconnect.mutate({ id: account.id })}
                      >
                        {row.chosen === null
                          ? `Disconnect ${account.name} · ${loginHint(account)}`
                          : `Disconnect your ${label} login`}
                      </MenuItem>
                    ))}
                  </Menu>
                )}
              </span>,
            ],
          };
        })}
      />
      {remedies.map((remedy) => (
        <p key={remedy} className="mt-2 px-4 text-[12.5px] text-muted-foreground">
          {remedy}
        </p>
      ))}
      {disconnect.error === null ? null : (
        <ErrorNote className="mt-3">{errorText(disconnect.error)}</ErrorNote>
      )}
      <p className="mt-2 px-4 font-mono text-[11px] text-faint">
        platform user {identity.sealantUserId} · logins go straight to Sealant, not kept by Mend
      </p>
      <div className="mt-3">
        <AgentLoginsSwitch />
      </div>
      <LoginDialog target={target} onClose={() => setTarget(null)} />
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
