import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { Button, Chevron } from "#/components/kit/button";
import { TextInput } from "#/components/kit/field";
import { FileButton } from "#/components/kit/file-button";
import { Menu, MenuItem, MenuSeparator } from "#/components/kit/menu";
import { ModalDialog } from "#/components/kit/modal";
import { Panel, SettingsSection } from "#/components/kit/section";
import { ErrorNote, errorText } from "#/components/kit/status";
import { DataTable } from "#/components/kit/table";
import type { FolderDto } from "#/lib/api";
import { formatBytes, planUpload, stagedPath, toBase64 } from "#/lib/organization";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

import { day, Notice, useOrganizationView } from "./org-parts";

/**
 * O6 · Folders (docs/adr/0003): directories Mend keeps for the organization, which a project
 * mounts for its next sessions. Everyone reads them; owners make, fill and remove them.
 */
export function FoldersTab() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const view = useOrganizationView();
  const folders = useSuspenseQuery(trpc.folders.list.queryOptions()).data;
  const owner = view.role === "owner";
  const [name, setName] = useState("");
  const [shown, setShown] = useState<FolderDto["id"] | null>(null);
  const [removing, setRemoving] = useState<FolderDto | null>(null);
  const refresh = () => queryClient.invalidateQueries(trpc.folders.pathFilter());

  const create = useMutation(
    trpc.folders.create.mutationOptions({
      onSuccess: () => setName(""),
      onSettled: refresh,
    }),
  );
  const remove = useMutation(
    trpc.folders.remove.mutationOptions({
      onSuccess: () => setRemoving(null),
      onSettled: refresh,
    }),
  );
  const upload = useFolderUpload();
  const open = folders.find((folder) => folder.id === shown) ?? null;

  return (
    <Panel>
      <SettingsSection
        title="Folders"
        why={
          <>
            Shared with everyone in {view.organization.name}; each project picks which it mounts, at{" "}
            <span className="font-mono text-[12px]">/workspace/home/&lt;name&gt;</span>, read-only
            unless chosen otherwise.
            {view.mountDelivery === "sources"
              ? " This deployment runs captured workspaces, so a folder travels as a read-only copy: writes inside a session stay there."
              : ""}
          </>
        }
      >
        <DataTable
          label="Folders"
          columns={[
            { head: "Folder", width: "1fr" },
            { head: "Created", width: "1fr" },
            { head: "", width: owner ? "190px" : "auto", align: "end" },
          ]}
          empty="no folders yet"
          rows={folders.map((folder) => ({
            key: folder.id,
            cells: [
              <span key="name" className="font-mono text-[12.5px] text-ink-2">
                {folder.name}
              </span>,
              <span key="created" className="font-mono text-[12px] text-muted-foreground">
                {day(folder.createdAt)}
              </span>,
              <span key="actions" className="flex justify-end gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={shown === folder.id}
                  aria-controls="folder-files"
                  aria-label={`${shown === folder.id ? "Hide" : "Show"} the files in ${folder.name}`}
                  onClick={() => setShown(shown === folder.id ? null : folder.id)}
                >
                  {shown === folder.id ? "Hide files" : "Files"}
                </Button>
                {owner ? (
                  <FolderMenu
                    folder={folder}
                    busy={upload.isPending && upload.variables?.folder.id === folder.id}
                    onFiles={(files) => {
                      setShown(folder.id);
                      upload.mutate({ folder, files });
                    }}
                    onRemove={() => {
                      remove.reset();
                      setRemoving(folder);
                    }}
                  />
                ) : null}
              </span>,
            ],
          }))}
        />
        {upload.data === undefined ? null : <Notice>{upload.data}</Notice>}
        {upload.error === null ? null : (
          <ErrorNote className="mt-3">{errorText(upload.error)}</ErrorNote>
        )}
        {open === null ? null : <FolderFiles folder={open} owner={owner} />}
        {owner ? (
          <form
            className="mt-3 flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate({ name: name.trim() });
            }}
          >
            <TextInput
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label="New folder name"
              placeholder="name"
              className="flex-1"
            />
            <Button type="submit" disabled={create.isPending || name.trim() === ""}>
              {create.isPending ? "Creating…" : "New folder"}
            </Button>
          </form>
        ) : null}
        {create.error === null ? null : (
          <ErrorNote className="mt-3">{errorText(create.error)}</ErrorNote>
        )}
      </SettingsSection>
      <ModalDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next && !remove.isPending) setRemoving(null);
        }}
        title={`Remove ${removing?.name ?? ""}?`}
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
                if (removing !== null) remove.mutate({ id: removing.id });
              }}
            >
              {remove.isPending ? "Removing…" : `Remove ${removing?.name ?? ""}`}
            </Button>
          </>
        }
      >
        {remove.error === null ? null : <ErrorNote>{errorText(remove.error)}</ErrorNote>}
      </ModalDialog>
    </Panel>
  );
}

