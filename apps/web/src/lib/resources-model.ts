import type { WorktreeId } from "@mend/domain";
import {
  choicesFor,
  resourceControls,
  resourceListEntries,
  type ResourceDefinition,
  type ResourceInstanceKind,
  type WorktreeChoice,
} from "@mend/domain/workbench";
import type { StatusTone } from "@mend/ui/components/status";

import { choiceInUse, type ResourcesPageView, type ResourceSettingView } from "./resources.ts";

/**
 * The Resources tab's model (ADR 0019): one panel per resource name, a project resource's
 * worktrees and how each uses it, a worktree resource's instances. What an instance is doing comes
 * from the server: its observed kind gives the one word the panel shows, and its status line stays
 * on hover; this file only arranges them and words the choices.
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
  /** `postgres 17 · project resource` and so on. */
  readonly kindLine: string;
  /** The definition on the default branch, when it has one. */
  readonly declared: boolean;
  /** The project-level instance, when one was started. */
  readonly project: ResourceSettingView | undefined;
  /** Worktree-level instances, each in its worktree. */
  readonly worktreeInstances: ReadonlyArray<ResourceSettingView>;
  /** The server's line for the panel's header: the project instance's, else the definition's. */
  readonly statusLine: string;
  readonly tone: StatusTone | null;
  /** Worktrees choose how they use it once a project instance exists. */
  readonly choosing: boolean;
  readonly rows: ReadonlyArray<WorktreeRow>;
}

/** The tone of what Sealant last observed of an instance: a word's colour, never a verdict. */
export const toneOf = (kind: ResourceInstanceKind | "off"): StatusTone | null => {
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
    case "not-started":
    case "stopped":
    case "off":
      return "idle";
    case "none":
      return null;
  }
};

/** The one word for what was observed of an instance, as the panel's header shows it. */
export const stateWord = (kind: ResourceInstanceKind): string => {
  switch (kind) {
    case "running":
      return "Running";
    case "starting":
      return "Starting";
    case "stopped":
      return "Stopped";
    case "exited":
      return "Exited";
    case "failed":
      return "Failed";
    case "not-started":
    case "none":
      return "Not started";
    case "unsupported":
      return "Not on Docker";
    case "not-observed":
      return "Not observed";
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

/** The line under a panel's header: what the levels mean for this resource. */
export const levelLine = (
  model: Pick<ResourcePanelModel, "name" | "spec" | "choosing">,
): string => {
  if (model.choosing)
    return model.spec.preset === "postgres"
      ? "Each worktree uses the shared database, a database of its own, or none."
      : `Every worktree uses the project's @${model.name} unless it picks its own or none.`;
  return "One instance per worktree that starts one.";
};

const levelWords = (project: boolean, worktrees: number, declaredOn: string | null): string => {
  if (project && worktrees > 0) return "project resource and worktree resources";
  if (project) return "project resource";
  if (worktrees > 0) return "worktree resource";
  return declaredOn === null ? "remembered" : `declared on ${declaredOn}`;
};

/** The instance a worktree's own read reaches for a resource, preferring its own. */
const useOf = (page: ResourcesPageView | undefined, name: string, worktreeId: WorktreeId) => {
  const entries = page?.settings.filter((entry) => entry.spec.name === name) ?? [];
  return (
    entries.find((entry) => entry.worktreeId === worktreeId) ??
    entries.find((entry) => entry.worktreeId === null)
  );
};

/**
 * The project's resources, panel by panel, from the project read and each worktree's read.
 * `defaultBranch` names where an unstarted definition is declared.
 */
export const resourcePanels = (
  project: ResourcesPageView,
  worktrees: ReadonlyArray<WorktreeRead>,
  defaultBranch = "the default branch",
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
        kindLine: `${engineWords(spec)} · ${levelWords(
          choosing,
          worktreeInstances.length,
          entry.definition === null ? null : defaultBranch,
        )}`,
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
                : "idle"
              : "idle",
        choosing,
        rows,
      },
    ];
  });

/** The header's word: the project instance's state, a count of worktree instances, or none yet. */
export const panelWord = (panel: ResourcePanelModel): string => {
  if (panel.project !== undefined) return stateWord(panel.project.instance);
  if (panel.worktreeInstances.length > 0) {
    const running = panel.worktreeInstances.filter((row) => row.instance === "running").length;
    return `${running} of ${panel.worktreeInstances.length} running`;
  }
  return "Not started";
};

