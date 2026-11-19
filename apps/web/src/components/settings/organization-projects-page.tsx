import { Button } from "@mend/ui/components/ui/button";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { toast } from "@mend/ui/components/ui/toast";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

import {
  dayWords,
  keptRows,
  orphanLine,
  takenOverWords,
  takeOverNote,
} from "#/lib/organization-projects";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";
import { useViewer } from "#/lib/use-viewer";

import { Overlay } from "../projects/overlay.tsx";
import { SettingSection } from "./setting-row.tsx";
import { SettingsPage } from "./settings-page.tsx";

/** A project whose creator left, as the server answers it. */
interface Orphan {
  readonly id: string;
  readonly name: string;
  readonly visibility: "private" | "shared";
  readonly createdAt: Date;
}

/**
 * Settings → the organization → Projects (Doop "Settings · Northwind · Projects"; owners only):
 * the projects whose creator left the organization, each with Take over…, and the resource volumes
 * Mend kept from removed projects, which have no actions. The route's loader read both lists.
 */
export function OrganizationProjectsPage() {
  const trpc = useTRPC();
  const { organizationName } = useViewer();
  const orphans = useSuspenseQuery(trpc.organization.orphanedProjects.queryOptions()).data;
  const archives = useSuspenseQuery(trpc.organization.resourceArchives.queryOptions()).data;
  const [taking, setTaking] = useState<Orphan | null>(null);
  const now = new Date();
  const kept = keptRows(archives);
  return (
    <SettingsPage
      page="o-projects"
      intro={`Projects whose creator left ${organizationName}, and the data Mend kept from projects that were removed.`}
    >
      <SettingSection
        title="Without a creator"
        description={`Their creator left ${organizationName}. A private one stays hidden from everyone until an owner takes it over.`}
      >
        {orphans.length === 0 ? (
          <Empty>
            No projects without a creator. When someone leaves {organizationName}, the projects they
            created show here.
          </Empty>
        ) : (
          <div role="table" aria-label="Projects without a creator" className="text-row">
            <div
              role="row"
              className="grid grid-cols-[minmax(0,1fr)_6rem_7.5rem] gap-4 border-b border-border py-2 text-meta text-muted-foreground max-lg:hidden"
            >
              <span role="columnheader">Project</span>
              <span role="columnheader">Added</span>
              <span role="columnheader">
                <span className="sr-only">Take over</span>
              </span>
            </div>
            {orphans
              .toSorted((a, b) => a.name.localeCompare(b.name))
              .map((project) => (
                <OrphanRow
                  key={project.id}
                  project={project}
                  organizationName={organizationName}
                  now={now}
                  onTakeOver={() => setTaking(project)}
                />
              ))}
          </div>
        )}
      </SettingSection>
      <SettingSection
        title="Kept resources"
        description="Removing a project keeps its resource volumes. They stay here, with their data, after the project is deleted."
      >
        {kept.length === 0 ? (
          <Empty>
            No kept resources. When someone removes a project that has resources, its volumes show
            here.
          </Empty>
        ) : (
          <div role="table" aria-label="Kept resources" className="text-row">
            <div
              role="row"
              className="grid grid-cols-[12rem_minmax(0,1fr)_6rem_7rem] gap-4 border-b border-border py-2 text-meta text-muted-foreground max-lg:hidden"
            >
              <span role="columnheader">Project</span>
              <span role="columnheader">Volume</span>
              <span role="columnheader">Kept since</span>
              <span role="columnheader" className="text-right">
                Size
              </span>
            </div>
            {kept.map((row) => (
              <div
                key={row.key}
                role="row"
                className="grid grid-cols-[12rem_minmax(0,1fr)_6rem_7rem] items-center gap-4 border-b border-border py-3 max-lg:grid-cols-1 max-lg:gap-0.5 max-lg:px-4"
              >
                <span role="cell" className="truncate font-mono text-meta max-lg:hidden">
                  {row.project}
                </span>
                <span role="cell" className="min-w-0 max-lg:hidden">
                  {row.volume === null ? (
                    <span className="text-muted-foreground">No volumes declared</span>
                  ) : (
                    <>
                      <span className="block font-mono text-meta">{row.volume}</span>
                      <span className="block truncate font-mono text-meta text-faint">
                        {row.dockerName}
                      </span>
                    </>
                  )}
                </span>
                <span role="cell" className="max-lg:hidden">
                  {dayWords(row.keptSince, now)}
                </span>
                <span
                  role="cell"
                  className={
                    row.size === "Not measured"
                      ? "text-right text-muted-foreground max-lg:hidden"
                      : "text-right max-lg:hidden"
                  }
                >
                  {row.size}
                </span>
                <span className="font-mono text-meta wrap-anywhere lg:hidden">
                  {row.volume === null ? row.project : `${row.project} · ${row.volume}`}
                </span>
                <span className="text-meta text-muted-foreground lg:hidden">
                  {[
                    `Kept since ${dayWords(row.keptSince, now)}`,
                    row.volume === null ? "No volumes declared" : row.size,
                  ]
                    .filter((part) => part !== null)
                    .join(" · ")}
                </span>
              </div>
            ))}
          </div>
        )}
      </SettingSection>
      <TakeOverDialog
        project={taking}
        organizationName={organizationName}
        onClose={() => setTaking(null)}
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

function OrphanRow({
  project,
  organizationName,
  now,
  onTakeOver,
}: {
  readonly project: Orphan;
  readonly organizationName: string;
  readonly now: Date;
  readonly onTakeOver: () => void;
}) {
  const phone = usePhone();
  return (
    <div
      role="row"
      className="grid grid-cols-[minmax(0,1fr)_6rem_7.5rem] items-center gap-4 border-b border-border py-3 max-lg:grid-cols-[minmax(0,1fr)_auto] max-lg:px-4"
    >
      <span role="cell" className="min-w-0">
        <span className="block truncate font-mono text-meta font-semibold">{project.name}</span>
        <span className="block text-muted-foreground max-lg:hidden">
          {orphanLine(project.visibility, organizationName)}
        </span>
        <span className="block text-meta text-muted-foreground lg:hidden">
          {`${project.visibility === "private" ? "Private" : "Shared"} · Added ${dayWords(project.createdAt, now)}`}
        </span>
      </span>
      <span role="cell" className="max-lg:hidden">
        {dayWords(project.createdAt, now)}
      </span>
      <span role="cell" className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size={phone ? "touch" : "default"}
          aria-label={`Take over ${project.name}…`}
          onClick={onTakeOver}
        >
          Take over…
        </Button>
      </span>
    </div>
  );
}

function TakeOverDialog({
  project,
  organizationName,
  onClose,
}: {
  readonly project: Orphan | null;
  readonly organizationName: string;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const take = useMutation(trpc.organization.takeOverProject.mutationOptions());
  // Kept while the dialog closes, so its words don't change as it goes.
  const [shown, setShown] = useState(project);
  if (project !== null && project !== shown) setShown(project);
  const close = () => {
    if (take.isPending) return;
    take.reset();
    onClose();
  };
  const confirm = async () => {
    if (shown === null) return;
    try {
      await take.mutateAsync({ id: shown.id });
      await Promise.all([
        queryClient.invalidateQueries(trpc.organization.pathFilter()),
        queryClient.invalidateQueries(trpc.projects.pathFilter()),
      ]);
      toast.add({ description: takenOverWords(shown.name) });
      take.reset();
      onClose();
    } catch {
      // Said in the dialog, from the mutation's error.
    }
  };
  return (
    <Overlay
      open={project !== null}
      onOpenChange={(next) => (next ? undefined : close())}
      size="sm"
      title={`Take over ${shown?.name ?? ""}?`}
      description="You become its creator. The audit log records that you took it over."
      footer={
        <>
          <Button type="button" variant="outline" disabled={take.isPending} onClick={close}>
            Cancel
          </Button>
          <Button type="button" disabled={take.isPending} onClick={() => void confirm()}>
            {take.isPending ? <Spinner aria-hidden /> : null}
            {take.isPending ? "Taking over…" : "Take over"}
          </Button>
        </>
      }
    >
      {shown === null ? null : (
        <p className="text-row text-pretty text-foreground-2">
          {takeOverNote(shown, organizationName)}
        </p>
      )}
      {take.isError ? (
        <p role="alert" className="mt-3 text-row text-destructive">
          Mend didn't take it over. {failureWords(take.error, "Try again.")}
        </p>
      ) : null}
    </Overlay>
  );
}
