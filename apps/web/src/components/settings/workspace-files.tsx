import { SECRET_FILE_MAX_BYTES, validateSecretFilePath } from "@mend/domain/workbench";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import { Button } from "#/components/kit/button";
import { Field, FieldSource, TextInput } from "#/components/kit/field";
import { FileButton } from "#/components/kit/file-button";
import { ModalClose, ModalDialog } from "#/components/kit/modal";
import { FoldSection } from "#/components/kit/section";
import { ErrorNote, errorText } from "#/components/kit/status";
import { DataTable } from "#/components/kit/table";
import { TextArea } from "#/components/kit/text-area";
import type { SecretFileDto, SecretFilesDto } from "#/lib/api";
import { documentWriter } from "#/lib/optimistic";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

/** A list longer than this starts folded. */
const FOLD_AFTER = 5;

/** Bytes as a terse mono fact: 812 B, 4.1 KB. */
export const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const syncedAgo = (at: Date): string => {
  const minutes = Math.floor((Date.now() - at.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
};

const dayOf = (at: Date) => at.toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** A file's bytes as base64, read in the browser; nothing leaves the page but the upload. */
const readAsBase64 = (file: File): Promise<string> =>
  file.arrayBuffer().then((buffer) => {
    let binary = "";
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary);
  });

/** What a list says when folded: its first few entries, then how many more. */
const foldSummary = (paths: ReadonlyArray<string>, none: string) =>
  paths.length === 0
    ? none
    : paths.length <= 3
      ? paths.join(" · ")
      : `${paths.slice(0, 3).join(" · ")} · and ${paths.length - 3} more`;

/** A picked file staged for upload; its target path can be edited before it is added. */
interface StagedFile {
  readonly path: string;
  readonly contentsBase64: string;
  readonly bytes: number;
}

/**
 * Home files: the snapshot of files copied into the home of every workspace, synced from the
 * person's own machine with `mend dotfiles sync` or added here. The store keeps one snapshot, so
 * files are added to it or it is removed whole.
 */
export function HomeFilesSection() {
  const trpc = useTRPC();
  const snapshot = useSuspenseQuery(trpc.settings.dotfiles.queryOptions()).data.snapshot;
  const [staged, setStaged] = useState<ReadonlyArray<StagedFile>>([]);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const add = useMutation(
    trpc.settings.postDotfilesSnapshot.mutationOptions({
      onSuccess: (next, _variables, _result, { client }) => {
        client.setQueryData(trpc.settings.dotfiles.queryKey(), next);
        setStaged([]);
      },
    }),
  );
  const remove = useMutation(
    trpc.settings.deleteDotfilesSnapshot.mutationOptions({
      onSuccess: (next, _variables, _result, { client }) => {
        client.setQueryData(trpc.settings.dotfiles.queryKey(), next);
        setConfirmRemove(false);
      },
    }),
  );
  const pending = add.isPending || remove.isPending;
  const files = snapshot?.files ?? [];

  const stage = (picked: ReadonlyArray<File>) => {
    add.reset();
    for (const file of picked) {
      void readAsBase64(file).then((contentsBase64) =>
        setStaged((current) => [
          ...current.filter((entry) => entry.path !== file.name),
          { path: file.name, contentsBase64, bytes: file.size },
        ]),
      );
    }
  };

  return (
    <FoldSection
      title="Home files"
      count={plural(files.length, "file", "files")}
      why={
        <>
          Files copied into your home in every workspace. Synced from your own computer with{" "}
          <code className="font-mono text-[12px]">mend dotfiles sync</code>, or added here.
        </>
      }
      summary={foldSummary(
        files.map((file) => `~/${file.path}`),
        "nothing synced yet",
      )}
      defaultOpen={files.length <= FOLD_AFTER}
    >
      {snapshot === null ? null : (
        <p className="mb-1 px-4 font-mono text-[11.5px] text-faint">
          synced {syncedAgo(snapshot.committedAt)} from {snapshot.source} ·{" "}
          {snapshot.sha.slice(0, 7)}
        </p>
      )}
      <DataTable
        label="Home files"
        columns={[
          { head: "Path", width: "2fr" },
          { head: "Size", width: "0.6fr" },
        ]}
        rows={files.map((file) => ({
          key: file.path,
          cells: [
            <span key="path" className="font-mono text-[12px] text-ink-2">
              ~/{file.path}
            </span>,
            <span key="size" className="font-mono text-[12px] text-muted-foreground">
              {formatBytes(file.bytes)}
            </span>,
          ],
        }))}
        empty="nothing synced yet · run mend dotfiles sync, or add files here"
      />
      {staged.length === 0 ? null : (
        <div className="mt-3 grid gap-2 rounded-[14px] bg-secondary p-3">
          <p className="font-sans text-[12.5px] font-medium text-ink-2">
            Ready to add · edit where each lands, relative to your home
          </p>
          {staged.map((entry, index) => (
            <div key={index} className="flex items-center gap-2.5">
              <TextInput
                value={entry.path}
                disabled={pending}
                spellCheck={false}
                aria-label={`Where ${entry.path || "this file"} lands, relative to your home`}
                onChange={(event) =>
                  setStaged((current) =>
                    current.map((candidate, at) =>
                      at === index ? { ...candidate, path: event.target.value } : candidate,
                    ),
                  )
                }
              />
              <span className="shrink-0 font-mono text-[12px] text-faint">
                {formatBytes(entry.bytes)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                aria-label={`Leave out ${entry.path}`}
                onClick={() => setStaged((current) => current.filter((_, at) => at !== index))}
              >
                Leave out
              </Button>
            </div>
          ))}
          <div>
            <Button
              variant="primary"
              size="sm"
              disabled={pending || staged.some((entry) => entry.path.trim() === "")}
              onClick={() =>
                add.mutate({
                  files: staged.map(({ path, contentsBase64 }) => ({
                    path: path.trim(),
                    contentsBase64,
                  })),
                  source: "web",
                  merge: true,
                })
              }
            >
              {add.isPending ? "Adding…" : `Add ${plural(staged.length, "file", "files")}`}
            </Button>
          </div>
        </div>
      )}
      <div className="mt-2.5 flex items-center gap-2">
        <FileButton size="sm" multiple disabled={pending} onFiles={stage}>
          Add files…
        </FileButton>
        {snapshot === null ? null : (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setConfirmRemove(true)}
          >
            Remove all…
          </Button>
        )}
      </div>
      {add.error === null ? null : <ErrorNote className="mt-3">{errorText(add.error)}</ErrorNote>}
      <ModalDialog
        open={confirmRemove}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmRemove(false);
            remove.reset();
          }
        }}
        width={440}
        title="Remove every home file?"
        description="New workspaces start without them. Workspaces already running keep theirs. Sync them again with mend dotfiles sync."
        footer={
          <>
            <ModalClose render={<Button variant="ghost" disabled={remove.isPending} />}>
              Cancel
            </ModalClose>
            <Button variant="primary" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {remove.isPending ? "Removing…" : `Remove ${plural(files.length, "file", "files")}`}
            </Button>
          </>
        }
      >
        {remove.error === null ? null : <ErrorNote>{errorText(remove.error)}</ErrorNote>}
      </ModalDialog>
    </FoldSection>
  );
}

