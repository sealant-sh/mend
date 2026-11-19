import { Segmented } from "@mend/ui/components/segmented";
import { Button } from "@mend/ui/components/ui/button";
import { Input } from "@mend/ui/components/ui/input";
import { Label } from "@mend/ui/components/ui/label";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { Switch } from "@mend/ui/components/ui/switch";
import { toast } from "@mend/ui/components/ui/toast";
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookMarkedIcon, FolderIcon, HardDriveIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { FolderDto, ProjectDto, ProjectMountDto, ReferenceDto } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import {
  ACCESS_WORDS,
  capturedNote,
  type FolderAccess,
  type FolderChange,
  folderSize,
  isFolderChange,
  isReferenceChange,
  nextFolderSelection,
  nextReferenceIds,
  type ReferenceChange,
  referenceVersion,
  shownAccess,
  shownSelected,
} from "#/lib/project-folders";
import { type ProjectPeople, readOnlyLine } from "#/lib/project-settings";
import { failureWords } from "#/lib/refusal";
import { sendInTurn } from "#/lib/serial-writes";
import { useTRPC, useTRPCClient } from "#/lib/trpc";
import { useProjectSettings } from "#/lib/use-project-settings";

import { Overlay } from "../projects/overlay.tsx";
import { SettingSection } from "./setting-row.tsx";
import { settingsLink } from "./settings-links.tsx";
import { SettingsPage } from "./settings-page.tsx";

const ACCESS_ORDER: ReadonlyArray<FolderAccess> = ["off", "read", "write"];

/** A path or a name as sessions see it: Geist Mono, at the row's size. */
const MONO = "font-mono text-meta";

/**
 * Settings → a project → Folders and references (Doop "Settings · Project · checkout-api · Folders
 * and references"): which of the organization's folders and references the project's sessions get,
 * and the server folders an operator mounted (references-folders.md `folder-select`, `ref-select`,
 * `host-mounts`). The organization's own page is where folders and references are made, renamed
 * and removed (docs/adr/0025); this page links there. Everyone who can open the project reads it;
 * the person who added it and the organization's owners change it (`capabilities.manage`), and an
 * operator of a single install adds and removes server folders (`capabilities.hostMounts`). The
 * route's loader read every list.
 */
export function ProjectFoldersPage({ projectId }: { readonly projectId: string }) {
  const trpc = useTRPC();
  const { detail, people } = useProjectSettings(projectId);
  const { project, capabilities, mountDelivery } = detail;
  const mounts = useSuspenseQuery(trpc.projects.mounts.queryOptions({ id: project.id })).data;
  const intro = `These are the folders and references ${project.name}'s sessions can open. Changes apply to sessions that start after you make them.`;
  return (
    <SettingsPage
      page="p-folders"
      project={{ id: project.id, name: project.name }}
      intro={capabilities.manage ? intro : `${intro} ${readOnlyLine(people)}`}
    >
      <FoldersSection
        project={project}
        people={people}
        manage={capabilities.manage}
        mountDelivery={mountDelivery}
      />
      <ReferencesSection project={project} people={people} manage={capabilities.manage} />
      {mounts.length > 0 || capabilities.hostMounts ? (
        <ServerFoldersSection
          project={project}
          mounts={mounts}
          operator={capabilities.hostMounts}
          mountDelivery={mountDelivery}
        />
      ) : null}
    </SettingsPage>
  );
}

/** The organization's Folders and references page, named for a sentence. */
function OrganizationPageLink({ people }: { readonly people: ProjectPeople }) {
  return (
    <Link {...settingsLink("o-folders")} className="text-foreground underline underline-offset-2">
      {people.organizationName}&apos;s Folders and references page
    </Link>
  );
}

function Empty({ children }: { readonly children: ReactNode }) {
  return (
    <p className="border-b border-border py-4 text-row text-muted-foreground max-lg:px-4">
      {children}
    </p>
  );
}

function Note({ children }: { readonly children: string | null }) {
  return children === null ? null : (
    <p className="pt-2.5 text-row text-pretty text-muted-foreground max-lg:px-4">{children}</p>
  );
}

function Failure({ children }: { readonly children: string | null }) {
  return children === null ? null : (
    <p role="alert" className="pt-2.5 text-row text-pretty text-destructive max-lg:px-4">
      {children}
    </p>
  );
}

