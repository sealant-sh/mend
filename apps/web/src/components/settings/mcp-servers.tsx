import {
  type McpSecretKind,
  mcpSecretNameIssue,
  mcpServerNameIssue,
  mcpServerUrlIssue,
  secretKindOf,
} from "@mend/domain/workbench";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import { Button } from "#/components/kit/button";
import { Field, FieldSource, GroupField, TextInput } from "#/components/kit/field";
import { ModalDialog } from "#/components/kit/modal";
import { Panel, SettingsSection } from "#/components/kit/section";
import { Segment } from "#/components/kit/segment";
import { ErrorNote, errorText } from "#/components/kit/status";
import { SwitchRow } from "#/components/kit/switch";
import { DataTable } from "#/components/kit/table";
import { TextArea } from "#/components/kit/text-area";
import type { McpServerDto } from "#/lib/api";
import { useTRPC, type TrpcProxy } from "#/lib/trpc";
import { useSignedInQuery, useViewer } from "#/lib/viewer";

import { OrganizationExecutorSettings, PersonalExecutorSection } from "./executor.tsx";

export const mcpServersOptions = (trpc: TrpcProxy) =>
  trpc.mcpServers.list.queryOptions(undefined, { staleTime: 30_000 });

type Transport = McpServerDto["transport"];
type TransportKind = Transport["_tag"];

const TRANSPORT_WORDS: Record<TransportKind, string> = { stdio: "stdio", http: "HTTP", sse: "SSE" };

const TRANSPORT_OPTIONS: ReadonlyArray<{ readonly value: TransportKind; readonly label: string }> =
  [
    { value: "stdio", label: "stdio command" },
    { value: "http", label: "HTTP" },
    { value: "sse", label: "SSE" },
  ];

export const targetOf = (transport: Transport): string =>
  transport._tag === "stdio"
    ? [transport.command, ...transport.args].join(" ")
    : (URL.parse(transport.url)?.host ?? transport.url);

const secretWord = (kind: McpSecretKind) => (kind === "env" ? "env" : "header");

