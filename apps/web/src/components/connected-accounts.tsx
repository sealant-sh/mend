import { type LoginChoice, loginChoiceOf, unchosenLoginSummary } from "@mend/domain/default-login";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";

import {
  connectAccount,
  type ConnectedAccountDto,
  type ConnectedAccountProviderDto,
  disconnectAccount,
  setAgentLogins,
} from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

const PROVIDERS: ReadonlyArray<{
  readonly provider: ConnectedAccountProviderDto;
  readonly label: string;
  readonly detail: string;
  readonly placeholder: string;
  readonly multiline: boolean;
}> = [
  {
    provider: "claude",
    label: "Claude",
    detail:
      "What `mend claude` and Mend's own reads of a change run on. Paste a setup token from `claude setup-token`, or the contents of ~/.claude/.credentials.json.",
    placeholder: 'sk-ant-oat01-…  or  { "claudeAiOauth": { … } }',
    multiline: true,
  },
  {
    provider: "codex",
    label: "Codex",
    detail:
      "What `mend codex` runs on. Paste the contents of ~/.codex/auth.json from a machine where `codex login` has run.",
    placeholder: '{ "OPENAI_API_KEY": null, "tokens": { … } }',
    multiline: true,
  },
  {
    provider: "github",
    label: "GitHub",
    // docs/adr/0016, decisions 4 and 5, and Known limits: written per person, no token in the env.
    detail:
      "In a per-person workspace, your processes use your own GitHub login, written into your own home (~/.config/gh/hosts.yml) and never into anyone else's. There is no GITHUB_TOKEN in the environment there: a command that needs one uses GITHUB_TOKEN=$(/run/mend/bin/mend-git-credential token). In a shared workspace, `gh` reads it as GH_TOKEN. Paste the output of `gh auth token`.",
    placeholder: "gho_…",
    multiline: false,
  },
];

