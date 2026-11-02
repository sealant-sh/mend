import { ProjectId } from "@mend/domain";
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type MutateOptions,
  type MutationKey,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";

import type { InheritSource, InheritValue } from "#/components/kit/inherit-choice";

import {
  setNewWorktreesUseProjectResources,
  setProjectApplyDotfiles,
  setProjectAutomation,
  setProjectDefaultShellProfile,
  setProjectGitAuth,
  setProjectHotSessions,
  setProjectInheritUserSkills,
  setProjectInstallCommand,
  setProjectInstallEnabled,
  setProjectVisibility,
  type AutomationChoiceDto,
  type ProjectDetailDto,
  type ProjectDto,
} from "./api.ts";
import { useTRPC } from "./trpc.ts";

/** The project's Inherit · On · Off settings, all saved by one request. */
export type AutomationKey =
  | "autoTour"
  | "autoSuggest"
  | "autoName"
  | "autoLand"
  | "backgroundSessions";

const AUTOMATION_KEYS: ReadonlyArray<AutomationKey> = [
  "autoTour",
  "autoSuggest",
  "autoName",
  "autoLand",
  "backgroundSessions",
];

/** Every project setting a page saves the moment it changes, with the values it takes. */
export type SettingField =
  | AutomationKey
  | "visibility"
  | "newWorktreesUseProjectResources"
  | "applyDotfiles"
  | "defaultShellProfile"
  | "inheritUserSkills"
  | "installEnabled"
  | "installCommand"
  | "hotSessions"
  | "gitAuthMode";

/** One change on its way: which project, which setting, and the value it asks for. */
export type SettingChange = {
  readonly [K in SettingField]: {
    readonly projectId: string;
    readonly field: K;
    readonly value: ProjectDto[K];
  };
}[SettingField];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isOneOf = <T extends string>(choices: ReadonlyArray<T>, value: unknown): value is T =>
  choices.some((choice) => choice === value);

const AUTOMATION_CHOICES: ReadonlyArray<AutomationChoiceDto> = ["inherit", "on", "off"];
const BOOLEAN_FIELDS = [
  "newWorktreesUseProjectResources",
  "applyDotfiles",
  "defaultShellProfile",
  "inheritUserSkills",
  "installEnabled",
] as const;

/** Narrows a mutation's stored variables back to a setting change. */
export const isSettingChange = (value: unknown): value is SettingChange => {
  if (!isRecord(value) || typeof value["projectId"] !== "string") return false;
  const { field, value: next } = value;
  if (isOneOf(AUTOMATION_KEYS, field)) return isOneOf(AUTOMATION_CHOICES, next);
  if (isOneOf(BOOLEAN_FIELDS, field)) return typeof next === "boolean";
  switch (field) {
    case "visibility":
      return next === "private" || next === "shared";
    case "installCommand":
      return next === null || typeof next === "string";
    case "hotSessions":
      return typeof next === "number";
    case "gitAuthMode":
      return next === "mend-key" || next === "bridge";
    default:
      return false;
  }
};

const withChange = (project: ProjectDto, change: SettingChange): ProjectDto => {
  switch (change.field) {
    case "visibility":
      return { ...project, visibility: change.value };
    case "gitAuthMode":
      return { ...project, gitAuthMode: change.value };
    case "installCommand":
      return { ...project, installCommand: change.value };
    case "hotSessions":
      return { ...project, hotSessions: change.value };
    case "newWorktreesUseProjectResources":
      return { ...project, newWorktreesUseProjectResources: change.value };
    case "applyDotfiles":
      return { ...project, applyDotfiles: change.value };
    case "defaultShellProfile":
      return { ...project, defaultShellProfile: change.value };
    case "inheritUserSkills":
      return { ...project, inheritUserSkills: change.value };
    case "installEnabled":
      return { ...project, installEnabled: change.value };
    case "autoTour":
      return { ...project, autoTour: change.value };
    case "autoSuggest":
      return { ...project, autoSuggest: change.value };
    case "autoName":
      return { ...project, autoName: change.value };
    case "autoLand":
      return { ...project, autoLand: change.value };
    case "backgroundSessions":
      return { ...project, backgroundSessions: change.value };
  }
};

/**
 * The project as the person sees it: the server's, with every change still on its way laid over
 * its own setting, the latest one winning. A change the server refuses stops being pending, so
 * only that setting falls back to the server's value; a refetch that lands meanwhile cannot erase
 * a change that is still on its way.
 */
export const visibleProject = (
  server: ProjectDto,
  pending: ReadonlyArray<SettingChange>,
): ProjectDto =>
  pending
    .filter((change) => change.projectId === server.id)
    .reduce((project, change) => withChange(project, change), server);