const sortedByPath = (files: ReadonlyArray<SecretFileDto>) =>
  files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

const withoutFile = (view: SecretFilesDto, path: string): SecretFilesDto => ({
  ...view,
  files: view.files.filter((file) => file.path !== path),
});

/** Removals leave the list at once and come back alone if the server refuses one. */
const secretFilesWriter = documentWriter<SecretFilesDto, { readonly path: string }, unknown>({
  overlay: (view, { path }) => withoutFile(view, path),
  saved: (view, _removed, { path }) => withoutFile(view, path),
});

/**
 * Secret files (docs/adr/0010): written into every workspace a session of this person launches
 * in, by path and size. Content is write-only: sent once, sealed on the server, never shown again.
 */
export function SecretFilesSection() {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const server = useSuspenseQuery(trpc.settings.secretFiles.queryOptions()).data;
  const view = secretFilesWriter.useVisible(server) ?? server;
  const [adding, setAdding] = useState(false);
  const remove = useMutation(
    secretFilesWriter.options({
      queryClient,
      documentKey: trpc.settings.secretFiles.queryKey(),
      mutationKey: trpc.settings.deleteSecretFile.mutationKey(),
      send: (change) => client.settings.deleteSecretFile.mutate(change),
    }),
  );
  return (
    <FoldSection
      title="Secret files"
      count={`${view.files.length} kept`}
      why={`Written into every workspace, never shown again. Up to 64, each at most ${SECRET_FILE_MAX_BYTES / 1024} KB.`}
      summary={foldSummary(
        view.files.map((file) => `~/${file.path}`),
        "none kept",
      )}
      defaultOpen={view.files.length <= FOLD_AFTER}
    >
      <DataTable
        label="Secret files"
        columns={[
          { head: "Path", width: "2fr" },
          { head: "Kept", width: "0.8fr" },
          { head: "", width: "auto" },
        ]}
        rows={view.files.map((file) => ({
          key: file.id,
          cells: [
            <span key="path" className="font-mono text-[12px] text-ink-2">
              ~/{file.path}
            </span>,
            <span key="kept" className="font-mono text-[12px] text-muted-foreground">
              {dayOf(file.updatedAt)} · {formatBytes(file.bytes)}
              {file.revision > 1 ? ` · replaced ${file.revision - 1}×` : ""}
            </span>,
            <Button
              key="remove"
              size="sm"
              variant="ghost"
              aria-label={`Remove ~/${file.path}`}
              disabled={remove.isPending}
              onClick={() => remove.mutate({ path: file.path })}
            >
              Remove
            </Button>,
          ],
        }))}
        empty="none kept"
      />
      {remove.error === null ? null : (
        <ErrorNote className="mt-3">
          {`~/${remove.variables?.path ?? ""} is still kept · ${errorText(remove.error)}`}
        </ErrorNote>
      )}
      <div className="mt-2.5">
        <Button size="sm" onClick={() => setAdding(true)}>
          Add a secret file
        </Button>
      </div>
      <ModalDialog
        open={adding}
        onOpenChange={setAdding}
        width={520}
        title="Add a secret file"
        description="Written into the home of every workspace your sessions launch in, before the agent starts. Encrypted at rest; never captured, and never shown again. A path already kept is replaced."
      >
        {adding ? <SecretFileForm onSaved={() => setAdding(false)} /> : null}
      </ModalDialog>
    </FoldSection>
  );
}