/** A table's header row, on the desk only: each row says its facts on a phone. */
function Head({
  columns,
  grid,
}: {
  readonly columns: ReadonlyArray<string>;
  readonly grid: string;
}) {
  return (
    <div
      role="row"
      className={`grid ${grid} gap-4 border-b border-border py-2 text-meta text-muted-foreground max-lg:hidden`}
    >
      {columns.map((column, index) => (
        <span
          key={column === "" ? `blank-${index}` : column}
          role="columnheader"
          className={index === columns.length - 1 ? "text-right" : undefined}
        >
          {column === "" ? <span className="sr-only">Actions</span> : column}
        </span>
      ))}
    </div>
  );
}

// --- Folders ------------------------------------------------------------------------------------

const FOLDER_GRID = "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_18rem]";

const folderMutationKey = (projectId: string) => ["project-folders", projectId];

/**
 * The organization's folders, each Off, Read only or Read and write for this project. A change
 * shows at once and saves; changes leave one after another, each built from the selection the
 * server last answered, and a refusal puts the folder back and says why.
 */
function FoldersSection({
  project,
  people,
  manage,
  mountDelivery,
}: {
  readonly project: ProjectDto;
  readonly people: ProjectPeople;
  readonly manage: boolean;
  readonly mountDelivery: "bind" | "sources";
}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const folders = useSuspenseQuery(trpc.folders.list.queryOptions()).data;
  const picked = useSuspenseQuery(trpc.projects.folders.queryOptions({ id: project.id })).data;
  const key = trpc.projects.folders.queryKey({ id: project.id });
  const save = useMutation({
    mutationKey: folderMutationKey(project.id),
    mutationFn: (change: FolderChange) =>
      sendInTurn(
        queryClient,
        `project-folders:${change.projectId}`,
        () =>
          client.projects.setFolders.mutate({
            id: project.id,
            selections: nextFolderSelection(queryClient.getQueryData(key) ?? [], change),
          }),
        (saved) => queryClient.setQueryData(key, saved),
      ),
    // This mutation still counts while it settles: read the list again after the last one.
    onSettled: () =>
      queryClient.isMutating({ mutationKey: folderMutationKey(project.id) }) <= 1
        ? queryClient.invalidateQueries({ queryKey: key })
        : undefined,
  });
  const pending = useMutationState({
    filters: { mutationKey: folderMutationKey(project.id), status: "pending" },
    select: (mutation) => mutation.state.variables,
  }).filter(isFolderChange);
  const failure = save.isError
    ? `Mend didn't change ${save.variables.name}. ${failureWords(save.error, "Check your connection and try again.")} It's back as it was.`
    : null;
  return (
    <SettingSection
      title={`${people.organizationName} folders`}
      description={
        <>
          Owners upload these on <OrganizationPageLink people={people} />. Each one appears in
          sessions at <code className={MONO}>/workspace/home/&lt;name&gt;</code>.
        </>
      }
    >
      {folders.length === 0 ? (
        <Empty>{people.organizationName} has no folders yet.</Empty>
      ) : (
        <div role="table" aria-label={`${people.organizationName} folders`} className="text-row">
          <Head columns={["Folder", "Size", "Access"]} grid={FOLDER_GRID} />
          {folders.map((folder) => (
            <FolderRow
              key={folder.id}
              folder={folder}
              access={shownAccess(picked, pending, folder.id)}
              saving={pending.some((change) => change.folderId === folder.id)}
              manage={manage}
              onChange={(access) =>
                save.mutate({
                  projectId: project.id,
                  folderId: folder.id,
                  name: folder.name,
                  access,
                })
              }
            />
          ))}
        </div>
      )}
      <Failure>{failure}</Failure>
      <Note>{capturedNote("folders", mountDelivery, project.name)}</Note>
    </SettingSection>
  );
}

