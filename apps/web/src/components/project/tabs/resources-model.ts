import type { WorktreeId } from "@mend/domain";
import {
  choicesFor,
  resourceControls,
  resourceListEntries,
  type ResourceDefinition,
  type ResourceInstanceKind,
  type WorktreeChoice,
} from "@mend/domain/workbench";

import type { Tone } from "#/components/kit/status";
import { choiceInUse, type ResourcesPageView, type ResourceSettingView } from "#/lib/resources";

/**
 * The Resources tab's model (ADR 0019): one panel per resource name, a project resource's
 * worktrees and how each uses it, a worktree resource's instances. Every word the panels show
 * that describes an instance is the server's status line; this file only arranges them.
 */

/** A worktree the tab reads for, and that read once it arrived. */
export interface WorktreeRead {
  readonly id: WorktreeId;
  readonly name: string;
  readonly page: ResourcesPageView | undefined;
  readonly failed: string | null;
}

/** One worktree's row on a resource's panel. */
export interface WorktreeRow {
  readonly worktreeId: WorktreeId;
  readonly name: string;
  /** The entry the worktree's own read gives for this resource; undefined while it is read. */
  readonly use: ResourceSettingView | undefined;
  /** The choice in effect for the worktree, and whether it stored one. */
  readonly choice: WorktreeChoice;
  /** The worktree's own instance, when it runs this resource at the worktree level. */
  readonly own: ResourceSettingView | undefined;
  readonly failed: string | null;
}

export interface ResourcePanelModel {
  readonly name: string;
  readonly spec: ResourceDefinition;
  /** `postgres:17 · project resource` and so on. */
  readonly kindLine: string;
  /** The definition on the default branch, when it has one. */
  readonly declared: boolean;
  /** The project-level instance, when one was started. */
  readonly project: ResourceSettingView | undefined;
  /** Worktree-level instances, each in its worktree. */
  readonly worktreeInstances: ReadonlyArray<ResourceSettingView>;
  /** The server's line for the panel's header: the project instance's, else the definition's. */
  readonly statusLine: string;
  readonly tone: Tone | null;
  /** Worktrees choose how they use it once a project instance exists. */
  readonly choosing: boolean;
  readonly rows: ReadonlyArray<WorktreeRow>;
}

/** A dot for what Sealant last observed of an instance, never a verdict. */
export const toneOf = (kind: ResourceInstanceKind | "off"): Tone | null => {
  switch (kind) {
    case "running":
      return "ok";
    case "starting":
      return "run";
    case "failed":
      return "bad";
    case "exited":
    case "not-observed":
    case "unsupported":
      return "wait";
    case "not-started":
    case "stopped":
    case "off":
      return "off";
    case "none":
      return null;
  }
};

/** The panel names the resource, so its lines drop their leading `@name · `. */
export const withoutName = (line: string, name: string): string =>
  line.startsWith(`@${name} · `) ? line.slice(name.length + 4) : line;

/** `postgres 17`, `redis 8` or the image as declared. */
export const engineWords = (spec: ResourceDefinition): string =>
  spec.preset === null ? spec.image : `${spec.preset} ${spec.image.split(":").at(1) ?? ""}`.trim();

/** Postgres says databases; any other resource says whose instance a worktree uses. */
export const choiceLabel = (spec: ResourceDefinition, choice: WorktreeChoice): string => {
  if (choice === "off") return "Off";
  if (spec.preset === "postgres") return choice === "project" ? "Shared" : "Own";
  return choice === "project" ? "Project" : "Worktree";
};

export const choiceOptions = (spec: ResourceDefinition) =>
  choicesFor(spec).map((choice) => ({ value: choice, label: choiceLabel(spec, choice) }));

/** What the panel's line under the header says the levels mean. */
export const levelLine = (model: Pick<ResourcePanelModel, "spec" | "project" | "choosing">) => {
  if (model.choosing)
    return model.spec.preset === "postgres"
      ? "Each worktree uses the shared database, its own database, or none."
      : "Each worktree uses the project's instance, its own instance, or none.";
  return "One instance per worktree that starts one.";
};

