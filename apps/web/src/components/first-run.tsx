import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { GitKeyCard } from "#/components/git-key-card";
import { StatusDot } from "#/components/status";
import { splitDevices } from "#/lib/onboarding";
import { useTRPC } from "#/lib/trpc";

/**
 * The empty machine, as a checklist rather than a wizard: six steps, each
 * with what to type and what Mend actually observed about it. Four of the six
 * are observed — git access, the CLI's sign-in (its token is a device of
 * platform `cli`), connected accounts, paired devices — and every observation
 * re-reads on the `user` event the server sends when it changes, so a
 * command run in a terminal lands here without a reload.
 *
 * It is not a modal and it does not gate anything — it disappears the moment
 * a project exists. Account and git access were settled at registration; the
 * first row only shows what that left behind.
 */

function Command({ children }: { readonly children: string }) {
  return (
    <code className="rounded-md bg-[var(--sw-sunken)] px-1.5 py-0.5 font-mono text-[12px] text-ink-2">
      {children}
    </code>
  );
}

function SettingsLink({ hash, children }: { readonly hash: string; readonly children: string }) {
  return (
    <Link
      to="/settings"
      hash={hash}
      className="shrink-0 font-sans text-xs font-medium text-muted-foreground no-underline transition-colors hover:text-foreground"
    >
      {children}
    </Link>
  );
}