function FolderRow({
  folder,
  access,
  saving,
  manage,
  onChange,
}: {
  readonly folder: FolderDto;
  readonly access: FolderAccess;
  readonly saving: boolean;
  readonly manage: boolean;
  readonly onChange: (access: FolderAccess) => void;
}) {
  const trpc = useTRPC();
  const phone = usePhone();
  // Each folder's listing, for its size; a folder whose files can't be read still has a row.
  const listing = useQuery(trpc.folders.files.queryOptions({ id: folder.id }));
  const size =
    listing.status === "pending"
      ? "Reading…"
      : listing.status === "error"
        ? "Mend couldn't read its files."
        : folderSize(listing.data);
  return (
    <div
      role="row"
      aria-label={folder.name}
      aria-busy={saving}
      className={`grid ${FOLDER_GRID} items-center gap-4 border-b border-border py-2.5 max-lg:grid-cols-1 max-lg:gap-3 max-lg:px-4 max-lg:py-3.5`}
    >
      <span role="cell" className="flex min-w-0 items-center gap-2.5">
        <FolderIcon aria-hidden className="size-4 flex-none text-muted-foreground max-lg:hidden" />
        <span className="min-w-0">
          <span className="block truncate font-mono font-semibold max-lg:font-sans">
            {folder.name}
          </span>
          <span className="block text-meta text-muted-foreground lg:hidden">{size}</span>
        </span>
      </span>
      <span role="cell" className="text-muted-foreground max-lg:hidden">
        {size}
      </span>
      <span role="cell" className="flex justify-end max-lg:justify-stretch">
        {manage ? (
          <Segmented
            aria-label={`Access to ${folder.name}`}
            size={phone ? "touch" : "default"}
            value={access}
            onValueChange={onChange}
            options={ACCESS_ORDER.map((value) => ({ value, label: ACCESS_WORDS[value] }))}
            // Each choice keeps its words on the desk; on a phone the three fill the row.
            className="*:min-w-fit max-lg:w-full"
          />
        ) : (
          <span className="text-muted-foreground">{ACCESS_WORDS[access]}</span>
        )}
      </span>
    </div>
  );
}

// --- References ---------------------------------------------------------------------------------

const REFERENCE_GRID = "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem]";

const referenceMutationKey = (projectId: string) => ["project-references", projectId];

/**
 * The organization's references, each on or off for this project's sessions. A switch moves at
 * once and saves, in turn with the others; a refusal moves it back and says why.
 */
function ReferencesSection({
  project,
  people,
  manage,
}: {
  readonly project: ProjectDto;
  readonly people: ProjectPeople;
  readonly manage: boolean;
}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const references = useSuspenseQuery(trpc.git.references.queryOptions()).data;
  const selected = useSuspenseQuery(trpc.projects.references.queryOptions({ id: project.id })).data;
  const key = trpc.projects.references.queryKey({ id: project.id });
  const save = useMutation({
    mutationKey: referenceMutationKey(project.id),
    mutationFn: (change: ReferenceChange) =>
      sendInTurn(
        queryClient,
        `project-references:${change.projectId}`,
        () =>
          client.projects.selectReferences.mutate({
            id: project.id,
            selection: {
              referenceIds: [...nextReferenceIds(queryClient.getQueryData(key) ?? [], change)],
            },
          }),
        (saved) => queryClient.setQueryData(key, saved),
      ),
    onSettled: () =>
      queryClient.isMutating({ mutationKey: referenceMutationKey(project.id) }) <= 1
        ? queryClient.invalidateQueries({ queryKey: key })
        : undefined,
  });
  const pending = useMutationState({
    filters: { mutationKey: referenceMutationKey(project.id), status: "pending" },
    select: (mutation) => mutation.state.variables,
  }).filter(isReferenceChange);
  const nameOf = (id: string) => references.find((reference) => reference.id === id)?.name ?? id;
  const failure = save.isError
    ? `Mend didn't change ${nameOf(save.variables.referenceId)}. ${failureWords(save.error, "Check your connection and try again.")} It's back as it was.`
    : null;
  return (
    <SettingSection
      title="References"
      description={
        <>
          These are read-only copies of other repositories, at{" "}
          <code className={MONO}>/workspace/ref/&lt;name&gt;</code>. The agent can read them but
          can&apos;t change them. Owners add them on <OrganizationPageLink people={people} />.
        </>
      }
    >
      {references.length === 0 ? (
        <Empty>{people.organizationName} has no references yet.</Empty>
      ) : (
        <div role="table" aria-label="References" className="text-row">
          <Head columns={["Reference", "Version", "In sessions"]} grid={REFERENCE_GRID} />
          {references.map((reference) => (
            <ReferenceRow
              key={reference.id}
              reference={reference}
              on={shownSelected(selected, pending, reference.id)}
              saving={pending.some((change) => change.referenceId === reference.id)}
              manage={manage}
              phone={phone}
              onChange={(on) =>
                save.mutate({ projectId: project.id, referenceId: reference.id, selected: on })
              }
            />
          ))}
        </div>
      )}
      <Failure>{failure}</Failure>
    </SettingSection>
  );
}

