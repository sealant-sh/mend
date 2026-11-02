import { ProjectId } from "@mend/domain";
import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "#/components/kit/button";
import { Field, GroupField, TextInput } from "#/components/kit/field";
import { ModalDialog } from "#/components/kit/modal";
import { Panel, SettingsSection } from "#/components/kit/section";
import { Segment } from "#/components/kit/segment";
import { DataTable } from "#/components/kit/table";
import {
  addProjectMount,
  removeProjectMount,
  setProjectFolders,
  type FolderDto,
  type ProjectDetailDto,
  type ProjectDto,
} from "#/lib/api";
import { listChangeOptions } from "#/lib/project-settings";
import { useTRPC } from "#/lib/trpc";

import type { SettingsReads } from "./reads";

type Selection = Awaited<ReturnType<typeof setProjectFolders>>;

/** One folder's access changed: the change travels with its project. */
interface FolderChange {
  readonly projectId: string;
  readonly folderId: FolderDto["id"];
  readonly name: string;
  readonly access: Access;
}

const ACCESS: ReadonlyArray<Access> = ["off", "read", "write"];

/** Narrows a mutation's stored variables back to a folder change. */
const isFolderChange = (value: unknown): value is FolderChange =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "projectId") === "string" &&
  typeof Reflect.get(value, "folderId") === "string" &&
  typeof Reflect.get(value, "name") === "string" &&
  ACCESS.some((access) => access === Reflect.get(value, "access"));

const folderMutationKey = (projectId: string) => ["project-folders", projectId];

/** The selection the server holds, with one folder's access changed. */
const nextSelection = (confirmed: Selection, change: FolderChange) => [
  ...confirmed
    .filter((view) => view.folder.id !== change.folderId)
    .map((view) => ({ folderId: view.folder.id, name: view.name, readOnly: view.readOnly })),
  ...(change.access === "off"
    ? []
    : [{ folderId: change.folderId, name: change.name, readOnly: change.access === "read" }]),
];

/** What the Folders tab reads before it shows, started together. */
export const foldersReads: SettingsReads = ({ queryClient, trpc }, projectId) => [
  queryClient.prefetchQuery(trpc.folders.list.queryOptions()),
  queryClient.prefetchQuery(trpc.projects.folders.queryOptions({ id: projectId })),
  queryClient.prefetchQuery(trpc.projects.mounts.queryOptions({ id: projectId })),
];

const errorWords = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const mono = "font-mono text-[12px] text-ink-2";
const muted = "font-mono text-[12px] text-muted-foreground";

type Access = "off" | "read" | "write";

/** Project settings · Folders (screen L8): organization folders and server folders it mounts. */
export function FoldersSettings({ detail }: { readonly detail: ProjectDetailDto }) {
  const { project, capabilities, mountDelivery } = detail;
  return (
    <Panel>
      <OrganizationFolders
        project={project}
        manage={capabilities.manage}
        captured={mountDelivery === "sources"}
      />
      {capabilities.hostMounts ? <ServerFolders project={project} /> : null}
    </Panel>
  );
}

/**
 * Organization folders (docs/adr/0003): folders Mend keeps for the organization. Each one this
 * project turns on mounts at `/workspace/home/<name>` in its next sessions, read-only unless
 * chosen otherwise. A pick shows at once and goes back if Mend refuses it.
 */