const levelWords = (project: boolean, worktrees: number, declared: boolean): string => {
  if (project && worktrees > 0) return "project resource and worktree resources";
  if (project) return "project resource";
  if (worktrees > 0) return "worktree resource";
  return declared ? "declared on the default branch" : "remembered";
};

/** The instance a worktree's own read reaches for a resource, preferring its own. */
const useOf = (page: ResourcesPageView | undefined, name: string, worktreeId: WorktreeId) => {
  const entries = page?.settings.filter((entry) => entry.spec.name === name) ?? [];
  return (
    entries.find((entry) => entry.worktreeId === worktreeId) ??
    entries.find((entry) => entry.worktreeId === null)
  );
};

/** The project's resources, panel by panel, from the project read and each worktree's read. */
export const resourcePanels = (
  project: ResourcesPageView,
  worktrees: ReadonlyArray<WorktreeRead>,
): ReadonlyArray<ResourcePanelModel> =>
  resourceListEntries(project).flatMap((entry): ReadonlyArray<ResourcePanelModel> => {
    const spec = entry.definition?.spec ?? entry.instances[0]?.spec;
    if (spec === undefined) return [];
    const projectInstance = entry.instances.find((row) => row.worktreeId === null);
    const worktreeInstances = entry.instances.filter((row) => row.worktreeId !== null);
    const choosing = projectInstance !== undefined;
    const rows = worktrees
      .map((worktree): WorktreeRow => {
        const use = useOf(worktree.page, entry.name, worktree.id);
        return {
          worktreeId: worktree.id,
          name: worktree.name,
          use,
          choice: use === undefined ? "project" : choiceInUse(use).choice,
          own: worktreeInstances.find((row) => row.worktreeId === worktree.id),
          failed: worktree.failed,
        };
      })
      .filter((row) => choosing || row.own !== undefined);
    const running = worktreeInstances.filter((row) => row.instance === "running").length;
    return [
      {
        name: entry.name,
        spec,
        kindLine: `${engineWords(spec)} · ${levelWords(choosing, worktreeInstances.length, entry.definition !== null)}`,
        declared: entry.definition !== null,
        project: projectInstance,
        worktreeInstances,
        statusLine:
          projectInstance !== undefined
            ? withoutName(projectInstance.statusLine, entry.name)
            : worktreeInstances.length > 0
              ? `${running} running · observed`
              : withoutName(entry.statusLine, entry.name),
        tone:
          projectInstance !== undefined
            ? toneOf(projectInstance.instance)
            : worktreeInstances.length > 0
              ? running > 0
                ? "ok"
                : "off"
              : "off",
        choosing,
        rows,
      },
    ];
  });

/** Whether Stop does something for an instance as last observed. */
export const canStop = (entry: ResourceSettingView | undefined): boolean =>
  entry !== undefined && resourceControls(entry.instance).stop;

/** Whether Start does something; a definition never started can always be started. */
export const canStart = (entry: ResourceSettingView | undefined): boolean =>
  entry === undefined || resourceControls(entry.instance).start;

/**
 * Resources a worktree's `.mend/mend.toml` declares that the default branch does not and nobody
 * started: `mend.toml in t3/settings-tabs declares @search`.
 */
export const worktreeDeclarations = (
  project: ResourcesPageView,
  worktrees: ReadonlyArray<WorktreeRead>,
): ReadonlyArray<{
  readonly worktreeId: WorktreeId;
  readonly worktree: string;
  readonly spec: ResourceDefinition;
}> => {
  const known = new Set(resourceListEntries(project).map((entry) => entry.name));
  const seen = new Set<string>();
  return worktrees.flatMap((worktree) => {
    const file = worktree.page?.file;
    if (file?.kind !== "read") return [];
    return file.tables.flatMap((table) => {
      if (known.has(table.spec.name) || seen.has(table.spec.name)) return [];
      seen.add(table.spec.name);
      return [{ worktreeId: worktree.id, worktree: worktree.name, spec: table.spec }];
    });
  });
};
