import type { SecretFile } from "@mend/domain/workbench";
import { InlineAlert } from "@mend/ui/components/banner";
import { Segmented } from "@mend/ui/components/segmented";
import { Button } from "@mend/ui/components/ui/button";
import { Input } from "@mend/ui/components/ui/input";
import { Switch } from "@mend/ui/components/ui/switch";
import { Textarea } from "@mend/ui/components/ui/textarea";
import { toast } from "@mend/ui/components/ui/toast";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileLockIcon, FileTextIcon, InfoIcon } from "lucide-react";
import { useId, useState } from "react";

import { shortDay } from "#/lib/devices";
import {
  cloneRefusal,
  DOTFILES_MANAGER_OPTIONS,
  type DotfilesRepositoryDraft,
  repositoryDraft,
  repositoryDraftDirty,
  repositoryFromDraft,
} from "#/lib/dotfiles-repository";
import { requestFailure } from "#/lib/git-access";
import { usePhone } from "#/lib/phone";
import { formatBytes, homeRelative, readAsBase64, secretFileProblem } from "#/lib/secret-files";
import { useTRPC } from "#/lib/trpc";

import { Overlay } from "../projects/overlay.tsx";
import { SettingRow, SettingSection } from "./setting-row.tsx";
import { SettingsPage } from "./settings-page.tsx";

const CONTROL = "max-lg:h-11 max-lg:text-base";
const FIELD = "h-9 w-90 font-mono text-meta max-lg:h-11 max-lg:w-full";

/**
 * Settings → Account → Dotfiles (Doop "Settings · Account · Dotfiles"): the dotfiles repository
 * Mend applies when a session starts, the home files copied in beside it, and the secret files
 * written into the home folder. All of it follows the person into every session they start, in
 * every project and organization: there is no per-project switch and no shell profile to choose
 * (docs/adr/0025, decision 2). A secret file is written once and never read back.
 */
export function DotfilesPage() {
  return (
    <SettingsPage
      page="a-dotfiles"
      intro={
        <>
          Your dotfiles and secret files follow you into every session you start, in every project
          and organization. So do your skills, which are on the{" "}
          <Link to="/skills" className="text-info underline-offset-4 hover:underline">
            Skills page
          </Link>
          .
        </>
      }
    >
      <SettingSection title="Dotfiles">
        <RepositoryRows />
        <HomeFilesRow />
      </SettingSection>
      <SecretFilesSection />
    </SettingsPage>
  );
}

/**
 * The repository: its address, branch, subdirectory, whether `install.sh` runs, and how the tree
 * lands. Edited as one draft and saved with Save, when the server clones it once to check it; a
 * repository it can't clone is refused and nothing is saved. An empty address clears it.
 */
