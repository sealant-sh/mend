import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "#/components/kit/button";
import { GroupField } from "#/components/kit/field";
import { ModalDialog } from "#/components/kit/modal";
import { Panel, SettingsSection } from "#/components/kit/section";
import { Segment } from "#/components/kit/segment";
import { StatusWord } from "#/components/kit/status";
import { removeProject, type ProjectDetailDto, type ProjectDto } from "#/lib/api";
import { projectRemovalFailureOf } from "#/lib/project-removal";
import { useProjectSetting } from "#/lib/project-settings";
import { startSetupSession, type Harness } from "#/lib/session-launch";
import { useTRPC } from "#/lib/trpc";

import { LinkedProjectsSection, ReferencesSection } from "./general-links";
import type { SettingsReads } from "./reads";

/** What the General tab reads before it shows, started together with the others. */
export const generalReads: SettingsReads = ({ queryClient, trpc }, projectId) => [
  queryClient.ensureQueryData(trpc.projects.links.queryOptions({ id: projectId })),
  queryClient.ensureQueryData(trpc.projects.list.queryOptions()),
  queryClient.ensureQueryData(trpc.git.references.queryOptions()),
  queryClient.ensureQueryData(trpc.projects.references.queryOptions({ id: projectId })),
  queryClient.prefetchQuery(
    trpc.organization.current.queryOptions(undefined, { retry: false, staleTime: 60_000 }),
  ),
];

/** Project settings · General (screen L1): who sees it, what it mounts, setup and removal. */
export function GeneralSettings({ detail }: { readonly detail: ProjectDetailDto }) {
  const { project, capabilities } = detail;
  return (
    <>
      {capabilities.manage ? null : (
        <p className="mb-3.5 max-w-[64ch] border-l-2 border-[var(--sw-accent)] pl-3 text-[13px] leading-relaxed text-ink-2">
          How sessions here launch is set by the project&apos;s creator or an organization owner.
          You can start sessions and review changes as it stands.
        </p>
      )}
      <Panel>
        {capabilities.changeVisibility ? <VisibilitySection project={project} /> : null}
        <LinkedProjectsSection project={project} manage={capabilities.manage} />
        <ReferencesSection project={project} manage={capabilities.manage} />
        {capabilities.manage ? <SetupSection project={project} /> : null}
        {capabilities.remove ? <RemoveSection project={project} /> : null}
      </Panel>
    </>
  );
}

const errorWords = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

function VisibilitySection({ project }: { readonly project: ProjectDto }) {
  const trpc = useTRPC();
  const organization = useQuery(
    trpc.organization.current.queryOptions(undefined, { retry: false, staleTime: 60_000 }),
  ).data;
  const name = organization?.organization.name ?? "the organization";
  const visibility = useProjectSetting(project.id, "visibility");
  return (
    <SettingsSection title="Visibility" why={`Private is only you. Shared is everyone in ${name}.`}>
      <Segment
        label="Visibility"
        value={project.visibility}
        onChange={(value) => visibility.mutate(value)}
        options={[
          { value: "private", label: "Private" },
          { value: "shared", label: "Shared" },
        ]}
      />
      <p className="mt-2.5 max-w-[60ch] text-[12.5px] text-muted-foreground">
        Shared: every member sees it, starts sessions in it and reviews its changes. Making a shared
        project private drains other members&apos; ready workspaces; their sessions keep running
        until they end.
      </p>
      <p role="alert" className="mt-2 font-mono text-[11.5px] text-danger empty:hidden">
        {visibility.isError
          ? `Not saved: ${errorWords(visibility.error)}. Visibility is back as it was.`
          : ""}
      </p>
    </SettingsSection>
  );
}

const SETUP_AGENTS = ["claude", "codex"] as const satisfies ReadonlyArray<Harness>;

/**
 * Set up this project (docs/adr/0021): an ordinary session running Mend's prompt, which proposes
 * a feature map, verification instructions and recipes under `.mend/` as a change. It spends the
 * starter's own agent login, so only agents connected in Settings are offered.
 */
