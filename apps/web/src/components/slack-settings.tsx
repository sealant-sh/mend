import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import {
  Empty,
  ErrorLine,
  PRIMARY,
  Panel,
  QuietButton,
  describe,
} from "#/components/organization-settings";
import { formatDay } from "#/components/pairing-qr";
import {
  connectSlack,
  disconnectSlack,
  removeSlackLink,
  setSlackDefaultProject,
  setSlackSettings,
  unlinkSlack,
  type SlackAppDto,
  type SlackMeDto,
  type SlackSettingsDto,
} from "#/lib/api";
import {
  SLACK_DISPLAY_SETTINGS,
  SLACK_REMOVAL_FACTS,
  defaultProjectOptions,
  slackLinkLine,
} from "#/lib/slack";
import { useTRPC } from "#/lib/trpc";

/**
 * Settings → Slack (docs/adr/0006-slack.md). An owner connects the organization's own Slack app
 * from Mend's manifest, sets what Mend posts, and manages links; everyone sees their own link and
 * picks the project a mention runs in when nothing else answers. Nothing renders for an account
 * in no organization.
 */
export function SlackSettings() {
  const trpc = useTRPC();
  const current = useQuery(trpc.organization.current.queryOptions(undefined, { retry: false }));
  const me = useQuery(trpc.slack.me.queryOptions(undefined, { retry: false }));
  if (current.data === undefined) return null;
  const owner = current.data.role === "owner";
  return (
    <Panel
      id="slack"
      title="Slack"
      description="Mention @mend in a Slack thread to start a session as yourself. Mend reads the thread, picks the project, and reports into the thread; review stays in Mend. Mend connects out to Slack, and Slack never connects to this instance."
    >
      {owner ? <SlackAppSection /> : null}
      {me.data === undefined ? null : <YourLink me={me.data} />}
    </Panel>
  );
}

function Subheading({ children }: { readonly children: ReactNode }) {
  return <p className="font-sans text-sm font-medium text-foreground">{children}</p>;
}

/** Re-read everything Slack-shaped, and the audit log that records it. */
const useRefresh = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries(trpc.slack.pathFilter()),
      queryClient.invalidateQueries(trpc.organization.audit.pathFilter()),
    ]);
};

// ─── The organization's app (owners) ────────────────────────────────────────

function SlackAppSection() {
  const trpc = useTRPC();
  const status = useQuery(trpc.slack.app.queryOptions());
  if (status.data === undefined) return <Empty>reading…</Empty>;
  const app = status.data.app;
  if (app === null) return <ConnectForm replacing={null} />;
  return (
    <>
      <AppFacts app={app} />
      <DisplaySettings app={app} harnesses={status.data.harnesses} />
      <Links />
    </>
  );
}

const INPUT =
  "w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-faint";

