import { Button } from "@mend/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { Input } from "@mend/ui/components/ui/input";
import { Label } from "@mend/ui/components/ui/label";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { toast } from "@mend/ui/components/ui/toast";
import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  BookMarkedIcon,
  EllipsisIcon,
  FolderIcon,
  PencilIcon,
  RefreshCwIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import type { FolderDto } from "#/lib/api";
import { sizeWords } from "#/lib/byte-size";
import {
  agoWords,
  deleteFolderLine,
  FOLDER_NAME_HINT,
  folderFacts,
  filesWords,
  planUpload,
  repositoryWords,
  stagedPath,
  toBase64,
  uploadedWords,
} from "#/lib/organization-folders";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC, useTRPCClient } from "#/lib/trpc";
import { useViewer } from "#/lib/use-viewer";

import { Overlay } from "../projects/overlay.tsx";
import { SettingSection } from "./setting-row.tsx";
import { SettingsPage } from "./settings-page.tsx";

type Reference = ReturnType<typeof useReferences>[number];

const useReferences = () => {
  const trpc = useTRPC();
  return useSuspenseQuery(trpc.git.references.queryOptions()).data;
};

/** Open a hidden file picker. */
const pick = (input: HTMLInputElement | null) => input?.click();

/** A control's size: 32px on the desk, a 44px touch target on a phone. */
const touch = (phone: boolean) => (phone ? "touch" : "default");

/**
 * Settings → the organization → Folders and references (Doop "Settings · Northwind · Folders and
 * references"): the folders Mend keeps for the organization, with their files, and the reference
 * repositories it clones (references-folders.md `folder-web`, `ref-refresh-remove`). Each project
 * picks which its sessions get. Everyone reads them; owners create, fill, rename and delete them.
 * The route's loader read both lists.
 */
