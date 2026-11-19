import { Button } from "@mend/ui/components/ui/button";
import { Input } from "@mend/ui/components/ui/input";
import { Label } from "@mend/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@mend/ui/components/ui/native-select";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { toast } from "@mend/ui/components/ui/toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { ProjectDto } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import { capturedNote, linkCandidates, linkPath, linkRequest } from "#/lib/project-folders";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";

import { Overlay } from "../projects/overlay.tsx";
import { SettingSection } from "./setting-row.tsx";

const GRID = "grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)_7rem]";
const READ_GRID = "grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)]";

/**
 * Linked projects on a project's General page (Doop "Settings · Project · checkout-api · General";
 * references-folders.md `link-project`): other projects whose worktree the project's sessions get,
 * read-write, at `/workspace/repos/<name>`. Commits there are the linked project's own change. The
 * person who added the project and the organization's owners link and unlink (`manage`); everyone
 * else reads the list. Each part loads apart, so the rest of General shows if this list can't.
 */
export function ProjectLinksSection({
  project,
  manage,
  mountDelivery,
}: {
  readonly project: ProjectDto;
  readonly manage: boolean;
  readonly mountDelivery: "bind" | "sources";
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const [linking, setLinking] = useState(false);
  const links = useQuery(trpc.projects.links.queryOptions({ id: project.id }));
  const projects = useQuery(trpc.projects.list.queryOptions());
  const unlink = useMutation(
    trpc.projects.removeLink.mutationOptions({
      onSuccess: (_answer, { linkId }) => {
        const name = links.data?.find((link) => link.id === linkId)?.name ?? "the project";
        toast.add({ description: `Unlinked ${name}. New sessions start without it.` });
      },
      onSettled: () =>
        queryClient.invalidateQueries(trpc.projects.links.queryFilter({ id: project.id })),
    }),
  );
  const nameOf = (id: string) =>
    projects.data?.find((candidate) => candidate.id === id)?.name ?? "A removed project";
  const candidates =
    links.status === "success" && projects.status === "success"
      ? linkCandidates(projects.data, project.id, links.data)
      : [];
  const add = (
    <Button
      type="button"
      variant="outline"
      size={phone ? "touch" : "default"}
      className="max-lg:w-full"
      disabled={links.status !== "success" || projects.status !== "success"}
      onClick={() => setLinking(true)}
    >
      Link project…
    </Button>
  );
  const grid = manage ? GRID : READ_GRID;
  const note = capturedNote("links", mountDelivery, project.name);
  return (
    <SettingSection
      title="Linked projects"
      description={`Sessions in ${project.name} also get these projects' files, so the agent can read and change them. Commits there are that project's own change.`}
      action={manage ? add : undefined}
    >
      {manage ? <div className="border-b border-border px-4 py-3 lg:hidden">{add}</div> : null}
      {links.status === "pending" ? (
        <p
          role="status"
          className="border-b border-border py-4 text-row text-muted-foreground max-lg:px-4"
        >
          Reading linked projects…
        </p>
      ) : links.status === "error" ? (
        <div
          role="alert"
          className="flex items-center gap-3 border-b border-border py-3 text-row max-lg:flex-col max-lg:items-stretch max-lg:px-4"
        >
          <p className="min-w-0 flex-1 text-destructive">
            Mend couldn&apos;t read the linked projects.{" "}
            {failureWords(links.error, "Check your connection and try again.")}
          </p>
          <Button
            type="button"
            variant="outline"
            size={phone ? "touch" : "sm"}
            onClick={() => void links.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : links.data.length === 0 ? (
        <p className="border-b border-border py-4 text-row text-muted-foreground max-lg:px-4">
          No linked projects.
        </p>
      ) : (
        <div role="table" aria-label="Linked projects" className="text-row">
          <div
            role="row"
            className={`grid ${grid} gap-4 border-b border-border py-2 text-meta text-muted-foreground max-lg:hidden`}
          >
            <span role="columnheader">Project</span>
            <span role="columnheader">Mounted at</span>
            <span role="columnheader">Worktree</span>
            {manage ? (
              <span role="columnheader">
                <span className="sr-only">Actions</span>
              </span>
            ) : null}
          </div>
          {links.data.map((link) => {
            const busy = unlink.isPending && unlink.variables.linkId === link.id;
            return (
              <div
                key={link.id}
                role="row"
                aria-label={link.name}
                className={`grid ${grid} items-center gap-4 border-b border-border py-2.5 max-lg:grid-cols-[minmax(0,1fr)_auto] max-lg:px-4 max-lg:py-3.5`}
              >
                <span role="cell" className="min-w-0">
                  <span className="block truncate font-semibold">
                    {nameOf(link.linkedProjectId)}
                  </span>
                  <span className="block font-mono text-meta break-all text-muted-foreground lg:hidden">
                    {linkPath(link.name)} · {link.worktreeName}
                  </span>
                </span>
                <span role="cell" className="font-mono text-meta break-all max-lg:hidden">
                  {linkPath(link.name)}
                </span>
                <span role="cell" className="font-mono text-meta max-lg:hidden">
                  {link.worktreeName}
                </span>
                {manage ? (
                  <span role="cell" className="flex justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size={phone ? "touch" : "sm"}
                      aria-label={`Unlink ${nameOf(link.linkedProjectId)}`}
                      disabled={unlink.isPending}
                      onClick={() => unlink.mutate({ id: project.id, linkId: link.id })}
                    >
                      {busy ? <Spinner aria-hidden /> : null}
                      {busy ? "Unlinking…" : "Unlink"}
                    </Button>
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {unlink.isError ? (
        <p role="alert" className="pt-2.5 text-row text-destructive max-lg:px-4">
          Mend didn&apos;t unlink the project.{" "}
          {failureWords(unlink.error, "Check your connection and try again.")}
        </p>
      ) : null}
      {note === null ? null : (
        <p className="pt-2.5 text-row text-pretty text-muted-foreground max-lg:px-4">{note}</p>
      )}
      {manage ? (
        <LinkProjectDialog
          project={project}
          candidates={candidates}
          open={linking}
          onClose={() => setLinking(false)}
        />
      ) : null}
    </SettingSection>
  );
}

/**
 * Link project…: which project, the directory it appears in (its own name unless changed), and
 * which of its worktrees (the default branch's unless named).
 */
function LinkProjectDialog({
  project,
  candidates,
  open,
  onClose,
}: {
  readonly project: ProjectDto;
  readonly candidates: ReadonlyArray<ProjectDto>;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const [linkedId, setLinkedId] = useState("");
  const [name, setName] = useState("");
  const [worktree, setWorktree] = useState("");
  const linked = candidates.find((candidate) => candidate.id === linkedId) ?? null;
  const request = linkRequest(linked, name, worktree);
  const link = useMutation(
    trpc.projects.addLink.mutationOptions({
      onSuccess: async (saved) => {
        await queryClient.invalidateQueries(trpc.projects.links.queryFilter({ id: project.id }));
        toast.add({
          description: `Linked ${linked?.name ?? saved.name}. New sessions in ${project.name} get it at ${linkPath(saved.name)}.`,
        });
        setLinkedId("");
        setName("");
        setWorktree("");
        onClose();
      },
    }),
  );
  const close = () => {
    if (link.isPending) return;
    link.reset();
    onClose();
  };
  const size = phone ? "touch" : "default";
  const field = phone ? "h-11 text-base" : "";
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title="Link project"
      description={`Its worktree appears in ${project.name}'s next sessions, and the agent can change it. Commits there are that project's own change, reviewed there.`}
      size="md"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size={size}
            disabled={link.isPending}
            onClick={close}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="link-project"
            size={size}
            disabled={request === null || link.isPending}
          >
            {link.isPending ? <Spinner aria-hidden /> : null}
            {link.isPending ? "Linking…" : "Link project"}
          </Button>
        </>
      }
    >
      <form
        id="link-project"
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (request !== null && !link.isPending) link.mutate({ id: project.id, link: request });
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="link-project-which">Project</Label>
          {candidates.length === 0 ? (
            <p className="text-row text-muted-foreground">
              Every other project is linked already, or there are no others yet.
            </p>
          ) : (
            <NativeSelect
              id="link-project-which"
              size="field"
              className="w-full"
              value={linkedId}
              onChange={(event) => setLinkedId(event.target.value)}
            >
              <NativeSelectOption value="">Choose a project</NativeSelectOption>
              {candidates.map((candidate) => (
                <NativeSelectOption key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="link-project-name">Mounted as</Label>
          <Input
            id="link-project-name"
            value={name}
            placeholder={linked?.name ?? "name"}
            autoComplete="off"
            spellCheck={false}
            className={`font-mono ${field}`}
            onChange={(event) => setName(event.target.value)}
          />
          <p className="text-row text-muted-foreground">
            Sessions see it at{" "}
            <code className="font-mono text-meta">
              {linkPath(request?.name ?? (name.trim() || "<name>"))}
            </code>
            .
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="link-project-worktree">Worktree</Label>
          <Input
            id="link-project-worktree"
            value={worktree}
            placeholder="The default branch's"
            autoComplete="off"
            spellCheck={false}
            className={`font-mono ${field}`}
            onChange={(event) => setWorktree(event.target.value)}
          />
        </div>
        {link.isError ? (
          <p role="alert" className="text-row text-destructive">
            Mend didn&apos;t link the project.{" "}
            {failureWords(link.error, "Check your connection and try again.")}
          </p>
        ) : null}
      </form>
    </Overlay>
  );
}
