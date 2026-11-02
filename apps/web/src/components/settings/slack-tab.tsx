import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button, Pick } from "#/components/kit/button";
import { CopyButton } from "#/components/kit/copy-button";
import { Field, FieldPair, TextInput } from "#/components/kit/field";
import { FuzzyFinder } from "#/components/kit/finder";
import { ModalDialog } from "#/components/kit/modal";
import { FoldSection, Panel, SettingsSection } from "#/components/kit/section";
import { Segment } from "#/components/kit/segment";
import { ErrorNote, errorText, StatusWord } from "#/components/kit/status";
import { SwitchRow } from "#/components/kit/switch";
import { DataTable } from "#/components/kit/table";
import type {
  SlackAppDto,
  SlackAppStatusDto,
  SlackLinkDto,
  SlackMeDto,
  SlackSettingsDto,
} from "#/lib/api";
import { documentWriter } from "#/lib/optimistic";
import {
  defaultProjectOptions,
  SLACK_DISPLAY_SETTINGS,
  SLACK_REMOVAL_FACTS,
  slackLinkLine,
  slackUploadNotice,
} from "#/lib/slack";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

import { CaptionedControl, day, Notice, useOrganizationView } from "./org-parts";

/** The app's thread settings: every switch and the default agent share one writer. */
const slackSettingsWriter = documentWriter<
  SlackAppStatusDto,
  Partial<SlackSettingsDto>,
  SlackAppDto
>({
  overlay: (status, patch) =>
    status.app === null
      ? status
      : { ...status, app: { ...status.app, settings: { ...status.app.settings, ...patch } } },
  saved: (status, app) => ({ ...status, app }),
});

/** The person's own default project, picked again before the last pick answered. */
const slackMeWriter = documentWriter<
  SlackMeDto,
  { readonly projectId: SlackMeDto["defaultProjectId"] },
  SlackMeDto
>({
  overlay: (me, { projectId }) => ({ ...me, defaultProjectId: projectId }),
  saved: (_me, saved) => saved,
});

/** Everything Slack-shaped is read again after a change, and the audit log that records it. */
const useSlackRefresh = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries(trpc.slack.pathFilter()),
      queryClient.invalidateQueries(trpc.organization.audit.pathFilter()),
    ]);
};

/**
 * O5 · Slack (docs/adr/0006-slack.md): the organization's own Slack app, connected over Socket
 * Mode, outbound only. Owners connect it from Mend's manifest, set what Mend posts in threads and
 * manage Slack links; everyone sees their own Slack link and picks the project a mention runs in
 * when nothing else answers. Tokens are never shown once saved.
 */
export function SlackTab() {
  const trpc = useTRPC();
  const view = useOrganizationView();
  const me = useSuspenseQuery(trpc.slack.me.queryOptions(undefined, { retry: false })).data;
  return (
    <Panel>
      {view.role === "owner" ? <OwnerSections /> : null}
      <YourLink me={me} />
    </Panel>
  );
}

function OwnerSections() {
  const trpc = useTRPC();
  const status = useSuspenseQuery(
    trpc.slack.app.queryOptions(undefined, { staleTime: 60_000 }),
  ).data;
  const app = status.app;
  if (app === null) {
    return (
      <SettingsSection
        title="Slack app"
        why="Each organization runs its own Slack app, made from Mend's manifest. Mend connects out to Slack; Slack never connects to this instance."
      >
        <StatusWord tone="off">not connected</StatusWord>
        <ConnectForm replacing={null} onDone={() => undefined} />
      </SettingsSection>
    );
  }
  return (
    <>
      <AppSection app={app} />
      <ThreadSettings app={app} harnesses={status.harnesses} />
      <LinksSection />
    </>
  );
}

