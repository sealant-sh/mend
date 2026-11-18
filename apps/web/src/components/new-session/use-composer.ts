import type { EffortLevel, ModelPicker } from "@mend/domain/workbench";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import {
  createSession,
  createSessionInWorktree,
  launchSessionStart,
  type ProjectDto,
  type SessionDefaultsDto,
} from "#/lib/api";
import { sessionPage } from "#/lib/later-pages";
import {
  type Agent,
  AGENTS,
  type AgentLogin,
  agentLogin,
  type LandingChoice,
  landingChoice,
  lastProject,
  noAgentLogin,
  pickerFor,
  promptProblem,
  startingAgent,
  startingProject,
  type StartSpec,
  type WorktreeTarget,
} from "#/lib/new-session";
import { type StartCalls, startSession } from "#/lib/start-session";
import { useTRPC } from "#/lib/trpc";

/** The browser's server calls for a start. */
const BROWSER_CALLS: StartCalls = {
  create: (projectId, agent, autoLand) => createSession(projectId, agent, null, null, autoLand),
  createInWorktree: createSessionInWorktree,
  launch: launchSessionStart,
};

/** A choice kept for one project or one agent: picking another starts the choice again. */
interface KeptFor<K, V> {
  readonly key: K;
  readonly value: V;
}

const keptFor = <K, V>(kept: KeptFor<K, V> | null, key: K): V | null =>
  kept !== null && kept.key === key ? kept.value : null;

/**
 * Logins: `unknown` while they are read or when they couldn't be: the composer then lets a start
 * go, and the server says if the agent has none.
 */
export type Logins =
  | { readonly _tag: "unknown" }
  | {
      readonly _tag: "known";
      readonly of: (agent: Agent) => AgentLogin;
      /** No agent here has a login: the person skipped the agent login at setup. */
      readonly none: boolean;
    };

export interface Composer {
  readonly projects: ReadonlyArray<ProjectDto>;
  /** Undefined only when no project exists yet. */
  readonly project: ProjectDto | undefined;
  readonly pickProject: (id: string) => void;
  readonly agent: Agent;
  readonly pickAgent: (agent: Agent) => void;
  readonly picker: ModelPicker;
  readonly pickModel: (model: string) => void;
  readonly pickEffort: (effort: EffortLevel | null) => void;
  readonly fast: boolean;
  readonly setFast: (fast: boolean) => void;
  readonly landing: LandingChoice | null;
  readonly setLand: (land: boolean) => void;
  readonly target: WorktreeTarget;
  readonly pickTarget: (target: WorktreeTarget) => void;
  readonly logins: Logins;
  /** Saving a pick for next time failed: what happened, in a sentence. */
  readonly saveFailed: string | null;
  readonly prompt: string;
  readonly setPrompt: (prompt: string) => void;
  /** Why the task as written can't be sent; send stays off until it changes. */
  readonly promptProblem: string | null;
  /** What went wrong starting the last task sent; the task is back in the field. */
  readonly startFailed: string | null;
  readonly starting: boolean;
  /** Send `text` as the session's first message; the field empties while it starts. */
  readonly start: (text: string) => void;
}

/**
 * The New session composer's state: what is picked, what the person last used, whether the
 * picked agent can start, and the start itself. The page's two layouts (desktop and phone) both
 * draw this one state, so a pick in either shows in the other.
 */