export function McpServersSettings() {
  const trpc = useTRPC();
  const servers = useQuery(mcpServersOptions(trpc));
  const viewer = useViewer();
  const [executorOpen, setExecutorOpen] = useState(() => window.location.hash === "#executor");
  const [editing, setEditing] = useState<McpServerDto | "new" | null>(null);
  const [removing, setRemoving] = useState<McpServerDto | null>(null);
  const toggle = useMutation(
    trpc.mcpServers.save.mutationOptions({
      onSuccess: (_saved, _variables, _result, { client }) =>
        client.invalidateQueries(trpc.mcpServers.list.queryFilter()),
    }),
  );
  const list = servers.data;
  const full = list !== undefined && list.servers.length >= list.limits.servers;
  const executorRow =
    viewer === null
      ? []
      : [{ key: "executor", cells: executorCells(executorOpen, setExecutorOpen) }];

  return (
    <>
      <Panel>
        <SettingsSection
          title="MCP servers"
          why="Your own servers, kept with your account in every organization. Variable and header values are sealed when you save them and never shown again."
        >
          {list === undefined ? (
            servers.isError ? (
              <ErrorNote>Could not read your MCP servers: {errorText(servers.error)}</ErrorNote>
            ) : (
              <p className="font-mono text-[12px] text-faint">reading MCP servers…</p>
            )
          ) : (
            <DataTable
              label="MCP servers"
              columns={[
                { head: "Name", width: "1fr" },
                { head: "Transport", width: "0.6fr" },
                { head: "Target", width: "1.4fr" },
                { head: "Secrets", width: "1.3fr" },
                { head: "", width: "88px" },
                { head: "", width: "136px", align: "end" },
              ]}
              empty="no MCP servers"
              rows={[
                ...list.servers.map((server) => ({
                  key: server.id,
                  cells: [
                    <span key="name" className="font-mono text-[12.5px] break-all text-foreground">
                      {server.name}
                    </span>,
                    <span key="transport" className="font-mono text-[12px] text-muted-foreground">
                      {TRANSPORT_WORDS[server.transport._tag]}
                    </span>,
                    <span
                      key="target"
                      className="block truncate font-mono text-[12px] text-ink-2"
                      title={targetOf(server.transport)}
                    >
                      {targetOf(server.transport)}
                    </span>,
                    <SecretNames
                      key="secrets"
                      kind={secretKindOf(server.transport)}
                      names={server.secretNames}
                    />,
                    <SwitchRow
                      key="enabled"
                      label={
                        <span className="font-mono text-[12px] text-muted-foreground">
                          <span className="sr-only">{server.name} </span>
                          {server.enabled ? "on" : "off"}
                        </span>
                      }
                      checked={
                        toggle.isPending && toggle.variables.name === server.name
                          ? toggle.variables.server.enabled === true
                          : server.enabled
                      }
                      pending={toggle.isPending}
                      onCheckedChange={(enabled) =>
                        toggle.mutate({
                          name: server.name,
                          server: { transport: server.transport, enabled },
                        })
                      }
                    />,
                    <span key="actions" className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Edit ${server.name}`}
                        onClick={() => setEditing(server)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove ${server.name}`}
                        onClick={() => setRemoving(server)}
                      >
                        Remove
                      </Button>
                    </span>,
                  ],
                })),
                ...executorRow,
              ]}
            />
          )}
          {toggle.error === null ? null : (
            <ErrorNote className="mt-3">
              {`${toggle.variables?.name ?? ""} is as it was · ${errorText(toggle.error)}`}
            </ErrorNote>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              size="sm"
              disabled={list === undefined || full}
              onClick={() => setEditing("new")}
            >
              Add an MCP server
            </Button>
            {full ? (
              <span className="font-mono text-[12px] text-faint">
                {list.servers.length} of {list.limits.servers} kept
              </span>
            ) : null}
          </div>
        </SettingsSection>
      </Panel>
      {viewer !== null && executorOpen ? <ExecutorDetail /> : null}
      {editing === null ? null : (
        <ServerDialog
          saved={editing === "new" ? null : editing}
          taken={list?.servers.map((server) => server.name) ?? []}
          onClose={() => setEditing(null)}
        />
      )}
      {removing === null ? null : (
        <RemoveDialog server={removing} onClose={() => setRemoving(null)} />
      )}
    </>
  );
}

function SecretNames({
  kind,
  names,
}: {
  readonly kind: McpSecretKind;
  readonly names: ReadonlyArray<string>;
}) {
  if (names.length === 0) return <span className="font-mono text-[12px] text-faint">none</span>;
  return (
    <span className="flex min-w-0 flex-col font-mono text-[12px] text-muted-foreground">
      {names.map((name) => (
        <span key={name} className="truncate" title={name}>
          {secretWord(kind)} {name} · saved
        </span>
      ))}
    </span>
  );
}

const linkWords = (state: "unlinked" | "active" | "refused") =>
  state === "active"
    ? "linked as you"
    : state === "refused"
      ? "Executor refused your link"
      : "not linked · calls use Mend's member";

const observedTime = (at: Date | null) =>
  at === null
    ? ""
    : ` · observed ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

function executorCells(open: boolean, setOpen: (open: boolean) => void) {
  return [
    <ExecutorName key="name" />,
    <span key="transport" />,
    <ExecutorState key="target" />,
    <ExecutorLinkState key="secrets" />,
    <span key="enabled" />,
    <span key="actions" className="flex justify-end">
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open}
        aria-controls="executor"
        onClick={() => setOpen(!open)}
      >
        {open ? "Close" : "Open"}
      </Button>
    </span>,
  ];
}

const useExecutorConfiguration = () =>
  useQuery(useTRPC().executor.configuration.queryOptions(undefined, { retry: false }));

function ExecutorName() {
  const mode = useExecutorConfiguration().data?.mode;
  return (
    <span className="flex min-w-0 flex-col">
      <span className="text-[13px] text-foreground">Executor</span>
      <span className="font-mono text-[11px] text-faint">
        {mode === undefined
          ? "reading…"
          : mode === null
            ? "not set up"
            : mode === "mend-run"
              ? "Mend-run"
              : "own"}
      </span>
    </span>
  );
}

function ExecutorState() {
  const configuration = useExecutorConfiguration();
  const data = configuration.data;
  const words =
    data === undefined
      ? configuration.isError
        ? "not read"
        : "reading…"
      : data.mode === "mend-run"
        ? data.managed === undefined
          ? "reading runtime…"
          : `${data.managed.state}${observedTime(data.managed.observedAt)}`
        : data.mode === "own" && data.url !== null
          ? (URL.parse(data.url)?.host ?? data.url)
          : "no Executor";
  return <span className="block truncate font-mono text-[12px] text-ink-2">{words}</span>;
}

function ExecutorLinkState() {
  const personal = useQuery(useTRPC().executor.personal.queryOptions(undefined, { retry: false }));
  const data = personal.data;
  const words =
    data === undefined
      ? personal.isError
        ? "not read"
        : "reading…"
      : data.configured
        ? `${linkWords(data.link.state)}${observedTime(data.link.observedAt)}`
        : "no link to make";
  return <span className="font-mono text-[12px] text-muted-foreground">{words}</span>;
}

function ExecutorDetail() {
  const organization = useSignedInQuery().data?.organization.name;
  return (
    <div id="executor" className="mt-6 grid gap-6">
      <Panel>
        <PersonalExecutorSection />
      </Panel>
      <div className="grid gap-2">
        <p className="ev-eyebrow px-1">For {organization ?? "your organization"}</p>
        <OrganizationExecutorSettings />
      </div>
    </div>
  );
}

function RemoveDialog({
  server,
  onClose,
}: {
  readonly server: McpServerDto;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const remove = useMutation(
    trpc.mcpServers.remove.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries(trpc.mcpServers.list.queryFilter());
        onClose();
      },
    }),
  );
  return (
    <ModalDialog
      open
      onOpenChange={(open) => {
        if (!open && !remove.isPending) onClose();
      }}
      title={`Remove ${server.name}?`}
      description={
        server.secretNames.length === 0
          ? "Mend forgets this server. Add it again to use it."
          : "Mend forgets this server and deletes its saved values. Add it again, with its values, to use it."
      }
      width={460}
      footer={
        <>
          <Button variant="ghost" disabled={remove.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={remove.isPending}
            onClick={() => remove.mutate({ name: server.name })}
          >
            {remove.isPending ? "Removing…" : "Remove"}
          </Button>
        </>
      }
    >
      {remove.isError ? <ErrorNote>Not removed: {errorText(remove.error)}</ErrorNote> : null}
    </ModalDialog>
  );
}

type SavedChoice = "keep" | "replace" | "remove";

interface SavedSecret {
  readonly name: string;
  readonly choice: SavedChoice;
  readonly value: string;
}

interface NewSecret {
  readonly key: number;
  readonly name: string;
  readonly value: string;
}

interface Draft {
  readonly name: string;
  readonly kind: TransportKind;
  readonly command: string;
  readonly argLines: string;
  readonly url: string;
  readonly saved: ReadonlyArray<SavedSecret>;
  readonly added: ReadonlyArray<NewSecret>;
}

const draftOf = (saved: McpServerDto | null): Draft => ({
  name: saved?.name ?? "",
  kind: saved?.transport._tag ?? "http",
  command: saved?.transport._tag === "stdio" ? saved.transport.command : "",
  argLines: saved?.transport._tag === "stdio" ? saved.transport.args.join("\n") : "",
  url: saved !== null && saved.transport._tag !== "stdio" ? saved.transport.url : "",
  saved: (saved?.secretNames ?? []).map((name) => ({ name, choice: "keep", value: "" })),
  added: [],
});

type SecretEdit = { readonly _tag: "Keep" } | { readonly _tag: "Set"; readonly value: string };

type Built =
  | { readonly _tag: "Incomplete" }
  | { readonly _tag: "Issue"; readonly issue: string }
  | {
      readonly _tag: "Write";
      readonly transport:
        | { readonly _tag: "stdio"; readonly command: string; readonly args: ReadonlyArray<string> }
        | { readonly _tag: "http" | "sse"; readonly url: string };
      readonly secrets: Readonly<Record<string, SecretEdit>>;
    };

const build = (draft: Draft, saved: McpServerDto | null, taken: ReadonlyArray<string>): Built => {
  if (saved === null) {
    if (draft.name === "") return { _tag: "Incomplete" };
    const issue = mcpServerNameIssue(draft.name);
    if (issue !== null) return { _tag: "Issue", issue };
    if (taken.includes(draft.name))
      return { _tag: "Issue", issue: `you already have ${draft.name}: edit it instead` };
  }
  const kind = secretKindOf({ _tag: draft.kind });
  let transport: Extract<Built, { _tag: "Write" }>["transport"];
  if (draft.kind === "stdio") {
    if (draft.command.trim() === "") return { _tag: "Incomplete" };
    transport = {
      _tag: "stdio",
      command: draft.command.trim(),
      args: draft.argLines.split("\n").filter((line) => line.trim() !== ""),
    };
  } else {
    if (draft.url.trim() === "") return { _tag: "Incomplete" };
    const issue = mcpServerUrlIssue(draft.url.trim());
    if (issue !== null) return { _tag: "Issue", issue };
    transport = { _tag: draft.kind, url: draft.url.trim() };
  }
  const entries: Array<readonly [string, SecretEdit]> = [];
  if (saved !== null && secretKindOf(saved.transport) === kind) {
    for (const secret of draft.saved) {
      if (secret.choice === "keep") entries.push([secret.name, { _tag: "Keep" }]);
      if (secret.choice === "replace") {
        if (secret.value === "") return { _tag: "Incomplete" };
        entries.push([secret.name, { _tag: "Set", value: secret.value }]);
      }
    }
  }
  for (const secret of draft.added) {
    const name = secret.name.trim();
    if (name === "" && secret.value === "") continue;
    if (name === "") return { _tag: "Issue", issue: "a value needs its name" };
    const issue = mcpSecretNameIssue(kind, name);
    if (issue !== null) return { _tag: "Issue", issue };
    if (secret.value === "") return { _tag: "Incomplete" };
    const same = (other: string) =>
      kind === "header" ? other.toLowerCase() === name.toLowerCase() : other === name;
    if (entries.some(([other]) => same(other)))
      return { _tag: "Issue", issue: `${name} is named twice` };
    entries.push([name, { _tag: "Set", value: secret.value }]);
  }
  return { _tag: "Write", transport, secrets: Object.fromEntries(entries) };
};

const SAVED_CHOICES: ReadonlyArray<{ readonly value: SavedChoice; readonly label: string }> = [
  { value: "keep", label: "Keep" },
  { value: "replace", label: "Replace" },
  { value: "remove", label: "Remove" },
];

function ServerDialog({
  saved,
  taken,
  onClose,
}: {
  readonly saved: McpServerDto | null;
  readonly taken: ReadonlyArray<string>;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const formId = useId();
  const [draft, setDraft] = useState<Draft>(() => draftOf(saved));
  const [nextKey, setNextKey] = useState(0);
  const save = useMutation(
    trpc.mcpServers.save.mutationOptions({
      // It carries values: gone from the mutation cache once nothing shows its result.
      gcTime: 0,
      onSuccess: async () => {
        await queryClient.invalidateQueries(trpc.mcpServers.list.queryFilter());
        onClose();
      },
    }),
  );
  const built = build(draft, saved, taken);
  const kind = secretKindOf({ _tag: draft.kind });
  const savedApplies = saved !== null && secretKindOf(saved.transport) === kind;
  const dropped = saved !== null && !savedApplies ? saved.secretNames : [];
  const set = (change: Partial<Draft>) => setDraft((current) => ({ ...current, ...change }));
  const addRow = () => {
    set({ added: [...draft.added, { key: nextKey, name: "", value: "" }] });
    setNextKey(nextKey + 1);
  };
  const noun = kind === "env" ? "variable" : "header";

  return (
    <ModalDialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending) onClose();
      }}
      title={saved === null ? "Add an MCP server" : `Edit ${saved.name}`}
      description={
        kind === "env"
          ? "A command Mend runs with the environment variables you name here. Values are sealed when you save and never shown again."
          : "A server Mend calls at its URL, with the headers you name here. Values are sealed when you save and never shown again."
      }
      width={600}
      footer={
        <>
          <Button variant="ghost" disabled={save.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            disabled={save.isPending || built._tag !== "Write"}
          >
            {save.isPending ? "Saving…" : saved === null ? "Add server" : "Save server"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (built._tag !== "Write") return;
          save.mutate({
            name: saved?.name ?? draft.name,
            server: { transport: built.transport, secrets: built.secrets },
          });
        }}
      >
        <div className="grid items-start gap-3 sm:grid-cols-[1fr_1.4fr] [&>*]:mb-0">
          <Field
            label="Name"
            {...(saved === null ? {} : { source: <FieldSource>cannot change</FieldSource> })}
          >
            {(id) => (
              <TextInput
                id={id}
                value={draft.name}
                readOnly={saved !== null}
                disabled={save.isPending}
                placeholder="github"
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => set({ name: event.target.value })}
              />
            )}
          </Field>
          <GroupField label="Transport">
            <Segment
              label="Transport"
              value={draft.kind}
              options={TRANSPORT_OPTIONS}
              disabled={save.isPending}
              onChange={(next) => set({ kind: next })}
            />
          </GroupField>
        </div>
        {draft.kind === "stdio" ? (
          <>
            <Field label="Command">
              {(id) => (
                <TextInput
                  id={id}
                  value={draft.command}
                  disabled={save.isPending}
                  placeholder="npx"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => set({ command: event.target.value })}
                />
              )}
            </Field>
            <Field label="Arguments, one per line">
              {(id) => (
                <TextArea
                  id={id}
                  rows={3}
                  value={draft.argLines}
                  disabled={save.isPending}
                  placeholder={"-y\n@modelcontextprotocol/server-github"}
                  onChange={(event) => set({ argLines: event.target.value })}
                />
              )}
            </Field>
          </>
        ) : (
          <Field label="URL">
            {(id) => (
              <TextInput
                id={id}
                type="url"
                value={draft.url}
                disabled={save.isPending}
                placeholder="https://mcp.example.com/mcp"
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => set({ url: event.target.value })}
              />
            )}
          </Field>
        )}
        <GroupField label={kind === "env" ? "Environment variables" : "Headers"}>
          <div className="grid gap-2">
            {savedApplies
              ? draft.saved.map((secret, index) => (
                  <SavedSecretRow
                    key={secret.name}
                    secret={secret}
                    noun={noun}
                    disabled={save.isPending}
                    onChange={(next) =>
                      set({ saved: draft.saved.map((s, at) => (at === index ? next : s)) })
                    }
                  />
                ))
              : null}
            {dropped.length === 0 ? null : (
              <p className="text-[12.5px] text-muted-foreground">
                Saving as {TRANSPORT_WORDS[draft.kind]} deletes the saved{" "}
                {kind === "env" ? "headers" : "variables"} {dropped.join(", ")}.
              </p>
            )}
            {draft.added.map((secret, index) => (
              <div key={secret.key} className="grid grid-cols-[1fr_1.3fr_auto] items-center gap-2">
                <TextInput
                  aria-label={`New ${noun} name`}
                  value={secret.name}
                  disabled={save.isPending}
                  placeholder={kind === "env" ? "GITHUB_TOKEN" : "Authorization"}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) =>
                    set({
                      added: draft.added.map((s, at) =>
                        at === index ? { ...s, name: event.target.value } : s,
                      ),
                    })
                  }
                />
                <TextInput
                  aria-label={`${secret.name.trim() || `New ${noun}`} value`}
                  type="password"
                  value={secret.value}
                  disabled={save.isPending}
                  autoComplete="new-password"
                  onChange={(event) =>
                    set({
                      added: draft.added.map((s, at) =>
                        at === index ? { ...s, value: event.target.value } : s,
                      ),
                    })
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Drop ${secret.name.trim() || `this ${noun}`}`}
                  disabled={save.isPending}
                  onClick={() => set({ added: draft.added.filter((_, at) => at !== index) })}
                >
                  Drop
                </Button>
              </div>
            ))}
            <div>
              <Button size="sm" disabled={save.isPending} onClick={addRow}>
                {kind === "env" ? "Add a variable" : "Add a header"}
              </Button>
            </div>
          </div>
        </GroupField>
        {built._tag === "Issue" ? <p className="text-[12.5px] text-danger">{built.issue}</p> : null}
        {save.error === null ? null : (
          <ErrorNote>
            {saved === null ? "Not added" : "Not saved"}: {errorText(save.error)}
          </ErrorNote>
        )}
      </form>
    </ModalDialog>
  );
}

function SavedSecretRow({
  secret,
  noun,
  disabled,
  onChange,
}: {
  readonly secret: SavedSecret;
  readonly noun: string;
  readonly disabled: boolean;
  readonly onChange: (next: SavedSecret) => void;
}) {
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[12.5px] text-ink-2">
          {secret.name}{" "}
          <span className="text-faint">
            · {secret.choice === "remove" ? "removed on save" : "saved"}
          </span>
        </span>
        <Segment
          label={`${secret.name}, a saved ${noun}`}
          value={secret.choice}
          options={SAVED_CHOICES}
          disabled={disabled}
          onChange={(choice) => onChange({ ...secret, choice, value: "" })}
        />
      </div>
      {secret.choice === "replace" ? (
        <TextInput
          aria-label={`${secret.name} new value`}
          type="password"
          value={secret.value}
          disabled={disabled}
          autoComplete="new-password"
          onChange={(event) => onChange({ ...secret, value: event.target.value })}
        />
      ) : null}
    </div>
  );
}
