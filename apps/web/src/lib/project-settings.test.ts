import { OrganizationId, ProjectId } from "@mend/domain";
import { MutationObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";

import type { ProjectDetailDto, ProjectDto } from "./api.ts";
import {
  isSettingChange,
  settingMutationKey,
  settingMutationOptions,
  visibleProject,
  type SettingChange,
} from "./project-settings.ts";

const deferred = <T>() => {
  const settlers: { resolve?: (value: T) => void; reject?: (reason: Error) => void } = {};
  const promise = new Promise<T>((resolve, reject) => {
    settlers.resolve = resolve;
    settlers.reject = reject;
  });
  return {
    promise,
    resolve: (value: T) => settlers.resolve?.(value),
    reject: (reason: Error) => settlers.reject?.(reason),
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const PROJECT_ID = "project-a";
const detailKey = (id: string) => ["projects", "detail", id];
const listKey = ["projects", "list"];

const base: ProjectDto = {
  id: ProjectId.make(PROJECT_ID),
  name: "mend",
  organizationId: OrganizationId.make("org-test"),
  visibility: "private",
  createdByUserId: null,
  scratchOwnerUserId: null,
  originUrl: "git@github.com:sealant-sh/mend.git",
  storePath: "/store/mend/repo.git",
  defaultBranch: "main",
  adoptedSha: null,
  autoTour: "inherit",
  autoSuggest: "inherit",
  autoName: "inherit",
  autoLand: "inherit",
  backgroundSessions: "inherit",
  gitAuthMode: "mend-key",
  workspaceImage: null,
  applyDotfiles: false,
  newWorktreesUseProjectResources: true,
  defaultShellProfile: true,
  inheritUserSkills: true,
  hotSessions: 0,
  installCommand: null,
  installEnabled: true,
  createdAt: new Date("2026-08-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
};

/** What the server holds; a test changes it, then answers a write with it. */
type Stored = {
  -readonly [K in keyof StoredFields]: StoredFields[K];
};
type StoredFields = Pick<
  ProjectDto,
  | "autoTour"
  | "autoSuggest"
  | "autoName"
  | "autoLand"
  | "backgroundSessions"
  | "hotSessions"
  | "visibility"
>;

const projectOf = (stored: Stored): ProjectDto => ({ ...base, ...stored });

let client: QueryClient | null = null;
afterEach(() => {
  client?.clear();
  client = null;
});

/** A query client with the project detail cached, and the setting mutation sending through `send`. */
const world = (
  send: (change: SettingChange, confirmed: ProjectDto | undefined) => Promise<ProjectDto>,
) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client = queryClient;
  const stored: Stored = {
    autoTour: base.autoTour,
    autoSuggest: base.autoSuggest,
    autoName: base.autoName,
    autoLand: base.autoLand,
    backgroundSessions: base.backgroundSessions,
    hotSessions: base.hotSessions,
    visibility: base.visibility,
  };
  const query = new QueryObserver(queryClient, {
    queryKey: detailKey(PROJECT_ID),
    queryFn: (): Promise<Pick<ProjectDetailDto, "project">> =>
      Promise.resolve({ project: projectOf(stored) }),
    staleTime: Infinity,
  });
  const unsubscribe = query.subscribe(() => undefined);
  const options = settingMutationOptions({ queryClient, detailKey, listKey, sendChange: send });
  const change = (next: SettingChange) =>
    new MutationObserver(queryClient, {
      ...options,
      mutationKey: [...settingMutationKey(PROJECT_ID), next.field],
    })
      .mutate(next)
      .catch(() => undefined);
  const pending = () =>
    queryClient
      .getMutationCache()
      .findAll({ mutationKey: settingMutationKey(PROJECT_ID), status: "pending" })
      .map((mutation) => mutation.state.variables)
      .filter(isSettingChange);
  const visible = () => {
    const detail = queryClient.getQueryData<{ project: ProjectDto }>(detailKey(PROJECT_ID));
    return detail === undefined ? undefined : visibleProject(detail.project, pending());
  };
  return { stored, change, visible, unsubscribe, queryClient };
};

describe("project settings saved at once", () => {
  it("rolls back only the change that failed while another one succeeds", async () => {
    const tour = deferred<ProjectDto>();
    const visibility = deferred<ProjectDto>();
    const { stored, change, visible, unsubscribe } = world((next) =>
      next.field === "autoTour" ? tour.promise : visibility.promise,
    );
    await settle();

    void change({ projectId: PROJECT_ID, field: "autoTour", value: "off" });
    void change({ projectId: PROJECT_ID, field: "visibility", value: "shared" });
    await settle();
    expect(visible()?.autoTour).toBe("off");
    expect(visible()?.visibility).toBe("shared");

    stored.visibility = "shared";
    visibility.resolve(projectOf(stored));
    await settle();
    tour.reject(new Error("refused"));
    await settle();
    await settle();

    expect(visible()?.autoTour).toBe("inherit");
    expect(visible()?.visibility).toBe("shared");
    unsubscribe();
  });

  it("sends changes to one setting in order, each from what the server last confirmed", async () => {
    const sent: Array<{ field: string; tour: string; suggest: string }> = [];
    const answers: Array<ReturnType<typeof deferred<ProjectDto>>> = [];
    const { stored, change, visible, unsubscribe } = world((next, confirmed) => {
      sent.push({
        field: next.field,
        tour: next.field === "autoTour" ? next.value : (confirmed?.autoTour ?? "?"),
        suggest: next.field === "autoSuggest" ? next.value : (confirmed?.autoSuggest ?? "?"),
      });
      const answer = deferred<ProjectDto>();
      answers.push(answer);
      return answer.promise;
    });
    await settle();

    void change({ projectId: PROJECT_ID, field: "autoTour", value: "off" });
    void change({ projectId: PROJECT_ID, field: "autoSuggest", value: "on" });
    await settle();
    // Both are automation, one request with every field: the second waits for the first.
    expect(sent).toHaveLength(1);

    stored.autoTour = "off";
    answers[0]?.resolve(projectOf(stored));
    await settle();
    await settle();
    expect(sent).toEqual([
      { field: "autoTour", tour: "off", suggest: "inherit" },
      { field: "autoSuggest", tour: "off", suggest: "on" },
    ]);
    expect(visible()?.autoSuggest).toBe("on");

    stored.autoSuggest = "on";
    answers[1]?.resolve(projectOf(stored));
    await settle();
    await settle();
    expect(visible()?.autoTour).toBe("off");
    expect(visible()?.autoSuggest).toBe("on");
    unsubscribe();
  });

  it("keeps a stepper's clicks in the order they were made", async () => {
    const sent: Array<number> = [];
    const answers: Array<ReturnType<typeof deferred<ProjectDto>>> = [];
    const { stored, change, visible, unsubscribe } = world((next) => {
      if (next.field === "hotSessions") sent.push(next.value);
      const answer = deferred<ProjectDto>();
      answers.push(answer);
      return answer.promise;
    });
    await settle();
    void change({ projectId: PROJECT_ID, field: "hotSessions", value: 1 });
    void change({ projectId: PROJECT_ID, field: "hotSessions", value: 2 });
    await settle();
    expect(visible()?.hotSessions).toBe(2);
    stored.hotSessions = 1;
    answers[0]?.resolve(projectOf(stored));
    await settle();
    await settle();
    stored.hotSessions = 2;
    answers[1]?.resolve(projectOf(stored));
    await settle();
    await settle();
    expect(sent).toEqual([1, 2]);
    expect(visible()?.hotSessions).toBe(2);
    unsubscribe();
  });
});
