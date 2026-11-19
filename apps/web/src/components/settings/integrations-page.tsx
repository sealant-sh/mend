import { InlineAlert } from "@mend/ui/components/banner";
import { CopyField } from "@mend/ui/components/copy-field";
import { Segmented } from "@mend/ui/components/segmented";
import { Button } from "@mend/ui/components/ui/button";
import { Input } from "@mend/ui/components/ui/input";
import { Label } from "@mend/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@mend/ui/components/ui/native-select";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { Switch } from "@mend/ui/components/ui/switch";
import { toast } from "@mend/ui/components/ui/toast";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LockIcon, WorkflowIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import {
  type ExecutorConfigurationDto,
  harnessLabel,
  managedLine,
  SLACK_REMOVAL_FACTS,
  SLACK_SWITCHES,
  slackAppLine,
  slackUploadNotice,
  versionOf,
} from "#/lib/integrations";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";
import { useViewer } from "#/lib/use-viewer";

import { Overlay } from "../projects/overlay.tsx";
import { SlackMark } from "./brand-marks.tsx";
import { SharedExecutorServices } from "./executor-services.tsx";
import { SettingRow } from "./setting-row.tsx";
import { settingsLink } from "./settings-links.tsx";
import { SettingsPage } from "./settings-page.tsx";

/** A control's size: 32px beside a row on the desk, a 44px touch target on a phone. */
const touch = (phone: boolean) => (phone ? "touch" : "default");

/** Everything Slack- or Executor-shaped is read again after a change, and the audit log. */
const useRefresh = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries(trpc.slack.pathFilter()),
      queryClient.invalidateQueries(trpc.executor.pathFilter()),
      queryClient.invalidateQueries(trpc.organization.audit.pathFilter()),
    ]);
};

/**
 * Settings → the organization → Integrations (Doop "Settings · Northwind · Integrations"): the
 * organization's Slack app (docs/adr/0006) and its Executor (docs/adr/0022), which everyone in it
 * shares and its owners set up (docs/adr/0025). A person's own Slack and Executor links are on
 * Connected apps; this page links there instead of repeating them. Slack's tokens are never shown
 * once entered. Old `/settings/organization/slack` (Slack's `@mend settings` links there) and
 * `/settings/organization/executor` land here.
 */
export function IntegrationsPage() {
  const trpc = useTRPC();
  const { organizationName } = useViewer();
  const { role } = useSuspenseQuery(signedInOptions(trpc)).data;
  const owner = role === "owner";
  return (
    <SettingsPage
      page="o-integrations"
      intro={
        <>
          {organizationName}'s Slack app and Executor. Everyone in {organizationName} shares them;
          you link your own accounts in{" "}
          <Link {...settingsLink("a-apps")} className="underline underline-offset-2">
            Connected apps
          </Link>
          .
        </>
      }
    >
      {owner ? <OwnerSlack /> : <MemberSlack />}
      <ExecutorSection owner={owner} />
    </SettingsPage>
  );
}

/** One app's heading row: its mark, its name, what stands, and its buttons. */
function AppHeader({
  mark,
  name,
  line,
  note,
  control,
}: {
  readonly mark: ReactNode;
  readonly name: string;
  readonly line: ReactNode;
  readonly note?: ReactNode;
  readonly control?: ReactNode;
}) {
  return (
    <div className="mt-7 flex items-start gap-3 border-b border-border py-3.5 first:mt-0 max-lg:flex-wrap max-lg:px-4">
      <span className="mt-0.5 flex size-5 flex-none items-center justify-center text-foreground [&_svg]:size-4.5">
        {mark}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-lead font-semibold">{name}</h2>
        <p className="mt-0.5 text-row text-pretty text-muted-foreground">{line}</p>
        {note === undefined || note === null ? null : (
          <p className="mt-1.5 flex gap-1.5 text-meta text-muted-foreground [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
            {note}
          </p>
        )}
      </div>
      {control === undefined ? null : (
        <div className="flex flex-none flex-wrap items-center justify-end gap-2 max-lg:w-full max-lg:pl-8 max-lg:*:flex-1">
          {control}
        </div>
      )}
    </div>
  );
}

/** A failure under a row, in a sentence. */
function Failed({ children }: { readonly children: ReactNode }) {
  return (
    <p role="alert" className="py-2 text-row text-destructive max-lg:px-4">
      {children}
    </p>
  );
}

