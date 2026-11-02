import { gitAuthorIssue, normalizeGitAuthor } from "@mend/domain/workbench";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button, Eyebrow } from "#/components/kit/button";
import { ChoiceCards } from "#/components/kit/choice-cards";
import { CodeBox } from "#/components/kit/code-box";
import { Field, FieldPair, FieldSource, TextInput } from "#/components/kit/field";
import { SaveBar } from "#/components/kit/save-bar";
import { Panel, SettingsSection } from "#/components/kit/section";
import { ErrorNote, errorText, StatusWord } from "#/components/kit/status";
import type { GitAccessDto, GitAccessModeDto } from "#/lib/api";
import { documentWriter } from "#/lib/optimistic";
import { useTRPC, useTRPCClient, type TrpcProxy } from "#/lib/trpc";

/** The access read; while the bridge is the choice, read it often so the signer's presence is current. */
export const gitAccessOptions = (trpc: TrpcProxy) =>
  trpc.git.access.queryOptions(undefined, {
    refetchInterval: (query) => (query.state.data?.mode === "bridge" ? 5_000 : false),
  });

/** Settings · Git access: which key your sessions' git uses, and the author their commits name. */
export function GitAccessSettings() {
  const [authorDraft, setAuthorDraft] = useState<AuthorDraft | null>(null);
  return (
    <>
      <Panel>
        <SettingsSection
          title="Git access"
          why="Which key signs your sessions' pushes and fetches. Mend's key is the simplest; your computer's key never leaves your computer. New projects adopt with this; a project can override it."
        >
          <GitAccessChoice />
        </SettingsSection>
        <SettingsSection
          title="Git author"
          why="The name and email on commits your sessions make. A user section in your dotfiles' .gitconfig, or in a repository's own config, still decides. Applies to sessions launched from now on."
        >
          <GitAuthorFields draft={authorDraft} onDraft={setAuthorDraft} />
        </SettingsSection>
      </Panel>
      <GitAuthorSave draft={authorDraft} onDone={() => setAuthorDraft(null)} />
    </>
  );
}

/** Which key git uses, picked again before the last pick answered. */
const gitAccessWriter = documentWriter<
  GitAccessDto,
  { readonly mode: GitAccessModeDto },
  GitAccessDto
>({
  overlay: (access, { mode }) => ({ ...access, mode }),
  saved: (_server, saved) => saved,
});

function GitAccessChoice() {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const access = useQuery(gitAccessOptions(trpc));
  const shown = gitAccessWriter.useVisible(access.data);
  const choose = useMutation(
    gitAccessWriter.options({
      queryClient,
      documentKey: trpc.git.access.queryKey(),
      mutationKey: trpc.git.setAccess.mutationKey(),
      send: (change) => client.git.setAccess.mutate(change),
    }),
  );
  if (shown === undefined) {
    return access.isError ? (
      <ErrorNote>Could not read your git access: {errorText(access.error)}</ErrorNote>
    ) : (
      <p className="font-mono text-[12px] text-faint">reading…</p>
    );
  }
  const { mode, key, bridge } = shown;
  return (
    <>
      <ChoiceCards<GitAccessModeDto>
        label="Git access"
        value={mode}
        onChange={(next) => choose.mutate({ mode: next })}
        options={[
          {
            value: "mend-key",
            title: "Mend's key",
            tag: "recommended",
            tagAccent: true,
            detail:
              "Held on the Mend server. You add its public key to your git account once; it works from detached sessions and the phone too.",
            status: key.exists ? (
              <StatusWord tone="ok">key held on this server · observed</StatusWord>
            ) : (
              <StatusWord tone="off">no key yet</StatusWord>
            ),
          },
          {
            value: "bridge",
            title: "Your computer's key",
            tag: "through the bridge",
            detail:
              "Stays on your computer. Each push asks it to sign, so a mend command must be running there.",
            status: bridge.connected ? (
              <StatusWord tone="ok">
                signer connected · {bridge.clientName ?? "unnamed computer"} · observed
              </StatusWord>
            ) : (
              <StatusWord tone="off">bridge not running on any computer</StatusWord>
            ),
          },
        ]}
      />
      {choose.isError ? (
        <ErrorNote className="mt-3">Not changed: {errorText(choose.error)}</ErrorNote>
      ) : null}
      {mode === "mend-key" ? (
        <MendKey publicKey={key.publicKey} fingerprint={key.fingerprint} />
      ) : (
        <p className="mt-3.5 text-[12.5px] text-muted-foreground">
          Any attaching <span className="font-mono">mend</span> command and the dashboard share your
          computer&apos;s agent while they run. Until one does, git for these projects waits: the
          base is not fetched, and pushes fail with a reason.
        </p>
      )}
    </>
  );
}

