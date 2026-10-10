import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import { Input } from "@mend/ui/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@mend/ui/components/ui/toggle-group";
import { cn } from "@mend/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { Titlebar } from "#/components/titlebar";
import {
  connectAccount,
  disconnectAccount,
  type ConnectedAccountDto,
  type ConnectedAccountProviderDto,
} from "#/lib/api";
import { appSettings, HARNESSES, useAppSettings } from "#/lib/app-settings";
import { useConnection } from "#/lib/connection";
import { queryClient, sealantIdentityQuery } from "#/lib/queries";
import { DEFAULT_FAMILY, DEFAULT_SIZE, terminalFont, useTerminalFont } from "#/lib/terminal-font";
import { setThemeMode, useThemeMode, type ThemeMode } from "#/lib/theme";
import { isMonospaceFamily } from "#/terminal/ghostty/monospace-probe";

/**
 * Settings (BRIEF.md §settings): the terminal, appearance, workbench
 * defaults, the connection, and the keymap. Everything applies live and
 * persists per machine. The one server-side section is the signed-in user's
 * connected accounts — their own subscriptions, held by the platform.
 */
export const Route = createFileRoute("/settings")({
  component: Settings,
});

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="w-full">
      <h2 className="mb-2 font-sans text-[12.5px] font-medium text-muted-foreground">{title}</h2>
      <div className="flex flex-col overflow-hidden rounded-2xl border border-rule bg-panel shadow-xs">
        {children}
      </div>
    </section>
  );
}

function RowShell({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 px-4 py-3 not-first:border-t not-first:border-rule">
      <div className="min-w-0 flex-1">
        <p className="font-sans text-[14px] text-foreground">{label}</p>
        {hint !== undefined && (
          <p className="mt-0.5 font-sans text-[12.5px] leading-relaxed text-label">{hint}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * A pick-one control composed from the ui ToggleGroup; re-clicking the active
 * option is ignored so a setting always has a value.
 */
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  readonly value: T;
  readonly options: ReadonlyArray<T>;
  readonly onChange: (next: T) => void;
}) {
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(next: string[]) => {
        const picked = next[0];
        if (picked !== undefined && options.includes(picked as T)) onChange(picked as T);
      }}
      className="flex rounded-xl border border-rule bg-background p-0.5"
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option}
          value={option}
          className="rounded-[10px] px-3 py-1 text-[13px] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground aria-pressed:bg-panel aria-pressed:font-medium aria-pressed:text-foreground aria-pressed:shadow-xs data-[state=on]:bg-panel"
        >
          {option}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function TerminalSection() {
  const font = useTerminalFont();
  const [familyDraft, setFamilyDraft] = useState(font.family);
  const committed = familyDraft === font.family;
  const monospace = familyDraft.trim() === "" || isMonospaceFamily(familyDraft);

  const commitFamily = () => terminalFont.setFamily(familyDraft);

  return (
    <Section title="Terminal">
      <RowShell
        label="Font family"
        hint={
          monospace
            ? "any installed monospace face; empty resets to JetBrains Mono"
            : "measures as proportional — the terminal will fall back to its default stack"
        }
      >
        <Input
          className={`w-64 font-mono text-[13px] ${monospace ? "" : "border-[var(--sw-amber)]"}`}
          value={familyDraft}
          onChange={(event) => setFamilyDraft(event.target.value)}
          onBlur={commitFamily}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitFamily();
          }}
          placeholder={DEFAULT_FAMILY}
          spellCheck={false}
        />
        {!committed && <span className="font-sans text-[12px] text-label">enter to apply</span>}
      </RowShell>
      <RowShell label="Font size" hint="6–32px · Ctrl+Shift+= / − / 0 from anywhere">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="Smaller"
          onClick={terminalFont.smaller}
          className="font-mono"
        >
          −
        </Button>
        <span className="w-10 text-center font-mono text-[13.5px] text-foreground">
          {font.size}px
        </span>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="Bigger"
          onClick={terminalFont.bigger}
          className="font-mono"
        >
          +
        </Button>
        {font.size !== DEFAULT_SIZE && (
          <Button type="button" variant="ghost" size="sm" onClick={terminalFont.reset}>
            reset
          </Button>
        )}
      </RowShell>
      <div className="border-t border-rule bg-term px-4 py-3">
        <p
          className="text-term-fg"
          style={{ fontFamily: `${font.family}, monospace`, fontSize: `${font.size}px` }}
        >
          mend › git log --oneline · 0O 1lI 5S 8B ~/.config
        </p>
      </div>
    </Section>
  );
}