// --- Slack ----------------------------------------------------------------------------------------

/** A member reads whether Slack is connected; their own link is on Connected apps. */
function MemberSlack() {
  const trpc = useTRPC();
  const { organizationName } = useViewer();
  const me = useSuspenseQuery(trpc.slack.me.queryOptions()).data;
  return (
    <AppHeader
      mark={<SlackMark />}
      name="Slack"
      line={
        me.workspace === null
          ? `${organizationName} hasn't connected Slack. An owner connects it here.`
          : `Connected to ${me.workspace.teamName}. Mention @mend there to start a session; an owner changes what Mend posts.`
      }
    />
  );
}

function OwnerSlack() {
  const trpc = useTRPC();
  const phone = usePhone();
  const status = useSuspenseQuery(trpc.slack.app.queryOptions()).data;
  const links = useQuery(trpc.slack.links.queryOptions());
  const [dialog, setDialog] = useState<"connect" | "replace" | "remove" | "links" | null>(null);
  const app = status.app;
  const close = () => setDialog(null);
  if (app === null) {
    return (
      <>
        <AppHeader
          mark={<SlackMark />}
          name="Slack"
          line="Not connected. Mention @mend in a Slack channel to start a session, once you connect Mend's Slack app. Each organization makes its own app from Mend's manifest; Slack never connects to this server."
          control={
            <Button type="button" size={touch(phone)} onClick={() => setDialog("connect")}>
              Connect Slack…
            </Button>
          }
        />
        <ConnectDialog replacing={null} open={dialog === "connect"} onClose={close} />
      </>
    );
  }
  // While the links are read, or if they can't be, the line leaves the count out; the dialog says why.
  const linkCount = links.isPending || links.isError ? null : links.data.length;
  const upload = slackUploadNotice(app.grantedScopes);
  return (
    <>
      <AppHeader
        mark={<SlackMark />}
        name="Slack"
        line={slackAppLine(app, linkCount)}
        note={
          <>
            <LockIcon aria-hidden />
            <span>Mend sealed the app token and the bot token. It can't show them again.</span>
          </>
        }
        control={
          <>
            <Button
              type="button"
              variant="outline"
              size={touch(phone)}
              onClick={() => setDialog("links")}
            >
              View linked people
            </Button>
            <Button
              type="button"
              variant="outline"
              size={touch(phone)}
              onClick={() => setDialog("replace")}
            >
              Replace tokens…
            </Button>
            <Button
              type="button"
              variant="ghost"
              size={touch(phone)}
              onClick={() => setDialog("remove")}
            >
              Remove…
            </Button>
          </>
        }
      />
      {upload === null ? null : (
        <InlineAlert tone="warning" className="mt-3 max-lg:mx-4">
          {upload}
        </InlineAlert>
      )}
      <SlackSettings settings={app.settings} harnesses={status.harnesses} />
      <SettingRow
        label="Channel projects"
        description="A channel's default project is set from Slack: mention @mend settings in the channel and pick one. Mend asks which project to use in any other channel."
      />
      <ConnectDialog replacing={app.teamName} open={dialog === "replace"} onClose={close} />
      <RemoveSlackDialog teamName={app.teamName} open={dialog === "remove"} onClose={close} />
      <LinksDialog open={dialog === "links"} onClose={close} />
    </>
  );
}