function MendKey({
  publicKey,
  fingerprint,
}: {
  readonly publicKey: string | null;
  readonly fingerprint: string | null;
}) {
  const trpc = useTRPC();
  const create = useMutation(
    trpc.git.initKey.mutationOptions({
      onSettled: (_data, _error, _variables, _result, { client }) =>
        client.invalidateQueries(trpc.git.pathFilter()),
    }),
  );
  if (publicKey === null) {
    return (
      <div className="mt-3.5 grid justify-items-start gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? "Creating…" : "Create my Mend key"}
        </Button>
        {create.isError ? <ErrorNote>Not created: {errorText(create.error)}</ErrorNote> : null}
      </div>
    );
  }
  return (
    <div className="mt-3.5">
      <Eyebrow className="mb-1.5">Mend&apos;s public key</Eyebrow>
      <CodeBox copy={publicKey} label="Mend's public key">
        {publicKey}
        {fingerprint === null ? null : <span className="text-faint"> · {fingerprint}</span>}
      </CodeBox>
      <p className="mt-2 text-[12.5px] text-muted-foreground">
        Add it to your git account&apos;s SSH keys (
        <a
          href="https://github.com/settings/ssh/new"
          target="_blank"
          rel="noreferrer"
          className="text-info underline-offset-2 hover:underline"
        >
          GitHub
        </a>
        ) and every repository you can reach works. For one repository only, add it as that
        repository&apos;s deploy key instead; grant write access if sessions should push.
      </p>
    </div>
  );
}

interface AuthorDraft {
  readonly name: string;
  readonly email: string;
}

/** The name and email fields; untouched, they show what is saved. */
function GitAuthorFields({
  draft,
  onDraft,
}: {
  readonly draft: AuthorDraft | null;
  readonly onDraft: (draft: AuthorDraft) => void;
}) {
  const trpc = useTRPC();
  const author = useQuery(trpc.git.author.queryOptions());
  const clear = useMutation(
    trpc.git.clearAuthor.mutationOptions({
      onSuccess: (saved, _variables, _result, { client }) =>
        client.setQueryData(trpc.git.author.queryKey(), saved),
    }),
  );
  if (author.data === undefined) {
    return author.isError ? (
      <ErrorNote>Could not read your git author: {errorText(author.error)}</ErrorNote>
    ) : (
      <p className="font-mono text-[12px] text-faint">reading…</p>
    );
  }
  const saved = author.data;
  const shown = draft ?? saved;
  const fromAccount =
    draft === null && saved.source === "account" ? (
      <FieldSource>from your account</FieldSource>
    ) : undefined;
  return (
    <>
      <FieldPair>
        <Field label="Name" {...(fromAccount === undefined ? {} : { source: fromAccount })}>
          {(id) => (
            <TextInput
              id={id}
              sans
              autoComplete="name"
              spellCheck={false}
              value={shown.name}
              onChange={(event) => onDraft({ ...shown, name: event.target.value })}
            />
          )}
        </Field>
        <Field label="Email" {...(fromAccount === undefined ? {} : { source: fromAccount })}>
          {(id) => (
            <TextInput
              id={id}
              sans
              type="email"
              autoComplete="email"
              spellCheck={false}
              value={shown.email}
              onChange={(event) => onDraft({ ...shown, email: event.target.value })}
            />
          )}
        </Field>
      </FieldPair>
      {saved.source === "setting" ? (
        <Button variant="ghost" size="sm" disabled={clear.isPending} onClick={() => clear.mutate()}>
          {clear.isPending ? "Saving…" : "Use my account's name and email"}
        </Button>
      ) : null}
      {clear.isError ? (
        <ErrorNote className="mt-2">Not saved: {errorText(clear.error)}</ErrorNote>
      ) : null}
    </>
  );
}

function GitAuthorSave({
  draft,
  onDone,
}: {
  readonly draft: AuthorDraft | null;
  readonly onDone: () => void;
}) {
  const trpc = useTRPC();
  const author = useQuery(trpc.git.author.queryOptions()).data;
  const save = useMutation(
    trpc.git.setAuthor.mutationOptions({
      onSuccess: (saved, _variables, _result, { client }) => {
        client.setQueryData(trpc.git.author.queryKey(), saved);
        onDone();
      },
    }),
  );
  const normalized = draft === null ? null : normalizeGitAuthor(draft);
  const dirty =
    normalized !== null &&
    author !== undefined &&
    (normalized.name !== author.name || normalized.email !== author.email);
  const issue = dirty && normalized !== null ? gitAuthorIssue(normalized) : null;
  return (
    <SaveBar
      dirty={dirty}
      summary={issue ?? "git author changed · applies to sessions launched from now on"}
      saveLabel="Save author"
      pending={save.isPending}
      error={save.isError ? errorText(save.error) : null}
      canSave={issue === null}
      onDiscard={() => {
        save.reset();
        onDone();
      }}
      onSave={() => {
        if (normalized !== null) save.mutate(normalized);
      }}
    />
  );
}
