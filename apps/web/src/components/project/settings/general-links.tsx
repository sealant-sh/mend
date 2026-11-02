import {
  useMutation,
  useMutationState,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useState } from "react";

import { Button, Pick } from "#/components/kit/button";
import { Checkbox } from "#/components/kit/checkbox";
import { Field, FieldPair, GroupField, TextInput } from "#/components/kit/field";
import { FuzzyFinder } from "#/components/kit/finder";
import { ModalDialog } from "#/components/kit/modal";
import { SettingsSection } from "#/components/kit/section";
import { DataTable } from "#/components/kit/table";
import {
  addProjectLink,
  addReference,
  refreshReference,
  removeProjectLink,
  removeReference,
  selectProjectReferences,
  type ProjectDto,
  type ReferenceDto,
} from "#/lib/api";
import { listChangeOptions } from "#/lib/project-settings";
import { useTRPC } from "#/lib/trpc";

const errorWords = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const mono = "font-mono text-[12px] text-ink-2";
const muted = "font-mono text-[12px] text-muted-foreground";

/** One reference turned on or off for a project. */
interface ReferenceChange {
  readonly projectId: string;
  readonly referenceId: string;
  readonly selected: boolean;
}

/** Narrows a mutation's stored variables back to a reference change. */
const isReferenceChange = (value: unknown): value is ReferenceChange =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "projectId") === "string" &&
  typeof Reflect.get(value, "referenceId") === "string" &&
  typeof Reflect.get(value, "selected") === "boolean";

const referenceMutationKey = (projectId: string) => ["project-references", projectId];

/**
 * Linked projects (ADR-0001): other adopted projects next sessions work in, read-write, at
 * `/workspace/repos/<name>`. One of the linked project's worktrees is bound at launch; commits
 * there are that project's own change.
 */
export function LinkedProjectsSection({
  project,
  manage,
}: {
  readonly project: ProjectDto;
  readonly manage: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const links = useSuspenseQuery(trpc.projects.links.queryOptions({ id: project.id })).data;
  const projects = useSuspenseQuery(trpc.projects.list.queryOptions()).data;
  const nameOf = (id: string) => projects.find((row) => row.id === id)?.name ?? id;
  const remove = useMutation({
    mutationFn: (linkId: string) => removeProjectLink(project.id, linkId),
    onSettled: () => queryClient.invalidateQueries(trpc.projects.links.queryFilter()),
  });

  return (
    <SettingsSection
      title="Linked projects"
      why={
        <>
          Other projects mounted into this one&apos;s workspaces, read-write, at{" "}
          <span className="font-mono text-[12px]">/workspace/repos/&lt;name&gt;</span>.
        </>
      }
    >
      <DataTable
        label="Linked projects"
        columns={[
          { head: "Project", width: "1fr" },
          { head: "Worktree", width: "1fr" },
          { head: "Mounted as", width: "1fr" },
          { head: "", width: "auto" },
        ]}
        empty="no linked projects"
        rows={links.map((link) => ({
          key: link.id,
          cells: [
            <span key="p" className={mono}>
              {nameOf(link.linkedProjectId)}
            </span>,
            <span key="w" className={mono}>
              {link.worktreeName}
            </span>,
            <span key="m" className={muted}>
              /workspace/repos/{link.name}
            </span>,
            manage ? (
              <Button
                key="r"
                size="sm"
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => remove.mutate(link.id)}
                aria-label={`Unlink ${link.name}`}
              >
                {remove.isPending && remove.variables === link.id ? "Unlinking…" : "Unlink"}
              </Button>
            ) : null,
          ],
        }))}
      />
      <p role="alert" className="mt-2 font-mono text-[11.5px] text-danger empty:hidden">
        {remove.isError ? `Not unlinked: ${errorWords(remove.error)}` : ""}
      </p>
      {manage ? (
        <div className="mt-2.5">
          <LinkProjectDialog
            project={project}
            candidates={projects.filter(
              (row) =>
                row.id !== project.id && !links.some((link) => link.linkedProjectId === row.id),
            )}
          />
        </div>
      ) : null}
    </SettingsSection>
  );
}