/** An owner's actions on one folder: add files, add a whole folder, remove it. */
function FolderMenu({
  folder,
  busy,
  onFiles,
  onRemove,
}: {
  readonly folder: FolderDto;
  readonly busy: boolean;
  readonly onFiles: (files: ReadonlyArray<File>) => void;
  readonly onRemove: () => void;
}) {
  const directory = useRef<HTMLInputElement>(null);
  return (
    <>
      <FileButton size="sm" variant="ghost" multiple disabled={busy} onFiles={onFiles}>
        {busy ? "Uploading…" : "Add files…"}
      </FileButton>
      <Menu
        align="end"
        trigger={
          <Button size="sm" variant="ghost" aria-label={`More for ${folder.name}`}>
            More
            <Chevron />
          </Button>
        }
      >
        <MenuItem disabled={busy} onClick={() => directory.current?.click()}>
          Add a folder…
        </MenuItem>
        <MenuSeparator />
        <MenuItem className="text-danger data-highlighted:text-danger" onClick={onRemove}>
          Remove…
        </MenuItem>
      </Menu>
      <input
        ref={(node) => {
          directory.current = node;
          node?.setAttribute("webkitdirectory", "");
        }}
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
    </>
  );
}

/**
 * Upload picked files in batches the server accepts; files over the limits are left out and
 * named. Resolves with what it did, in one line.
 */
const useFolderUpload = () => {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      folder,
      files: picked,
    }: {
      readonly folder: FolderDto;
      readonly files: ReadonlyArray<File>;
    }) => {
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
      const left = plan.rejected.length;
      const reasons = [...new Set(plan.rejected.map((entry) => entry.reason))].join(", ");
      return `added ${sent} ${sent === 1 ? "file" : "files"} to ${folder.name}${left === 0 ? "" : ` · ${left} left out (${reasons})`}`;
    },
    onSettled: () => queryClient.invalidateQueries(trpc.folders.files.pathFilter()),
  });
};

function FolderFiles({ folder, owner }: { readonly folder: FolderDto; readonly owner: boolean }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listing = useQuery(trpc.folders.files.queryOptions({ id: folder.id }));
  const remove = useMutation(
    trpc.folders.deleteFile.mutationOptions({
      onSettled: () => queryClient.invalidateQueries(trpc.folders.files.pathFilter()),
    }),
  );
  const files = listing.data?.files ?? [];
  return (
    <section id="folder-files" aria-label={`Files in ${folder.name}`} className="mt-3">
      <p className="mb-1 px-4 font-sans text-[12.5px] font-medium text-ink-2">
        Files in <span className="font-mono">{folder.name}</span>
      </p>
      {listing.error === null ? null : <ErrorNote>{errorText(listing.error)}</ErrorNote>}
      <DataTable
        label={`Files in ${folder.name}`}
        columns={[
          { head: "Path", width: "2fr" },
          { head: "Size", width: "0.6fr" },
          ...(owner ? [{ head: "", width: "auto" }] : []),
        ]}
        empty={listing.isPending ? "reading…" : "empty"}
        rows={files.map((file) => ({
          key: file.path,
          cells: [
            <span key="path" className="font-mono text-[12px] break-all text-ink-2">
              {file.path}
            </span>,
            <span key="size" className="font-mono text-[12px] text-muted-foreground">
              {formatBytes(file.bytes)}
            </span>,
            ...(owner
              ? [
                  <Button
                    key="delete"
                    size="sm"
                    variant="ghost"
                    disabled={remove.isPending && remove.variables?.path === file.path}
                    aria-label={`Delete ${file.path}`}
                    onClick={() => remove.mutate({ id: folder.id, path: file.path })}
                  >
                    {remove.isPending && remove.variables?.path === file.path
                      ? "Deleting…"
                      : "Delete"}
                  </Button>,
                ]
              : []),
          ],
        }))}
      />
      {listing.data?.truncated === true ? (
        <p className="px-4 font-mono text-[12px] text-faint">listing truncated</p>
      ) : null}
      {remove.error === null ? null : (
        <ErrorNote className="mt-2">{errorText(remove.error)}</ErrorNote>
      )}
    </section>
  );
}