/** Sends one change. Automation sends every automation field: the server's, with this one set. */
const send = (change: SettingChange, confirmed: ProjectDto | undefined): Promise<ProjectDto> => {
  const id = change.projectId;
  switch (change.field) {
    case "visibility":
      return setProjectVisibility(ProjectId.make(id), change.value);
    case "gitAuthMode":
      return setProjectGitAuth(id, change.value);
    case "installCommand":
      return setProjectInstallCommand(id, change.value);
    case "hotSessions":
      return setProjectHotSessions(id, change.value);
    case "newWorktreesUseProjectResources":
      return setNewWorktreesUseProjectResources(ProjectId.make(id), change.value);
    case "applyDotfiles":
      return setProjectApplyDotfiles(id, change.value);
    case "defaultShellProfile":
      return setProjectDefaultShellProfile(id, change.value);
    case "inheritUserSkills":
      return setProjectInheritUserSkills(id, change.value);
    case "installEnabled":
      return setProjectInstallEnabled(id, change.value);
    case "autoTour":
    case "autoSuggest":
    case "autoName":
    case "autoLand":
    case "backgroundSessions": {
      if (confirmed === undefined)
        return Promise.reject(new Error("the project is not loaded; read it again and retry"));
      return setProjectAutomation(id, {
        autoTour: confirmed.autoTour,
        autoSuggest: confirmed.autoSuggest,
        autoName: confirmed.autoName,
        backgroundSessions: confirmed.backgroundSessions,
        autoLand: confirmed.autoLand,
        [change.field]: change.value,
      });
    }
  }
};

/** Writes that must leave one after another: one setting, or all automation, of one project. */
const chainKey = (change: SettingChange) =>
  `${change.projectId}:${isOneOf(AUTOMATION_KEYS, change.field) ? "automation" : change.field}`;

// Per query client: the last write sent on each chain, so writes to one setting leave in order.
const chainsOf = new WeakMap<QueryClient, Map<string, Promise<unknown>>>();

/**
 * Sends `leave` once every earlier write on the same chain has settled, whatever its outcome, and
 * stores its answer with `store` before the next write on the chain leaves.
 */
const sendInTurn = <A>(
  queryClient: QueryClient,
  key: string,
  leave: () => Promise<A>,
  store: (answer: A) => void,
): Promise<A> => {
  const chains = chainsOf.get(queryClient) ?? new Map<string, Promise<unknown>>();
  chainsOf.set(queryClient, chains);
  const go = () =>
    leave().then((answer) => {
      store(answer);
      return answer;
    });
  const before = chains.get(key) ?? Promise.resolve();
  const sent = before.then(go, go);
  chains.set(key, sent);
  const forget = () => {
    if (chains.get(key) === sent) chains.delete(key);
  };
  sent.then(forget, forget);
  return sent;
};

/**
 * A project list saved one item at a time (folders, references), apart from React so its ordering
 * can be tested. Each change leaves after the earlier ones and is applied, when it leaves, to the
 * list the server last confirmed; the server's list then replaces the cached one. The list is read
 * again once nothing else on it is on its way.
 */
export const listChangeOptions = <C extends { readonly projectId: string }, L>({
  queryClient,
  listKey,
  mutationKey,
  send: sendList,
}: {
  readonly queryClient: QueryClient;
  readonly listKey: (projectId: string) => QueryKey;
  readonly mutationKey: (projectId: string) => MutationKey;
  readonly send: (change: C, confirmed: L | undefined) => Promise<L>;
}) => ({
  mutationFn: (change: C): Promise<L> =>
    sendInTurn(
      queryClient,
      mutationKey(change.projectId).map(String).join(":"),
      () => sendList(change, queryClient.getQueryData<L>(listKey(change.projectId))),
      (saved) => queryClient.setQueryData<L>(listKey(change.projectId), saved),
    ),
  onMutate: async (change: C) => {
    await queryClient.cancelQueries({ queryKey: listKey(change.projectId) });
  },
  // This mutation still counts as in flight while it settles.
  onSettled: (_saved: L | undefined, _error: Error | null, change: C) =>
    queryClient.isMutating({ mutationKey: mutationKey(change.projectId) }) <= 1
      ? queryClient.invalidateQueries({ queryKey: listKey(change.projectId) })
      : undefined,
});

/** The key every setting change shares, for one project. */
export const settingMutationKey = (projectId: string): MutationKey => [
  "project-setting",
  projectId,
];

/**
 * The setting mutation, apart from React so its ordering can be tested. Writes to one setting
 * (and all automation writes of a project) go one after another, each built when it leaves from
 * the project the server last confirmed: each answer replaces the cached project before the next
 * write leaves. The detail is read again once nothing else for that project is on its way.
 */