export function FoldersPage() {
  const trpc = useTRPC();
  const { organizationName } = useViewer();
  const { role } = useSuspenseQuery(signedInOptions(trpc)).data;
  const owner = role === "owner";
  const folders = useSuspenseQuery(trpc.folders.list.queryOptions()).data;
  const references = useReferences();
  const [dialog, setDialog] = useState<
    | { readonly kind: "new-folder" | "add-reference" }
    | { readonly kind: "rename" | "delete"; readonly folder: FolderDto }
    | { readonly kind: "remove-reference"; readonly reference: Reference }
    | null
  >(null);
  const [shown, setShown] = useState<string | null>(null);
  const now = new Date();
  const close = () => setDialog(null);
  return (
    <SettingsPage
      page="o-folders"
      intro={`These are the shared folders and reference repositories that ${organizationName}'s sessions can read. Each project picks which ones its sessions get.`}
    >
      <SettingSection
        title="Folders"
        count={folders.length}
        description={
          <>
            Files you upload here. Sessions see each folder at{" "}
            <code className="font-mono text-meta">/workspace/home/&lt;name&gt;</code>.
          </>
        }
        action={
          owner ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialog({ kind: "new-folder" })}
            >
              New folder…
            </Button>
          ) : undefined
        }
      >
        {owner ? (
          <PhoneAction label="New folder…" onClick={() => setDialog({ kind: "new-folder" })} />
        ) : null}
        {folders.length === 0 ? (
          <Empty>
            No folders yet.{" "}
            {owner
              ? "Make one, then upload the files sessions should read."
              : `An owner of ${organizationName} makes them.`}
          </Empty>
        ) : (
          <div role="table" aria-label="Folders" className="text-row">
            <div
              role="row"
              className="grid grid-cols-[minmax(0,1fr)_5rem_6rem_8rem_auto] gap-4 border-b border-border py-2 text-meta text-muted-foreground max-lg:hidden"
            >
              <span role="columnheader">Name</span>
              <span role="columnheader">Files</span>
              <span role="columnheader">Size</span>
              <span role="columnheader">Added</span>
              <span role="columnheader" className="w-36">
                <span className="sr-only">Actions</span>
              </span>
            </div>
            {folders.map((folder) => (
              <FolderRow
                key={folder.id}
                folder={folder}
                owner={owner}
                now={now}
                open={shown === folder.id}
                onToggle={() => setShown(shown === folder.id ? null : folder.id)}
                onShow={() => setShown(folder.id)}
                onRename={() => setDialog({ kind: "rename", folder })}
                onDelete={() => setDialog({ kind: "delete", folder })}
              />
            ))}
          </div>
        )}
      </SettingSection>
      <SettingSection
        title="References"
        count={references.length}
        description={
          <>
            Repositories that sessions can read but not change, at{" "}
            <code className="font-mono text-meta">/workspace/ref/&lt;name&gt;</code>. Mend fetches
            the branch or tag you pick.
          </>
        }
        action={
          owner ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialog({ kind: "add-reference" })}
            >
              Add reference…
            </Button>
          ) : undefined
        }
      >
        {owner ? (
          <PhoneAction
            label="Add reference…"
            onClick={() => setDialog({ kind: "add-reference" })}
          />
        ) : null}
        {references.length === 0 ? (
          <Empty>
            No references yet.{" "}
            {owner
              ? "Add a repository sessions should read beside their own, such as a library or a style guide."
              : `An owner of ${organizationName} adds them.`}
          </Empty>
        ) : (
          <div role="table" aria-label="References" className="text-row">
            <div
              role="row"
              className="grid grid-cols-[10rem_minmax(0,1fr)_7.5rem_6.5rem_auto] gap-4 border-b border-border py-2 text-meta text-muted-foreground max-lg:hidden"
            >
              <span role="columnheader">Name</span>
              <span role="columnheader">Repository</span>
              <span role="columnheader">Ref</span>
              <span role="columnheader">Fetched</span>
              <span role="columnheader" className="w-36">
                <span className="sr-only">Actions</span>
              </span>
            </div>
            {references.map((reference) => (
              <ReferenceRow
                key={reference.id}
                reference={reference}
                owner={owner}
                now={now}
                onRemove={() => setDialog({ kind: "remove-reference", reference })}
              />
            ))}
          </div>
        )}
      </SettingSection>
      <NewFolderDialog open={dialog?.kind === "new-folder"} onClose={close} />
      <RenameFolderDialog
        folder={dialog?.kind === "rename" ? dialog.folder : null}
        onClose={close}
      />
      <DeleteFolderDialog
        folder={dialog?.kind === "delete" ? dialog.folder : null}
        onClose={close}
      />
      <AddReferenceDialog open={dialog?.kind === "add-reference"} onClose={close} />
      <RemoveReferenceDialog
        reference={dialog?.kind === "remove-reference" ? dialog.reference : null}
        onClose={close}
      />
    </SettingsPage>
  );
}

function Empty({ children }: { readonly children: ReactNode }) {
  return (
    <p className="border-b border-border px-5 py-4 text-row text-muted-foreground max-lg:px-4">
      {children}
    </p>
  );
}

/** A section's own action on a phone, under its heading, filling the width. */
function PhoneAction({ label, onClick }: { readonly label: string; readonly onClick: () => void }) {
  return (
    <div className="border-b border-border px-4 py-3 lg:hidden">
      <Button type="button" variant="outline" size="touch" className="w-full" onClick={onClick}>
        {label}
      </Button>
    </div>
  );
}

// --- Folders ------------------------------------------------------------------------------------

/** One folder's listing, read for its file count and size and for its file list. */
const useListing = (id: FolderDto["id"]) => {
  const trpc = useTRPC();
  return useQuery(trpc.folders.files.queryOptions({ id }));
};