function RepositoryRows() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const saved = useSuspenseQuery(trpc.settings.dotfiles.queryOptions()).data.repository;
  const [draft, setDraft] = useState<DotfilesRepositoryDraft>(() => repositoryDraft(saved));
  const [said, setSaid] = useState<string | null>(null);
  const save = useMutation(
    trpc.settings.putDotfilesRepository.mutationOptions({
      onSuccess: (next) => {
        queryClient.setQueryData(trpc.settings.dotfiles.queryKey(), next);
        setDraft(repositoryDraft(next.repository));
        setSaid(
          next.repository === null
            ? "Removed. Sessions you start from now on apply no dotfiles repository."
            : "Saved. Sessions you start from now on apply it.",
        );
      },
    }),
  );
  const dirty = repositoryDraftDirty(saved, draft);
  const clearing = repositoryFromDraft(draft) === null;
  const edit = (change: Partial<DotfilesRepositoryDraft>) => {
    save.reset();
    setSaid(null);
    setDraft((current) => ({ ...current, ...change }));
  };
  const ids = useId();
  const manager = DOTFILES_MANAGER_OPTIONS.find((option) => option.value === draft.manager);
  const pending = save.isPending;
  return (
    <>
      <SettingRow
        layout="stack"
        label="Dotfiles repository"
        labelFor={`${ids}-url`}
        description="Mend applies these dotfiles when your sessions start. When you change the repository, Mend clones it first to check that it works."
        note={
          save.isError ? (
            <span role="alert" className="text-destructive">
              {cloneRefusal(draft.url.trim(), requestFailure(save.error))}
            </span>
          ) : said !== null && !dirty ? (
            <span role="status" className="text-muted-foreground">
              {said}
            </span>
          ) : null
        }
        control={
          <Input
            id={`${ids}-url`}
            value={draft.url}
            disabled={pending}
            placeholder="https://github.com/you/dotfiles.git"
            spellCheck={false}
            autoComplete="off"
            className={FIELD}
            onChange={(event) => edit({ url: event.target.value })}
          />
        }
      />
      {draft.url.trim() === "" ? null : (
        <>
          <SettingRow
            layout="stack"
            label="Branch"
            labelFor={`${ids}-ref`}
            description="Leave it empty for the repository's default branch."
            control={
              <Input
                id={`${ids}-ref`}
                value={draft.ref}
                disabled={pending}
                placeholder="default"
                spellCheck={false}
                autoComplete="off"
                className={FIELD}
                onChange={(event) => edit({ ref: event.target.value })}
              />
            }
          />
          <SettingRow
            layout="stack"
            label="Subdirectory"
            labelFor={`${ids}-dir`}
            description="Leave it empty to apply the whole repository."
            control={
              <Input
                id={`${ids}-dir`}
                value={draft.subdirectory}
                disabled={pending}
                placeholder="repository root"
                spellCheck={false}
                autoComplete="off"
                className={FIELD}
                onChange={(event) => edit({ subdirectory: event.target.value })}
              />
            }
          />
          <SettingRow
            layout="stack"
            label="How it lands"
            description={manager?.detail}
            control={
              <Segmented
                aria-label="How the dotfiles land in your home folder"
                value={draft.manager}
                disabled={pending}
                options={DOTFILES_MANAGER_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
                className="max-lg:w-full lg:[&_[data-slot=segmented-item]]:flex-auto"
                onValueChange={(value) => edit({ manager: value })}
              />
            }
          />
          <SettingRow
            label="Run install.sh"
            labelFor={`${ids}-bootstrap`}
            description={
              <>
                When the repository has an <code className="font-mono text-meta">install.sh</code>,
                Mend runs it after applying the files.
              </>
            }
            control={
              <Switch
                id={`${ids}-bootstrap`}
                aria-label="Run install.sh"
                checked={draft.bootstrap}
                disabled={pending}
                onCheckedChange={(bootstrap) => edit({ bootstrap })}
              />
            }
          />
        </>
      )}
      {dirty ? (
        <SettingRow
          label={pending ? "Cloning the repository…" : "Unsaved changes"}
          description={
            save.isError
              ? "Your sessions keep using the repository you saved before."
              : clearing
                ? "Saving removes your dotfiles repository."
                : "Mend clones the repository to check it before saving."
          }
          control={
            <>
              <Button
                variant="ghost"
                className={CONTROL}
                disabled={pending}
                onClick={() => {
                  save.reset();
                  setDraft(repositoryDraft(saved));
                }}
              >
                Cancel
              </Button>
              <Button
                className={CONTROL}
                disabled={pending}
                onClick={() => save.mutate({ repository: repositoryFromDraft(draft) })}
              >
                {pending ? "Saving…" : "Save"}
              </Button>
            </>
          }
        />
      ) : null}
    </>
  );
}

/**
 * Home files: the snapshot copied into the home of every workspace, synced from the person's
 * computer with `mend dotfiles sync` or added here. The store keeps one snapshot, so files are
 * added to it or it is removed whole.
 */