/** The one line the row shows about an account: the platform's non-secret metadata. */
const accountHint = (account: ConnectedAccountDto): string => {
  const meta = account.metadata;
  const pick = (key: string) => (typeof meta[key] === "string" ? String(meta[key]) : null);
  const identity = pick("login") ?? pick("email") ?? pick("accountEmail") ?? pick("accountId");
  const suffix = pick("tokenSuffix");
  const parts = [
    identity,
    suffix === null ? null : `…${suffix}`,
    account.status === "invalid" ? "rejected by the provider — reconnect" : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? account.kind : parts.join(" · ");
};

interface RowView {
  readonly dot: string;
  readonly hint: string;
  readonly chosen: ConnectedAccountDto | null;
  readonly unchosen: {
    readonly accounts: ReadonlyArray<ConnectedAccountDto>;
    readonly remedy: string;
  } | null;
}

const rowViewOf = (
  provider: ConnectedAccountProviderDto,
  choice: LoginChoice<ConnectedAccountDto>,
): RowView => {
  switch (choice._tag) {
    case "chosen":
      return {
        dot: choice.account.status === "active" ? "bg-success-dot" : "bg-[var(--sw-amber)]",
        hint: accountHint(choice.account),
        chosen: choice.account,
        unchosen: null,
      };
    case "unchosen": {
      const summary = unchosenLoginSummary(provider, choice.accounts.length);
      return {
        dot: "bg-[var(--sw-amber)]",
        hint: summary.words,
        chosen: null,
        unchosen: { accounts: choice.accounts, remedy: summary.remedy },
      };
    }
    case "none":
      return {
        dot: "bg-[var(--sw-faint-rule)]",
        hint: "not connected",
        chosen: null,
        unchosen: null,
      };
  }
};

/**
 * The signed-in user's own provider accounts (docs/SEALANT-IDENTITY.md). Each
 * person connects their own subscription; the credential goes to the platform
 * under their Sealant user and is never shown again.
 */
export function ConnectedAccountsPanel() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const identity = useSuspenseQuery(trpc.platform.sealantIdentity.queryOptions()).data;
  const [editing, setEditing] = useState<ConnectedAccountProviderDto | null>(null);
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState<ConnectedAccountProviderDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries(trpc.platform.sealantIdentity.queryFilter());
  const submit = (provider: ConnectedAccountProviderDto, chosen: ConnectedAccountDto | null) => {
    const value = secret.trim();
    if (value === "") return;
    setPending(provider);
    setError(null);
    void connectAccount({
      provider,
      secret: value,
      ...(chosen === null ? {} : { accountId: chosen.id }),
    })
      .then(() => {
        setEditing(null);
        setSecret("");
        return refresh();
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(null));
  };
  const disconnect = (account: ConnectedAccountDto) => {
    setPending(account.provider);
    setError(null);
    void disconnectAccount(account.id)
      .then(() => refresh())
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(null));
  };

  return (
    <section id="accounts" className="rounded-2xl bg-panel p-6 shadow-[var(--shadow-sm)]">
      <h2 className="font-sans text-sm font-semibold">Connected accounts</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        Your own subscriptions. Sessions and Mend's model calls run on these, under your platform
        user <span className="font-mono text-[12px] text-ink-2">{identity.sealantUserId}</span>.
        Credentials go straight to Sealant and are not kept here.
      </p>
      <div className="mt-5 space-y-5 border-t border-[var(--sw-faint-rule)] pt-5">
        {PROVIDERS.map((row) => {
          const view = rowViewOf(row.provider, loginChoiceOf(identity.accounts, row.provider));
          const isEditing = editing === row.provider;
          const busy = pending === row.provider;
          return (
            <div key={row.provider} className="space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5">
                    <span className={`size-2 rounded-full ${view.dot}`} aria-hidden="true" />
                    <p className="font-sans text-sm font-medium text-foreground">{row.label}</p>
                    <span className="font-mono text-[12px] text-label">{view.hint}</span>
                  </div>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                    {row.detail}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded-xl border border-border bg-card px-3.5 py-1.5 font-sans text-xs font-medium text-foreground shadow-xs transition-colors hover:border-input disabled:opacity-60"
                    onClick={() => {
                      setError(null);
                      setSecret("");
                      setEditing(isEditing ? null : row.provider);
                    }}
                  >
                    {isEditing ? "Cancel" : view.chosen === null ? "Connect" : "Replace"}
                  </button>
                  {view.chosen === null ? null : (
                    <DisconnectButton busy={busy} account={view.chosen} onDisconnect={disconnect} />
                  )}
                </div>
              </div>
              {view.unchosen === null ? null : (
                <div className="space-y-2">
                  {view.unchosen.accounts.map((account) => (
                    <div key={account.id} className="flex items-center justify-between gap-4">
                      <span className="font-mono text-[12px] text-label">
                        {`${account.name} · ${accountHint(account)}`}
                      </span>
                      <DisconnectButton busy={busy} account={account} onDisconnect={disconnect} />
                    </div>
                  ))}
                  <p className="text-[13px] leading-relaxed text-muted-foreground">
                    {view.unchosen.remedy}
                  </p>
                </div>
              )}
              {isEditing ? (
                <form
                  className="space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submit(row.provider, view.chosen);
                  }}
                >
                  {row.multiline ? (
                    <textarea
                      autoFocus
                      rows={4}
                      value={secret}
                      onChange={(event) => setSecret(event.target.value)}
                      placeholder={row.placeholder}
                      spellCheck={false}
                      className="w-full rounded-xl border border-border bg-card px-3 py-2 font-mono text-[12.5px] text-foreground shadow-xs outline-none placeholder:text-label focus:border-input"
                    />
                  ) : (
                    <input
                      autoFocus
                      type="password"
                      value={secret}
                      onChange={(event) => setSecret(event.target.value)}
                      placeholder={row.placeholder}
                      spellCheck={false}
                      autoComplete="off"
                      className="w-full rounded-xl border border-border bg-card px-3 py-2 font-mono text-[12.5px] text-foreground shadow-xs outline-none placeholder:text-label focus:border-input"
                    />
                  )}
                  <div className="flex items-center gap-3">
                    <button
                      type="submit"
                      disabled={busy || secret.trim() === ""}
                      className="rounded-xl border border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash px-3.5 py-1.5 font-sans text-xs font-medium text-foreground shadow-xs disabled:opacity-60"
                    >
                      {busy ? "Connecting…" : "Connect"}
                    </button>
                    <span className="font-mono text-[12px] text-label">
                      sent once to the platform · not stored by Mend
                    </span>
                  </div>
                </form>
              ) : null}
            </div>
          );
        })}
        <AgentLoginsSwitch />
        {error === null ? null : (
          <p className="font-mono text-[12.5px] text-warning" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

function DisconnectButton({
  busy,
  account,
  onDisconnect,
}: {
  readonly busy: boolean;
  readonly account: ConnectedAccountDto;
  readonly onDisconnect: (account: ConnectedAccountDto) => void;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      className="rounded-xl border border-border bg-card px-3.5 py-1.5 font-sans text-xs font-medium text-muted-foreground shadow-xs transition-colors hover:text-foreground disabled:opacity-60"
      onClick={() => onDisconnect(account)}
    >
      {busy ? "…" : "Disconnect"}
    </button>
  );
}

/**
 * Which of the person's own logins their Claude and Codex sessions receive (docs/adr/0016,
 * decision 5): every connected one by default, so a Claude session can run `codex` on the same
 * person's login; on, only the session's own agent's.
 */
function AgentLoginsSwitch() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const setting = useSuspenseQuery(trpc.platform.agentLogins.queryOptions()).data;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (selectedOnly: boolean) => {
    if (setting.selectedOnly === selectedOnly) return;
    setPending(true);
    setError(null);
    void setAgentLogins(selectedOnly)
      .then((next) =>
        queryClient.setQueryData(trpc.platform.agentLogins.queryOptions().queryKey, next),
      )
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(false));
  };

  return (
    <div className="space-y-2 border-t border-[var(--sw-faint-rule)] pt-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-sans text-sm font-medium text-foreground">
            Give my sessions only the selected agent&apos;s login
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            Off: a Claude session also gets your Codex login and a Codex session your Claude login,
            when connected, so the agent can run <span className="font-mono text-xs">codex</span> or{" "}
            <span className="font-mono text-xs">claude</span> on your own login. Only ever yours: in
            a per-person workspace no session gets anyone else&apos;s. In a workspace that shares
            one home, whoever joins or steers there runs on the logins of the person who started it,
            these included. Shells, pi and opencode get every login you connected either way, and so
            does a shell you open on a session, into the home its agent shares. A change applies the
            next time your logins are written into a workspace: one that already holds them keeps
            them while it runs, for new sessions of yours there too.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {[true, false].map((value) => (
            <button
              key={String(value)}
              type="button"
              disabled={pending}
              onClick={() => toggle(value)}
              className={`rounded-xl border px-3.5 py-1.5 font-sans text-xs font-medium shadow-xs transition-colors disabled:opacity-60 ${
                setting.selectedOnly === value
                  ? "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash text-foreground"
                  : "border-border bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              {value ? "On" : "Off"}
            </button>
          ))}
        </div>
      </div>
      {error === null ? null : (
        <p className="font-mono text-[12.5px] text-warning" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