export function useComposer(): Composer {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // The route's loader read these; a failure there is the route's error screen.
  const projects = useSuspenseQuery(trpc.projects.list.queryOptions()).data;
  const defaults = useSuspenseQuery(trpc.platform.sessionDefaults.queryOptions()).data;

  const catalogsRead = useQuery(
    trpc.harnesses.models.queryOptions(undefined, { staleTime: 60_000, retry: false }),
  );
  // Without the catalog the picker sends what the person last used, and the server resolves the
  // rest (`modelPickerFor`).
  const catalogs = catalogsRead.isPending || catalogsRead.isError ? undefined : catalogsRead.data;
  const identity = useQuery(
    trpc.platform.sealantIdentity.queryOptions(undefined, { staleTime: 30_000, retry: false }),
  );
  const automation = useQuery(trpc.platform.automation.queryOptions());

  const project = startingProject(projects, lastProject.use());
  const agent = startingAgent(defaults);
  const picker = pickerFor(catalogs, defaults, agent);

  const [fastFor, setFastFor] = useState<KeptFor<Agent, boolean> | null>(null);
  const [landFor, setLandFor] = useState<KeptFor<string, boolean> | null>(null);
  const [targetFor, setTargetFor] = useState<KeptFor<string, WorktreeTarget> | null>(null);
  const [prompt, setPrompt] = useState("");

  const defaultsKey = trpc.platform.sessionDefaults.queryKey();
  const saveDefaults = useMutation(
    trpc.platform.setSessionDefaults.mutationOptions({
      // The pick shows at once; a refusal puts the last saved defaults back.
      onMutate: async (next) => {
        await queryClient.cancelQueries({ queryKey: defaultsKey });
        const before = queryClient.getQueryData(defaultsKey);
        queryClient.setQueryData(defaultsKey, next);
        return { before };
      },
      onError: (_error, _next, context) => {
        if (context?.before !== undefined) queryClient.setQueryData(defaultsKey, context.before);
      },
      onSuccess: (saved) => queryClient.setQueryData(defaultsKey, saved),
    }),
  );
  const save = (next: SessionDefaultsDto) => saveDefaults.mutate(next);
  const byHarnessWith = (
    choice: Agent,
    change: { readonly model?: string | null; readonly effort?: EffortLevel | null },
  ): SessionDefaultsDto["byHarness"] => ({
    ...defaults.byHarness,
    [choice]: {
      model: defaults.byHarness[choice]?.model ?? null,
      effort: defaults.byHarness[choice]?.effort ?? null,
      ...change,
    },
  });

  const run = useMutation({
    mutationFn: (request: {
      readonly projectId: string;
      readonly target: WorktreeTarget;
      readonly spec: StartSpec;
    }) => startSession(BROWSER_CALLS, request.projectId, request.target, request.spec),
    onSuccess: (sessionId) => {
      void queryClient.invalidateQueries(trpc.sessions.pathFilter());
      void navigate(sessionPage(sessionId));
    },
    // The task comes back into the field, so nothing the person wrote is lost.
    onError: (_error, request) => setPrompt(request.spec.prompt),
  });

  const projectId = project?.id ?? "";
  const landing =
    project === undefined || automation.isPending || automation.isError
      ? null
      : landingChoice(project, automation.data.effective.autoLand, keptFor(landFor, projectId));
  const fast = picker.fastCapable && keptFor(fastFor, agent) === true;
  const target = keptFor(targetFor, projectId) ?? { _tag: "new" };

  const logins: Logins =
    identity.isPending || identity.isError
      ? { _tag: "unknown" }
      : {
          _tag: "known",
          of: (choice) => agentLogin(identity.data.accounts, choice),
          none: noAgentLogin(identity.data.accounts),
        };

  return {
    projects,
    project,
    pickProject: (id) => lastProject.set(id),
    agent,
    pickAgent: (choice) => save({ ...defaults, harness: choice }),
    picker,
    pickModel: (model) =>
      save({ harness: agent, byHarness: byHarnessWith(agent, { model, effort: picker.effort }) }),
    pickEffort: (effort) =>
      save({ harness: agent, byHarness: byHarnessWith(agent, { model: picker.model, effort }) }),
    fast,
    setFast: (value) => setFastFor({ key: agent, value }),
    landing,
    setLand: (value) => setLandFor({ key: projectId, value }),
    target,
    pickTarget: (value) => setTargetFor({ key: projectId, value }),
    logins,
    saveFailed: saveDefaults.isError
      ? "Mend couldn't keep this choice for next time. It still applies to this session."
      : null,
    prompt,
    setPrompt,
    promptProblem: promptProblem(prompt),
    startFailed: run.isError
      ? `The session didn't start. ${run.error instanceof Error ? run.error.message : ""}`.trim()
      : null,
    starting: run.isPending,
    start: (text) => {
      if (project === undefined || run.isPending || promptProblem(text) !== null) return;
      run.reset();
      lastProject.set(project.id);
      run.mutate({
        projectId: project.id,
        target,
        spec: {
          agent,
          prompt: text,
          model: picker.model,
          effort: picker.effort,
          speed: fast ? "fast" : null,
          autoLand: landing === null ? null : landing._tag === "pick" ? landing.land : null,
        },
      });
    },
  };
}

/** The agents in the menu's order. */
export const COMPOSER_AGENTS: ReadonlyArray<Agent> = AGENTS.map((row) => row.id);
