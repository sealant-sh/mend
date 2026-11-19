import { Segmented } from "@mend/ui/components/segmented";
import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import { Input } from "@mend/ui/components/ui/input";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";

import type { ProjectDto } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import {
  privateLabel,
  type ProjectPeople,
  projectNameDraft,
  readOnlyLine,
  renameRefusal,
  repositoryLine,
  visibilityLine,
  whoRemoves,
} from "#/lib/project-settings";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";
import { useProjectSettings } from "#/lib/use-project-settings";

import { RemoveProject } from "../projects/remove-project.tsx";
import { SettingRow, SettingSection } from "./setting-row.tsx";
import { SettingsPage } from "./settings-page.tsx";

/** A control's height: the frames' 36px on the desk, a 44px touch target on a phone. */
const CONTROL = "h-9 max-lg:h-11 max-lg:text-base";

/** A machine value shown, not edited: Geist Mono on a muted fill, as the frame draws the repository. */
const VALUE =
  "flex min-h-9 min-w-0 items-center rounded-lg bg-muted px-3 font-mono text-sm break-all max-lg:min-h-11 max-lg:w-full";

/**
 * Settings → a project → General (Doop "Settings · Project · checkout-api · General"): its name,
 * its repository and default branch, who can see it, the setup session, and removing it. Everyone
 * who can open the project reads it; the project's `capabilities` say who changes what (its name:
 * the person who added it and the organization's owners; who sees it: the owners; removing it: an
 * owner, or the person who added a private project), and the page names them to everyone else.
 */
export function ProjectGeneralPage({ projectId }: { readonly projectId: string }) {
  const { detail, people } = useProjectSettings(projectId);
  const { project, capabilities } = detail;
  return (
    <SettingsPage
      page="p-general"
      project={{ id: project.id, name: project.name }}
      intro={
        capabilities.manage
          ? `This is ${project.name}'s name, who can see it, and how to remove it.`
          : `This is ${project.name}'s name, who can see it, and how to remove it. ${readOnlyLine(people)}`
      }
    >
      <SettingSection title="Project">
        {/* Keyed by project: a draft never carries over to another project's page. */}
        <NameRow
          key={project.id}
          project={project}
          people={people}
          canChange={capabilities.manage}
        />
        <SettingRow
          layout="stack"
          label="Repository"
          description={repositoryLine(project, people)}
          control={
            <span className={VALUE}>
              {project.originUrl ?? <span className="font-sans text-muted-foreground">None</span>}
            </span>
          }
        />
        <SettingRow
          layout="stack"
          label="Default branch"
          description="New sessions start from this branch, and Automatic landing opens pull requests against it."
          control={<span className={VALUE}>{project.defaultBranch}</span>}
        />
        <VisibilityRow
          project={project}
          people={people}
          canChange={capabilities.changeVisibility}
        />
      </SettingSection>
      {capabilities.manage ? (
        <SettingSection title="Setup session">
          <SettingRow
            layout="stack"
            label="Write the setup files"
            description="An agent reads the repository and writes the files in .mend/: how to start its services, what to install and how to check a change. You review them like any other change."
            control={
              <Link
                to="/projects/$projectId"
                params={{ projectId: project.id }}
                search={{ setup: true }}
                className={cn(buttonVariants({ variant: "outline" }), CONTROL)}
              >
                Start setup session
              </Link>
            }
          />
        </SettingSection>
      ) : null}
      <RemoveSection project={project} people={people} canRemove={capabilities.remove} />
    </SettingsPage>
  );
}

/**
 * The project's name. For someone who may change it, Save and Discard appear once it differs from
 * the saved name; Enter saves and Escape discards. A name Mend won't take is said beside the field
 * before it is sent, in the words adding a project uses, and a refusal in the server's words. The
 * sidebar, the breadcrumb and the project's pages read the new name once it is saved.
 */