function Settings() {
  const themeMode = useThemeMode();
  const settings = useAppSettings();
  const connection = useConnection();

  return (
    <>
      <Titlebar liveCount={null} />
      <main className="min-h-0 flex-1 overflow-y-auto bg-canvas">
        <div className="mx-auto flex max-w-[640px] flex-col gap-6 px-6 py-10">
          <header className="flex items-end justify-between">
            <div>
              <p className="font-mono text-[11px] tracking-[0.57px] text-muted-foreground">
                MEND / SETTINGS
              </p>
              <h1 className="mt-1 font-display text-[24px] leading-tight font-medium text-foreground">
                Settings
              </h1>
            </div>
            <Link
              to="/"
              className="font-sans text-[13.5px] text-muted-foreground hover:text-foreground"
            >
              ← back to the cockpit
            </Link>
          </header>

          <TerminalSection />

          <Section title="Appearance">
            <RowShell
              label="Theme"
              hint="system follows the OS; the terminal stays dark either way"
            >
              <Segmented<ThemeMode>
                value={themeMode}
                options={["system", "light", "dark"]}
                onChange={setThemeMode}
              />
            </RowShell>
          </Section>

          <Section title="Workbench">
            <RowShell
              label="Default harness"
              hint="what a project's composer starts with until it picks its own"
            >
              <Segmented
                value={settings.defaultHarness}
                options={HARNESSES}
                onChange={appSettings.setDefaultHarness}
              />
            </RowShell>
            <RowShell
              label="Supporting shells"
              hint="open in the focused session and follow that workspace image's login shell"
            >
              <span className="font-mono text-[12px] text-label">session-owned</span>
            </RowShell>
          </Section>

          <Section title="Connection">
            <RowShell
              label={connection?.signedIn === true ? "Signed in" : "Not signed in"}
              hint={
                connection === null
                  ? ""
                  : `${connection.url} · credential shared with the mend CLI at ${connection.configPath}`
              }
            >
              <Link to="/connect" className={cn(buttonVariants({ variant: "outline" }))}>
                Manage
              </Link>
              {connection?.signedIn === true && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    void window.mend.connection.signOut().then(() => {
                      queryClient.clear();
                      return null;
                    });
                  }}
                >
                  Sign out
                </Button>
              )}
            </RowShell>
          </Section>

          {connection?.signedIn === true && <ConnectedAccountsSection />}

          <Section title="Keyboard">
            <div className="px-4 py-3">
              <table className="w-full font-mono text-[12px]">
                <tbody>
                  {[
                    ["Ctrl+Shift+J / K", "next / previous session"],
                    ["Ctrl+Shift+H / L", "previous / next project"],
                    ["Ctrl+Shift+T / W", "new shell tab / close tab"],
                    ["Ctrl+Tab / +Shift", "next / previous tab"],
                    ["Ctrl+1…9", "jump to inbox row (hold Ctrl for pills)"],
                    ["Ctrl+Shift+P", "session palette"],
                    ["Ctrl+Shift+B", "sidebar: tree ⇄ inbox"],
                    ["Ctrl+Shift+= / − / 0", "terminal font bigger / smaller / reset"],
                    ["Ctrl+,", "settings"],
                    ["Alt+Space", "summon the window (global)"],
                  ].map(([keys, action]) => (
                    <tr key={keys} className="not-first:border-t not-first:border-rule-faint">
                      <td className="py-1.5 pr-6 whitespace-nowrap text-foreground">{keys}</td>
                      <td className="py-1.5 font-sans text-[12.5px] text-label">{action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 font-sans text-[12px] text-faint">
                fixed for now — configurable later; Ctrl+K and Ctrl+T stay readline's
              </p>
            </div>
          </Section>
        </div>
      </main>
    </>
  );
}

const PROVIDERS: ReadonlyArray<{
  readonly provider: ConnectedAccountProviderDto;
  readonly label: string;
  readonly hint: string;
  readonly placeholder: string;
}> = [
  {
    provider: "claude",
    label: "Claude",
    hint: "Paste a setup token (`claude setup-token`) or ~/.claude/.credentials.json",
    placeholder: "sk-ant-oat01-…",
  },
  {
    provider: "codex",
    label: "Codex",
    hint: "Paste ~/.codex/auth.json from a machine where `codex login` has run",
    placeholder: '{ "tokens": { … } }',
  },
  {
    provider: "github",
    label: "GitHub",
    hint: "Paste `gh auth token` — gives `gh` in every session a GH_TOKEN",
    placeholder: "gho_…",
  },
];

const accountHint = (account: ConnectedAccountDto): string => {
  const meta = account.metadata;
  const pick = (key: string) => (typeof meta[key] === "string" ? String(meta[key]) : null);
  const identity = pick("login") ?? pick("email") ?? pick("accountEmail") ?? pick("accountId");
  const suffix = pick("tokenSuffix");
  const parts = [
    "connected",
    identity,
    suffix === null ? null : `…${suffix}`,
    account.status === "invalid" ? "rejected by the provider — reconnect" : null,
  ].filter((part): part is string => part !== null);
  return parts.join(" · ");
};

/**
 * The signed-in user's own provider accounts (docs/SEALANT-IDENTITY.md in the
 * Mend repo). The credential goes to the platform under their Sealant user
 * and is never shown again; Mend stores nothing.
 */
const refreshIdentity = () => queryClient.invalidateQueries({ queryKey: ["sealant-identity"] });

function ConnectedAccountsSection() {
  const identity = useQuery(sealantIdentityQuery);
  const [editing, setEditing] = useState<ConnectedAccountProviderDto | null>(null);
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState<ConnectedAccountProviderDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = refreshIdentity;
  const report = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : String(cause));
  const submit = (provider: ConnectedAccountProviderDto) => {
    const value = secret.trim();
    if (value === "") return;
    setPending(provider);
    setError(null);
    void connectAccount({ provider, secret: value })
      .then(() => {
        setEditing(null);
        setSecret("");
        return refresh();
      })
      .catch(report)
      .finally(() => setPending(null));
  };
  const disconnect = (account: ConnectedAccountDto) => {
    setPending(account.provider);
    setError(null);
    void disconnectAccount(account.id)
      .then(() => refresh())
      .catch(report)
      .finally(() => setPending(null));
  };

  return (
    <Section title="Connected accounts">
      {identity.data === undefined ? (
        <RowShell
          label={identity.isError ? "Platform identity unavailable" : "Loading…"}
          {...(identity.isError ? { hint: identity.error.message } : {})}
        >
          <span />
        </RowShell>
      ) : (
        PROVIDERS.map((row) => {
          const accounts = identity.data.accounts;
          const account =
            accounts.find(
              (candidate) => candidate.provider === row.provider && candidate.name === "default",
            ) ?? accounts.find((candidate) => candidate.provider === row.provider);
          const isEditing = editing === row.provider;
          const busy = pending === row.provider;
          return (
            <div key={row.provider}>
              <RowShell
                label={row.label}
                hint={account === undefined ? row.hint : accountHint(account)}
              >
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setSecret("");
                    setEditing(isEditing ? null : row.provider);
                  }}
                >
                  {isEditing ? "Cancel" : account === undefined ? "Connect" : "Replace"}
                </Button>
                {account !== undefined && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => disconnect(account)}
                  >
                    Disconnect
                  </Button>
                )}
              </RowShell>
              {isEditing && (
                <form
                  className="flex items-center gap-2 border-t border-rule px-4 py-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submit(row.provider);
                  }}
                >
                  <Input
                    autoFocus
                    type="password"
                    value={secret}
                    placeholder={row.placeholder}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => setSecret(event.target.value)}
                    className="font-mono"
                  />
                  <Button type="submit" disabled={busy || secret.trim() === ""}>
                    {busy ? "Connecting…" : "Connect"}
                  </Button>
                </form>
              )}
            </div>
          );
        })
      )}
      {error !== null && (
        <p
          className="border-t border-rule px-4 py-3 font-mono text-[12.5px] text-warning"
          role="alert"
        >
          {error}
        </p>
      )}
      <p className="border-t border-rule px-4 py-3 font-sans text-[12.5px] leading-relaxed text-label">
        Your subscriptions, under your platform user
        {identity.data === undefined ? "" : ` ${identity.data.sealantUserId}`}. Sessions and Mend's
        model calls run on these. Credentials go to Sealant once and are not kept here.
      </p>
    </Section>
  );
}
