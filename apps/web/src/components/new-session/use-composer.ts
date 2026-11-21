import type { EffortLevel, ModelPicker, PermissionMode } from "@mend/domain/workbench";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { adoptionProgressOptions, clonePercent, useAdoptionAttempt } from "#/lib/adoptions";
import { startSessionNow, type ProjectDto, queueSession, type SessionDefaultsDto } from "#/lib/api";
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
  launchFields,
} from "#/lib/new-session";
import { dismissRefusal, keepRefusal, refusedStart, useRefusedStart } from "#/lib/pending-starts";
import { signedInOptions } from "#/lib/sign-in";
import { composerStart, type StartCalls } from "#/lib/start-session";
import { useTRPC } from "#/lib/trpc";

import { usePageStart, useTabStart } from "./instant-start.ts";

/** The browser's server calls for a start. */
const BROWSER_CALLS: StartCalls = {
  start: startSessionNow,
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

/**
 * A project this browser started cloning, while its clone runs: the composer offers it, and a
 * session started in it is queued (`queuedSessions.queue`) and starts when the clone finishes.
 */
export interface Clone {
  /** The clone's key (`AdoptProject.adoptionId`), which the project picker lists it by. */
  readonly id: string;
  readonly name: string;
  /** How far git got, as a whole percent; null before it says. */
  readonly percent: number | null;
}

export interface Composer {
  readonly projects: ReadonlyArray<ProjectDto>;
  /** The project picked; undefined when no project exists yet, or the clone is picked. */
  readonly project: ProjectDto | undefined;
  /** The project this browser is cloning, while it clones. */
  readonly clone: Clone | null;
  /** The clone is picked: a start queues the session on it. */
  readonly onClone: boolean;
  /** A project's id, or the clone's. */
  readonly pickProject: (id: string) => void;
  readonly agent: Agent;
  readonly pickAgent: (agent: Agent) => void;
  readonly picker: ModelPicker;
  readonly pickModel: (model: string) => void;
  readonly pickEffort: (effort: EffortLevel | null) => void;
  readonly fast: boolean;
  readonly setFast: (fast: boolean) => void;
  /** The agent asks before it acts, instead of skipping its permission prompts. */
  readonly askFirst: boolean;
  readonly setAskFirst: (ask: boolean) => void;
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
  /** A start in this workspace's tab, while Mend makes the session: the tab shows it. */
  readonly startingIn: string | null;
  /** The last session queued on the clone, while the composer is left as it is. */
  readonly queuedOn: string | null;
  /** Send `text` as the session's first message; the field empties while it starts. */
  readonly start: (text: string) => void;
}

/** A composer fixed to one workspace: a New session tab in a session's sheet (ADR 0026). */
export interface ComposerPlace {
  readonly projectId: string;
  readonly worktree: { readonly id: string; readonly branch: string };
  /** The session exists and its agent is starting; the composer opens nothing itself. */
  readonly onStarted: (sessionId: string) => void;
}

/**
 * The New session composer's state: what is picked, what the person last used, whether the
 * picked agent can start, and the start itself. The page's two layouts (desktop and phone) both
 * draw this one state, so a pick in either shows in the other. With `place`, the session starts
 * in that worktree, and `place.onStarted` says what happens next instead of opening its page.
 */
export function useComposer(place?: ComposerPlace): Composer {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
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

  // The clone this browser started, while it runs and its project isn't listed yet.
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const attempt = useAdoptionAttempt(viewer.userId);
  const progressRead = useQuery({
    ...adoptionProgressOptions(trpc, attempt?.id ?? ""),
    enabled: attempt !== null,
  });
  const progress = progressRead.isPending || progressRead.isError ? null : progressRead.data;
  const adoptedId = progress?.state === "adopted" ? progress.projectId : null;
  // The clone finished: its project is listed from now on. Reading the list again is the server
  // state catching up, so it runs as the clone's end is seen.
  useEffect(() => {
    if (adoptedId !== null)
      void queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() });
  }, [adoptedId, queryClient, trpc]);
  const clone: Clone | null =
    attempt === null ||
    progressRead.isError ||
    (progress !== null && progress.state !== "running") ||
    projects.some((row) => row.id === progress?.projectId)
      ? null
      : { id: attempt.id, name: attempt.name, percent: clonePercent(progress) };
  const [cloneFor, setCloneFor] = useState<string | null>(null);
  const lastId = lastProject.use();
  // The clone is picked when chosen here, when it is the only project there is (the first run),
  // or when the page that opened the composer named it (the cloning project's page).
  const cloneChosen = cloneFor ?? (lastId === attempt?.id ? lastId : null);
  const onClone =
    place === undefined && clone !== null && (cloneChosen === clone.id || projects.length === 0);
  // Once the picked clone's project is listed, the composer moves onto it.
  const project = onClone
    ? undefined
    : place !== undefined
      ? projects.find((row) => row.id === place.projectId)
      : startingProject(
          projects,
          cloneChosen !== null && cloneChosen === attempt?.id && adoptedId !== null
            ? adoptedId
            : lastId,
        );
  const agent = startingAgent(defaults);
  const picker = pickerFor(catalogs, defaults, agent);

  const [fastFor, setFastFor] = useState<KeptFor<Agent, boolean> | null>(null);
  const [askFor, setAskFor] = useState<KeptFor<Agent, boolean> | null>(null);
  const [landFor, setLandFor] = useState<KeptFor<string, boolean> | null>(null);
  const [targetFor, setTargetFor] = useState<KeptFor<string, WorktreeTarget> | null>(null);
  // A start Mend refused comes back here: its words in the field, Mend's reason under it.
  const refused = useRefusedStart();
  const [prompt, setPrompt] = useState(() =>
    place === undefined ? (refusedStart()?.prompt ?? "") : "",
  );
  // A refusal that lands while this composer is open (Mend answered before the start's page
  // showed) puts its words back too, once.
  const [tookBack, setTookBack] = useState(() => refusedStart()?.draftId ?? null);
  if (place === undefined && refused !== null && refused.draftId !== tookBack) {
    setTookBack(refused.draftId);
    setPrompt(refused.prompt);
  }

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

  const pageStart = usePageStart();
  const tabStart = useTabStart();
  // A start in a workspace's tab: the tab shows it until Mend has made the session; a refusal
  // puts the words back here, with Mend's reason.
  const [startingIn, setStartingIn] = useState<string | null>(null);
  const [refusedHere, setRefusedHere] = useState<string | null>(null);

  const [queuedOn, setQueuedOn] = useState<string | null>(null);
  const queue = useMutation({
    mutationFn: queueSession,
    onSuccess: () => {
      setQueuedOn(clone?.name ?? "the project");
      void queryClient.invalidateQueries({ queryKey: trpc.queuedSessions.list.queryKey() });
    },
    onError: (_error, request) => setPrompt(request.launch.prompt ?? ""),
  });

  const projectId = onClone ? (clone?.id ?? "") : (project?.id ?? "");
  // A project still cloning sets no policy of its own: the choice starts from the automation.
  const landingOf = onClone ? { autoLand: "inherit" as const } : project;
  const landing =
    landingOf === undefined || automation.isPending || automation.isError
      ? null
      : landingChoice(landingOf, automation.data.effective.autoLand, keptFor(landFor, projectId));
  const fast = picker.fastCapable && keptFor(fastFor, agent) === true;
  const askFirst = keptFor(askFor, agent) === true;
  const permission: PermissionMode | null = askFirst ? "ask" : null;
  const target: WorktreeTarget = onClone
    ? { _tag: "new" }
    : place !== undefined
      ? { _tag: "existing", ...place.worktree }
      : (keptFor(targetFor, projectId) ?? { _tag: "new" });

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
    clone,
    onClone,
    pickProject: (id) => {
      setQueuedOn(null);
      if (clone !== null && id === clone.id) {
        setCloneFor(id);
        return;
      }
      setCloneFor(null);
      lastProject.set(id);
    },
    agent,
    pickAgent: (choice) => save({ ...defaults, harness: choice }),
    picker,
    pickModel: (model) =>
      save({ harness: agent, byHarness: byHarnessWith(agent, { model, effort: picker.effort }) }),
    pickEffort: (effort) =>
      save({ harness: agent, byHarness: byHarnessWith(agent, { model: picker.model, effort }) }),
    fast,
    setFast: (value) => setFastFor({ key: agent, value }),
    askFirst,
    setAskFirst: (value) => setAskFor({ key: agent, value }),
    landing,
    setLand: (value) => setLandFor({ key: projectId, value }),
    target,
    pickTarget: (value) => setTargetFor({ key: projectId, value }),
    logins,
    saveFailed: saveDefaults.isError
      ? "Mend couldn't keep this choice for next time. It still applies to this session."
      : null,
    prompt,
    setPrompt: (value) => {
      setPrompt(value);
      if (value !== "") setQueuedOn(null);
    },
    promptProblem: promptProblem(prompt),
    startFailed: queue.isError
      ? `The session didn't start. ${messageOf(queue.error)}`.trim()
      : place === undefined
        ? (refused?.words ?? null)
        : refusedHere,
    starting: queue.isPending,
    startingIn,
    queuedOn,
    start: (text) => {
      if (queue.isPending || startingIn !== null || promptProblem(text) !== null) return;
      const autoLand = landing === null ? null : landing._tag === "pick" ? landing.land : null;
      const spec: StartSpec = {
        agent,
        prompt: text,
        model: picker.model,
        effort: picker.effort,
        speed: fast ? "fast" : null,
        permission,
        autoLand,
      };
      if (onClone && clone !== null) {
        queue.reset();
        queue.mutate({
          id: crypto.randomUUID(),
          adoptionId: clone.id,
          harness: agent,
          autoLand,
          launch: launchFields(spec),
        });
        return;
      }
      if (project === undefined) return;
      queue.reset();
      const request = {
        ...composerStart(BROWSER_CALLS, project.id, target, spec),
        project: { id: project.id, name: project.name },
      };
      if (place !== undefined) {
        setRefusedHere(null);
        tabStart(request, {
          show: setStartingIn,
          settle: (sessionId) => {
            setStartingIn(null);
            place.onStarted(sessionId);
          },
          refuse: (refusal) => {
            setStartingIn(null);
            setPrompt(refusal.prompt);
            setRefusedHere(refusal.words);
          },
        });
        return;
      }
      lastProject.set(project.id);
      dismissRefusal();
      // The session's page opens now, with the message; Mend makes the session meanwhile.
      pageStart(request, keepRefusal);
    },
  };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "");

/** The agents in the menu's order. */
export const COMPOSER_AGENTS: ReadonlyArray<Agent> = AGENTS.map((row) => row.id);