function LinkProjectDialog({
  project,
  candidates,
}: {
  readonly project: ProjectDto;
  readonly candidates: ReadonlyArray<ProjectDto>;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [linked, setLinked] = useState<ProjectDto | null>(null);
  const [name, setName] = useState("");
  const [worktree, setWorktree] = useState("");
  const link = useMutation({
    mutationFn: (input: { linkedProjectId: string; name: string; worktreeName: string | null }) =>
      addProjectLink(project.id, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries(trpc.projects.links.queryFilter());
      setOpen(false);
      setLinked(null);
      setName("");
      setWorktree("");
    },
  });
  const mountName = name.trim() === "" ? (linked?.name ?? "") : name.trim();

  return (
    <ModalDialog
      open={open}
      onOpenChange={(next) => {
        if (!link.isPending) setOpen(next);
      }}
      trigger={
        <Button size="sm" disabled={candidates.length === 0}>
          Link a project
        </Button>
      }
      title={`Link a project to ${project.name}`}
      description="Its worktree is mounted read-write in this project's next sessions. Commits there are that project's own change, reviewed there."
      width={480}
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (linked === null || mountName === "") return;
          link.mutate({
            linkedProjectId: linked.id,
            name: mountName,
            worktreeName: worktree.trim() === "" ? null : worktree.trim(),
          });
        }}
      >
        <GroupField label="Project">
          <FuzzyFinder
            label="Project to link"
            items={candidates}
            itemKey={(row) => row.id}
            itemText={(row) => row.name}
            meta={(row) => row.defaultBranch}
            onPick={setLinked}
            placeholder="Find a project"
            trigger={<Pick className="w-fit">{linked?.name ?? "Choose a project"}</Pick>}
          />
        </GroupField>
        <FieldPair>
          <Field label="Mounted as">
            {(id) => (
              <TextInput
                id={id}
                value={name}
                placeholder={linked?.name ?? "name"}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <Field label="Worktree">
            {(id) => (
              <TextInput
                id={id}
                value={worktree}
                placeholder="the default branch's"
                onChange={(event) => setWorktree(event.target.value)}
              />
            )}
          </Field>
        </FieldPair>
        <p role="alert" className="font-mono text-[11.5px] text-danger empty:hidden">
          {link.isError ? `Not linked: ${errorWords(link.error)}` : ""}
        </p>
        <div className="flex justify-end gap-2.5">
          <Button variant="ghost" disabled={link.isPending} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={link.isPending || linked === null || mountName === ""}
          >
            {link.isPending ? "Linking…" : "Link project"}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

const fetchedWords = (reference: ReferenceDto): string =>
  [
    reference.pinnedRef ?? "default branch",
    reference.headSha === null ? null : reference.headSha.slice(0, 7),
    reference.refreshedAt === null
      ? null
      : `fetched ${new Date(reference.refreshedAt).toLocaleDateString()}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");

/**
 * References: read-only clones of dependency sources the organization keeps. Checked ones mount at
 * `/workspace/ref/<name>` in this project's next sessions. Checking one moves at once and moves
 * back if Mend refuses.
 */
export function ReferencesSection({
  project,
  manage,
}: {
  readonly project: ProjectDto;
  readonly manage: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const references = useSuspenseQuery(trpc.git.references.queryOptions()).data;
  const selected = useSuspenseQuery(trpc.projects.references.queryOptions({ id: project.id })).data;
  const selectedIds = new Set<string>(selected.map((reference) => reference.id));
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries(trpc.git.references.queryFilter()),
      queryClient.invalidateQueries(trpc.projects.references.queryFilter({ id: project.id })),
    ]);

  // One change per reference, each applied when it leaves to the selection the server last
  // confirmed, so two quick clicks never send a list built before the first one landed.
  const select = useMutation({
    ...listChangeOptions<ReferenceChange, ReadonlyArray<ReferenceDto>>({
      queryClient,
      listKey: (id) => trpc.projects.references.queryKey({ id }),
      mutationKey: referenceMutationKey,
      send: (change, confirmed) => {
        const ids = new Set<string>((confirmed ?? []).map((reference) => reference.id));
        if (change.selected) ids.add(change.referenceId);
        else ids.delete(change.referenceId);
        return selectProjectReferences(change.projectId, [...ids]);
      },
    }),
    mutationKey: referenceMutationKey(project.id),
    onSettled: (_saved, _error, change) =>
      queryClient.isMutating({ mutationKey: referenceMutationKey(change.projectId) }) <= 1
        ? invalidate()
        : undefined,
  });
  const pending = useMutationState({
    filters: { mutationKey: referenceMutationKey(project.id), status: "pending" },
    select: (mutation) => mutation.state.variables,
  }).filter(isReferenceChange);
  // A reference shows the newest change still on its way, else what the server holds.
  const isUsed = (id: string) =>
    pending.findLast((change) => change.referenceId === id)?.selected ?? selectedIds.has(id);
  const refresh = useMutation({
    mutationFn: (id: string) => refreshReference(id),
    onSettled: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeReference(id),
    onSettled: invalidate,
  });
  const failure = select.isError
    ? `Not saved: ${errorWords(select.error)}. The reference is back as it was.`
    : refresh.isError
      ? `Not fetched: ${errorWords(refresh.error)}`
      : remove.isError
        ? `Not removed: ${errorWords(remove.error)}`
        : "";

  return (
    <SettingsSection
      title="References"
      why={
        <>
          Read-only repositories the agent can consult. Checked ones mount at{" "}
          <span className="font-mono text-[12px]">/workspace/ref/&lt;name&gt;</span>.
        </>
      }
    >
      <DataTable
        label="References"
        columns={[
          { head: "", width: "22px" },
          { head: "Name", width: "0.7fr" },
          { head: "URL", width: "2fr" },
          { head: "Ref", width: "1fr" },
          { head: "", width: "150px", align: "end" },
        ]}
        empty="no references in this organization yet"
        rows={references.map((reference) => {
          const used = isUsed(reference.id);
          return {
            key: reference.id,
            cells: [
              <Checkbox
                key="c"
                label={`Mount ${reference.name} in ${project.name}`}
                checked={used}
                disabled={!manage}
                onCheckedChange={(next) =>
                  select.mutate({
                    projectId: project.id,
                    referenceId: reference.id,
                    selected: next,
                  })
                }
              />,
              <span key="n" className={mono}>
                {reference.name}
              </span>,
              <span key="u" className={`${muted} block truncate`} title={reference.originUrl}>
                {reference.originUrl}
              </span>,
              <span key="r" className={`${muted} block truncate`}>
                {fetchedWords(reference)}
              </span>,
              manage ? (
                <span key="a" className="flex justify-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={refresh.isPending || remove.isPending}
                    aria-label={`Fetch ${reference.name} again`}
                    onClick={() => refresh.mutate(reference.id)}
                  >
                    {refresh.isPending && refresh.variables === reference.id
                      ? "Fetching…"
                      : "Fetch"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={refresh.isPending || remove.isPending}
                    aria-label={`Remove ${reference.name}`}
                    onClick={() => remove.mutate(reference.id)}
                  >
                    {remove.isPending && remove.variables === reference.id ? "Removing…" : "Remove"}
                  </Button>
                </span>
              ) : null,
            ],
          };
        })}
      />
      <p role="alert" className="mt-2 font-mono text-[11.5px] text-danger empty:hidden">
        {failure}
      </p>
      {manage ? (
        <div className="mt-2.5">
          <AddReferenceDialog
            onAdded={async (created) => {
              // A reference added from this page is meant for this project.
              await select.mutateAsync({
                projectId: project.id,
                referenceId: created.id,
                selected: true,
              });
            }}
          />
        </div>
      ) : null}
    </SettingsSection>
  );
}

function AddReferenceDialog({
  onAdded,
}: {
  readonly onAdded: (created: ReferenceDto) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [ref, setRef] = useState("");
  const add = useMutation({
    mutationFn: async () => {
      const created = await addReference(
        name.trim(),
        source.trim(),
        ref.trim() === "" ? null : ref.trim(),
      );
      await onAdded(created);
    },
    onSuccess: () => {
      setOpen(false);
      setName("");
      setSource("");
      setRef("");
    },
  });
  const ready = name.trim() !== "" && source.trim() !== "";

  return (
    <ModalDialog
      open={open}
      onOpenChange={(next) => {
        if (!add.isPending) setOpen(next);
      }}
      trigger={<Button size="sm">Add a reference</Button>}
      title="Add a reference"
      description="Mend clones it read-only. Every project in the organization can mount it; this one mounts it from its next session."
      width={520}
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) add.mutate();
        }}
      >
        <Field label="URL">
          {(id) => (
            <TextInput
              id={id}
              value={source}
              placeholder="https://github.com/Effect-TS/effect.git"
              onChange={(event) => setSource(event.target.value)}
            />
          )}
        </Field>
        <FieldPair columns="1fr 1fr">
          <Field label="Name">
            {(id) => (
              <TextInput
                id={id}
                value={name}
                placeholder="effect"
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <Field
            label="Ref"
            source={<span className="font-mono text-[11px] text-faint">optional</span>}
          >
            {(id) => (
              <TextInput
                id={id}
                value={ref}
                placeholder="default branch"
                onChange={(event) => setRef(event.target.value)}
              />
            )}
          </Field>
        </FieldPair>
        <p role="status" className="font-mono text-[11.5px] text-muted-foreground empty:hidden">
          {add.isPending ? `Cloning ${source.trim()}…` : ""}
        </p>
        <p role="alert" className="font-mono text-[11.5px] text-danger empty:hidden">
          {add.isError ? `Not added: ${errorWords(add.error)}` : ""}
        </p>
        <div className="flex justify-end gap-2.5">
          <Button variant="ghost" disabled={add.isPending} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={add.isPending || !ready}>
            {add.isPending ? "Cloning…" : "Add reference"}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}