/** The default agent and the thread switches. Each change is sent at once. */
function SlackSettings({
  settings,
  harnesses,
}: {
  readonly settings: {
    readonly defaultHarness: string;
    readonly showAgentMessages: boolean;
    readonly showDiffs: boolean;
    readonly externalChannels: boolean;
    readonly landAutomatically: boolean;
  };
  readonly harnesses: ReadonlyArray<string>;
}) {
  const trpc = useTRPC();
  const phone = usePhone();
  const refresh = useRefresh();
  const save = useMutation(trpc.slack.setSettings.mutationOptions({ onSettled: refresh }));
  const shown = save.isPending ? save.variables.settings : settings;
  const change = (patch: Partial<typeof settings>) =>
    save.mutate({ settings: { ...shown, ...patch } });
  return (
    <>
      <SettingRow
        label="Default agent"
        labelFor="slack-default-agent"
        layout="stack"
        description="Sessions started from Slack use this agent unless the message names another one."
        control={
          <NativeSelect
            id="slack-default-agent"
            size={phone ? "field" : "default"}
            value={shown.defaultHarness}
            disabled={save.isPending}
            className="w-48 max-lg:w-full"
            onChange={(event) => change({ defaultHarness: event.target.value })}
          >
            {harnesses.map((harness) => (
              <NativeSelectOption key={harness} value={harness}>
                {harnessLabel(harness)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        }
      />
      {SLACK_SWITCHES.map((setting) => {
        const on = shown[setting.key];
        return (
          <SettingRow
            key={setting.key}
            label={setting.label}
            labelFor={`slack-${setting.key}`}
            description={on ? setting.on : setting.off}
            control={
              <Switch
                id={`slack-${setting.key}`}
                checked={on}
                disabled={save.isPending}
                onCheckedChange={(checked) => change({ [setting.key]: checked })}
              />
            }
          />
        );
      })}
      {save.isError ? (
        <Failed>
          Mend didn't save the Slack app's settings.{" "}
          {failureWords(save.error, "Check your connection and try again.")}
        </Failed>
      ) : null}
    </>
  );
}

/** The manifest and its steps (first connect only), then both tokens, checked with Slack. */
function ConnectDialog({
  replacing,
  open,
  onClose,
}: {
  readonly replacing: string | null;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => (next ? undefined : onClose())}
      size="lg"
      title={replacing === null ? "Connect Slack" : `Replace the tokens for ${replacing}`}
      description={
        replacing === null
          ? "Make the app in Slack from Mend's manifest, then paste its two tokens. Mend checks both with Slack before it saves them."
          : `Tokens for ${replacing} keep its Slack links and channel projects. Tokens for another workspace start over: its links and channel projects are deleted.`
      }
      footer={null}
    >
      {open ? <ConnectForm replacing={replacing} onClose={onClose} /> : null}
    </Overlay>
  );
}

function ConnectForm({
  replacing,
  onClose,
}: {
  readonly replacing: string | null;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const phone = usePhone();
  const refresh = useRefresh();
  const manifest = useQuery({ ...trpc.slack.manifest.queryOptions(), enabled: replacing === null });
  // It carries both tokens: gone from the mutation cache once nothing shows its result.
  const connect = useMutation(trpc.slack.connect.mutationOptions({ gcTime: 0 }));
  const [appToken, setAppToken] = useState("");
  const [botToken, setBotToken] = useState("");
  const submit = async () => {
    const tokens = { appToken: appToken.trim(), botToken: botToken.trim() };
    // Gone from the page the moment they are sent; a refusal asks for them again.
    setAppToken("");
    setBotToken("");
    try {
      await connect.mutateAsync(tokens);
      await refresh();
      toast.add({
        description: replacing === null ? "Connected Slack." : "Replaced the Slack app's tokens.",
      });
      onClose();
    } catch {
      // Said under the fields, from the mutation's error.
    }
  };
  const field = "h-9 font-mono max-lg:h-11 max-lg:text-base";
  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {replacing === null ? (
        manifest.isPending ? (
          <p className="text-row text-muted-foreground">Reading Mend's manifest…</p>
        ) : manifest.isError ? (
          <p role="alert" className="text-row text-destructive">
            Mend couldn't read its manifest.{" "}
            {failureWords(manifest.error, "Close this and try again.")}
          </p>
        ) : (
          <div className="grid gap-3">
            <ol className="grid list-decimal gap-1 pl-5 text-row text-pretty text-foreground-2">
              {manifest.data.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <CopyField
              value={manifest.data.manifest}
              label="Copy manifest"
              size={phone ? "touch" : "default"}
              className="max-h-40 overflow-auto"
            />
          </div>
        )
      ) : null}
      <div className="grid gap-1.5">
        <Label htmlFor="slack-app-token">App-level token</Label>
        <Input
          id="slack-app-token"
          type="password"
          value={appToken}
          placeholder="xapp-…"
          autoComplete="off"
          spellCheck={false}
          className={field}
          onChange={(event) => setAppToken(event.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="slack-bot-token">Bot token</Label>
        <Input
          id="slack-bot-token"
          type="password"
          value={botToken}
          placeholder="xoxb-…"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="slack-tokens-help"
          className={field}
          onChange={(event) => setBotToken(event.target.value)}
        />
        <p id="slack-tokens-help" className="text-meta text-muted-foreground">
          Mend seals both tokens when you save, so nobody can read them back. Links Mend posts into
          Slack start with the address you're using now.
        </p>
      </div>
      {connect.isError ? (
        <p role="alert" className="text-row text-destructive">
          {failureWords(connect.error, "Slack didn't answer. Try again.")}
        </p>
      ) : null}
      <div className="flex justify-end gap-2.5 pt-1 max-lg:*:flex-1">
        <Button
          type="button"
          variant="outline"
          size={touch(phone)}
          disabled={connect.isPending}
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size={touch(phone)}
          disabled={connect.isPending || appToken.trim() === "" || botToken.trim() === ""}
        >
          {connect.isPending ? <Spinner aria-hidden /> : null}
          {connect.isPending
            ? "Checking with Slack…"
            : replacing === null
              ? "Connect"
              : "Replace tokens"}
        </Button>
      </div>
    </form>
  );
}

function RemoveSlackDialog({
  teamName,
  open,
  onClose,
}: {
  readonly teamName: string;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const refresh = useRefresh();
  const disconnect = useMutation(trpc.slack.disconnect.mutationOptions());
  const close = () => {
    if (disconnect.isPending) return;
    disconnect.reset();
    onClose();
  };
  const confirm = async () => {
    try {
      await disconnect.mutateAsync();
      await refresh();
      toast.add({ description: "Removed the Slack app." });
      disconnect.reset();
      onClose();
    } catch {
      // Said in the dialog, from the mutation's error.
    }
  };
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => (next ? undefined : close())}
      size="sm"
      title={`Remove the Slack app from ${teamName}?`}
      footer={
        <>
          <Button type="button" variant="outline" disabled={disconnect.isPending} onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={disconnect.isPending}
            onClick={() => void confirm()}
          >
            {disconnect.isPending ? <Spinner aria-hidden /> : null}
            {disconnect.isPending ? "Removing…" : "Remove the Slack app"}
          </Button>
        </>
      }
    >
      <ul className="grid list-disc gap-1.5 pl-5 text-row text-pretty text-foreground-2">
        {SLACK_REMOVAL_FACTS.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
      {disconnect.isError ? (
        <p role="alert" className="mt-3 text-row text-destructive">
          Mend didn't remove the Slack app. {failureWords(disconnect.error, "Try again.")}
        </p>
      ) : null}
    </Overlay>
  );
}

/** Everyone's Slack link in the organization; an owner removes any of them. */
function LinksDialog({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
  const trpc = useTRPC();
  const phone = usePhone();
  const refresh = useRefresh();
  const links = useQuery(trpc.slack.links.queryOptions());
  const remove = useMutation(trpc.slack.removeLink.mutationOptions({ onSettled: refresh }));
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => {
        if (next || remove.isPending) return;
        setConfirming(null);
        remove.reset();
        onClose();
      }}
      size="md"
      title="Linked people"
      description="Each link joins one Slack user to one Mend account, made by that person from Slack, never by email."
      footer={null}
    >
      {links.isPending ? (
        <p className="text-row text-muted-foreground">Reading the links…</p>
      ) : links.isError ? (
        <p role="alert" className="text-row text-destructive">
          Mend couldn't read the links. {failureWords(links.error, "Try again.")}{" "}
          <button
            type="button"
            className="font-medium text-foreground underline underline-offset-2"
            onClick={() => void links.refetch()}
          >
            Try again
          </button>
        </p>
      ) : links.data.length === 0 ? (
        <p className="text-row text-muted-foreground">
          Nobody has linked their account yet. A person mentions @mend in Slack, and Mend sends them
          a link only they see.
        </p>
      ) : (
        <ul aria-label="Linked people" className="divide-y divide-border border-y border-border">
          {links.data.map((link) => (
            <li key={link.slackUserId} className="flex items-center gap-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{link.userName}</span>
                <span className="block font-mono text-meta text-muted-foreground">
                  Slack user {link.slackUserId}
                </span>
              </span>
              {confirming === link.slackUserId ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size={phone ? "touch" : "sm"}
                    disabled={remove.isPending}
                    onClick={() => setConfirming(null)}
                  >
                    Keep
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size={phone ? "touch" : "sm"}
                    disabled={remove.isPending}
                    onClick={() =>
                      remove.mutate(
                        { slackUserId: link.slackUserId },
                        {
                          onSuccess: () => {
                            setConfirming(null);
                            toast.add({ description: `Removed ${link.userName}'s Slack link.` });
                          },
                        },
                      )
                    }
                  >
                    {remove.isPending ? <Spinner aria-hidden /> : null}
                    Remove link
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size={phone ? "touch" : "sm"}
                  aria-label={`Remove ${link.userName}'s Slack link…`}
                  onClick={() => {
                    remove.reset();
                    setConfirming(link.slackUserId);
                  }}
                >
                  Remove…
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {confirming === null ? null : (
        <p className="mt-3 text-row text-muted-foreground">
          Their mentions stop starting sessions until they link again from Slack.
        </p>
      )}
      {remove.isError ? (
        <p role="alert" className="mt-3 text-row text-destructive">
          Mend didn't remove the link. {failureWords(remove.error, "Try again.")}
        </p>
      ) : null}
    </Overlay>
  );
}

// --- Executor -------------------------------------------------------------------------------------

function ExecutorSection({ owner }: { readonly owner: boolean }) {
  const trpc = useTRPC();
  const { organizationName } = useViewer();
  const configuration = useQuery(trpc.executor.configuration.queryOptions());
  if (configuration.isPending) {
    return (
      <AppHeader
        mark={<WorkflowIcon aria-hidden />}
        name="Executor"
        line="Reading Executor's settings…"
      />
    );
  }
  if (configuration.isError) {
    return (
      <AppHeader
        mark={<WorkflowIcon aria-hidden />}
        name="Executor"
        line={`Mend couldn't read Executor's settings. ${failureWords(configuration.error, "Try again.")}`}
        control={
          <Button type="button" variant="outline" onClick={() => void configuration.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  const saved = configuration.data;
  const about = (
    <>
      Executor connects sessions to tools like Linear and Sentry, and asks you before an agent uses
      one. People link their own accounts in{" "}
      <Link {...settingsLink("a-apps")} className="underline underline-offset-2">
        Connected apps
      </Link>
      .
    </>
  );
  if (!owner) {
    return (
      <AppHeader
        mark={<WorkflowIcon aria-hidden />}
        name="Executor"
        line={
          saved.mode === null
            ? `${organizationName} hasn't set up Executor. An owner sets it up here.`
            : saved.mode === "own"
              ? `${organizationName} uses its own Executor${saved.url === null ? "" : ` at ${saved.url}`}.`
              : `Mend runs Executor for ${organizationName}.`
        }
        note={<span>{about}</span>}
      />
    );
  }
  return <OwnerExecutor saved={saved} about={about} />;
}

type ExecutorSaved = ExecutorConfigurationDto;

function OwnerExecutor({
  saved,
  about,
}: {
  readonly saved: ExecutorSaved;
  readonly about: ReactNode;
}) {
  const trpc = useTRPC();
  const phone = usePhone();
  const { organizationName } = useViewer();
  const refresh = useRefresh();
  const manage = useMutation(trpc.executor.manage.mutationOptions({ onSettled: refresh }));
  const [dialog, setDialog] = useState<"mend-run" | "own" | "stop-own" | "remove" | null>(null);
  const managed = saved.managed;
  const running = saved.mode === "mend-run" && managed?.state === "running";
  const upgrade =
    running &&
    managed !== undefined &&
    managed.image !== null &&
    managed.image !== managed.releaseImage
      ? versionOf(managed.releaseImage)
      : null;
  const line =
    saved.mode === "own"
      ? `Your own Executor at ${saved.url ?? "an address not set"}.`
      : saved.mode === "mend-run" && managed !== undefined
        ? managedLine(managed)
        : "Not set up.";
  const act = (action: "start" | "stop" | "upgrade") =>
    manage.mutate(
      { action },
      {
        onSuccess: () =>
          toast.add({
            description:
              action === "start"
                ? "Executor is starting."
                : action === "stop"
                  ? "Stopped Executor."
                  : "Executor is upgrading.",
          }),
      },
    );
  const busy = manage.isPending ? manage.variables.action : null;
  return (
    <>
      <AppHeader
        mark={<WorkflowIcon aria-hidden />}
        name="Executor"
        line={line}
        note={<span>{about}</span>}
        control={
          saved.mode !== "mend-run" || managed === undefined ? undefined : (
            <>
              {upgrade === null ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size={touch(phone)}
                  disabled={manage.isPending}
                  onClick={() => act("upgrade")}
                >
                  {busy === "upgrade" ? <Spinner aria-hidden /> : null}
                  {busy === "upgrade" ? "Backing up…" : `Upgrade to ${upgrade}`}
                </Button>
              )}
              {managed.state === "running" ? (
                <Button
                  type="button"
                  variant="outline"
                  size={touch(phone)}
                  disabled={manage.isPending}
                  onClick={() => act("stop")}
                >
                  {busy === "stop" ? <Spinner aria-hidden /> : null}
                  {busy === "stop" ? "Stopping…" : "Stop Executor"}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size={touch(phone)}
                  disabled={manage.isPending}
                  onClick={() => act("start")}
                >
                  {busy === "start" ? <Spinner aria-hidden /> : null}
                  {busy === "start" ? "Starting…" : "Start Executor"}
                </Button>
              )}
            </>
          )
        }
      />
      {manage.isError ? (
        <Failed>
          Executor didn't {manage.variables.action}. {failureWords(manage.error, "Try again.")}
        </Failed>
      ) : null}
      {managed?.reason === null || managed?.reason === undefined ? null : (
        <InlineAlert tone="info" className="mt-3 max-lg:mx-4">
          {managed.reason}
        </InlineAlert>
      )}
      <SettingRow
        label="Who runs it"
        layout="stack"
        description="Mend can run Executor on this server, or connect to one you run yourself."
        control={
          <Segmented
            aria-label="Who runs Executor"
            value={saved.mode ?? "none"}
            size={phone ? "touch" : "default"}
            onValueChange={(value) => {
              if (value === "mend-run" || value === "own") setDialog(value);
            }}
            options={[
              { value: "mend-run", label: "Mend runs it", disabled: !saved.mendRunAvailable },
              { value: "own", label: "Use your own" },
            ]}
          />
        }
      />
      {saved.mode === "own" ? (
        <SettingRow
          label="Your Executor's address"
          layout="stack"
          description={`${saved.url ?? "Not set"}. Changing or clearing it revokes everyone's links; people link again at the new Executor.`}
          control={
            <>
              <Button
                type="button"
                variant="outline"
                size={touch(phone)}
                onClick={() => setDialog("own")}
              >
                Change…
              </Button>
              <Button
                type="button"
                variant="ghost"
                size={touch(phone)}
                onClick={() => setDialog("stop-own")}
              >
                Stop using it…
              </Button>
            </>
          }
        />
      ) : null}
      {saved.mode === null ? null : <MemberLinkRow saved={saved} />}
      {saved.mode === "mend-run" && saved.member.state === "active" ? (
        <SharedExecutorServices />
      ) : null}
      {saved.mode === "mend-run" && managed?.retained === true ? (
        <SettingRow
          label="Remove Executor"
          description={`Sessions lose the tools it connects. Mend deletes ${organizationName}'s service logins, its services, its data, its backups and everyone's linked accounts.`}
          control={
            <Button
              type="button"
              variant="destructive"
              size={touch(phone)}
              onClick={() => setDialog("remove")}
            >
              Remove Executor…
            </Button>
          }
        />
      ) : null}
      <MendRunDialog saved={saved} open={dialog === "mend-run"} onClose={() => setDialog(null)} />
      <OwnExecutorDialog saved={saved} open={dialog === "own"} onClose={() => setDialog(null)} />
      <StopOwnDialog open={dialog === "stop-own"} onClose={() => setDialog(null)} />
      <RemoveExecutorDialog open={dialog === "remove"} onClose={() => setDialog(null)} />
    </>
  );
}

/**
 * The shared account calls use when their person has no link of their own (docs/adr/0025,
 * decision 3: your own link is used first). With your own Executor an owner links it; with the
 * Executor Mend runs, Mend made it.
 */
function MemberLinkRow({ saved }: { readonly saved: ExecutorSaved }) {
  const trpc = useTRPC();
  const phone = usePhone();
  const { organizationName } = useViewer();
  const refresh = useRefresh();
  const begin = useMutation(
    trpc.executor.begin.mutationOptions({
      gcTime: 0,
      onSuccess: (result) => window.location.assign(result.url),
    }),
  );
  const unlink = useMutation(trpc.executor.unlink.mutationOptions({ onSettled: refresh }));
  const state = saved.member.state;
  const words =
    state === "active"
      ? `Linked. Sessions whose person has no link of their own use ${organizationName}'s shared account.`
      : state === "refused"
        ? "Executor refused the shared account's link. Link it again."
        : "Not linked. Sessions whose person has no link of their own reach no services.";
  return (
    <SettingRow
      label="Shared account"
      layout="stack"
      description={words}
      note={
        begin.isError || unlink.isError ? (
          <p role="alert" className="text-destructive">
            {failureWords(begin.error ?? unlink.error, "Executor didn't answer. Try again.")}
          </p>
        ) : undefined
      }
      control={
        saved.mode === "own" ? (
          <>
            <Button
              type="button"
              variant="outline"
              size={touch(phone)}
              disabled={begin.isPending || unlink.isPending}
              onClick={() => begin.mutate({ target: "member" })}
            >
              {begin.isPending ? <Spinner aria-hidden /> : null}
              {state === "active" ? "Link again" : state === "refused" ? "Link again" : "Link"}
            </Button>
            {state === "unlinked" ? null : (
              <Button
                type="button"
                variant="ghost"
                size={touch(phone)}
                disabled={begin.isPending || unlink.isPending}
                onClick={() => unlink.mutate({ target: "member" })}
              >
                {unlink.isPending ? "Unlinking…" : "Unlink"}
              </Button>
            )}
          </>
        ) : undefined
      }
    />
  );
}

function MendRunDialog({
  saved,
  open,
  onClose,
}: {
  readonly saved: ExecutorSaved;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const { organizationName } = useViewer();
  const refresh = useRefresh();
  const configure = useMutation(trpc.executor.configure.mutationOptions());
  const manage = useMutation(trpc.executor.manage.mutationOptions());
  const pending = configure.isPending || manage.isPending;
  const memory = saved.managed === undefined ? null : saved.managed.memoryBytes;
  const close = () => {
    if (pending) return;
    configure.reset();
    manage.reset();
    onClose();
  };
  const confirm = async () => {
    try {
      if (saved.mode === "own") await configure.mutateAsync(null);
      await manage.mutateAsync({ action: "start" });
      await refresh();
      toast.add({ description: "Executor is starting." });
      onClose();
    } catch {
      await refresh();
    }
  };
  const failure = configure.error ?? manage.error;
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => (next ? undefined : close())}
      size="sm"
      title={`Let Mend run Executor for ${organizationName}?`}
      description={`Sealant runs one Executor for ${organizationName} on this server${memory === null ? "" : `, using about ${(memory / 1024 ** 3).toFixed(1)} GiB of memory`}. Mend adds no services for anyone.`}
      footer={
        <>
          <Button type="button" variant="outline" disabled={pending} onClick={close}>
            Cancel
          </Button>
          <Button type="button" disabled={pending} onClick={() => void confirm()}>
            {pending ? <Spinner aria-hidden /> : null}
            {pending ? "Starting…" : "Start Executor"}
          </Button>
        </>
      }
    >
      {saved.mode === "own" ? (
        <p className="text-row text-pretty text-foreground-2">
          Mend stops using your Executor at {saved.url ?? "its address"}, and everyone's links to it
          are revoked.
        </p>
      ) : null}
      {failure === null ? null : (
        <p role="alert" className="mt-3 text-row text-destructive">
          {failureWords(failure, "Executor didn't start. Try again.")}
        </p>
      )}
    </Overlay>
  );
}

function OwnExecutorDialog({
  saved,
  open,
  onClose,
}: {
  readonly saved: ExecutorSaved;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => (next ? undefined : onClose())}
      size="md"
      title="Use your own Executor"
      description="People consent at your Executor. Mend keeps their grants on its server and relays tools through each session's mend MCP server."
      footer={null}
    >
      {open ? <OwnExecutorForm saved={saved} onClose={onClose} /> : null}
    </Overlay>
  );
}

function OwnExecutorForm({
  saved,
  onClose,
}: {
  readonly saved: ExecutorSaved;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const phone = usePhone();
  const refresh = useRefresh();
  const configure = useMutation(trpc.executor.configure.mutationOptions());
  const [url, setUrl] = useState(saved.mode === "own" ? (saved.url ?? "") : "");
  const submit = async () => {
    try {
      await configure.mutateAsync({ mode: "own", url: url.trim() });
      await refresh();
      toast.add({ description: "Saved your Executor's address." });
      onClose();
    } catch {
      // Said under the field, from the mutation's error.
    }
  };
  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="executor-url">Executor address</Label>
        <Input
          id="executor-url"
          type="url"
          value={url}
          placeholder="https://executor.example.org"
          autoComplete="off"
          spellCheck={false}
          className="h-9 font-mono max-lg:h-11 max-lg:text-base"
          onChange={(event) => setUrl(event.target.value)}
        />
        <p className="text-meta text-muted-foreground">
          {saved.mode === "mend-run"
            ? "Stop the Executor Mend runs first; its data stays until you remove it."
            : "Changing the address revokes everyone's links; people link again at the new Executor."}
        </p>
      </div>
      {configure.isError ? (
        <p role="alert" className="text-row text-destructive">
          {failureWords(configure.error, "Mend didn't save the address. Try again.")}
        </p>
      ) : null}
      <div className="flex justify-end gap-2.5 pt-1 max-lg:*:flex-1">
        <Button
          type="button"
          variant="outline"
          size={touch(phone)}
          disabled={configure.isPending}
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size={touch(phone)}
          disabled={configure.isPending || url.trim() === ""}
        >
          {configure.isPending ? <Spinner aria-hidden /> : null}
          {configure.isPending ? "Saving…" : "Save address"}
        </Button>
      </div>
    </form>
  );
}

function StopOwnDialog({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const refresh = useRefresh();
  const configure = useMutation(trpc.executor.configure.mutationOptions());
  const close = () => {
    if (configure.isPending) return;
    configure.reset();
    onClose();
  };
  const confirm = async () => {
    try {
      await configure.mutateAsync(null);
      await refresh();
      toast.add({ description: "Stopped using your Executor." });
      configure.reset();
      onClose();
    } catch {
      // Said in the dialog.
    }
  };
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => (next ? undefined : close())}
      size="sm"
      title="Stop using your Executor?"
      description="Mend forgets its address and revokes everyone's links to it. Sessions lose the tools it connects."
      footer={
        <>
          <Button type="button" variant="outline" disabled={configure.isPending} onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={configure.isPending}
            onClick={() => void confirm()}
          >
            {configure.isPending ? <Spinner aria-hidden /> : null}
            {configure.isPending ? "Stopping…" : "Stop using it"}
          </Button>
        </>
      }
    >
      {configure.isError ? (
        <p role="alert" className="text-row text-destructive">
          {failureWords(configure.error, "Mend didn't change it. Try again.")}
        </p>
      ) : null}
    </Overlay>
  );
}

function RemoveExecutorDialog({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const { organizationName } = useViewer();
  const refresh = useRefresh();
  const manage = useMutation(trpc.executor.manage.mutationOptions());
  const close = () => {
    if (manage.isPending) return;
    manage.reset();
    onClose();
  };
  const confirm = async () => {
    try {
      await manage.mutateAsync({ action: "remove" });
      await refresh();
      toast.add({ description: "Removed Executor." });
      manage.reset();
      onClose();
    } catch {
      // Said in the dialog.
    }
  };
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => (next ? undefined : close())}
      size="sm"
      title={`Remove ${organizationName}'s Executor?`}
      description={`Mend deletes ${organizationName}'s service logins, its services, its data, its saved backups and everyone's Executor links. You can't undo this.`}
      footer={
        <>
          <Button type="button" variant="outline" disabled={manage.isPending} onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={manage.isPending}
            onClick={() => void confirm()}
          >
            {manage.isPending ? <Spinner aria-hidden /> : null}
            {manage.isPending ? "Removing…" : "Remove Executor"}
          </Button>
        </>
      }
    >
      {manage.isError ? (
        <p role="alert" className="text-row text-destructive">
          {failureWords(manage.error, "Executor wasn't removed. Try again.")}
        </p>
      ) : null}
    </Overlay>
  );
}