function FolderRow({
  folder,
  owner,
  now,
  open,
  onToggle,
  onShow,
  onRename,
  onDelete,
}: {
  readonly folder: FolderDto;
  readonly owner: boolean;
  readonly now: Date;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onShow: () => void;
  readonly onRename: () => void;
  readonly onDelete: () => void;
}) {
  const phone = usePhone();
  const listing = useListing(folder.id);
  const upload = useFolderUpload(folder);
  const files = useRef<HTMLInputElement>(null);
  const directory = useRef<HTMLInputElement>(null);
  const facts = listing.isSuccess ? folderFacts(listing.data) : null;
  const factLine = listing.isPending
    ? "Reading…"
    : listing.isError
      ? "Mend couldn't read its files."
      : facts === null
        ? ""
        : `${filesWords(facts.files)} · ${facts.size}`;
  return (
    <>
      <div
        role="row"
        aria-label={folder.name}
        className="grid grid-cols-[minmax(0,1fr)_5rem_6rem_8rem_auto] items-center gap-4 border-b border-border py-2.5 max-lg:grid-cols-[minmax(0,1fr)_auto] max-lg:px-4"
      >
        <span role="cell" className="flex min-w-0 items-center gap-2.5">
          <FolderIcon aria-hidden className="size-4 flex-none text-muted-foreground" />
          <span className="min-w-0">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={`folder-files-${folder.id}`}
              aria-label={`${open ? "Hide" : "Show"} the files in ${folder.name}`}
              onClick={onToggle}
              className="block truncate text-left font-mono text-meta font-semibold underline-offset-2 hover:underline"
            >
              {folder.name}
            </button>
            <span className="block text-meta text-muted-foreground lg:hidden">
              {[factLine, `added ${agoWords(folder.createdAt, now)}`]
                .filter((part) => part !== "")
                .join(" · ")}
            </span>
          </span>
        </span>
        <span role="cell" className="max-lg:hidden">
          {listing.isError ? (
            <span className="text-destructive">Not read</span>
          ) : (
            (facts?.files ?? "…")
          )}
        </span>
        <span role="cell" className="max-lg:hidden">
          {facts?.size ?? ""}
        </span>
        <span role="cell" className="text-muted-foreground max-lg:hidden">
          {agoWords(folder.createdAt, now)}
        </span>
        <span role="cell" className="flex w-36 items-center justify-end gap-1 max-lg:w-auto">
          {owner ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="max-lg:hidden"
              disabled={upload.isPending}
              onClick={() => pick(files.current)}
            >
              {upload.isPending ? <Spinner aria-hidden /> : null}
              {upload.isPending ? "Uploading…" : "Upload files…"}
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size={phone ? "icon-touch" : "icon-sm"}
                  aria-label={`Actions for ${folder.name}`}
                  className="text-muted-foreground"
                >
                  <EllipsisIcon aria-hidden />
                </Button>
              }
            />
            <DropdownMenuContent align="end" width="sm">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{folder.name}</DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuItem onClick={onToggle}>
                <FolderIcon aria-hidden />
                {open ? "Hide files" : "Show files"}
              </DropdownMenuItem>
              {owner ? (
                <>
                  <DropdownMenuItem disabled={upload.isPending} onClick={() => pick(files.current)}>
                    <UploadIcon aria-hidden />
                    Upload files…
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={upload.isPending}
                    onClick={() => pick(directory.current)}
                  >
                    <UploadIcon aria-hidden />
                    Upload a folder…
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onRename}>
                    <PencilIcon aria-hidden />
                    Rename…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={onDelete}>
                    <Trash2Icon aria-hidden />
                    Delete folder…
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      {upload.isError ? (
        <p
          role="alert"
          className="border-b border-border py-2 text-row text-destructive max-lg:px-4"
        >
          Mend didn't upload every file to {folder.name}.{" "}
          {failureWords(upload.error, "Check your connection and try again.")}
        </p>
      ) : null}
      {open ? <FolderFiles folder={folder} owner={owner} /> : null}
      {owner ? (
        <>
          <input
            ref={files}
            data-upload-to={folder.name}
            data-upload-kind="files"
            type="file"
            multiple
            tabIndex={-1}
            aria-hidden="true"
            className="hidden"
            onChange={(event) => {
              const picked = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (picked.length > 0) {
                onShow();
                upload.mutate(picked);
              }
            }}
          />
          <input
            ref={(node) => {
              directory.current = node;
              node?.setAttribute("webkitdirectory", "");
            }}
            data-upload-to={folder.name}
            data-upload-kind="directory"
            type="file"
            multiple
            tabIndex={-1}
            aria-hidden="true"
            className="hidden"
            onChange={(event) => {
              const picked = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (picked.length > 0) {
                onShow();
                upload.mutate(picked);
              }
            }}
          />
        </>
      ) : null}
    </>
  );
}

/**
 * Upload picked files in batches the server accepts; files over the limits are left out and
 * named in the toast.
 */
const useFolderUpload = (folder: FolderDto) => {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: trpc.folders.upload.mutationKey(),
    mutationFn: async (picked: ReadonlyArray<File>) => {
      const plan = planUpload(
        picked.map((file) => ({ path: stagedPath(file), size: file.size, file })),
      );
      let sent = 0;
      for (const batch of plan.batches) {
        const files = await Promise.all(
          batch.map(async (staged) => ({
            path: staged.path,
            contentsBase64: toBase64(new Uint8Array(await staged.file.arrayBuffer())),
          })),
        );
        await client.folders.upload.mutate({ id: folder.id, files, merge: true });
        sent += batch.length;
      }
      return uploadedWords(folder.name, sent, plan.rejected);
    },
    onSuccess: (words) => toast.add({ description: words }),
    onSettled: () => queryClient.invalidateQueries(trpc.folders.files.pathFilter()),
  });
};

