import type { ProjectWorkspaceImageSaveResult } from "@mend/api-contracts";
import { WorkspaceImage } from "@mend/domain";
import { Schema } from "effect";

import {
  CommandInputError,
  needsInput,
  readinessResult,
  type CommandResult,
} from "./command-result.ts";
import type { ApiCall } from "./pair.ts";
import { parseProjectRetentionArgs } from "./project-retention.ts";
import { cwdFacts, matchProjectByCwd, takeFlagValue } from "./shared.ts";

interface ListedProject {
  readonly id: string;
  readonly name: string;
  readonly originUrl: string | null;
  readonly defaultBranch: string;
  readonly storePath: string;
  readonly workspaceImage: unknown;
}

const selectedProject = async (api: ApiCall, word: string): Promise<ListedProject> => {
  const rows = await api<ReadonlyArray<ListedProject>>("GET", "/projects");
  const project = rows.find((row) => row.id === word || row.name === word);
  if (project === undefined)
    throw new CommandInputError(
      "project_not_found",
      "The selected project was not found.",
      "Run mend projects --json and pass an existing project id or name.",
    );
  return project;
};

export const projectImageCommand = async (
  api: ApiCall,
  args: ReadonlyArray<string>,
): Promise<CommandResult<unknown>> => {
  const words = args.filter(
    (word, index) => !word.startsWith("--") && args[index - 1] !== "--screen",
  );
  const screen = takeFlagValue(args, "--screen");
  if (words.length !== 1 || (screen !== null && screen !== "on" && screen !== "off"))
    return needsInput(
      "Name one project and an optional screen setting.",
      "Run mend projects image <project> [--screen on|off] --json.",
    );
  const project = await selectedProject(api, words[0] ?? "");
  const inherited = project.workspaceImage === null || project.workspaceImage === undefined;
  const value = inherited
    ? (
        await api<{ readonly effective: { readonly workspaceImage: unknown } }>(
          "GET",
          "/organization/settings",
        )
      ).effective.workspaceImage
    : project.workspaceImage;
  const image = Schema.decodeUnknownSync(WorkspaceImage)(value);
  if (screen === null)
    return {
      status: "done",
      data: { projectId: project.id, source: inherited ? "organization" : "project", image },
    };
  if (image.mode === "custom")
    return {
      status: "not_ready",
      data: { projectId: project.id, image },
      items: [
        {
          id: "screen",
          state: "todo",
          detail: "Custom workspace images do not support Mend's screen setting.",
          fix: "Choose a family workspace image in the project's environment settings, then enable its screen.",
        },
      ],
      error: {
        code: "screen_image_unsupported",
        message: "A screen requires a family workspace image.",
        fix: "Choose a family workspace image in the project's environment settings, then retry this command.",
      },
    };
  const answer = await api<Schema.Codec.Encoded<typeof ProjectWorkspaceImageSaveResult>>(
    "PUT",
    `/projects/${encodeURIComponent(project.id)}/workspace-image`,
    { workspaceImage: { ...image, screen: screen === "on" } },
  );
  const data = {
    projectId: project.id,
    saved: answer.saved,
    image: answer.saved ? answer.project?.workspaceImage : image,
    resolutions: answer.resolutions,
    next: "Start a new session in a new worktree for the image change to apply. Existing sessions keep their current image.",
  };
  return readinessResult(data, [
    {
      id: "image",
      state: answer.saved ? "ok" : "todo",
      detail: answer.saved
        ? "Project workspace image saved."
        : "The workspace image could not be saved; inspect the package resolutions.",
      fix: "Resolve the reported package failures in project environment settings, then retry.",
    },
  ]);
};

export const projectsJson = async (
  api: ApiCall,
  args: ReadonlyArray<string>,
): Promise<CommandResult<unknown>> => {
  if (args[0] === "image") return projectImageCommand(api, args.slice(1));
  if (args[0] !== undefined && ["rm", "removed", "restore", "purge"].includes(args[0])) {
    const command = parseProjectRetentionArgs(args);
    if ("error" in command)
      return needsInput(
        command.error,
        "Run mend help projects and pass the required project id and confirmation.",
      );
    if (command.command === "removed")
      return { status: "done", data: { removed: await api("GET", "/removed-projects") } };
    const id = encodeURIComponent(command.id);
    if (command.command === "rm")
      return { status: "done", data: await api("DELETE", `/projects/${id}`) };
    if (command.command === "restore")
      return {
        status: "done",
        data: await api(
          "POST",
          `/removed-projects/${id}/restore`,
          command.name === undefined ? {} : { name: command.name },
        ),
      };
    return {
      status: "done",
      data: await api("POST", `/removed-projects/${id}/purge`, { confirm: command.confirm }),
    };
  }
  if (args.some((word) => word !== "--json"))
    return needsInput(
      "Unexpected project argument.",
      "Run mend projects --json to list projects, or mend help projects.",
    );
  const [rows, sessions] = await Promise.all([
    api<ReadonlyArray<ListedProject>>("GET", "/projects"),
    api<ReadonlyArray<{ readonly projectId: string }>>("GET", "/sessions"),
  ]);
  const current = matchProjectByCwd(rows, cwdFacts(process.cwd()));
  return {
    status: "done",
    data: {
      projects: rows.map((project) => ({
        id: project.id,
        name: project.name,
        originUrl: project.originUrl,
        defaultBranch: project.defaultBranch,
        storePath: project.storePath,
        liveSessions: sessions.filter((row) => row.projectId === project.id).length,
        current: current?.id === project.id,
      })),
    },
  };
};