/** The manifest, the steps around it, and both tokens, checked with Slack before anything saves. */
function ConnectForm({
  replacing,
  onDone,
}: {
  /** The workspace whose tokens these replace; null connects the first time. */
  readonly replacing: string | null;
  readonly onDone: () => void;
}) {
  const trpc = useTRPC();
  const manifest = useQuery(trpc.slack.manifest.queryOptions());
  const refresh = useSlackRefresh();
  const [appToken, setAppToken] = useState("");
  const [botToken, setBotToken] = useState("");
  const connect = useMutation(
    trpc.slack.connect.mutationOptions({
      // It carries a credential: gone from the mutation cache once nothing shows its result.
      gcTime: 0,
      onSuccess: () => {
        setAppToken("");
        setBotToken("");
        onDone();
      },
      onSettled: refresh,
    }),
  );
  return (
    <form
      className="mt-3"
      onSubmit={(event) => {
        event.preventDefault();
        connect.mutate({ appToken: appToken.trim(), botToken: botToken.trim() });
      }}
    >
      {replacing === null ? (
        manifest.data === undefined ? (
          <p className="mb-3 font-mono text-[12px] text-faint">
            {manifest.isError ? errorText(manifest.error) : "reading the manifest…"}
          </p>
        ) : (
          <>
            <ol className="mb-3 grid list-decimal gap-1 pl-5 text-[13px] leading-relaxed text-ink-2">
              {manifest.data.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <Manifest text={manifest.data.manifest} />
          </>
        )
      ) : (
        <p className="mb-3 text-[13px] leading-relaxed text-muted-foreground">
          Tokens for {replacing} keep its Slack links and channel defaults. Tokens for another
          workspace start over: its links and channel defaults are deleted.
        </p>
      )}
      <FieldPair>
        <Field label="App-level token">
          {(id) => (
            <TextInput
              id={id}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="xapp-…"
              value={appToken}
              onChange={(event) => setAppToken(event.target.value)}
            />
          )}
        </Field>
        <Field label="Bot token">
          {(id) => (
            <TextInput
              id={id}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="xoxb-…"
              value={botToken}
              onChange={(event) => setBotToken(event.target.value)}
            />
          )}
        </Field>
      </FieldPair>
      <p className="mb-3 text-[12.5px] text-muted-foreground">
        Both tokens are sealed at rest and never shown again. Links Mend posts into Slack start with
        the address you are using now.
      </p>
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={connect.isPending || appToken.trim() === "" || botToken.trim() === ""}
        >
          {connect.isPending ? "Checking with Slack…" : "Check and connect"}
        </Button>
        {replacing === null ? null : (
          <Button variant="ghost" disabled={connect.isPending} onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
      {connect.error === null ? null : (
        <ErrorNote className="mt-3">{errorText(connect.error)}</ErrorNote>
      )}
    </form>
  );
}

/** The manifest to paste into Slack, with Copy. */
function Manifest({ text }: { readonly text: string }) {
  return (
    <div className="mb-4 rounded-[10px] border border-input bg-panel">
      <div className="flex items-center gap-2 border-b border-rule-faint px-3 py-1.5">
        <span className="font-mono text-[11.5px] text-muted-foreground">manifest.json</span>
        <span className="flex-1" />
        <CopyButton text={text} label="the manifest" />
      </div>
      <pre className="max-h-56 overflow-auto px-3 py-2 font-mono text-[12px] leading-relaxed text-ink-2">
        {text}
      </pre>
    </div>
  );
}

function AppSection({ app }: { readonly app: SlackAppDto }) {
  const trpc = useTRPC();
  const refresh = useSlackRefresh();
  const [dialog, setDialog] = useState<"replace" | "remove" | null>(null);
  const manifest = useQuery({ ...trpc.slack.manifest.queryOptions(), enabled: false });
  const disconnect = useMutation(
    trpc.slack.disconnect.mutationOptions({
      onSuccess: () => setDialog(null),
      onSettled: refresh,
    }),
  );
  const uploadNotice = slackUploadNotice(app.grantedScopes);
  return (
    <SettingsSection title="Slack app" why="Connected over Socket Mode, outbound only.">
      <StatusWord tone="ok">connected · {app.teamName}</StatusWord>
      <p className="mt-1.5 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
        {app.teamId} · app {app.appId} · bot {app.botUserId} · connected by{" "}
        {app.installedByName ?? "a removed account"} {day(app.installedAt)} · links open{" "}
        {app.webOrigin}
      </p>
      {uploadNotice === null ? null : <Notice>{uploadNotice}</Notice>}
      <div className="mt-2.5 flex gap-2">
        <Button size="sm" onClick={() => setDialog("replace")}>
          Replace tokens…
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={manifest.isFetching}
          onClick={() => void manifest.refetch()}
        >
          {manifest.isFetching ? "Reading…" : "Manifest"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDialog("remove")}>
          Remove…
        </Button>
      </div>
      {manifest.data === undefined ? null : (
        <div className="mt-3">
          <Manifest text={manifest.data.manifest} />
        </div>
      )}
      {manifest.error === null ? null : (
        <ErrorNote className="mt-3">{errorText(manifest.error)}</ErrorNote>
      )}
      <ModalDialog
        open={dialog === "replace"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title={`Replace the tokens for ${app.teamName}`}
        width={560}
      >
        <ConnectForm replacing={app.teamName} onDone={() => setDialog(null)} />
      </ModalDialog>
      <ModalDialog
        open={dialog === "remove"}
        onOpenChange={(open) => {
          if (!open && !disconnect.isPending) setDialog(null);
        }}
        title={`Remove the Slack app from ${app.teamName}?`}
        width={520}
        footer={
          <>
            <Button variant="ghost" disabled={disconnect.isPending} onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              className="border-danger text-danger"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              {disconnect.isPending ? "Removing…" : "Remove the Slack app"}
            </Button>
          </>
        }
      >
        <ul className="grid list-disc gap-1 pl-5 text-[13px] leading-relaxed text-muted-foreground">
          {SLACK_REMOVAL_FACTS.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
        {disconnect.error === null ? null : <ErrorNote>{errorText(disconnect.error)}</ErrorNote>}
      </ModalDialog>
    </SettingsSection>
  );
}

/**
 * What Mend posts and does from Slack, and the agent a mention starts when it names none. Each
 * change shows at once and goes back if the server refuses it.
 */
function ThreadSettings({
  app,
  harnesses,
}: {
  readonly app: SlackAppDto;
  readonly harnesses: ReadonlyArray<string>;
}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const status = slackSettingsWriter.useVisible(useQuery(trpc.slack.app.queryOptions()).data);
  const settings = status?.app?.settings ?? app.settings;
  const save = useMutation(
    slackSettingsWriter.options({
      queryClient,
      documentKey: trpc.slack.app.queryKey(),
      mutationKey: trpc.slack.setSettings.mutationKey(),
      send: (patch, latest) => {
        if (latest.app === null) throw new Error("Slack is not connected any more.");
        return client.slack.setSettings.mutate({ settings: { ...latest.app.settings, ...patch } });
      },
    }),
  );
  const change = (next: Partial<SlackSettingsDto>) => save.mutate(next);
  return (
    <SettingsSection title="In threads" why="What Mend posts and does from Slack.">
      <CaptionedControl caption="Default agent">
        <Segment
          label="Default agent"
          value={settings.defaultHarness}
          onChange={(defaultHarness) => change({ defaultHarness })}
          options={harnesses.map((harness) => ({ value: harness, label: harness }))}
        />
      </CaptionedControl>
      <div>
        {SLACK_DISPLAY_SETTINGS.map((setting) => {
          const on = settings[setting.key];
          return (
            <SwitchRow
              key={setting.key}
              label={setting.label}
              detail={on ? setting.on : setting.off}
              checked={on}
              onCheckedChange={(checked) => change({ [setting.key]: checked })}
            />
          );
        })}
      </div>
      {save.error === null ? null : <ErrorNote className="mt-3">{errorText(save.error)}</ErrorNote>}
    </SettingsSection>
  );
}

/** Every Slack link in the organization; an owner can remove any of them. */
function LinksSection() {
  const trpc = useTRPC();
  const links = useQuery(trpc.slack.links.queryOptions());
  const refresh = useSlackRefresh();
  const [removing, setRemoving] = useState<SlackLinkDto | null>(null);
  const remove = useMutation(
    trpc.slack.removeLink.mutationOptions({
      onSuccess: () => setRemoving(null),
      onSettled: refresh,
    }),
  );
  const rows = links.data ?? [];
  return (
    <FoldSection
      title="Slack links"
      count={links.data === undefined ? "…" : `${rows.length}`}
      why="Each joins one Slack user to one Mend account, made by that person, never by email."
      summary={
        rows.length === 0
          ? "no Slack links yet"
          : rows
              .slice(0, 3)
              .map((link) => link.userName)
              .join(" · ") + (rows.length > 3 ? ` · and ${rows.length - 3} more` : "")
      }
      defaultOpen={false}
    >
      {links.error === null ? null : <ErrorNote>{errorText(links.error)}</ErrorNote>}
      <DataTable
        label="Slack links"
        columns={[
          { head: "Person", width: "1fr" },
          { head: "Slack user", width: "1fr" },
          { head: "Linked", width: "0.7fr" },
          { head: "", width: "auto" },
        ]}
        empty={links.isPending ? "reading…" : "no Slack links yet"}
        rows={rows.map((link) => ({
          key: link.slackUserId,
          cells: [
            <span key="name">{link.userName}</span>,
            <span key="slack" className="font-mono text-[12px] text-ink-2">
              {link.slackUserId}
            </span>,
            <span key="linked" className="font-mono text-[12px] text-muted-foreground">
              {day(link.createdAt)}
            </span>,
            <Button
              key="remove"
              size="sm"
              variant="ghost"
              aria-label={`Remove ${link.userName}'s Slack link`}
              onClick={() => {
                remove.reset();
                setRemoving(link);
              }}
            >
              Remove…
            </Button>,
          ],
        }))}
      />
      <ModalDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setRemoving(null);
        }}
        title={`Remove ${removing?.userName ?? ""}'s Slack link?`}
        description="Their mentions stop starting sessions until they link again from Slack."
        width={480}
        footer={
          <>
            <Button variant="ghost" disabled={remove.isPending} onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              className="border-danger text-danger"
              disabled={remove.isPending || removing === null}
              onClick={() => {
                if (removing !== null) remove.mutate({ slackUserId: removing.slackUserId });
              }}
            >
              {remove.isPending ? "Removing…" : "Remove the Slack link"}
            </Button>
          </>
        }
      >
        {remove.error === null ? null : <ErrorNote>{errorText(remove.error)}</ErrorNote>}
      </ModalDialog>
    </FoldSection>
  );
}

const NO_DEFAULT = { id: null, label: "none" } as const;

/** The signed-in person's Slack link and default project; everyone in the organization sees it. */
function YourLink({ me }: { readonly me: SlackMeDto }) {
  const trpc = useTRPC();
  const projects = useQuery(trpc.projects.list.queryOptions());
  const refresh = useSlackRefresh();
  const unlink = useMutation(trpc.slack.unlink.mutationOptions({ onSettled: refresh }));
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const shown = slackMeWriter.useVisible(me) ?? me;
  const setDefault = useMutation(
    slackMeWriter.options({
      queryClient,
      documentKey: trpc.slack.me.queryKey(),
      mutationKey: trpc.slack.setDefaultProject.mutationKey(),
      send: (change) => client.slack.setDefaultProject.mutate(change),
    }),
  );
  const options = [NO_DEFAULT, ...defaultProjectOptions(projects.data ?? [])];
  const picked = options.find((option) => option.id === shown.defaultProjectId) ?? NO_DEFAULT;
  const error = unlink.error ?? setDefault.error ?? projects.error;
  return (
    <SettingsSection
      title="Your Slack link"
      why="Joins your Slack user to your Mend account. Never by email."
    >
      <StatusWord tone={me.link === null ? "off" : "ok"}>
        {me.link === null
          ? me.workspace === null
            ? "Slack not connected"
            : "not linked"
          : `linked · ${me.link.slackUserId} · ${day(me.link.createdAt)}`}
      </StatusWord>
      <p className="mt-1.5 mb-3 text-[13px] text-muted-foreground">{slackLinkLine(me)}</p>
      {me.workspace === null ? null : (
        <CaptionedControl caption="Your default project">
          <FuzzyFinder
            label="Your default project"
            items={options}
            itemKey={(option) => option.id ?? "none"}
            itemText={(option) => option.label}
            placeholder="Find a project"
            onPick={(option) => {
              if (option.id !== shown.defaultProjectId) setDefault.mutate({ projectId: option.id });
            }}
            trigger={<Pick className="w-fit">{picked.label}</Pick>}
          />
          <p className="text-[12.5px] text-muted-foreground">
            Where a mention runs when it names no project and neither the thread nor the channel
            gives one.
          </p>
        </CaptionedControl>
      )}
      {me.link === null ? null : (
        <Button
          size="sm"
          variant="ghost"
          disabled={unlink.isPending}
          onClick={() => unlink.mutate()}
        >
          {unlink.isPending ? "Unlinking…" : "Unlink"}
        </Button>
      )}
      {error === null ? null : <ErrorNote className="mt-3">{errorText(error)}</ErrorNote>}
    </SettingsSection>
  );
}