function HomeFilesRow() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const snapshot = useSuspenseQuery(trpc.settings.dotfiles.queryOptions()).data.snapshot;
  const [staged, setStaged] = useState<
    ReadonlyArray<{
      readonly id: string;
      readonly path: string;
      readonly contentsBase64: string;
      readonly bytes: number;
    }>
  >([]);
  const [removing, setRemoving] = useState(false);
  const add = useMutation(
    trpc.settings.postDotfilesSnapshot.mutationOptions({
      onSuccess: (next) => {
        queryClient.setQueryData(trpc.settings.dotfiles.queryKey(), next);
        setStaged([]);
      },
    }),
  );
  const remove = useMutation(
    trpc.settings.deleteDotfilesSnapshot.mutationOptions({
      onSuccess: (next) => {
        queryClient.setQueryData(trpc.settings.dotfiles.queryKey(), next);
        setRemoving(false);
      },
    }),
  );
  const files = snapshot?.files ?? [];
  const inputId = useId();
  const pending = add.isPending || remove.isPending;
  return (
    <SettingRow
      layout="stack"
      label="Home files"
      description={
        <>
          Files Mend copies into your home folder in every session, beside the repository. Sync them
          from your computer with <code className="font-mono text-meta">mend dotfiles sync</code>,
          or add them here.
        </>
      }
      note={
        <div className="mt-1 grid gap-2">
          {files.length === 0 ? (
            <p className="text-muted-foreground">No home files yet.</p>
          ) : (
            <ul aria-label="Home files" className="grid gap-1">
              {files.map((file) => (
                <li key={file.path} className="flex items-center gap-2">
                  <FileTextIcon aria-hidden className="size-3.5 text-muted-foreground" />
                  <span className="min-w-0 truncate font-mono text-meta">~/{file.path}</span>
                  <span className="text-muted-foreground">{formatBytes(file.bytes)}</span>
                </li>
              ))}
            </ul>
          )}
          {staged.length === 0 ? null : (
            <div className="grid gap-2 rounded-lg border border-border p-3">
              <p className="text-muted-foreground">
                Ready to add. Edit where each lands, relative to your home folder.
              </p>
              {staged.map((entry, index) => (
                <div key={entry.id} className="flex items-center gap-2">
                  <Input
                    value={entry.path}
                    disabled={pending}
                    spellCheck={false}
                    aria-label={`Where ${entry.path || "this file"} lands in your home folder`}
                    className="h-8 font-mono text-meta"
                    onChange={(event) =>
                      setStaged((current) =>
                        current.map((candidate, at) =>
                          at === index ? { ...candidate, path: event.target.value } : candidate,
                        ),
                      )
                    }
                  />
                  <span className="shrink-0 text-muted-foreground">{formatBytes(entry.bytes)}</span>
                  <Button
                    variant="ghost"
                    size="sm"
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
                  size="sm"
                  disabled={pending || staged.some((entry) => entry.path.trim() === "")}
                  onClick={() =>
                    add.mutate({
                      files: staged.map(({ path, contentsBase64 }) => ({
                        path: homeRelative(path),
                        contentsBase64,
                      })),
                      source: "web",
                      merge: true,
                    })
                  }
                >
                  {add.isPending
                    ? "Adding…"
                    : `Add ${staged.length} ${staged.length === 1 ? "file" : "files"}`}
                </Button>
              </div>
            </div>
          )}
          {add.isError ? (
            <p role="alert" className="text-destructive">
              Mend didn't add them. {requestFailure(add.error)}
            </p>
          ) : null}
        </div>
      }
      control={
        <>
          {snapshot === null ? null : (
            <Button
              variant="ghost"
              className={CONTROL}
              disabled={pending}
              onClick={() => setRemoving(true)}
            >
              Remove all…
            </Button>
          )}
          <label
            htmlFor={inputId}
            className="inline-flex h-8 cursor-pointer items-center rounded-lg border border-input px-3 text-sm font-medium focus-within:ring-3 focus-within:ring-ring/50 max-lg:h-11 max-lg:justify-center max-lg:text-base"
          >
            Add files…
            <input
              id={inputId}
              type="file"
              multiple
              className="sr-only"
              disabled={pending}
              onChange={(event) => {
                const picked = [...(event.target.files ?? [])];
                event.target.value = "";
                add.reset();
                void Promise.all(
                  picked.map(async (file) => ({
                    id: crypto.randomUUID(),
                    path: file.name,
                    contentsBase64: await readAsBase64(file),
                    bytes: file.size,
                  })),
                ).then((read) => setStaged((current) => [...current, ...read]));
              }}
            />
          </label>
          {removing ? (
            <Overlay
              open
              onOpenChange={(next) => {
                if (!next && !remove.isPending) setRemoving(false);
              }}
              size="sm"
              title="Remove every home file?"
              description="Sessions you start from now on begin without them. Sessions already running keep theirs. Sync them again with mend dotfiles sync."
              footer={
                <>
                  <Button
                    variant="outline"
                    className={CONTROL}
                    disabled={remove.isPending}
                    onClick={() => setRemoving(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    className={CONTROL}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate()}
                  >
                    {remove.isPending ? "Removing…" : "Remove all"}
                  </Button>
                </>
              }
            >
              {remove.isError ? (
                <InlineAlert title="Mend didn't remove them.">
                  {requestFailure(remove.error)}
                </InlineAlert>
              ) : null}
            </Overlay>
          ) : null}
        </>
      }
    />
  );
}

/**
 * Secret files (docs/adr/0010): written into the home folder of every session's workspace before
 * the agent starts. A file's content is sent once and never shown again; the list has only its
 * path and when it was added.
 */
function SecretFilesSection() {
  const trpc = useTRPC();
  const view = useSuspenseQuery(trpc.settings.secretFiles.queryOptions()).data;
  const phone = usePhone();
  const [editing, setEditing] = useState<{ readonly path: string | null } | null>(null);
  const [removing, setRemoving] = useState<SecretFile | null>(null);
  return (
    <SettingSection
      title="Secret files"
      description="Mend writes these files into your home folder when your sessions start. Once you save one, nobody can read it back here, including you."
      action={
        <Button
          variant="outline"
          size={phone ? "touch" : "sm"}
          onClick={() => setEditing({ path: null })}
        >
          Add secret file…
        </Button>
      }
    >
      {view.files.length === 0 ? (
        <p className="border-b border-border py-3 text-row text-muted-foreground max-lg:px-4">
          No secret files yet. Add one for a credential your tools read from your home folder, such
          as <code className="font-mono text-meta">~/.npmrc</code>.
        </p>
      ) : (
        <ul aria-label="Secret files">
          {view.files.map((file) => (
            <li
              key={file.id}
              className="flex items-center gap-3 border-b border-border py-3 max-lg:flex-wrap max-lg:px-4"
            >
              <FileLockIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-meta">~/{file.path}</span>
              <span className="w-28 text-row text-muted-foreground max-lg:w-auto">
                {file.revision > 1 ? "Replaced" : "Added"}{" "}
                {shortDay(file.updatedAt.toISOString(), new Date())}
              </span>
              <span className="flex gap-1 max-lg:w-full max-lg:*:flex-1">
                <Button
                  variant="ghost"
                  size={phone ? "touch" : "sm"}
                  aria-label={`Replace ~/${file.path}`}
                  onClick={() => setEditing({ path: file.path })}
                >
                  Replace…
                </Button>
                <Button
                  variant="ghost"
                  size={phone ? "touch" : "sm"}
                  aria-label={`Remove ~/${file.path}`}
                  onClick={() => setRemoving(file)}
                >
                  Remove…
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="flex gap-1.5 py-3 text-row text-muted-foreground max-lg:px-4 [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
        <InfoIcon aria-hidden />
        Up to 64 files, each at most 256 KB. A file kept at the same path is replaced.
      </p>
      {editing === null ? null : (
        <SecretFileDialog path={editing.path} onClose={() => setEditing(null)} />
      )}
      {removing === null ? null : (
        <RemoveSecretFile file={removing} onClose={() => setRemoving(null)} />
      )}
    </SettingSection>
  );
}

/**
 * Add or replace a secret file: a path in the home folder, and the content from a chosen file or
 * pasted text. The content lives in this dialog only, and leaves the page when it closes.
 */
function SecretFileDialog({
  path: fixed,
  onClose,
}: {
  readonly path: string | null;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const ids = useId();
  const [typed, setTyped] = useState(fixed === null ? "" : `~/${fixed}`);
  const [chosen, setChosen] = useState<{
    readonly name: string;
    readonly bytes: number;
    readonly base64: string;
  } | null>(null);
  const [pasted, setPasted] = useState("");
  const save = useMutation(
    trpc.settings.putSecretFile.mutationOptions({
      // It carries the secret: gone from the mutation cache once nothing shows its result.
      gcTime: 0,
      onSuccess: async (saved) => {
        setPasted("");
        setChosen(null);
        await queryClient.invalidateQueries(trpc.settings.secretFiles.queryFilter());
        toast.add({
          description: `${saved.action === "replaced" ? "Replaced" : "Saved"} ~/${saved.file.path}.`,
          priority: "low",
        });
        onClose();
      },
    }),
  );
  const path = homeRelative(typed);
  const problem = secretFileProblem(typed, chosen);
  const ready =
    !save.isPending && path !== "" && problem === null && (chosen !== null || pasted.length > 0);
  const title = fixed === null ? "Add a secret file" : `Replace ~/${fixed}`;
  return (
    <Overlay
      open
      onOpenChange={(next) => {
        if (!next && !save.isPending) onClose();
      }}
      size="md"
      title={title}
      description={
        fixed === null
          ? "Mend writes it into your home folder in every session you start, before the agent starts. Nobody can read it back here once it's saved."
          : "The new content replaces the old one in sessions you start from now on. Nobody can read either back here."
      }
      footer={
        <>
          <Button variant="outline" className={CONTROL} disabled={save.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={`${ids}-form`} className={CONTROL} disabled={!ready}>
            {save.isPending ? "Saving…" : fixed === null ? "Save file" : "Replace file"}
          </Button>
        </>
      }
    >
      <form
        id={`${ids}-form`}
        noValidate
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
        <div>
          <label htmlFor={`${ids}-path`} className="mb-2 block font-medium">
            Path in your home folder
          </label>
          <Input
            id={`${ids}-path`}
            value={typed}
            readOnly={fixed !== null}
            placeholder="~/.npmrc"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={problem !== null}
            aria-describedby={`${ids}-problem`}
            className="h-9 font-mono text-meta max-lg:h-11"
            onChange={(event) => setTyped(event.target.value)}
          />
          {problem === null ? null : (
            <p id={`${ids}-problem`} role="alert" className="mt-1.5 text-row text-destructive">
              {problem}
            </p>
          )}
        </div>
        <div>
          <p className="mb-2 font-medium">Content</p>
          <label
            htmlFor={`${ids}-file`}
            className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-input px-3 py-2 focus-within:ring-3 focus-within:ring-ring/50"
          >
            <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              {chosen === null ? "Choose a file…" : chosen.name}
            </span>
            {chosen === null ? null : (
              <span className="text-row text-muted-foreground">{formatBytes(chosen.bytes)}</span>
            )}
            <input
              id={`${ids}-file`}
              type="file"
              aria-label="Choose a file"
              className="sr-only"
              disabled={save.isPending || pasted.length > 0}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file === undefined) return;
                void readAsBase64(file).then((base64) =>
                  setChosen({ name: file.name, bytes: file.size, base64 }),
                );
              }}
            />
          </label>
          <label htmlFor={`${ids}-text`} className="mt-3 mb-2 block text-row text-muted-foreground">
            Or paste its text
          </label>
          <Textarea
            id={`${ids}-text`}
            rows={phone ? 3 : 4}
            value={pasted}
            autoComplete="off"
            spellCheck={false}
            disabled={save.isPending || chosen !== null}
            className="font-mono text-meta"
            onChange={(event) => setPasted(event.target.value)}
          />
        </div>
        {save.isError ? (
          <InlineAlert title="Mend didn't save the file.">{requestFailure(save.error)}</InlineAlert>
        ) : null}
      </form>
    </Overlay>
  );
}

function RemoveSecretFile({
  file,
  onClose,
}: {
  readonly file: SecretFile;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const remove = useMutation(
    trpc.settings.deleteSecretFile.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries(trpc.settings.secretFiles.queryFilter());
        toast.add({ description: `Removed ~/${file.path}.`, priority: "low" });
        onClose();
      },
    }),
  );
  return (
    <Overlay
      open
      onOpenChange={(next) => {
        if (!next && !remove.isPending) onClose();
      }}
      size="sm"
      title={`Remove ~/${file.path}?`}
      description="Sessions you start from now on begin without it. Sessions already running keep their copy."
      footer={
        <>
          <Button
            variant="outline"
            className={CONTROL}
            disabled={remove.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            className={CONTROL}
            disabled={remove.isPending}
            onClick={() => remove.mutate({ path: file.path })}
          >
            {remove.isPending ? "Removing…" : "Remove file"}
          </Button>
        </>
      }
    >
      {remove.isError ? (
        <InlineAlert title="Mend didn't remove it.">{requestFailure(remove.error)}</InlineAlert>
      ) : null}
    </Overlay>
  );
}
