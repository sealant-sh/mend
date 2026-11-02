import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "#/components/kit/button";
import { ModalDialog } from "#/components/kit/modal";
import { Panel, SettingsSection } from "#/components/kit/section";
import { ErrorNote, errorText } from "#/components/kit/status";
import { DataTable } from "#/components/kit/table";
import type { ProjectDto } from "#/lib/api";
import { formatBytes } from "#/lib/organization";
import { useTRPC } from "#/lib/trpc";

import { day } from "./org-parts";

interface ResourceArchive {
  readonly projectId: string;
  readonly projectName: string;
  readonly archivedAt: string | Date;
  readonly volumes: ReadonlyArray<{
    readonly resourceName: string;
    readonly name: string;
    readonly dockerName: string;
    readonly bytes: number | null;
  }>;
}

interface ArchiveRow {
  readonly key: string;
  readonly project: string;
  readonly volume: string;
  readonly dockerName: string | null;
  readonly size: string | null;
  readonly archivedAt: Date;
}

/** One row per kept volume, with its project and when it was archived. */
export const archiveRows = (archives: ReadonlyArray<ResourceArchive>): ReadonlyArray<ArchiveRow> =>
  archives.flatMap(
    (archive): ReadonlyArray<ArchiveRow> =>
      archive.volumes.length === 0
        ? [
            {
              key: archive.projectId,
              project: archive.projectName,
              volume: "no volumes were declared",
              dockerName: null,
              size: null,
              archivedAt: new Date(archive.archivedAt),
            },
          ]
        : archive.volumes.map((volume) => ({
            key: `${archive.projectId}:${volume.dockerName}`,
            project: archive.projectName,
            volume: `@${volume.resourceName} · ${volume.name}`,
            dockerName: volume.dockerName,
            size: volume.bytes === null ? "size not observed" : formatBytes(volume.bytes),
            archivedAt: new Date(archive.archivedAt),
          })),
  );

/**
 * O7 · Projects (owners): projects whose creator left the organization, which an owner can take
 * over, and the resource volumes kept after a project was removed and purged.
 */
export function ProjectsTab() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const orphaned = useSuspenseQuery(trpc.organization.orphanedProjects.queryOptions()).data;
  const archives = useSuspenseQuery(trpc.organization.resourceArchives.queryOptions()).data;
  const [taking, setTaking] = useState<ProjectDto | null>(null);
  const take = useMutation(
    trpc.organization.takeOverProject.mutationOptions({
      onSuccess: () => setTaking(null),
      onSettled: () =>
        Promise.all([
          queryClient.invalidateQueries(trpc.organization.pathFilter()),
          queryClient.invalidateQueries(trpc.projects.pathFilter()),
        ]),
    }),
  );
  return (
    <Panel>
      <SettingsSection
        title="Without a creator"
        why="Their creator left the organization. A private one stays hidden from everyone until an owner takes it over."
      >
        <DataTable
          label="Projects without a creator"
          columns={[
            { head: "Project", width: "1fr" },
            { head: "Visible to", width: "0.7fr" },
            { head: "Adopted", width: "0.7fr" },
            { head: "", width: "auto" },
          ]}
          empty="every project has its creator"
          rows={orphaned.map((project) => ({
            key: project.id,
            cells: [
              <span key="name" className="font-mono text-[12.5px] text-ink-2">
                {project.name}
              </span>,
              <span key="visibility" className="font-mono text-[12px] text-muted-foreground">
                {project.visibility}
              </span>,
              <span key="adopted" className="font-mono text-[12px] text-muted-foreground">
                {day(project.createdAt)}
              </span>,
              <Button
                key="take"
                size="sm"
                aria-label={`Take over ${project.name}`}
                onClick={() => {
                  take.reset();
                  setTaking(project);
                }}
              >
                Take over…
              </Button>,
            ],
          }))}
        />
      </SettingsSection>
      <SettingsSection
        title="Archived resources"
        why="Removing a project keeps its resource volumes. Their data stays here after the project is purged."
      >
        <DataTable
          label="Archived resources"
          columns={[
            { head: "Project", width: "0.9fr" },
            { head: "Volume", width: "1.4fr" },
            { head: "Archived", width: "0.7fr" },
            { head: "Size", width: "0.7fr", align: "end" },
          ]}
          empty="no archived resources"
          rows={archiveRows(archives).map((row) => ({
            key: row.key,
            cells: [
              <span key="project" className="font-mono text-[12.5px] text-ink-2">
                {row.project}
              </span>,
              <span key="volume" className="grid">
                <span className="font-mono text-[12px] text-ink-2">{row.volume}</span>
                {row.dockerName === null ? null : (
                  <span className="font-mono text-[11px] break-all text-faint">
                    {row.dockerName}
                  </span>
                )}
              </span>,
              <span key="archived" className="font-mono text-[12px] text-muted-foreground">
                {day(row.archivedAt)}
              </span>,
              <span key="size" className="font-mono text-[12px] text-muted-foreground">
                {row.size ?? ""}
              </span>,
            ],
          }))}
        />
      </SettingsSection>
      <ModalDialog
        open={taking !== null}
        onOpenChange={(open) => {
          if (!open && !take.isPending) setTaking(null);
        }}
        title={`Take over ${taking?.name ?? ""}?`}
        description="You become its creator. The audit log records that you took it over."
        width={480}
        footer={
          <>
            <Button variant="ghost" disabled={take.isPending} onClick={() => setTaking(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={take.isPending || taking === null}
              onClick={() => {
                if (taking !== null) take.mutate({ id: taking.id });
              }}
            >
              {take.isPending ? "Taking over…" : "Take over"}
            </Button>
          </>
        }
      >
        {take.error === null ? null : <ErrorNote>{errorText(take.error)}</ErrorNote>}
      </ModalDialog>
    </Panel>
  );
}