/** The manifest to paste, the steps around it, and the two tokens. */
function ConnectForm({
  replacing,
  onCancel,
}: {
  /** The workspace whose tokens these replace; null connects the first time. */
  readonly replacing: string | null;
  readonly onCancel?: () => void;
}) {
  const trpc = useTRPC();
  const manifest = useQuery(trpc.slack.manifest.queryOptions());
  const refresh = useRefresh();
  const [appToken, setAppToken] = useState("");
  const [botToken, setBotToken] = useState("");
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setPending(true);
    setError(null);
    void connectSlack(appToken, botToken)
      .then(() => {
        setAppToken("");
        setBotToken("");
        onCancel?.();
        return refresh();
      })
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setPending(false));
  };

  return (
    <div className="space-y-4">
      <Subheading>
        {replacing === null ? "Connect a Slack app" : `Replace the tokens for ${replacing}`}
      </Subheading>
      {replacing === null ? (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Each organization runs its own Slack app, made from this manifest. It asks for Socket
          Mode, the <span className="font-mono text-[12px]">app_mention</span> event and ten bot
          scopes, and names no URL.
        </p>
      ) : (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Tokens for the same workspace keep its links and channel defaults. Tokens for another
          workspace start over: its links and channel defaults are deleted.
        </p>
      )}
      {manifest.data === undefined ? null : (
        <>
          <ol className="list-decimal space-y-1 pl-5 text-[13px] leading-relaxed text-ink-2">
            {manifest.data.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <div className="rounded-xl bg-sunken p-4">
            <div className="flex items-center justify-between gap-4">
              <span className="ev-eyebrow">manifest.json</span>
              <div className="flex items-center gap-3">
                <span aria-live="polite" className="font-mono text-[12px] text-label">
                  {copied ? "Copied" : ""}
                </span>
                <QuietButton
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(manifest.data.manifest)
                      .then(() => setCopied(true))
                  }
                >
                  Copy
                </QuietButton>
              </div>
            </div>
            <pre className="mt-3 max-h-56 overflow-auto font-mono text-[12px] leading-relaxed text-ink-2">
              {manifest.data.manifest}
            </pre>
          </div>
        </>
      )}
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="space-y-1">
          <span className="font-mono text-[12px] text-label">app-level token</span>
          <input
            type="password"
            value={appToken}
            onChange={(event) => {
              setAppToken(event.target.value);
              setError(null);
            }}
            autoComplete="off"
            spellCheck={false}
            placeholder="xapp-…"
            className={INPUT}
          />
        </label>
        <label className="space-y-1">
          <span className="font-mono text-[12px] text-label">bot token</span>
          <input
            type="password"
            value={botToken}
            onChange={(event) => {
              setBotToken(event.target.value);
              setError(null);
            }}
            autoComplete="off"
            spellCheck={false}
            placeholder="xoxb-…"
            className={INPUT}
          />
        </label>
        <div className="flex items-center gap-4 sm:col-span-2">
          <button
            type="submit"
            disabled={pending || appToken.trim() === "" || botToken.trim() === ""}
            className={PRIMARY}
          >
            {pending ? "Checking with Slack…" : "Check and connect"}
          </button>
          {onCancel === undefined ? null : <QuietButton onClick={onCancel}>Cancel</QuietButton>}
        </div>
      </form>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        Both tokens are sealed at rest and never shown again. Links Mend posts into Slack start with
        the address you are using now.
      </p>
      <ErrorLine error={error} />
    </div>
  );
}

function AppFacts({ app }: { readonly app: SlackAppDto }) {
  const refresh = useRefresh();
  const [mode, setMode] = useState<"idle" | "replace" | "remove">("idle");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = () => {
    setPending(true);
    setError(null);
    void disconnectSlack()
      .then(refresh)
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setPending(false));
  };

  if (mode === "replace") {
    return <ConnectForm replacing={app.teamName} onCancel={() => setMode("idle")} />;
  }
  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Subheading>{app.teamName}</Subheading>
          <p className="mt-1 font-mono text-[12px] text-label">
            {app.teamId} · app {app.appId} · bot {app.botUserId} · connected by{" "}
            {app.installedByName ?? "a removed account"} {formatDay(app.installedAt.toISOString())}
          </p>
          <p className="mt-1 font-mono text-[12px] text-label">links open {app.webOrigin}</p>
        </div>
        {mode === "idle" ? (
          <div className="flex shrink-0 items-center gap-4">
            <QuietButton onClick={() => setMode("replace")}>Replace tokens…</QuietButton>
            <QuietButton onClick={() => setMode("remove")}>Remove…</QuietButton>
          </div>
        ) : null}
      </div>
      {mode === "remove" ? (
        <div
          role="group"
          aria-labelledby="slack-remove"
          className="mt-3 rounded-xl bg-sunken p-4 text-[13px] leading-relaxed"
        >
          <p id="slack-remove" className="font-medium text-foreground">
            Remove the Slack app from {app.teamName}?
          </p>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            {SLACK_REMOVAL_FACTS.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
          <div className="mt-3 flex items-center gap-4">
            <QuietButton danger disabled={pending} onClick={remove}>
              {pending ? "Removing…" : "Remove the Slack app"}
            </QuietButton>
            <QuietButton onClick={() => setMode("idle")}>Cancel</QuietButton>
          </div>
        </div>
      ) : null}
      <ErrorLine error={error} />
    </div>
  );
}