function NameRow({
  project,
  people,
  canChange,
}: {
  readonly project: ProjectDto;
  readonly people: ProjectPeople;
  readonly canChange: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const others = useQuery(trpc.projects.list.queryOptions());
  // Null while the person hasn't typed: the field follows the saved name, even when someone else
  // renames it meanwhile.
  const [draft, setDraft] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const typed = draft ?? project.name;
  const { changed, problem } = projectNameDraft(
    project.name,
    typed,
    others.status === "success" ? others.data : [],
    project.id,
    people.organizationName,
  );
  const rename = useMutation(
    trpc.projects.rename.mutationOptions({
      onSuccess: async (renamed) => {
        setDraft(null);
        toast.add({ description: `Renamed to ${renamed.name}.` });
        await Promise.all([
          queryClient.invalidateQueries(trpc.projects.detail.queryFilter({ id: project.id })),
          queryClient.invalidateQueries(trpc.projects.list.queryFilter()),
        ]);
      },
      onError: (error) => setRefusal(renameRefusal(error, project.name)),
    }),
  );
  const description = `Each project in ${people.organizationName} needs its own name.`;
  if (!canChange) {
    return (
      <SettingRow
        layout="stack"
        label="Name"
        labelFor="project-name"
        description={description}
        control={
          <Input
            id="project-name"
            value={project.name}
            readOnly
            className={`${CONTROL} w-80 text-muted-foreground max-lg:w-full`}
          />
        }
      />
    );
  }
  const save = () => {
    if (!changed || rename.isPending) return;
    setRefusal(problem);
    if (problem === null) rename.mutate({ id: project.id, name: typed.trim() });
  };
  const discard = () => {
    setDraft(null);
    setRefusal(null);
    rename.reset();
  };
  return (
    <>
      <SettingRow
        layout="stack"
        label="Name"
        labelFor="project-name"
        description={`${description}${changed ? ` It was ${project.name}.` : ""}`}
        note={
          refusal === null ? null : (
            <span id="project-name-problem" role="alert" className="text-destructive">
              {refusal}
            </span>
          )
        }
        control={
          <Input
            id="project-name"
            value={typed}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={refusal !== null}
            aria-describedby={refusal === null ? undefined : "project-name-problem"}
            onChange={(event) => {
              setDraft(event.target.value);
              setRefusal(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") save();
              if (event.key === "Escape") discard();
            }}
            className={`${CONTROL} w-80 max-lg:w-full`}
          />
        }
      />
      {changed ? (
        <div
          role="group"
          aria-label="Unsaved changes"
          className="flex items-center gap-3 border-b border-border py-3 max-lg:sticky max-lg:bottom-0 max-lg:z-10 max-lg:flex-col max-lg:items-stretch max-lg:border-t max-lg:bg-background max-lg:px-4"
        >
          <p className="min-w-0 flex-1">Unsaved changes</p>
          <div className="flex gap-2 max-lg:*:flex-1">
            <Button
              type="button"
              variant="outline"
              className={CONTROL}
              disabled={rename.isPending}
              onClick={discard}
            >
              Discard
            </Button>
            <Button type="button" className={CONTROL} disabled={rename.isPending} onClick={save}>
              {rename.isPending ? <Spinner aria-hidden /> : null}
              {rename.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * Who can see the project: only the person who added it, or everyone in the organization. An owner
 * switches it, and it saves at once; while it saves the switch shows the choice and stays still,
 * and a refusal puts it back and says why. Anyone else reads who sees it and which owners can
 * change that.
 */
function VisibilityRow({
  project,
  people,
  canChange,
}: {
  readonly project: ProjectDto;
  readonly people: ProjectPeople;
  readonly canChange: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const visibility = useMutation(
    trpc.projects.setVisibility.mutationOptions({
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries(trpc.projects.detail.queryFilter({ id: project.id })),
          queryClient.invalidateQueries(trpc.projects.list.queryFilter()),
        ]),
    }),
  );
  const shown = visibility.isPending ? visibility.variables.visibility : project.visibility;
  const shared = `Everyone in ${people.organizationName}`;
  return (
    <SettingRow
      layout="stack"
      label="Visible to"
      description={visibilityLine(shown, people, canChange)}
      note={
        visibility.isError ? (
          <span role="alert" className="text-destructive">
            {`Who can see ${project.name} didn't change. ${failureWords(visibility.error, "Check your connection and try again.")}`}
          </span>
        ) : null
      }
      control={
        canChange ? (
          <Segmented
            aria-label="Visible to"
            size={phone ? "touch" : "default"}
            value={shown}
            disabled={visibility.isPending}
            onValueChange={(next) => visibility.mutate({ id: project.id, visibility: next })}
            options={[
              { value: "private", label: privateLabel(people) },
              { value: "shared", label: shared },
            ]}
            // Each choice is as wide as its words (the names differ in length), filling the row on a
            // phone.
            className="*:flex-auto max-lg:w-full"
          />
        ) : (
          <span>{shown === "shared" ? shared : privateLabel(people)}</span>
        )
      }
    />
  );
}

/**
 * Remove project…: it leaves the organization's projects, and Mend keeps it until someone purges
 * it. Removing it here keeps the person on this page, which then shows the removed project with
 * Restore and Purge… (the route's `errorComponent`, through the project being gone). Someone who
 * may not remove it reads who can.
 */
function RemoveSection({
  project,
  people,
  canRemove,
}: {
  readonly project: ProjectDto;
  readonly people: ProjectPeople;
  readonly canRemove: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [removing, setRemoving] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <SettingSection title="Remove project">
      <SettingRow
        layout="stack"
        label={`Remove ${project.name}`}
        description={`${project.name} leaves ${people.organizationName}'s projects. Mend keeps its files and its sessions' history, so you can restore it until someone purges it. Mend won't remove it while a session is running in it.`}
        note={
          canRemove ? null : (
            <span className="text-muted-foreground">{whoRemoves(project.visibility, people)}</span>
          )
        }
        control={
          canRemove ? (
            <Button
              ref={trigger}
              type="button"
              variant="destructive"
              className={CONTROL}
              onClick={() => setRemoving(true)}
            >
              Remove project…
            </Button>
          ) : undefined
        }
      />
      <RemoveProject
        project={removing ? project : null}
        onOpenChange={setRemoving}
        onRemoved={(removed) => {
          setRemoving(false);
          toast.add({ description: `${removed.name} was removed. You can restore it here.` });
          // The project is gone: reading it again lands on the route's removed-project view.
          queryClient.removeQueries(trpc.projects.detail.queryFilter({ id: removed.id }));
          void router.invalidate();
        }}
      />
    </SettingSection>
  );
}