function Step({
  index,
  title,
  status,
  children,
  action,
  evidence,
}: {
  readonly index: number;
  readonly title: string;
  readonly status: ReactNode;
  readonly children: ReactNode;
  readonly action?: ReactNode;
  /** The thing beside the claim — the key to add, the failure's own words. */
  readonly evidence?: ReactNode;
}) {
  return (
    <div className={`px-5 py-4 ${index === 1 ? "" : "border-t border-rule-faint"}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="flex min-w-0 items-baseline gap-3">
          <span className="font-mono text-[11px] text-faint">0{index}</span>
          <span className="font-sans text-sm font-medium text-foreground">{title}</span>
        </p>
        {status}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 pl-[1.65rem]">
        <p className="min-w-0 text-[13px] leading-relaxed text-muted-foreground">{children}</p>
        {action}
      </div>
      {evidence === undefined ? null : <div className="mt-3 pl-[1.65rem]">{evidence}</div>}
    </div>
  );
}

/** Up to two names, then a count — enough to recognise a machine, not a roster. */
const named = (devices: ReadonlyArray<{ readonly name: string }>): string => {
  const names = devices.slice(0, 2).map((device) => device.name);
  const rest = devices.length - names.length;
  return rest > 0 ? `${names.join(", ")} +${rest}` : names.join(", ");
};

const failureMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function FirstRun() {
  const trpc = useTRPC();
  const identity = useQuery(trpc.platform.sealantIdentity.queryOptions());
  const devices = useQuery(trpc.devices.list.queryOptions());
  const gitAccess = useQuery(trpc.git.access.queryOptions());

  const connected = (identity.data?.accounts ?? []).filter(({ status }) => status === "active");
  const { machines, paired } = splitDevices(devices.data ?? []);
  const origin = typeof window === "undefined" ? "http://<this server>" : window.location.origin;

  return (
    <section className="mt-8">
      <div className="rounded-2xl bg-card shadow-sm">
        <div className="border-b border-rule-faint px-5 py-4">
          <p className="text-xs font-medium text-label">First run</p>
          <p className="mt-1.5 max-w-[62ch] text-sm leading-relaxed text-muted-foreground">
            Nothing is adopted yet. Six steps get an agent working in a recorded worktree on this
            machine. Each row shows what Mend observed; the marks move as you go.
          </p>
        </div>

        <Step
          index={1}
          title="Git access"
          status={
            gitAccess.isPending ? (
              <StatusDot tone="hollow" word="…" />
            ) : gitAccess.data === undefined ? (
              <StatusDot tone="red" word="not observed" />
            ) : gitAccess.data.mode === "bridge" ? (
              <StatusDot
                tone={gitAccess.data.bridge.connected ? "green" : "hollow"}
                word={
                  gitAccess.data.bridge.connected
                    ? `signer connected · ${gitAccess.data.bridge.clientName ?? "unknown machine"}`
                    : "no signer yet"
                }
              />
            ) : gitAccess.data.key.exists ? (
              <StatusDot tone="green" word="key created" />
            ) : (
              <StatusDot tone="hollow" word="no key yet" />
            )
          }
          action={<SettingsLink hash="git-access">Settings → Git access</SettingsLink>}
          evidence={
            gitAccess.data?.mode === "mend-key" && gitAccess.data.key.exists ? (
              <GitKeyCard gitKey={gitAccess.data.key} />
            ) : undefined
          }
        >
          {gitAccess.data?.mode === "bridge"
            ? "Chosen when your account was created: the ssh-agent on your machine signs while a mend command runs there. Git for bridge projects waits for nobody — until a signer connects, the base is not fetched."
            : "Chosen when your account was created: a key of yours on this server. Added to your git account, it keeps working when the laptop is closed."}
        </Step>

        <Step
          index={2}
          title="Sign the CLI in"
          status={
            devices.isPending ? (
              <StatusDot tone="hollow" word="…" />
            ) : machines.length === 0 ? (
              <StatusDot tone="hollow" word="not signed in yet" />
            ) : (
              <StatusDot tone="green" word={`signed in · ${named(machines)}`} />
            )
          }
        >
          Run <Command>{`mend login --url ${origin}`}</Command> on your machine and press Authorize
          in the browser page it opens. The token lands in{" "}
          <span className="font-mono text-[12px]">~/.config/mend/cli.json</span>; the server keeps
          only its hash.
        </Step>

        <Step
          index={3}
          title="Connect your accounts"
          status={
            identity.isPending ? (
              <StatusDot tone="hollow" word="…" />
            ) : identity.isError ? (
              <StatusDot tone="red" word="platform unreachable" />
            ) : connected.length === 0 ? (
              <StatusDot tone="hollow" word="none connected" />
            ) : (
              <StatusDot tone="green" word={`${connected.length} connected`} />
            )
          }
          action={<SettingsLink hash="accounts">Settings → Accounts</SettingsLink>}
          evidence={
            identity.isError ? (
              <p className="font-mono text-[12px] leading-relaxed break-words text-faint">
                {failureMessage(identity.error)}
              </p>
            ) : undefined
          }
        >
          <Command>mend connect claude</Command> · <Command>mend connect codex</Command> ·{" "}
          <Command>mend connect github</Command>. Mend ships no keys — agents run on your own
          subscription.
        </Step>

        <Step
          index={4}
          title="Adopt a repository"
          status={<StatusDot tone="hollow" word="none adopted" />}
          action={
            <Link
              to="/projects"
              className="shrink-0 rounded-xl bg-primary px-3.5 py-1.5 font-sans text-xs font-medium text-primary-foreground no-underline shadow-[var(--shadow-cobalt)] transition-transform hover:-translate-y-0.5"
            >
              Adopt a repository
            </Link>
          }
        >
          Or run <Command>mend adopt</Command> inside a checkout. Mend clones it into its own store;
          your checkout is never the execution target.
        </Step>

        <Step
          index={5}
          title="Start a session"
          status={<StatusDot tone="hollow" word="none yet" />}
        >
          <Command>mend claude &quot;fix the flaky upload test&quot;</Command> in an adopted
          repository. The session gets its own worktree, and its change is reviewable from the first
          edit.
        </Step>

        <Step
          index={6}
          title="Pair your phone"
          status={
            devices.isPending ? (
              <StatusDot tone="hollow" word="…" />
            ) : paired.length === 0 ? (
              <StatusDot tone="hollow" word="no device paired" />
            ) : (
              <StatusDot tone="green" word={`paired · ${named(paired)}`} />
            )
          }
          action={<SettingsLink hash="devices">Settings → Devices</SettingsLink>}
        >
          Scan the QR from Settings → Devices, or run <Command>mend pair</Command> for one in the
          terminal. The phone gets its own token; revoke it there any time.
        </Step>
      </div>
    </section>
  );
}

/**
 * The one line that outlives the checklist: once a project exists, the phone
 * is still unpaired until it is, and this is where you would notice.
 */
export function PairHint() {
  const trpc = useTRPC();
  const { paired } = splitDevices(
    useQuery(trpc.devices.list.queryOptions(undefined, { staleTime: 30_000 })).data ?? [],
  );
  if (paired.length > 0) return null;
  return (
    <Link
      to="/settings"
      hash="devices"
      className="font-sans text-xs font-medium text-muted-foreground no-underline transition-colors hover:text-foreground"
    >
      Pair your phone · Settings → Devices
    </Link>
  );
}
