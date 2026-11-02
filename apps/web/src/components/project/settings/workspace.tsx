import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "#/components/kit/button";
import { Stepper, SwitchRow } from "#/components/kit/controls";
import { Field, FieldSource, TextInput } from "#/components/kit/field";
import { Panel, SettingsSection } from "#/components/kit/section";
import { StatusWord } from "#/components/kit/status";
import {
  setProjectApplyDotfiles,
  setProjectDefaultShellProfile,
  setProjectHotSessions,
  setProjectInstallCommand,
  setProjectInstallEnabled,
  type ProjectDetailDto,
  type ProjectDto,
  type ProjectInstallDetectionDto,
} from "#/lib/api";
import { useProjectSetting } from "#/lib/project-settings";
import { useTRPC } from "#/lib/trpc";

import type { SettingsReads } from "./reads";
import {
  useWorkspaceImageDraft,
  WorkspaceImageSaveBar,
  WorkspaceImageSections,
  type ImageDraft,
} from "./workspace-image";

/** Hot sessions per person, at most: each is a live container on this machine. */
const MAX_READY = 8;

/** What the Workspace tab reads before it shows, started together with the others. */
export const workspaceReads: SettingsReads = ({ queryClient, trpc }, projectId) => [
  queryClient.prefetchQuery(trpc.projects.installDetection.queryOptions({ id: projectId })),
  queryClient.prefetchQuery(trpc.projects.hotSessionsStatus.queryOptions({ id: projectId })),
];

/**
 * Project settings · Workspace (screen L2): the image sessions start from, its Screen and Docker
 * switches, installing dependencies, dotfiles, and how many workspaces stay ready. The image is a
 * draft saved with "Save and rebuild"; every switch saves at once and moves back if Mend refuses.
 */
export function WorkspaceSettings({ detail }: { readonly detail: ProjectDetailDto }) {
  const { project } = detail;
  const image = useWorkspaceImageDraft(project);
  if (!detail.capabilities.manage)
    return (
      <Panel className="px-[26px] py-6">
        <p className="text-[13.5px] text-ink-2">
          The project&apos;s creator or an organization owner sets how its workspaces are built.
        </p>
      </Panel>
    );
  return (
    <>
      <Panel>
        <WorkspaceImageSections draft={image} />
        <DependenciesSection project={project} captured={detail.mountDelivery === "sources"} />
        <DotfilesSection project={project} image={image} />
        <ReadyWorkspacesSection project={project} />
      </Panel>
      <WorkspaceImageSaveBar draft={image} />
    </>
  );
}

function SaveError({ error }: { readonly error: Error | null }) {
  return (
    <p role="alert" className="mt-1.5 font-mono text-[11.5px] text-danger empty:hidden">
      {error === null ? "" : `That did not save: ${error.message}. It is back as it was.`}
    </p>
  );
}

/**
 * "Automatic install" and its custom command (ADR-0002 decisions 2 and 9). On, Mend runs the
 * custom command, else the one detected from the lockfile, where the saved state and shared cache
 * have no dependency tree; off, it runs none. Only capture mode installs, so the section says so
 * on a server that runs sessions beside the store.
 */
function DependenciesSection({
  project,
  captured,
}: {
  readonly project: ProjectDto;
  readonly captured: boolean;
}) {
  const trpc = useTRPC();
  const detection = useQuery(trpc.projects.installDetection.queryOptions({ id: project.id }));
  const enabled = useProjectSetting(project.id, {
    save: (installEnabled: boolean) => setProjectInstallEnabled(project.id, installEnabled),
    apply: (current, installEnabled) => ({ ...current, installEnabled }),
  });
  return (
    <SettingsSection
      title="Dependencies"
      why={
        captured
          ? "Installs dependencies in every new worktree before the agent starts."
          : "Capture mode only. Sessions here run beside the store, where a worktree keeps its own dependencies, so Mend runs no install. The setting is kept for capture mode."
      }
    >
      <SwitchRow
        label="Automatic install"
        detail={
          project.installEnabled
            ? undefined
            : `No install runs, in sessions or for the shared cache${project.installCommand === null ? "" : " · custom command kept"}`
        }
        checked={project.installEnabled}
        pending={enabled.isPending}
        onCheckedChange={(next) => enabled.mutate(next)}
      />
      <SaveError error={enabled.error} />
      {project.installEnabled ? (
        <InstallCommandField
          // A command saved elsewhere starts a fresh draft from it.
          key={project.installCommand ?? ""}
          project={project}
          detection={detection.data}
          detectionFailed={detection.isError}
        />
      ) : null}
    </SettingsSection>
  );
}

function InstallCommandField({
  project,
  detection,
  detectionFailed,
}: {
  readonly project: ProjectDto;
  readonly detection: ProjectInstallDetectionDto | undefined;
  readonly detectionFailed: boolean;
}) {
  const current = project.installCommand ?? "";
  const [draft, setDraft] = useState(current);
  const command = useProjectSetting(project.id, {
    save: (installCommand: string | null) => setProjectInstallCommand(project.id, installCommand),
    apply: (saved, installCommand) => ({ ...saved, installCommand }),
  });
  const dirty = draft.trim() !== current;
  const source =
    current === "" ? (
      <FieldSource>optional · replaces the detected one</FieldSource>
    ) : (
      <FieldSource tone="set">
        set for {project.name} ·{" "}
        <button type="button" disabled={command.isPending} onClick={() => command.mutate(null)}>
          reset
        </button>
      </FieldSource>
    );
  return (
    <form
      className="mt-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && !command.isPending) command.mutate(draft.trim() === "" ? null : draft.trim());
      }}
    >
      <Field label="Custom command" source={source}>
        {(id) => (
          <>
            <div className="flex items-center gap-2">
              <TextInput
                id={id}
                value={draft}
                spellCheck={false}
                placeholder={detection?.command ?? "detected from the lockfile at launch"}
                aria-describedby={`${id}-runs`}
                onChange={(event) => setDraft(event.target.value)}
              />
              {dirty ? (
                <Button type="submit" size="sm" disabled={command.isPending}>
                  {command.isPending ? "Saving…" : "Save"}
                </Button>
              ) : null}
            </div>
            <p id={`${id}-runs`} className="font-mono text-[11.5px] text-muted-foreground">
              {current !== "" ? (
                <>runs · {current} · custom</>
              ) : (
                <DetectedInstall detection={detection} failed={detectionFailed} />
              )}
            </p>
          </>
        )}
      </Field>
      <SaveError error={command.error} />
    </form>
  );
}