function SetupSection({ project }: { readonly project: ProjectDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const identity = useQuery(trpc.platform.sealantIdentity.queryOptions());
  const agents = SETUP_AGENTS.filter((agent) =>
    identity.data?.accounts.some(
      (account) => account.provider === agent && account.status === "active",
    ),
  );
  const [chosen, setChosen] = useState<(typeof SETUP_AGENTS)[number] | null>(null);
  const agent = agents.find((candidate) => candidate === chosen) ?? agents[0];
  const start = useMutation({
    mutationFn: (harness: Harness) =>
      startSetupSession(navigate, { queryClient, trpc }, project.id, harness),
  });

  return (
    <SettingsSection
      title="Set up this project"
      why="A setup session studies the repository and proposes .mend/ files for you to review, on your own agent login."
    >
      {identity.isPending ? (
        <p role="status" className="font-mono text-[12px] text-muted-foreground">
          Reading your connected agents…
        </p>
      ) : identity.isError ? (
        <p role="alert" className="font-mono text-[12px] text-danger">
          Your connected agents did not load: {identity.error.message}
        </p>
      ) : agent === undefined ? (
        <p className="text-[13px] text-muted-foreground">
          Connect Claude or Codex in Settings › Account to start a setup session.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2.5">
          <GroupField label="Agent" className="mb-0 grid-flow-col items-center gap-2.5">
            <Segment
              label="Agent"
              value={agent}
              disabled={start.isPending}
              onChange={setChosen}
              options={agents.map((value) => ({
                value,
                label: value === "claude" ? "Claude" : "Codex",
              }))}
            />
          </GroupField>
          <Button disabled={start.isPending} onClick={() => start.mutate(agent)}>
            {start.isPending ? "Starting the setup session…" : "Start a setup session"}
          </Button>
        </div>
      )}
      <p className="mt-2.5 text-[12.5px] text-muted-foreground">
        Writing these files starts no commands, Services or resources.
      </p>
      <p role="alert" className="mt-2 font-mono text-[11.5px] text-danger empty:hidden">
        {start.isError ? `The setup session did not start: ${errorWords(start.error)}` : ""}
      </p>
    </SettingsSection>
  );
}

/**
 * Remove project: it leaves Projects and its sessions' history stays restorable until purged.
 * Mend refuses while any session, anyone's, runs or saves, or any change is not on origin, and
 * names each worktree in the way; nothing is stopped or removed then.
 */
function RemoveSection({ project }: { readonly project: ProjectDto }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const remove = useMutation({
    mutationFn: () => removeProject(project.id),
    onSuccess: async () => {
      // The list refetches before the detail cache goes, so nothing refetches a removed project.
      await queryClient.invalidateQueries(trpc.projects.list.queryFilter());
      await navigate({ to: "/projects" });
      queryClient.removeQueries(trpc.projects.detail.queryFilter({ id: project.id }));
    },
  });
  const failure = remove.isError ? projectRemovalFailureOf(remove.error) : null;
  const leftover = remove.data?.leftover ?? null;

  return (
    <SettingsSection
      title="Remove project"
      why="Removes it from Projects. You can restore it until it's purged."
    >
      <ModalDialog
        open={open}
        onOpenChange={(next) => {
          if (!remove.isPending) setOpen(next);
        }}
        trigger={<Button size="sm">Remove project…</Button>}
        title={`Remove ${project.name}?`}
        description="It leaves Projects for everyone who can see it. Its files and history are kept, and you can restore it from Removed projects until it's purged."
        width={480}
        footer={
          <>
            <Button variant="ghost" disabled={remove.isPending} onClick={() => setOpen(false)}>
              Keep it
            </Button>
            <Button
              variant="primary"
              className="border-danger bg-danger hover:border-danger hover:bg-danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? "Removing…" : "Remove project"}
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-2">
          Mend refuses while any session runs or saves, or any change is not on origin, whoever
          started it. It stops nothing itself.
        </p>
        {failure === null ? null : (
          <div role="alert" className="grid gap-1.5 border-l-2 border-[var(--sw-amber)] pl-3">
            <p className="text-[13px] leading-relaxed text-ink-2">{failure.words}</p>
            {failure.worktrees.length === 0 ? null : (
              <ul aria-label="Worktrees in the way" className="grid gap-0.5">
                {failure.worktrees.map((name) => (
                  <li key={name}>
                    <StatusWord tone="wait">{name}</StatusWord>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </ModalDialog>
      {leftover === null ? null : (
        <p role="status" className="mt-2 font-mono text-[11.5px] text-warning">
          some files would not delete (container-owned) · remaining at {leftover}
        </p>
      )}
    </SettingsSection>
  );
}