function Choice({
  selected,
  disabled,
  onClick,
  children,
}: {
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-xl border px-3.5 py-1.5 font-sans text-xs font-medium shadow-xs transition-colors disabled:opacity-60 ${
        selected
          ? "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash text-foreground"
          : "border-border bg-card text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

/** What Mend posts into Slack, and the harness a mention runs when it names none. */
function DisplaySettings({
  app,
  harnesses,
}: {
  readonly app: SlackAppDto;
  readonly harnesses: ReadonlyArray<string>;
}) {
  const refresh = useRefresh();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = (next: SlackSettingsDto) => {
    setPending(true);
    setError(null);
    void setSlackSettings(next)
      .then(refresh)
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setPending(false));
  };

  return (
    <div className="space-y-4 border-t border-[var(--sw-faint-rule)] pt-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Subheading>Default harness</Subheading>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            What a mention starts when it names none, with the person's own credentials.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {harnesses.map((harness) => (
            <Choice
              key={harness}
              selected={app.settings.defaultHarness === harness}
              disabled={pending}
              onClick={() => save({ ...app.settings, defaultHarness: harness })}
            >
              {harness}
            </Choice>
          ))}
        </div>
      </div>
      {SLACK_DISPLAY_SETTINGS.map((setting) => {
        const on = app.settings[setting.key];
        return (
          <div key={setting.key} className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <Subheading>{setting.label}</Subheading>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                {on ? setting.on : setting.off}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              {[true, false].map((value) => (
                <Choice
                  key={String(value)}
                  selected={on === value}
                  disabled={pending}
                  onClick={() => {
                    if (on !== value) save({ ...app.settings, [setting.key]: value });
                  }}
                >
                  {value ? "On" : "Off"}
                </Choice>
              ))}
            </div>
          </div>
        );
      })}
      <ErrorLine error={error} />
    </div>
  );
}

/** Every link in the organization; an owner can remove any of them. */
function Links() {
  const trpc = useTRPC();
  const links = useQuery(trpc.slack.links.queryOptions()).data ?? [];
  const refresh = useRefresh();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remove = (slackUserId: string) => {
    setError(null);
    void removeSlackLink(slackUserId)
      .then(() => {
        setConfirming(null);
        return refresh();
      })
      .catch((cause: unknown) => setError(describe(cause)));
  };

  return (
    <div className="space-y-3 border-t border-[var(--sw-faint-rule)] pt-4">
      <Subheading>Links</Subheading>
      {links.length === 0 ? (
        <Empty>no links yet</Empty>
      ) : (
        links.map((link) => (
          <div key={link.slackUserId} className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="font-sans text-sm text-foreground">{link.userName}</p>
              <p className="mt-1 font-mono text-[12px] text-label">
                Slack {link.slackUserId} · linked {formatDay(link.createdAt.toISOString())}
              </p>
            </div>
            {confirming === link.slackUserId ? (
              <div className="flex shrink-0 items-center gap-4">
                <QuietButton danger onClick={() => remove(link.slackUserId)}>
                  Remove {link.userName}'s link
                </QuietButton>
                <QuietButton onClick={() => setConfirming(null)}>Cancel</QuietButton>
              </div>
            ) : (
              <QuietButton onClick={() => setConfirming(link.slackUserId)}>Remove…</QuietButton>
            )}
          </div>
        ))
      )}
      <ErrorLine error={error} />
    </div>
  );
}

// ─── The signed-in person (everyone) ────────────────────────────────────────

function YourLink({ me }: { readonly me: SlackMeDto }) {
  const trpc = useTRPC();
  const projects = useQuery(trpc.projects.list.queryOptions()).data ?? [];
  const refresh = useRefresh();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = defaultProjectOptions(projects);

  const act = (work: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    void work()
      .then(refresh)
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setPending(false));
  };

  return (
    <div className="space-y-4 border-t border-[var(--sw-faint-rule)] pt-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Subheading>Your Slack link</Subheading>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            {slackLinkLine(me)}
          </p>
          {me.link === null ? null : (
            <p className="mt-1 font-mono text-[12px] text-label">
              linked {formatDay(me.link.createdAt.toISOString())}
            </p>
          )}
        </div>
        {me.link === null ? null : (
          <QuietButton disabled={pending} onClick={() => act(unlinkSlack)}>
            Unlink
          </QuietButton>
        )}
      </div>
      {me.workspace === null ? null : (
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 basis-72">
            <Subheading>Your default project</Subheading>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              Where a mention runs when it names no project and neither the thread nor the channel
              gives one.
            </p>
          </div>
          <select
            aria-label="Your default project"
            disabled={pending}
            value={me.defaultProjectId ?? ""}
            onChange={(event) => {
              const picked = options.find((option) => option.id === event.target.value);
              act(() => setSlackDefaultProject(picked?.id ?? null));
            }}
            className="w-full max-w-[36ch] rounded-lg border border-border bg-card px-2.5 py-1.5 font-mono text-[12.5px] text-foreground shadow-xs outline-none focus:border-input"
          >
            <option value="">none</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
}