/** What a launch with no custom command would run, as read from the ref it bases on. */
function DetectedInstall({
  detection,
  failed,
}: {
  readonly detection: ProjectInstallDetectionDto | undefined;
  readonly failed: boolean;
}) {
  if (detection === undefined)
    return failed ? (
      <>not read · detected from the lockfile at launch</>
    ) : (
      <span role="status">reading the lockfile…</span>
    );
  if (!detection.read) return <>not read · detected from the lockfile at launch</>;
  if (detection.command === null || detection.from === null)
    return <>no lockfile recognised on {detection.ref} · detected again at launch</>;
  return (
    <>
      detected · <span className="text-foreground">{detection.command}</span> · from{" "}
      {detection.from} on {detection.ref}
    </>
  );
}

/** Whether sessions here get the launching person's dotfiles and Mend's default shell profile. */
function DotfilesSection({
  project,
  image,
}: {
  readonly project: ProjectDto;
  readonly image: ImageDraft;
}) {
  const dotfiles = useProjectSetting(project.id, {
    save: (applyDotfiles: boolean) => setProjectApplyDotfiles(project.id, applyDotfiles),
    apply: (current, applyDotfiles) => ({ ...current, applyDotfiles }),
  });
  const profile = useProjectSetting(project.id, {
    save: (defaultShellProfile: boolean) =>
      setProjectDefaultShellProfile(project.id, defaultShellProfile),
    apply: (current, defaultShellProfile) => ({ ...current, defaultShellProfile }),
  });
  const saved = image?.form.savedImage;
  const shell = saved?.mode === "family" ? saved.shell : null;
  if (saved?.mode === "custom")
    return (
      <SettingsSection title="Dotfiles" why="From your Workspace settings.">
        <p className="font-mono text-[12px] text-muted-foreground">
          custom image · dotfiles and the default shell profile are not applied
        </p>
      </SettingsSection>
    );
  return (
    <SettingsSection title="Dotfiles" why="From your Workspace settings.">
      <SwitchRow
        label="Apply my dotfiles"
        detail="Each person's own dotfiles, applied when their session starts."
        checked={project.applyDotfiles}
        pending={dotfiles.isPending}
        onCheckedChange={(next) => dotfiles.mutate(next)}
      />
      <SwitchRow
        label="Use the default shell profile"
        detail={
          shell === null || shell === "zsh"
            ? "Written where dotfiles left no file. Never overwrites."
            : `zsh only · this image runs ${shell}`
        }
        checked={project.defaultShellProfile}
        pending={profile.isPending}
        onCheckedChange={(next) => profile.mutate(next)}
      />
      <SaveError error={dotfiles.error ?? profile.error} />
    </SettingsSection>
  );
}

/**
 * Hot sessions: workspaces kept ready per person who started a session here in the last week, so
 * their next session attaches at once. Each is a live container on this machine. The count saves
 * at once; what is ready is observed and read again every few seconds.
 */
function ReadyWorkspacesSection({ project }: { readonly project: ProjectDto }) {
  const trpc = useTRPC();
  const status = useQuery(
    trpc.projects.hotSessionsStatus.queryOptions({ id: project.id }, { refetchInterval: 5_000 }),
  );
  const count = useProjectSetting(project.id, {
    save: (hotSessions: number) => setProjectHotSessions(project.id, hotSessions),
    apply: (current, hotSessions) => ({ ...current, hotSessions }),
  });
  const observed = status.data;
  const parts: Array<string> = [];
  if (observed !== undefined) {
    if (observed.ready > 0) parts.push(`${observed.ready} ready now`);
    if (observed.warming > 0) parts.push(`${observed.warming} warming`);
    if (observed.failed > 0) parts.push(`${observed.failed} failed`);
  }
  const tone =
    observed === undefined
      ? null
      : observed.failed > 0
        ? "bad"
        : observed.warming > 0
          ? "run"
          : observed.ready > 0
            ? "ok"
            : "off";
  const line = status.isPending
    ? "reading…"
    : status.isError
      ? "not observed · Mend could not read the pool"
      : parts.length > 0
        ? parts.join(" · ")
        : project.hotSessions === 0
          ? "off"
          : "none ready yet";
  return (
    <SettingsSection
      title="Ready workspaces"
      why="Kept started so a new session opens in seconds. Each is a live container, per person."
    >
      <div className="flex items-center gap-3">
        <Stepper
          label="Ready workspaces"
          value={project.hotSessions}
          min={0}
          max={MAX_READY}
          onValueChange={(next) => count.mutate(next)}
        />
        <span role="status">
          <StatusWord tone={tone}>{line}</StatusWord>
        </span>
      </div>
      {observed?.error == null ? null : (
        <p className="mt-2 font-mono text-[11.5px] text-danger">
          warming failed · {observed.error}
        </p>
      )}
      <SaveError error={count.error} />
    </SettingsSection>
  );
}
