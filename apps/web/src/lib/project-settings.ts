import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { InheritSource, InheritValue } from "#/components/kit/inherit-choice";

import { setProjectAutomation, type AutomationChoiceDto, type ProjectDto } from "./api.ts";
import { useTRPC } from "./trpc.ts";

/**
 * A project setting saved with the page already showing it: the project detail in the cache takes
 * the new value at once, a refusal puts the old one back, and the detail is read again either
 * way, so the page ends on what the server holds. Every tab reads the same cached detail, so the
 * tab line and the other tabs move with it.
 *
 * ```ts
 * const visibility = useProjectSetting(project.id, {
 *   save: (value: ProjectDto["visibility"]) => setProjectVisibility(project.id, value),
 *   apply: (project, value) => ({ ...project, visibility: value }),
 * });
 * visibility.mutate("shared");
 * ```
 */
export function useProjectSetting<V>(
  projectId: ProjectDto["id"],
  {
    save,
    apply,
  }: {
    readonly save: (value: V) => Promise<unknown>;
    readonly apply: (project: ProjectDto, value: V) => ProjectDto;
  },
) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const detailKey = trpc.projects.detail.queryKey({ id: projectId });
  return useMutation({
    mutationFn: save,
    onMutate: async (value: V) => {
      await queryClient.cancelQueries({ queryKey: detailKey });
      const previous = queryClient.getQueryData(detailKey);
      if (previous !== undefined)
        queryClient.setQueryData(detailKey, {
          ...previous,
          project: apply(previous.project, value),
        });
      return { previous };
    },
    onError: (_error, _value, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(detailKey, context.previous);
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: detailKey }),
        queryClient.invalidateQueries(trpc.projects.list.queryFilter()),
      ]),
  });
}

/** The project's Inherit · On · Off settings, all saved by one request. */
export type AutomationKey =
  | "autoTour"
  | "autoSuggest"
  | "autoName"
  | "autoLand"
  | "backgroundSessions";

/** One automation choice, saved optimistically with the others as they stand. */
export function useAutomationSetting(project: ProjectDto, key: AutomationKey) {
  return useProjectSetting(project.id, {
    save: (value: AutomationChoiceDto) =>
      setProjectAutomation(project.id, {
        autoTour: project.autoTour,
        autoSuggest: project.autoSuggest,
        autoName: project.autoName,
        backgroundSessions: project.backgroundSessions,
        autoLand: project.autoLand,
        [key]: value,
      }),
    apply: (current, value) => ({ ...current, [key]: value }),
  });
}

/** What Inherit resolves to for one setting, in its own words, and who set that. */
export interface InheritedValue {
  readonly resolved: string;
  readonly source: InheritSource;
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
            source: {
              title: "From the instance default",
              detail: `Set by this machine's operator for every organization. Pick On or Off to set it for ${projectName} only.`,
            },
          }
        : {
            resolved,
            source: {
              title: `From ${name}'s organization defaults`,
              detail: `${resolved === "on" ? "On" : "Off"} for every project in ${name}. Pick On or Off to set it for ${projectName} only.`,
              link: "Settings › Organization › Defaults",
            },
          };
    },
  };
}

/** `inherit | on | off` is the same three words on both sides; this keeps the types honest. */
export const inheritValue = (choice: AutomationChoiceDto): InheritValue => choice;
