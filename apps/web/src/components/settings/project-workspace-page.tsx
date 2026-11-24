import { Segmented } from "@mend/ui/components/segmented";
import { Button } from "@mend/ui/components/ui/button";
import { ButtonGroup } from "@mend/ui/components/ui/button-group";
import { Input } from "@mend/ui/components/ui/input";
import { Label } from "@mend/ui/components/ui/label";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { Switch } from "@mend/ui/components/ui/switch";
import { Textarea } from "@mend/ui/components/ui/textarea";
import { toast } from "@mend/ui/components/ui/toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { ProjectDto } from "#/lib/api";
import { dayOf } from "#/lib/organization";
import { usePhone } from "#/lib/phone";
import { type ProjectPeople, projectChangers, readOnlyLine } from "#/lib/project-settings";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";
import { useProjectSettings } from "#/lib/use-project-settings";
import {
  addPackages,
  customCommandLine,
  customCommandValue,
  customUnavailable,
  draftOf,
  draftProblem,
  type ImageDraft,
  imageLine,
  imageOf,
  imageSavedWords,
  imageSectionLine,
  imageTag,
  installSwitchLine,
  MAX_READY,
  OS_LABELS,
  OS_ORDER,
  osUnavailable,
  readyWords,
  resolutionIssue,
  SHELL_ORDER,
  workspaceImagesEqual,
} from "#/lib/workspace-image";

import { Overlay } from "../projects/overlay.tsx";
import { ProjectAccessPolicySection } from "./project-access-policy-section.tsx";
import { SettingRow, SettingSection } from "./setting-row.tsx";
import { SettingsPage } from "./settings-page.tsx";

/** A machine value shown, not edited: Geist Mono on a muted line. */
const MONO = "font-mono text-meta text-muted-foreground";

/**
 * Settings → a project → Workspace (Doop "Settings · Project · checkout-api · Workspace"): the
 * project's own image (workspace-images.md `image-project-override`, and `image-use-default` read as
 * "start again from a copy of the organization's starting image"), its dependency install (every
 * web part of automatic-install.md) and its ready workspaces (hot-sessions.md `hot-count`,
 * `hot-status`, `hot-rewarm`). Everyone who can open the project reads it; the person who added it
 * and the organization's owners change it (`capabilities.manage`). The route's loader read the
 * project; the detection and the ready workspaces load here, each with its own state.
 */
export function ProjectWorkspacePage({ projectId }: { readonly projectId: string }) {
  const { detail, people } = useProjectSettings(projectId);
  const { project, capabilities, mountDelivery } = detail;
  const intro = `These apply to every new session in ${project.name}. Sessions that are already running keep the setup they started with.`;
  return (
    <SettingsPage
      page="p-workspace"
      project={{ id: project.id, name: project.name }}
      intro={
        capabilities.manage
          ? `${intro} ${projectChangers(people)} can change them.`
          : `${intro} ${readOnlyLine(people)}`
      }
    >
      <ImageSection project={project} people={people} manage={capabilities.manage} />
      <ProjectAccessPolicySection
        projectId={project.id}
        projectName={project.name}
        manage={capabilities.manage}
      />
      <DependenciesSection
        project={project}
        manage={capabilities.manage}
        colocated={mountDelivery === "bind"}
      />
      <ReadyWorkspacesSection project={project} manage={capabilities.manage} />
    </SettingsPage>
  );
}

// --- Image --------------------------------------------------------------------------------------