export const settingMutationOptions = ({
  queryClient,
  detailKey,
  listKey,
  sendChange = send,
}: {
  readonly queryClient: QueryClient;
  readonly detailKey: (projectId: string) => QueryKey;
  readonly listKey: QueryKey;
  readonly sendChange?: (
    change: SettingChange,
    confirmed: ProjectDto | undefined,
  ) => Promise<ProjectDto>;
}) => {
  const confirmedProject = (projectId: string) =>
    queryClient.getQueryData<ProjectDetailDto>(detailKey(projectId))?.project;
  return {
    // The server's answer is stored before the next write on the chain leaves, so that write
    // builds on it.
    mutationFn: (change: SettingChange): Promise<ProjectDto> =>
      sendInTurn(
        queryClient,
        chainKey(change),
        () => sendChange(change, confirmedProject(change.projectId)),
        (saved) =>
          queryClient.setQueryData<ProjectDetailDto>(detailKey(change.projectId), (current) =>
            current === undefined ? current : { ...current, project: saved },
          ),
      ),
    onMutate: async (change: SettingChange) => {
      await queryClient.cancelQueries({ queryKey: detailKey(change.projectId) });
    },
    // This mutation still counts as in flight while it settles.
    onSettled: (_saved: ProjectDto | undefined, _error: Error | null, change: SettingChange) =>
      queryClient.isMutating({ mutationKey: settingMutationKey(change.projectId) }) <= 1
        ? Promise.all([
            queryClient.invalidateQueries({ queryKey: detailKey(change.projectId) }),
            queryClient.invalidateQueries({ queryKey: listKey }),
          ])
        : undefined,
  };
};

/** Every setting change still on its way, for every project. */
const usePendingChanges = (): ReadonlyArray<SettingChange> =>
  useMutationState({
    filters: { mutationKey: ["project-setting"], status: "pending" },
    select: (mutation) => mutation.state.variables,
  }).filter(isSettingChange);

/** The project detail with the setting changes still on their way laid over it. */
export const useVisibleDetail = (detail: ProjectDetailDto): ProjectDetailDto => {
  const pending = usePendingChanges();
  const project = visibleProject(detail.project, pending);
  return project === detail.project ? detail : { ...detail, project };
};

/**
 * One project setting, saved the moment it changes: the page shows the new value at once
 * (`useVisibleDetail`), a refusal puts back that setting alone and leaves its error here, and
 * changes to the same setting leave in the order they were made. The project id travels with
 * each change, so a page that moved to another project never writes into it.
 *
 * ```ts
 * const visibility = useProjectSetting(project.id, "visibility");
 * visibility.mutate("shared");
 * ```
 */
export function useProjectSetting<K extends SettingField>(
  projectId: string,
  field: K,
  { onSaved }: { readonly onSaved?: () => Promise<unknown> } = {},
) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    ...settingMutationOptions({
      queryClient,
      detailKey: (id) => trpc.projects.detail.queryKey({ id }),
      listKey: trpc.projects.list.queryKey(),
    }),
    mutationKey: [...settingMutationKey(projectId), field],
    onSuccess: () => onSaved?.(),
  });
  return {
    ...mutation,
    mutate: (value: ProjectDto[K], options?: MutateOptions<ProjectDto, Error, SettingChange>) =>
      mutation.mutate(changeOf(projectId, field, value), options),
  };
}

/** Builds the change for one field; the cast-free way to pair a field with its value type. */
const changeOf = <K extends SettingField>(
  projectId: string,
  field: K,
  value: ProjectDto[K],
): SettingChange => {
  const change: unknown = { projectId, field, value };
  if (!isSettingChange(change)) throw new Error(`not a value ${field} takes`);
  return change;
};

/** One automation choice, saved like any other setting. */
export const useAutomationSetting = (projectId: string, key: AutomationKey) =>
  useProjectSetting(projectId, key);

/** What Inherit resolves to for one setting, in its own words, and who set that. */
export interface InheritedValue {
  readonly resolved: string;
  readonly source: InheritSource;
  /** The organization set it, so the source can link to its defaults. */
  readonly fromOrganization: boolean;
}

/**
 * Where a project on Inherit gets each automation setting (docs/adr/0003): the organization's
 * default when it set one, else the instance default its operator set. Undefined while the
 * organization's settings are read; null when they cannot be read, so the page says so instead
 * of guessing.
 */
export function useInheritedAutomation(): {
  readonly of: (key: AutomationKey, projectName: string) => InheritedValue | undefined;
  readonly failed: boolean;
} {
  const trpc = useTRPC();
  const view = useQuery(trpc.organization.settings.queryOptions(undefined, { retry: false }));
  const organization = useQuery(
    trpc.organization.current.queryOptions(undefined, { retry: false, staleTime: 60_000 }),
  ).data;
  const name = organization?.organization.name ?? "your organization";
  return {
    failed: view.isError,
    of: (key, projectName) => {
      const settings = view.data;
      if (settings === undefined) return undefined;
      const own = settings.organization[key];
      const resolved = settings.effective[key] ? "on" : "off";
      return own === null
        ? {
            resolved,
            fromOrganization: false,
            source: {
              title: "From the instance default",
              detail: `Set by this machine's operator for every organization. Pick On or Off to set it for ${projectName} only.`,
            },
          }
        : {
            resolved,
            fromOrganization: true,
            source: {
              title: `From ${name}'s organization defaults`,
              detail: `${resolved === "on" ? "On" : "Off"} for every project in ${name}. Pick On or Off to set it for ${projectName} only.`,
            },
          };
    },
  };
}

/** `inherit | on | off` is the same three words on both sides; this keeps the types honest. */
export const inheritValue = (choice: AutomationChoiceDto): InheritValue => choice;