/** The home-relative path a typed `~/.aws/credentials` means. */
const homeRelative = (typed: string) => {
  const trimmed = typed.trim();
  return trimmed.startsWith("~/") ? trimmed.slice(2) : trimmed;
};

interface ChosenFile {
  readonly name: string;
  readonly bytes: number;
  readonly base64: string;
}

/** The secret file being added. Its content lives here only and leaves the page when it closes. */
function SecretFileForm({ onSaved }: { readonly onSaved: () => void }) {
  const trpc = useTRPC();
  const [pathTyped, setPathTyped] = useState("");
  const [chosen, setChosen] = useState<ChosenFile | null>(null);
  const [pasted, setPasted] = useState("");
  const issueId = useId();
  const save = useMutation(
    trpc.settings.putSecretFile.mutationOptions({
      // It carries a credential: gone from the mutation cache once nothing shows its result.
      gcTime: 0,
      onSuccess: (saved, _variables, _result, { client }) => {
        client.setQueryData(trpc.settings.secretFiles.queryKey(), (current) =>
          current === undefined
            ? current
            : {
                ...current,
                files: sortedByPath([
                  ...current.files.filter((file) => file.path !== saved.file.path),
                  saved.file,
                ]),
              },
        );
        setPasted("");
        setChosen(null);
        onSaved();
      },
    }),
  );
  const path = homeRelative(pathTyped);
  const pathIssue = path === "" ? null : validateSecretFilePath(path);
  const sizeIssue =
    chosen !== null && chosen.bytes > SECRET_FILE_MAX_BYTES
      ? `${chosen.name} is over ${SECRET_FILE_MAX_BYTES / 1024} KB`
      : null;
  const issue = pathIssue ?? sizeIssue;
  const ready =
    !save.isPending && path !== "" && issue === null && (chosen !== null || pasted.length > 0);

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        save.mutate(
          chosen !== null
            ? { path, encoding: "base64", contents: chosen.base64 }
            : { path, encoding: "utf8", contents: pasted },
        );
      }}
    >
      <Field
        label="Path in the workspace"
        source={<FieldSource>relative to your home</FieldSource>}
      >
        {(id) => (
          <TextInput
            id={id}
            value={pathTyped}
            disabled={save.isPending}
            placeholder=".aws/credentials"
            spellCheck={false}
            autoComplete="off"
            aria-describedby={issue === null ? undefined : issueId}
            aria-invalid={issue !== null}
            onChange={(event) => setPathTyped(event.target.value)}
          />
        )}
      </Field>
      <div className="grid gap-1.5">
        <span className="font-sans text-[12.5px] font-medium text-ink-2">File</span>
        <div className="flex items-center gap-2.5">
          <FileButton
            size="sm"
            disabled={save.isPending || pasted.length > 0}
            onFiles={([file]) => {
              if (file === undefined) return;
              void readAsBase64(file).then((base64) =>
                setChosen({ name: file.name, bytes: file.size, base64 }),
              );
            }}
          >
            Choose a file
          </FileButton>
          <span className="min-w-0 truncate font-mono text-[12px] text-faint">
            {chosen === null ? "none chosen" : `${chosen.name} · ${formatBytes(chosen.bytes)}`}
          </span>
          {chosen === null ? null : (
            <Button size="sm" variant="ghost" onClick={() => setChosen(null)}>
              Clear
            </Button>
          )}
        </div>
      </div>
      <Field label="Or paste its text">
        {(id) => (
          <TextArea
            id={id}
            rows={4}
            value={pasted}
            autoComplete="off"
            disabled={save.isPending || chosen !== null}
            onChange={(event) => setPasted(event.target.value)}
          />
        )}
      </Field>
      {issue === null ? null : (
        <p id={issueId} className="text-[12.5px] text-danger">
          {issue}
        </p>
      )}
      {save.error === null ? null : <ErrorNote>{errorText(save.error)}</ErrorNote>}
      <div className="flex items-center justify-end gap-2.5">
        <ModalClose render={<Button variant="ghost" disabled={save.isPending} />}>
          Cancel
        </ModalClose>
        <Button type="submit" variant="primary" disabled={!ready}>
          {save.isPending ? "Saving…" : "Add secret file"}
        </Button>
      </div>
    </form>
  );
}