/** Is the instance a worktree uses (its own, or the project's) running, as last observed? */
const usedRunning = (row: WorktreeRow): boolean => (row.own ?? row.use)?.instance === "running";

/**
 * What a worktree uses, in words: `The shared database`, `Its own database · running`, `No
 * database`, `The project's @redis · not running`. `loading` adds a load under way into the
 * database this worktree uses.
 */
export const rowWords = (
  row: WorktreeRow,
  panel: Pick<ResourcePanelModel, "name" | "spec">,
  loading: "shared" | "own" | null = null,
): string => {
  if (row.failed !== null) return `Not read · ${row.failed}`;
  if (row.use === undefined) return "Reading…";
  const postgres = panel.spec.preset === "postgres";
  if (row.choice === "off") return postgres ? "No database" : "Off";
  const own = row.choice === "worktree";
  const what = own
    ? postgres
      ? "Its own database"
      : `Its own @${panel.name}`
    : postgres
      ? "The shared database"
      : `The project's @${panel.name}`;
  if (loading !== null && loading === (own ? "own" : "shared")) return `${what} · loading`;
  if (own) return `${what} · ${usedRunning(row) ? "running" : "not running"}`;
  return usedRunning(row) ? what : `${what} · not running`;
};

/** The tone of a worktree's row: red only when its own read failed; the panel says why a start did. */
export const rowTone = (row: WorktreeRow): StatusTone => (row.failed === null ? "idle" : "bad");

/**
 * Why a start failed, from the instance's status line: what follows `failed · `
 * (`@db · postgres:17 · failed · exited with code 1 · project` → `exited with code 1 · project`).
 */
export const failureWords = (statusLine: string): string => {
  const at = statusLine.indexOf("failed · ");
  return at === -1 ? statusLine : statusLine.slice(at + "failed · ".length);
};

/** Whether Stop does something for an instance as last observed. */
export const canStop = (entry: ResourceSettingView | undefined): boolean =>
  entry !== undefined && resourceControls(entry.instance).stop;

/** Whether Start does something; a definition never started can always be started. */
export const canStart = (entry: ResourceSettingView | undefined): boolean =>
  entry === undefined || resourceControls(entry.instance).start;

/**
 * Resources a worktree's `.mend/mend.toml` declares that the default branch does not and nobody
 * started: `.mend/mend.toml in t3/settings-tabs declares @search`.
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

/** How many resources the tab lists: one per name, declared or running. */
export const resourceCount = (page: ResourcesPageView): number => resourceListEntries(page).length;

/**
 * Which file on the default branch the read came from: the server's `observed` begins with its
 * path (`.mend/mend.toml · observed on the worktree`), and a repository may still use the root
 * `mend.toml`. Null when the file could not be read at all.
 */
export const declaredFile = (file: ResourcesPageView["file"]): string | null => {
  if (file.kind === "not-selected" || file.kind === "unavailable") return null;
  const path = file.observed.split(" · ")[0]?.trim() ?? "";
  return path === "" ? ".mend/mend.toml" : path;
};

/**
 * The file on GitHub, for Open file: only a project cloned from GitHub has one to open.
 * `git@github.com:o/r.git` and `https://github.com/o/r` both work.
 */
export const githubFileUrl = (
  originUrl: string | null,
  branch: string,
  path: string,
): string | null => {
  if (originUrl === null) return null;
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(originUrl.trim());
  if (match === null) return null;
  const [, owner, repo] = match;
  if (owner === undefined || repo === undefined) return null;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${owner}/${repo}/blob/${encodeURIComponent(branch)}/${encodedPath}`;
};

/** The worktrees that use a project resource now, for what removing it takes away. */
export const usingWorktrees = (panel: Pick<ResourcePanelModel, "rows">): number =>
  panel.rows.filter((row) => row.choice === "project").length;

/**
 * `smtp=1025 http=8025` → the `--port` flags the add command parses. A port typed bare needs a
 * name: one alone is `port`, several are `port7700`, `port7701`.
 */
export const portFlags = (raw: string): ReadonlyArray<string> => {
  const parts = raw.split(/[\s,]+/).filter((part) => part !== "");
  const bare = /^(\d+)(\/(?:tcp|udp))?$/;
  const named = (part: string): string => {
    const match = bare.exec(part);
    if (match === null) return part;
    return parts.length === 1 ? `port=${part}` : `port${match[1]}=${part}`;
  };
  return parts.flatMap((part) => ["--port", named(part)]);
};