function OrganizationFolders({
  project,
  manage,
  captured,
}: {
  readonly project: ProjectDto;
  readonly manage: boolean;
  readonly captured: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const folders = useQuery(trpc.folders.list.queryOptions());
  const selected = useQuery(trpc.projects.folders.queryOptions({ id: project.id }));

  // One change per folder, each applied when it leaves to the selection the server last confirmed.
  const save = useMutation({
    ...listChangeOptions<FolderChange, Selection>({
      queryClient,
      listKey: (id) => trpc.projects.folders.queryKey({ id }),
      mutationKey: folderMutationKey,
      send: (change, confirmed) =>
        setProjectFolders(ProjectId.make(change.projectId), nextSelection(confirmed ?? [], change)),
    }),
    mutationKey: folderMutationKey(project.id),
  });
  const pending = useMutationState({
    filters: { mutationKey: folderMutationKey(project.id), status: "pending" },
    select: (mutation) => mutation.state.variables,
  }).filter(isFolderChange);

  // A folder shows the newest change still on its way, else what the server holds.
  const accessOf = (folder: FolderDto): Access => {
    const waiting = pending.findLast((change) => change.folderId === folder.id);
    if (waiting !== undefined) return waiting.access;
    const entry = selected.data?.find((view) => view.folder.id === folder.id);
    return entry === undefined ? "off" : entry.readOnly ? "read" : "write";
  };
  const choose = (folder: FolderDto, access: Access) =>
    save.mutate({ projectId: project.id, folderId: folder.id, name: folder.name, access });

  return (
    <SettingsSection
      title="Organization folders"
      why="Folders Mend keeps for your organization (Settings › Organization › Folders). Turn one on to mount it in this project's workspaces."
    >
      {folders.isPending || selected.isPending ? (
        <p role="status" className="font-mono text-[12px] text-muted-foreground">
          Reading folders…
        </p>
      ) : folders.isError || selected.isError ? (
        <p role="alert" className="font-mono text-[12px] text-danger">
          Folders did not load: {errorWords(folders.error ?? selected.error)}
        </p>
      ) : (
        <DataTable
          label="Organization folders"
          columns={[
            { head: "Folder", width: "0.8fr" },
            { head: "Mounted at", width: "1.4fr" },
            { head: "Access", width: "1.4fr", align: "end" },
          ]}
          empty="no folders in this organization yet"
          rows={folders.data.map((folder) => {
            const access = accessOf(folder);
            return {
              key: folder.id,
              cells: [
                <span key="f" className={mono}>
                  {folder.name}
                </span>,
                <span key="m" className={muted}>
                  {access === "off" ? "not mounted" : `/workspace/home/${folder.name}`}
                </span>,
                <Segment
                  key="a"
                  label={`Access to ${folder.name}`}
                  value={access}
                  disabled={!manage}
                  onChange={(next) => choose(folder, next)}
                  options={[
                    { value: "off", label: "Off" },
                    { value: "read", label: "Read" },
                    { value: "write", label: "Read and write" },
                  ]}
                />,
              ],
            };
          })}
        />
      )}
      {captured ? (
        <p className="mt-2.5 max-w-[60ch] text-[12.5px] text-muted-foreground">
          This deployment runs captured workspaces, so a folder travels as a read-only copy: writes
          inside a session stay there.
        </p>
      ) : null}
      <p role="alert" className="mt-2 font-mono text-[11.5px] text-danger empty:hidden">
        {save.isError ? `Not saved: ${errorWords(save.error)}. The folder is back as it was.` : ""}
      </p>
    </SettingsSection>
  );
}

/**
 * Server folders (plan §17): directories on the Mend server itself, such as a models cache, each
 * mounted at `/workspace/home/<name>`. Writes to a read-and-write one land on the server folder
 * directly, outside the reviewed change.
 */
function ServerFolders({ project }: { readonly project: ProjectDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const mounts = useQuery(trpc.projects.mounts.queryOptions({ id: project.id }));
  const remove = useMutation({
    mutationFn: (mountId: string) => removeProjectMount(project.id, mountId),
    onSettled: () => queryClient.invalidateQueries(trpc.projects.mounts.queryFilter()),
  });
  return (
    <SettingsSection
      title="Server folders"
      why="Directories on the Mend server itself, such as a models cache. Writes land on the server folder, outside the reviewed change."
    >
      {mounts.isPending ? (
        <p role="status" className="font-mono text-[12px] text-muted-foreground">
          Reading server folders…
        </p>
      ) : mounts.isError ? (
        <p role="alert" className="font-mono text-[12px] text-danger">
          Server folders did not load: {mounts.error.message}
        </p>
      ) : (
        <DataTable
          label="Server folders"
          columns={[
            { head: "Name", width: "0.6fr" },
            { head: "Path on the server", width: "1fr" },
            { head: "Mounted at", width: "1.2fr" },
            { head: "Access", width: "0.8fr" },
            { head: "", width: "auto" },
          ]}
          empty="no server folders mounted"
          rows={mounts.data.map((mount) => ({
            key: mount.id,
            cells: [
              <span key="n" className={mono}>
                {mount.name}
              </span>,
              <span key="p" className={`${muted} block truncate`} title={mount.hostPath}>
                {mount.hostPath}
              </span>,
              <span key="m" className={muted}>
                /workspace/home/{mount.name}
              </span>,
              <span
                key="a"
                className={mount.readOnly ? mono : "font-mono text-[12px] text-warning"}
              >
                {mount.readOnly ? "read" : "read and write"}
              </span>,
              <Button
                key="r"
                size="sm"
                variant="ghost"
                disabled={remove.isPending}
                aria-label={`Unmount ${mount.name}`}
                onClick={() => remove.mutate(mount.id)}
              >
                {remove.isPending && remove.variables === mount.id ? "Unmounting…" : "Unmount"}
              </Button>,
            ],
          }))}
        />
      )}
      <p role="alert" className="mt-2 font-mono text-[11.5px] text-danger empty:hidden">
        {remove.isError ? `Not unmounted: ${errorWords(remove.error)}` : ""}
      </p>
      <div className="mt-2.5">
        <MountDialog project={project} />
      </div>
    </SettingsSection>
  );
}

function MountDialog({ project }: { readonly project: ProjectDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [hostPath, setHostPath] = useState("");
  const [access, setAccess] = useState<"read" | "write">("read");
  const mount = useMutation({
    mutationFn: () =>
      addProjectMount(project.id, {
        name: name.trim(),
        hostPath: hostPath.trim(),
        readOnly: access === "read",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries(trpc.projects.mounts.queryFilter());
      setOpen(false);
      setName("");
      setHostPath("");
      setAccess("read");
    },
  });
  const ready = name.trim() !== "" && hostPath.trim() !== "";
  return (
    <ModalDialog
      open={open}
      onOpenChange={(next) => {
        if (!mount.isPending) setOpen(next);
      }}
      trigger={<Button size="sm">Mount a server folder</Button>}
      title="Mount a server folder"
      description={`Next sessions in ${project.name} see it at /workspace/home/<name>.`}
      width={500}
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) mount.mutate();
        }}
      >
        <Field label="Path on the server">
          {(id) => (
            <TextInput
              id={id}
              value={hostPath}
              placeholder="/srv/models"
              onChange={(event) => setHostPath(event.target.value)}
            />
          )}
        </Field>
        <Field label="Name">
          {(id) => (
            <TextInput
              id={id}
              value={name}
              placeholder="models"
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        <GroupField label="Access">
          <Segment
            label="Access"
            value={access}
            onChange={setAccess}
            options={[
              { value: "read", label: "Read" },
              { value: "write", label: "Read and write" },
            ]}
          />
        </GroupField>
        <p role="alert" className="font-mono text-[11.5px] text-danger empty:hidden">
          {mount.isError ? `Not mounted: ${errorWords(mount.error)}` : ""}
        </p>
        <div className="flex justify-end gap-2.5">
          <Button variant="ghost" disabled={mount.isPending} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={mount.isPending || !ready}>
            {mount.isPending ? "Mounting…" : "Mount folder"}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}