function ReferenceRow({
  reference,
  on,
  saving,
  manage,
  phone,
  onChange,
}: {
  readonly reference: ReferenceDto;
  readonly on: boolean;
  readonly saving: boolean;
  readonly manage: boolean;
  readonly phone: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  const version = referenceVersion(reference);
  return (
    <div
      role="row"
      aria-label={reference.name}
      aria-busy={saving}
      className={`grid ${REFERENCE_GRID} items-center gap-4 border-b border-border py-2.5 max-lg:grid-cols-[minmax(0,1fr)_auto] max-lg:px-4 max-lg:py-3.5`}
    >
      <span role="cell" className="flex min-w-0 items-center gap-2.5">
        <BookMarkedIcon
          aria-hidden
          className="size-4 flex-none text-muted-foreground max-lg:hidden"
        />
        <span className="min-w-0">
          <span className="block truncate font-mono font-semibold max-lg:font-sans">
            {reference.name}
          </span>
          <span className="block text-meta text-muted-foreground lg:hidden">{version}</span>
        </span>
      </span>
      <span role="cell" className={`${MONO} max-lg:hidden`}>
        {version}
      </span>
      <span role="cell" className="flex justify-end">
        {manage ? (
          <span className={phone ? "flex h-11 items-center" : "flex items-center"}>
            <Switch
              aria-label={`Use ${reference.name} in sessions`}
              checked={on}
              onCheckedChange={onChange}
            />
          </span>
        ) : (
          <span className="text-muted-foreground">{on ? "On" : "Off"}</span>
        )}
      </span>
    </div>
  );
}

// --- Server folders -----------------------------------------------------------------------------

const MOUNT_GRID = "grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_8rem]";
const OPERATOR_MOUNT_GRID = "grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_8rem_6rem]";

/**
 * Directories on the Mend server itself, such as a models cache, mounted at
 * `/workspace/home/<name>`. Only an operator of a single install adds and removes them; everyone
 * else reads them and is told to ask.
 */
function ServerFoldersSection({
  project,
  mounts,
  operator,
  mountDelivery,
}: {
  readonly project: ProjectDto;
  readonly mounts: ReadonlyArray<ProjectMountDto>;
  readonly operator: boolean;
  readonly mountDelivery: "bind" | "sources";
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const [adding, setAdding] = useState(false);
  const remove = useMutation(
    trpc.projects.removeMount.mutationOptions({
      onSuccess: (_answer, { mountId }) => {
        const name = mounts.find((mount) => mount.id === mountId)?.name ?? "the folder";
        toast.add({ description: `Removed ${name}. New sessions start without it.` });
      },
      onSettled: () =>
        queryClient.invalidateQueries(trpc.projects.mounts.queryFilter({ id: project.id })),
    }),
  );
  const grid = operator ? OPERATOR_MOUNT_GRID : MOUNT_GRID;
  const failure = remove.isError
    ? `Mend didn't remove the folder. ${failureWords(remove.error, "Check your connection and try again.")}`
    : null;
  const add = (
    <Button
      type="button"
      variant="outline"
      size={phone ? "touch" : "default"}
      className="max-lg:w-full"
      onClick={() => setAdding(true)}
    >
      Add server folder…
    </Button>
  );
  return (
    <SettingSection
      title="Server folders"
      description={
        operator
          ? "Folders from this server's own disk. What sessions write to a read-and-write one lands on the server, outside the change."
          : "Operators add these from the server's own disk. Ask an operator of this server to add or remove one."
      }
      action={operator ? add : undefined}
    >
      {operator ? <div className="border-b border-border px-4 py-3 lg:hidden">{add}</div> : null}
      {mounts.length === 0 ? (
        <Empty>No server folders yet.</Empty>
      ) : (
        <div role="table" aria-label="Server folders" className="text-row">
          <Head
            columns={
              operator
                ? ["Path on the server", "Mounted as", "Access", ""]
                : ["Path on the server", "Mounted as", "Access"]
            }
            grid={grid}
          />
          {mounts.map((mount) => (
            <div
              key={mount.id}
              role="row"
              aria-label={mount.name}
              className={`grid ${grid} items-center gap-4 border-b border-border py-2.5 max-lg:grid-cols-[minmax(0,1fr)_auto] max-lg:px-4 max-lg:py-3.5`}
            >
              <span role="cell" className="flex min-w-0 items-center gap-2.5 max-lg:order-1">
                <HardDriveIcon
                  aria-hidden
                  className="size-4 flex-none text-muted-foreground max-lg:hidden"
                />
                <span className="min-w-0">
                  <span className="block font-semibold lg:hidden">{mount.name}</span>
                  <span
                    className={`${MONO} block break-all max-lg:text-muted-foreground`}
                    title={mount.hostPath}
                  >
                    {mount.hostPath}
                  </span>
                </span>
              </span>
              <span role="cell" className={`${MONO} max-lg:hidden`}>
                {mount.name}
              </span>
              <span role="cell" className="text-right text-muted-foreground max-lg:order-2">
                {mount.readOnly ? ACCESS_WORDS.read : ACCESS_WORDS.write}
              </span>
              {operator ? (
                <span role="cell" className="flex justify-end max-lg:order-3 max-lg:col-span-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size={phone ? "touch" : "sm"}
                    className="max-lg:w-full"
                    aria-label={`Remove ${mount.name}`}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate({ id: project.id, mountId: mount.id })}
                  >
                    {remove.isPending && remove.variables.mountId === mount.id ? (
                      <Spinner aria-hidden />
                    ) : null}
                    {remove.isPending && remove.variables.mountId === mount.id
                      ? "Removing…"
                      : "Remove"}
                  </Button>
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <Failure>{failure}</Failure>
      <Note>{capturedNote("server-folders", mountDelivery, project.name)}</Note>
      {operator ? (
        <AddServerFolderDialog project={project} open={adding} onClose={() => setAdding(false)} />
      ) : null}
    </SettingSection>
  );
}

/** Add server folder…: a path on the server, the name it mounts as, and whether sessions may write. */
function AddServerFolderDialog({
  project,
  open,
  onClose,
}: {
  readonly project: ProjectDto;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const [hostPath, setHostPath] = useState("");
  const [name, setName] = useState("");
  const [access, setAccess] = useState<"read" | "write">("read");
  const reset = () => {
    setHostPath("");
    setName("");
    setAccess("read");
  };
  const add = useMutation(
    trpc.projects.addMount.mutationOptions({
      onSuccess: async (mount) => {
        await queryClient.invalidateQueries(trpc.projects.mounts.queryFilter({ id: project.id }));
        toast.add({ description: `Added ${mount.name}. New sessions in ${project.name} get it.` });
        reset();
        onClose();
      },
    }),
  );
  const ready = hostPath.trim() !== "" && name.trim() !== "";
  const submit = () => {
    if (!ready || add.isPending) return;
    add.mutate({
      id: project.id,
      mount: { hostPath: hostPath.trim(), name: name.trim(), readOnly: access === "read" },
    });
  };
  const size = phone ? "touch" : "default";
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => {
        if (next || add.isPending) return;
        add.reset();
        onClose();
      }}
      title="Add server folder"
      description={`New sessions in ${project.name} get it at /workspace/home/<name>.`}
      size="md"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size={size}
            disabled={add.isPending}
            onClick={() => {
              add.reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="add-server-folder"
            size={size}
            disabled={!ready || add.isPending}
          >
            {add.isPending ? <Spinner aria-hidden /> : null}
            {add.isPending ? "Adding…" : "Add folder"}
          </Button>
        </>
      }
    >
      <form
        id="add-server-folder"
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="server-folder-path">Path on the server</Label>
          <Input
            id="server-folder-path"
            value={hostPath}
            placeholder="/srv/models"
            autoComplete="off"
            spellCheck={false}
            className={`font-mono ${phone ? "h-11 text-base" : ""}`}
            onChange={(event) => setHostPath(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="server-folder-name">Mounted as</Label>
          <Input
            id="server-folder-name"
            value={name}
            placeholder="models"
            autoComplete="off"
            spellCheck={false}
            className={`font-mono ${phone ? "h-11 text-base" : ""}`}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <span id="server-folder-access" className="text-sm font-medium">
            Access
          </span>
          <Segmented
            aria-label="Access"
            size={size}
            value={access}
            onValueChange={setAccess}
            options={[
              { value: "read", label: ACCESS_WORDS.read },
              { value: "write", label: ACCESS_WORDS.write },
            ]}
            className="max-lg:w-full"
          />
        </div>
        {add.isError ? (
          <p role="alert" className="text-row text-destructive">
            Mend didn&apos;t add the folder.{" "}
            {failureWords(add.error, "Check the path and try again.")}
          </p>
        ) : null}
      </form>
    </Overlay>
  );
}