function ImageSection({
  project,
  people,
  manage,
}: {
  readonly project: ProjectDto;
  readonly people: ProjectPeople;
  readonly manage: boolean;
}) {
  const phone = usePhone();
  const [editing, setEditing] = useState(false);
  return (
    <SettingSection
      title="Image"
      description={imageSectionLine(
        project.name,
        people.organizationName,
        dayOf(project.createdAt),
      )}
    >
      <SettingRow
        layout="stack"
        label="Current image"
        description={imageLine(project.workspaceImage)}
        // The phone frame puts the image's tag under the line, and Edit image… under it.
        note={
          phone ? (
            <span className={`${MONO} break-all`}>{imageTag(project.workspaceImage)}</span>
          ) : null
        }
        control={
          <>
            <span className={`${MONO} break-all max-lg:hidden`}>
              {imageTag(project.workspaceImage)}
            </span>
            {manage ? (
              <Button
                type="button"
                variant="outline"
                size={phone ? "touch" : "default"}
                onClick={() => setEditing(true)}
              >
                Edit image…
              </Button>
            ) : null}
          </>
        }
      />
      {manage ? (
        <ImageEditor
          // A fresh draft each time it opens, from what is saved.
          key={editing ? "open" : "closed"}
          project={project}
          organizationName={people.organizationName}
          open={editing}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </SettingSection>
  );
}

/** One setting in the editor: its name and what it does, its control on the right. */
function EditorRow({
  label,
  description,
  note,
  control,
  stack = false,
}: {
  readonly label: string;
  readonly description: string;
  readonly note?: string | null;
  readonly control: ReactNode;
  readonly stack?: boolean;
}) {
  return (
    <div
      className={`flex gap-6 border-b border-border pb-4 last:border-b-0 ${stack ? "flex-col gap-3" : "items-start max-lg:flex-col max-lg:gap-3"}`}
    >
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{label}</p>
        <p className="mt-0.5 text-row text-muted-foreground">{description}</p>
        {note === undefined || note === null ? null : (
          <p className="mt-1 text-row text-muted-foreground">{note}</p>
        )}
      </div>
      <div className="flex flex-none items-center max-lg:w-full">{control}</div>
    </div>
  );
}

/**
 * Edit image…: the operating system and shell, or a custom base with its setup commands, the
 * packages, the agent's screen and Docker. Save image saves it as the project's own and starts no
 * build of its own (S17): the next session builds it, and a project with ready workspaces rebuilds
 * them. A package Sealant can't resolve is named with why, and nothing is saved. "Start again from
 * <organization>'s image" fills the fields with a copy of the organization's starting image as it
 * is now.
 */
function ImageEditor({
  project,
  organizationName,
  open,
  onClose,
}: {
  readonly project: ProjectDto;
  readonly organizationName: string;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const [draft, setDraft] = useState<ImageDraft>(() => draftOf(project.workspaceImage));
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [restarted, setRestarted] = useState(false);
  const runtime = useQuery({
    ...trpc.organization.runtime.queryOptions(),
    enabled: open,
    retry: false,
  });
  const starting = useQuery({ ...trpc.organization.settings.queryOptions(), enabled: open });
  const support =
    runtime.status === "success" && runtime.data.support.state === "observed"
      ? runtime.data.support.support
      : null;
  const save = useMutation(
    trpc.projects.setWorkspaceImage.mutationOptions({
      onSuccess: async (result) => {
        if (!result.saved) return;
        await Promise.all([
          queryClient.invalidateQueries(trpc.projects.detail.queryFilter({ id: project.id })),
          queryClient.invalidateQueries(
            trpc.projects.hotSessionsStatus.queryFilter({ id: project.id }),
          ),
        ]);
        toast.add({ description: imageSavedWords(project.name, project.hotSessions) });
        onClose();
      },
    }),
  );
  const refused = save.data?.saved === false ? save.data.resolutions : [];
  const issues = refused.flatMap((resolution) => {
    const issue = resolutionIssue(resolution, draft.os);
    return issue === null ? [] : [{ name: resolution.requested, issue }];
  });
  const image = imageOf(draft);
  const changed = !workspaceImagesEqual(image, project.workspaceImage);
  const edit = (next: Partial<ImageDraft>) => {
    setDraft({ ...draft, ...next });
    setProblem(null);
    save.reset();
  };
  const add = () => {
    const result = addPackages(draft.packages, typed);
    if (result.invalid !== null) {
      setProblem(`${result.invalid} can't be a package name.`);
      return;
    }
    edit({ packages: result.packages });
    setTyped("");
  };
  const submit = () => {
    const issue = draftProblem(draft);
    setProblem(issue);
    if (issue !== null || save.isPending) return;
    save.mutate({ id: project.id, request: { workspaceImage: image } });
  };
  const size = phone ? "touch" : "default";
  const customRefusal = customUnavailable(support);
  const osRefused = draft.mode === "family" ? osUnavailable(support, draft.os) : null;
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => {
        if (!next && !save.isPending) onClose();
      }}
      title={`Edit ${project.name}'s image`}
      description="Mend builds it when the next session needs it. New sessions wait for the build; running sessions keep the image they started with."
      size="lg"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size={size}
            disabled={save.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" form="edit-image" size={size} disabled={!changed || save.isPending}>
            {save.isPending ? <Spinner aria-hidden /> : null}
            {save.isPending ? "Saving…" : "Save image"}
          </Button>
        </>
      }
    >
      <form
        id="edit-image"
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <EditorRow
          label="Base"
          description="An operating system Mend builds on, or a container image you already use."
          note={draft.mode === "family" ? customRefusal : null}
          control={
            <Segmented
              aria-label="Base"
              size={size}
              value={draft.mode}
              onValueChange={(mode) => edit({ mode })}
              options={[
                { value: "family", label: "Operating system" },
                {
                  value: "custom",
                  label: "Custom image",
                  disabled: customRefusal !== null && draft.mode !== "custom",
                },
              ]}
              className="*:min-w-fit max-lg:w-full"
            />
          }
        />
        {draft.mode === "family" ? (
          <>
            <EditorRow
              label="Operating system"
              description="Agents install extra tools with this system's package manager."
              note={osRefused}
              control={
                <Segmented
                  aria-label="Operating system"
                  size={size}
                  value={draft.os}
                  onValueChange={(os) => edit({ os })}
                  options={OS_ORDER.map((os) => ({
                    value: os,
                    label: OS_LABELS[os],
                    disabled: os !== draft.os && osUnavailable(support, os) !== null,
                  }))}
                  className="*:min-w-fit max-lg:w-full"
                />
              }
            />
            <EditorRow
              label="Shell"
              description="The shell for terminals and the agent's commands."
              control={
                <Segmented
                  aria-label="Shell"
                  size={size}
                  value={draft.shell}
                  onValueChange={(shell) => edit({ shell })}
                  options={SHELL_ORDER.map((shell) => ({ value: shell, label: shell }))}
                  className="*:min-w-fit max-lg:w-full"
                />
              }
            />
          </>
        ) : (
          <>
            <div className="grid gap-1.5">
              <Label htmlFor="image-base">Base image</Label>
              <Input
                id="image-base"
                value={draft.baseImage}
                placeholder="node:22-bookworm"
                autoComplete="off"
                spellCheck={false}
                className={`font-mono ${phone ? "h-11 text-base" : ""}`}
                onChange={(event) => edit({ baseImage: event.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="image-setup">Setup commands</Label>
              <Textarea
                id="image-setup"
                value={draft.setupCommands}
                placeholder="One command per line, run when a new workspace starts"
                spellCheck={false}
                className="min-h-20 font-mono text-meta"
                onChange={(event) => edit({ setupCommands: event.target.value })}
              />
            </div>
          </>
        )}
        <div className="grid gap-2 border-b border-border pb-4">
          <p className="font-semibold">Packages</p>
          <p className="text-row text-muted-foreground">
            {draft.mode === "family"
              ? "Use the package's usual name. Mend finds the right one for each operating system."
              : "Passed as they are to the base image's own package manager."}
          </p>
          <ul aria-label="Packages" className="flex flex-wrap gap-1.5">
            {draft.packages.map((name) => (
              <li
                key={name}
                className="flex items-center gap-1 rounded-md border border-border py-0.5 pr-0.5 pl-2 font-mono text-meta"
              >
                {name}
                <Button
                  type="button"
                  variant="ghost"
                  size={phone ? "icon-touch" : "icon-xs"}
                  aria-label={`Remove ${name}`}
                  onClick={() => edit({ packages: draft.packages.filter((p) => p !== name) })}
                >
                  <XIcon aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Input
              aria-label="Add package"
              value={typed}
              placeholder="Add package"
              autoComplete="off"
              spellCheck={false}
              className={`font-mono ${phone ? "h-11 text-base" : "w-56"}`}
              onChange={(event) => {
                setTyped(event.target.value);
                setProblem(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  add();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              size={size}
              disabled={typed.trim() === ""}
              onClick={add}
            >
              Add
            </Button>
          </div>
          {issues.length === 0 ? null : (
            <ul role="alert" aria-label="Packages Mend didn't save" className="grid gap-0.5">
              {issues.map(({ name, issue }) => (
                <li key={name} className="text-row text-destructive">
                  <span className="font-mono">{name}</span> · {issue}
                </li>
              ))}
            </ul>
          )}
        </div>
        {draft.mode === "family" ? (
          <EditorRow
            label="Screen for the agent"
            description="The agent gets a display it can see and click, for testing in a browser."
            control={
              <Switch
                aria-label="Screen for the agent"
                checked={draft.screen}
                onCheckedChange={(screen) => edit({ screen })}
              />
            }
          />
        ) : null}
        <EditorRow
          label="Docker inside workspaces"
          description="Sessions can run docker and docker compose."
          control={
            <Switch
              aria-label="Docker inside workspaces"
              checked={draft.docker}
              onCheckedChange={(docker) => edit({ docker })}
            />
          }
        />
        <div className="grid gap-1">
          <div>
            <Button
              type="button"
              variant="link"
              disabled={starting.status !== "success"}
              onClick={() => {
                if (starting.status !== "success") return;
                edit(draftOf(starting.data.organization.workspaceImage));
                setRestarted(true);
              }}
            >
              Start again from {organizationName}&apos;s image
            </Button>
          </div>
          <p className="text-row text-muted-foreground">
            {restarted
              ? `The fields now hold a copy of ${organizationName}'s starting image as it is now. Save image to make it ${project.name}'s.`
              : starting.status === "error"
                ? `Mend couldn't read ${organizationName}'s starting image. ${failureWords(starting.error, "Try again later.")}`
                : `Fills the fields with a copy of ${organizationName}'s starting image as it is now. Changing ${organizationName}'s image later doesn't change ${project.name}'s.`}
          </p>
        </div>
        {problem !== null ? (
          <p role="alert" className="text-row text-destructive">
            {problem}
          </p>
        ) : save.isError ? (
          <p role="alert" className="text-row text-destructive">
            Mend didn&apos;t save the image.{" "}
            {failureWords(save.error, "Check your connection and try again.")}
          </p>
        ) : null}
      </form>
    </Overlay>
  );
}

// --- Dependencies -------------------------------------------------------------------------------

/**
 * Automatic install and the custom command (automatic-install.md). The switch saves at once; the
 * command saves with Save or Enter, and a blank one goes back to the command Mend finds from the
 * lockfile. On a server where sessions run beside the store, the setting changes nothing a session
 * sees, and the section says so.
 */
function DependenciesSection({
  project,
  manage,
  colocated,
}: {
  readonly project: ProjectDto;
  readonly manage: boolean;
  readonly colocated: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const detection = useQuery(trpc.projects.installDetection.queryOptions({ id: project.id }));
  const [typed, setTyped] = useState<string | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries(trpc.projects.detail.queryFilter({ id: project.id }));
  const enabled = useMutation(
    trpc.projects.setInstallEnabled.mutationOptions({ onSettled: refresh }),
  );
  const command = useMutation(
    trpc.projects.setInstallCommand.mutationOptions({
      onSuccess: async (saved) => {
        await refresh();
        setTyped(null);
        toast.add({
          description:
            saved.installCommand === null
              ? `New sessions in ${project.name} run the command Mend finds from the lockfile.`
              : `Saved the custom command. New sessions in ${project.name} run it.`,
        });
      },
    }),
  );
  const on = enabled.isPending ? enabled.variables.request.installEnabled : project.installEnabled;
  const saved = project.installCommand ?? "";
  const value = typed ?? saved;
  const dirty = typed !== null && customCommandValue(typed) !== project.installCommand;
  const found = detection.status === "success" ? detection.data : null;
  const size = phone ? "touch" : "default";
  const cancel = () => {
    setTyped(null);
    command.reset();
  };
  const submit = () => {
    if (!dirty || command.isPending) return;
    command.mutate({ id: project.id, request: { installCommand: customCommandValue(value) } });
  };
  return (
    <SettingSection
      title="Dependencies"
      description="Mend installs dependencies in each new worktree before the agent starts."
    >
      {colocated ? (
        <p className="border-b border-border py-3 text-row text-pretty text-muted-foreground max-lg:px-4">
          Sessions here run beside the store, where a worktree keeps its own dependencies, so Mend
          runs no install. Mend keeps this setting for a server that runs captured workspaces.
        </p>
      ) : null}
      <SettingRow
        label="Automatic install"
        description={installSwitchLine(on, project.installCommand)}
        note={
          enabled.isError ? (
            <span role="alert" className="text-destructive">
              Mend didn&apos;t change automatic install.{" "}
              {failureWords(enabled.error, "Check your connection and try again.")}
            </span>
          ) : null
        }
        control={
          manage ? (
            <span className={phone ? "flex h-11 items-center" : "flex items-center"}>
              <Switch
                aria-label="Automatic install"
                checked={on}
                disabled={enabled.isPending}
                onCheckedChange={(next) =>
                  enabled.mutate({ id: project.id, request: { installEnabled: next } })
                }
              />
            </span>
          ) : (
            <span className="text-muted-foreground">{on ? "On" : "Off"}</span>
          )
        }
      />
      {on ? (
        <SettingRow
          layout="stack"
          label="Custom command"
          labelFor="install-command"
          description={
            detection.status === "error" && project.installCommand === null
              ? `Mend couldn't read the lockfile on ${project.defaultBranch}. ${failureWords(detection.error, "It finds the command when a session starts.")}`
              : customCommandLine(project.installCommand, found)
          }
          note={
            command.isError ? (
              <span role="alert" className="text-destructive">
                Mend didn&apos;t save the command.{" "}
                {failureWords(command.error, "Check your connection and try again.")}
              </span>
            ) : null
          }
          control={
            <Input
              id="install-command"
              value={value}
              readOnly={!manage}
              placeholder={found?.command ?? "Found from the lockfile when a session starts"}
              autoComplete="off"
              spellCheck={false}
              className={`w-96 font-mono text-meta max-lg:w-full ${phone ? "h-11" : "h-9"}`}
              onChange={(event) => {
                setTyped(event.target.value);
                command.reset();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
                if (event.key === "Escape") cancel();
              }}
            />
          }
        />
      ) : null}
      {on && dirty ? (
        <div
          role="group"
          aria-label="Unsaved custom command"
          className="flex items-center gap-3 border-b border-border py-3 max-lg:flex-col max-lg:items-stretch max-lg:px-4"
        >
          <p className="min-w-0 flex-1 text-row text-muted-foreground">
            {customCommandValue(value) === null
              ? `New sessions in ${project.name} run the command Mend finds from the lockfile after you save.`
              : `New sessions in ${project.name} run this after you save.`}
          </p>
          <div className="flex gap-2 max-lg:*:flex-1">
            <Button
              type="button"
              variant="ghost"
              size={size}
              disabled={command.isPending}
              onClick={cancel}
            >
              Cancel
            </Button>
            <Button type="button" size={size} disabled={command.isPending} onClick={submit}>
              {command.isPending ? <Spinner aria-hidden /> : null}
              {command.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      ) : null}
    </SettingSection>
  );
}

// --- Ready workspaces ---------------------------------------------------------------------------

/**
 * How many workspaces Mend keeps started per person (hot-sessions.md): the count saves at once,
 * and what is ready for the signed-in person is read again every five seconds, so a save of the
 * image shows its ready workspaces starting again (S17).
 */
function ReadyWorkspacesSection({
  project,
  manage,
}: {
  readonly project: ProjectDto;
  readonly manage: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const status = useQuery({
    ...trpc.projects.hotSessionsStatus.queryOptions({ id: project.id }),
    refetchInterval: 5_000,
  });
  const runtime = useQuery({ ...trpc.organization.runtime.queryOptions(), retry: false });
  const count = useMutation(
    trpc.projects.setHotSessions.mutationOptions({
      onSettled: () =>
        Promise.all([
          queryClient.invalidateQueries(trpc.projects.detail.queryFilter({ id: project.id })),
          queryClient.invalidateQueries(
            trpc.projects.hotSessionsStatus.queryFilter({ id: project.id }),
          ),
        ]),
    }),
  );
  const shown = count.isPending ? count.variables.request.hotSessions : project.hotSessions;
  const set = (next: number) => count.mutate({ id: project.id, request: { hotSessions: next } });
  const idleCost =
    runtime.status === "success" &&
    runtime.data.support.state === "observed" &&
    runtime.data.support.support.idleCost.charged
      ? `${runtime.data.support.support.idleCost.message} Each ready workspace runs while it waits, so each one counts.`
      : null;
  const words =
    status.status === "pending"
      ? "Reading…"
      : status.status === "error"
        ? "Mend couldn't read them."
        : readyWords({ ...status.data, hotSessions: shown });
  const size = phone ? "icon-touch" : "icon";
  return (
    <SettingSection
      title="Ready workspaces"
      description="Mend keeps this many workspaces ready for each person who started a session here this week, so their next session opens in seconds. Each one is a live container."
    >
      <SettingRow
        layout="stack"
        label="Per person"
        description={`${phone ? `${words}. ` : ""}You can set up to ${MAX_READY}.${idleCost === null ? "" : ` ${idleCost}`}`}
        note={
          <>
            {status.status === "success" && status.data.error !== null ? (
              <span className="block text-destructive">
                Starting one failed: {status.data.error}
              </span>
            ) : null}
            {count.isError ? (
              <span role="alert" className="block text-destructive">
                Mend didn&apos;t change the count.{" "}
                {failureWords(count.error, "Check your connection and try again.")}
              </span>
            ) : null}
          </>
        }
        control={
          <>
            <span role="status" className="text-row text-muted-foreground max-lg:sr-only">
              {words}
            </span>
            {manage ? (
              <ButtonGroup aria-label="Ready workspaces per person">
                <Button
                  type="button"
                  variant="outline"
                  size={size}
                  aria-label="One fewer ready workspace"
                  disabled={shown <= 0 || count.isPending}
                  onClick={() => set(shown - 1)}
                >
                  <MinusIcon aria-hidden />
                </Button>
                <span
                  aria-label="Ready workspaces per person"
                  className={`flex items-center justify-center border-y border-border px-4 font-mono text-row max-lg:flex-1 ${phone ? "h-11" : "h-8"}`}
                >
                  {shown}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size={size}
                  aria-label="One more ready workspace"
                  disabled={shown >= MAX_READY || count.isPending}
                  onClick={() => set(shown + 1)}
                >
                  <PlusIcon aria-hidden />
                </Button>
              </ButtonGroup>
            ) : (
              <span className="font-mono text-row">{shown}</span>
            )}
          </>
        }
      />
    </SettingSection>
  );
}