/** A folder's files, under its row: each file's path and size, and Delete for owners. */
function FolderFiles({ folder, owner }: { readonly folder: FolderDto; readonly owner: boolean }) {
  const trpc = useTRPC();
  const phone = usePhone();
  const queryClient = useQueryClient();
  const listing = useListing(folder.id);
  const remove = useMutation(
    trpc.folders.deleteFile.mutationOptions({
      onSettled: () => queryClient.invalidateQueries(trpc.folders.files.pathFilter()),
    }),
  );
  return (
    <section
      id={`folder-files-${folder.id}`}
      aria-label={`Files in ${folder.name}`}
      className="border-b border-border bg-muted/40 px-4 py-2 text-row"
    >
      {listing.isPending ? (
        <p className="py-2 text-muted-foreground">Reading the files…</p>
      ) : listing.isError ? (
        <div className="flex items-center gap-3 py-2">
          <p role="alert" className="text-destructive">
            Mend couldn't read the files in {folder.name}.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void listing.refetch()}>
            Try again
          </Button>
        </div>
      ) : listing.data.files.length === 0 ? (
        <p className="py-2 text-muted-foreground">
          No files yet.{owner ? " Upload files or a whole folder from the row's menu." : ""}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {listing.data.files.map((file) => {
            const deleting = remove.isPending && remove.variables.path === file.path;
            return (
              <li key={file.path} className="flex items-center gap-3 py-1.5">
                <span className="min-w-0 flex-1 font-mono text-meta wrap-anywhere">
                  {file.path}
                </span>
                <span className="flex-none text-meta text-muted-foreground">
                  {sizeWords(file.bytes)}
                </span>
                {owner ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size={phone ? "touch" : "sm"}
                    disabled={deleting}
                    aria-label={`Delete ${file.path}`}
                    onClick={() => remove.mutate({ id: folder.id, path: file.path })}
                  >
                    {deleting ? "Deleting…" : "Delete"}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {listing.data?.truncated === true ? (
        <p className="py-1 text-meta text-muted-foreground">
          Only the first files are listed. `mend folder push` replaces the whole folder.
        </p>
      ) : null}
      {remove.isError ? (
        <p role="alert" className="py-1 text-destructive">
          Mend didn't delete {remove.variables.path}. {failureWords(remove.error, "Try again.")}
        </p>
      ) : null}
    </section>
  );
}

/** One name field, for a new folder or a new name. */
function NameForm({
  id,
  label,
  initial,
  submit,
  pending,
  error,
  onCancel,
}: {
  readonly id: string;
  readonly label: string;
  readonly initial: string;
  readonly submit: {
    readonly label: string;
    readonly busy: string;
    readonly run: (name: string) => void;
  };
  readonly pending: boolean;
  readonly error: ReactNode;
  readonly onCancel: () => void;
}) {
  const phone = usePhone();
  const [name, setName] = useState(initial);
  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() !== "") submit.run(name.trim());
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={id}>{label}</Label>
        <Input
          id={id}
          value={name}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error !== null}
          aria-describedby={`${id}-help`}
          className="h-9 font-mono max-lg:h-11 max-lg:text-base"
          onChange={(event) => setName(event.target.value)}
        />
        {error === null ? (
          <p id={`${id}-help`} className="text-meta text-muted-foreground">
            {FOLDER_NAME_HINT}
          </p>
        ) : (
          <p id={`${id}-help`} role="alert" className="text-row text-destructive">
            {error}
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2.5 pt-1 max-lg:*:flex-1">
        <Button
          type="button"
          variant="outline"
          size={touch(phone)}
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" size={touch(phone)} disabled={pending || name.trim() === ""}>
          {pending ? <Spinner aria-hidden /> : null}
          {pending ? submit.busy : submit.label}
        </Button>
      </div>
    </form>
  );
}

function NewFolderDialog({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const create = useMutation(trpc.folders.create.mutationOptions());
  const close = () => {
    if (create.isPending) return;
    create.reset();
    onClose();
  };
  const run = async (name: string) => {
    try {
      const made = await create.mutateAsync({ name });
      await queryClient.invalidateQueries(trpc.folders.list.queryFilter());
      toast.add({ description: `Made the folder ${made.name}.` });
      create.reset();
      onClose();
    } catch {
      // Said under the field, from the mutation's error.
    }
  };
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => (next ? undefined : close())}
      size="sm"
      title="New folder"
      description="Upload its files once it is made. Each project picks whether its sessions get it."
      footer={null}
    >
      {open ? (
        <NameForm
          id="new-folder-name"
          label="Name"
          initial=""
          submit={{ label: "Make folder", busy: "Making…", run: (name) => void run(name) }}
          pending={create.isPending}
          error={
            create.isError
              ? failureWords(create.error, "Mend didn't make the folder. Try again.")
              : null
          }
          onCancel={close}
        />
      ) : null}
    </Overlay>
  );
}

function RenameFolderDialog({
  folder,
  onClose,
}: {
  readonly folder: FolderDto | null;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const rename = useMutation(trpc.folders.rename.mutationOptions());
  const [shown, setShown] = useState(folder);
  if (folder !== null && folder !== shown) setShown(folder);
  const close = () => {
    if (rename.isPending) return;
    rename.reset();
    onClose();
  };
  const run = async (name: string) => {
    if (shown === null) return;
    try {
      const renamed = await rename.mutateAsync({ id: shown.id, name });
      await queryClient.invalidateQueries(trpc.folders.list.queryFilter());
      toast.add({ description: `Renamed the folder to ${renamed.name}.` });
      rename.reset();
      onClose();
    } catch {
      // Said under the field, from the mutation's error.
    }
  };
  return (
    <Overlay
      open={folder !== null}
      onOpenChange={(next) => (next ? undefined : close())}
      size="sm"
      title={`Rename ${shown?.name ?? "the folder"}`}
      description="Its files stay as they are. A project that picked it keeps the name it mounts it under."
      footer={null}
    >
      {folder === null ? null : (
        <NameForm
          id="rename-folder-name"
          label="New name"
          initial={folder.name}
          submit={{ label: "Rename", busy: "Renaming…", run: (name) => void run(name) }}
          pending={rename.isPending}
          error={
            rename.isError
              ? failureWords(rename.error, "Mend didn't rename the folder. Try again.")
              : null
          }
          onCancel={close}
        />
      )}
    </Overlay>
  );
}

function DeleteFolderDialog({
  folder,
  onClose,
}: {
  readonly folder: FolderDto | null;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const remove = useMutation(trpc.folders.remove.mutationOptions());
  const [shown, setShown] = useState(folder);
  if (folder !== null && folder !== shown) setShown(folder);
  const listing = useQuery(
    trpc.folders.files.queryOptions(shown === null ? skipToken : { id: shown.id }),
  );
  const close = () => {
    if (remove.isPending) return;
    remove.reset();
    onClose();
  };
  const confirm = async () => {
    if (shown === null) return;
    try {
      await remove.mutateAsync({ id: shown.id });
      await queryClient.invalidateQueries(trpc.folders.list.queryFilter());
      toast.add({ description: `Deleted the folder ${shown.name}.` });
      remove.reset();
      onClose();
    } catch {
      // Said in the dialog, from the mutation's error.
    }
  };
  return (
    <Overlay
      open={folder !== null}
      onOpenChange={(next) => (next ? undefined : close())}
      size="sm"
      title={`Delete the ${shown?.name ?? ""} folder?`}
      description={
        listing.isPending
          ? "Mend is reading what the folder holds…"
          : listing.isError
            ? deleteFolderLine(null)
            : deleteFolderLine(folderFacts(listing.data))
      }
      footer={
        <>
          <Button type="button" variant="outline" disabled={remove.isPending} onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => void confirm()}
          >
            {remove.isPending ? <Spinner aria-hidden /> : null}
            {remove.isPending ? "Deleting…" : "Delete folder"}
          </Button>
        </>
      }
    >
      <ul className="grid list-disc gap-1.5 pl-5 text-row text-pretty text-foreground-2">
        <li>Mend refuses while a project still picks it: take it out of that project first.</li>
        <li>Sessions that are running keep their copy until they stop.</li>
      </ul>
      {remove.isError ? (
        <p role="alert" className="mt-3 text-row text-destructive">
          Mend didn't delete the folder. {failureWords(remove.error, "Try again.")}
        </p>
      ) : null}
    </Overlay>
  );
}

// --- References ---------------------------------------------------------------------------------

function ReferenceRow({
  reference,
  owner,
  now,
  onRemove,
}: {
  readonly reference: Reference;
  readonly owner: boolean;
  readonly now: Date;
  readonly onRemove: () => void;
}) {
  const trpc = useTRPC();
  const phone = usePhone();
  const queryClient = useQueryClient();
  const refresh = useMutation(
    trpc.git.refreshReference.mutationOptions({
      onSuccess: (fresh) => toast.add({ description: `Fetched ${fresh.name} again.` }),
      onSettled: () => queryClient.invalidateQueries(trpc.git.references.queryFilter()),
    }),
  );
  const fetched =
    reference.refreshedAt === null ? "Not fetched yet" : agoWords(reference.refreshedAt, now);
  const ref = reference.pinnedRef ?? "default branch";
  return (
    <>
      <div
        role="row"
        aria-label={reference.name}
        className="grid grid-cols-[10rem_minmax(0,1fr)_7.5rem_6.5rem_auto] items-center gap-4 border-b border-border py-2.5 max-lg:grid-cols-[minmax(0,1fr)_auto] max-lg:px-4"
      >
        <span role="cell" className="flex min-w-0 items-center gap-2.5">
          <BookMarkedIcon aria-hidden className="size-4 flex-none text-muted-foreground" />
          <span className="min-w-0">
            <span className="block truncate font-mono text-meta font-semibold">
              {reference.name}
            </span>
            <span className="block text-meta text-muted-foreground lg:hidden">
              <span className="font-mono">{ref}</span> · {repositoryWords(reference.originUrl)} ·{" "}
              {fetched}
            </span>
          </span>
        </span>
        <span role="cell" className="truncate font-mono text-meta max-lg:hidden">
          {repositoryWords(reference.originUrl)}
        </span>
        <span role="cell" className="truncate font-mono text-meta max-lg:hidden">
          {ref}
        </span>
        <span role="cell" className="text-muted-foreground max-lg:hidden">
          {fetched}
        </span>
        <span role="cell" className="flex w-36 items-center justify-end gap-1 max-lg:w-auto">
          {owner ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="max-lg:hidden"
                disabled={refresh.isPending}
                onClick={() => refresh.mutate({ id: reference.id })}
              >
                {refresh.isPending ? <Spinner aria-hidden /> : null}
                {refresh.isPending ? "Fetching…" : "Fetch again"}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size={phone ? "icon-touch" : "icon-sm"}
                      aria-label={`Actions for ${reference.name}`}
                      className="text-muted-foreground"
                    >
                      <EllipsisIcon aria-hidden />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" width="sm">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>{reference.name}</DropdownMenuLabel>
                  </DropdownMenuGroup>
                  <DropdownMenuItem
                    disabled={refresh.isPending}
                    onClick={() => refresh.mutate({ id: reference.id })}
                  >
                    <RefreshCwIcon aria-hidden />
                    Fetch again
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={onRemove}>
                    <Trash2Icon aria-hidden />
                    Remove reference…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : null}
        </span>
      </div>
      {refresh.isError ? (
        <p
          role="alert"
          className="border-b border-border py-2 text-row text-destructive max-lg:px-4"
        >
          Mend couldn't fetch {reference.name} again.{" "}
          {failureWords(refresh.error, "Check the repository's address and try again.")}
        </p>
      ) : null}
    </>
  );
}

function AddReferenceDialog({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const phone = usePhone();
  const queryClient = useQueryClient();
  const add = useMutation(trpc.git.addReference.mutationOptions());
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [ref, setRef] = useState("");
  const close = () => {
    if (add.isPending) return;
    add.reset();
    setName("");
    setSource("");
    setRef("");
    onClose();
  };
  const submit = async () => {
    try {
      const added = await add.mutateAsync({
        name: name.trim(),
        source: source.trim(),
        ref: ref.trim() === "" ? null : ref.trim(),
      });
      await queryClient.invalidateQueries(trpc.git.references.queryFilter());
      toast.add({ description: `Added the reference ${added.name}.` });
      add.reset();
      setName("");
      setSource("");
      setRef("");
      onClose();
    } catch {
      // Said under the fields, from the mutation's error.
    }
  };
  const field = "h-9 font-mono max-lg:h-11 max-lg:text-base";
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => (next ? undefined : close())}
      size="md"
      title="Add reference"
      description="Mend clones the repository now and keeps it at the branch or tag you pick. Each project picks whether its sessions get it."
      footer={null}
    >
      <form
        noValidate
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="reference-source">Repository</Label>
          <Input
            id="reference-source"
            value={source}
            placeholder="https://github.com/org/repo"
            autoComplete="off"
            spellCheck={false}
            className={field}
            onChange={(event) => setSource(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="reference-name">Name</Label>
          <Input
            id="reference-name"
            value={name}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="reference-name-help"
            className={field}
            onChange={(event) => setName(event.target.value)}
          />
          <p id="reference-name-help" className="text-meta text-muted-foreground">
            Sessions see it at{" "}
            <code className="font-mono">/workspace/ref/{name.trim() || "<name>"}</code>.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="reference-ref">Branch or tag</Label>
          <Input
            id="reference-ref"
            value={ref}
            placeholder="The default branch"
            autoComplete="off"
            spellCheck={false}
            className={field}
            onChange={(event) => setRef(event.target.value)}
          />
        </div>
        {add.isError ? (
          <p role="alert" className="text-row text-destructive">
            {failureWords(add.error, "Mend didn't add the reference. Try again.")}
          </p>
        ) : null}
        <div className="flex justify-end gap-2.5 pt-1 max-lg:*:flex-1">
          <Button
            type="button"
            variant="outline"
            size={touch(phone)}
            disabled={add.isPending}
            onClick={close}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            size={touch(phone)}
            disabled={add.isPending || name.trim() === "" || source.trim() === ""}
          >
            {add.isPending ? <Spinner aria-hidden /> : null}
            {add.isPending ? "Cloning…" : "Add reference"}
          </Button>
        </div>
      </form>
    </Overlay>
  );
}

function RemoveReferenceDialog({
  reference,
  onClose,
}: {
  readonly reference: Reference | null;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const remove = useMutation(trpc.git.removeReference.mutationOptions());
  const [shown, setShown] = useState(reference);
  if (reference !== null && reference !== shown) setShown(reference);
  const close = () => {
    if (remove.isPending) return;
    remove.reset();
    onClose();
  };
  const confirm = async () => {
    if (shown === null) return;
    try {
      await remove.mutateAsync({ id: shown.id });
      await queryClient.invalidateQueries(trpc.git.references.queryFilter());
      toast.add({ description: `Removed the reference ${shown.name}.` });
      remove.reset();
      onClose();
    } catch {
      // Said in the dialog, from the mutation's error.
    }
  };
  return (
    <Overlay
      open={reference !== null}
      onOpenChange={(next) => (next ? undefined : close())}
      size="sm"
      title={`Remove the ${shown?.name ?? ""} reference?`}
      description={`Mend deletes its clone. New sessions in the projects that picked it no longer get /workspace/ref/${shown?.name ?? ""}; sessions that are running keep their copy until they stop.`}
      footer={
        <>
          <Button type="button" variant="outline" disabled={remove.isPending} onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => void confirm()}
          >
            {remove.isPending ? <Spinner aria-hidden /> : null}
            {remove.isPending ? "Removing…" : "Remove reference"}
          </Button>
        </>
      }
    >
      {remove.isError ? (
        <p role="alert" className="text-row text-destructive">
          Mend didn't remove the reference. {failureWords(remove.error, "Try again.")}
        </p>
      ) : null}
    </Overlay>
  );
}
