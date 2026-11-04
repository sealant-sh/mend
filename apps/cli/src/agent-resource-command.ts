import {
  parseDuration,
  resourceAdditionOf,
  resourceChoiceOf,
  resourceLevelFlag,
  resourcePositionals,
  type ResourceAdded,
  type ResourceControlled,
  type ResourceDefinition,
  type ResourceEnvAnswer,
  type ResourceLoadAnswer,
  type ResourceSelectionEntry,
  type ResourcesPage,
} from "@mend/domain/workbench";

import type { ConversationBoundary } from "./agent-conversation-command.ts";
import { resourceStartJson } from "./agent-observation-command.ts";
import {
  CommandInputError,
  needsInput,
  readinessResult,
  type CommandResult,
} from "./command-result.ts";
import { resolveOnboardingProject } from "./onboarding-command.ts";
import { runResourceLoad, type ResourceLoadUpload } from "./resource-load.ts";
import { MendRequestError } from "./server-request.ts";
import { gitCurrentBranch, takeFlagValue } from "./shared.ts";

const definitionView = (spec: ResourceDefinition) => ({
  name: spec.name,
  preset: spec.preset,
  image: spec.image,
  ports: spec.ports,
  envNames: Object.keys(spec.env),
  exportNames: Object.keys(spec.exports),
  volumes: spec.volumes,
  limits: spec.limits,
});

/** Resource environment values and command text never cross the agent output boundary. */
const pageView = (page: ResourcesPage) => ({
  settings: page.settings.map((row) => ({ ...row, spec: definitionView(row.spec) })),
  file:
    page.file.kind === "read"
      ? {
          ...page.file,
          tables: page.file.tables.map((row) => ({ ...row, spec: definitionView(row.spec) })),
        }
      : page.file,
});

export const resourceJson = async (
  boundary: ConversationBoundary,
  args: ReadonlyArray<string>,
  upload: ResourceLoadUpload,
): Promise<CommandResult<unknown>> => {
  const [first, ...after] = args;
  const verb = first === undefined || first.startsWith("--") ? "list" : first;
  const rest = verb === first ? after : args;
  if (verb === "start") return resourceStartJson(boundary, rest);
  const [name, extra] = resourcePositionals(
    rest.filter((word, index) => word !== "--timeout" && rest[index - 1] !== "--timeout"),
  );
  const level = resourceLevelFlag(rest);
  const required = (message: string): never => {
    throw new CommandInputError(
      "needs_input",
      message,
      `Run mend help resource ${verb} and pass the named selectors explicitly.`,
    );
  };
  if (!["list", "add", "stop", "remove", "use", "env", "load", "reset"].includes(verb))
    return needsInput("Unknown resource command.", "Run mend help resource.");
  if (rest.includes("--project") && rest.includes("--worktree"))
    return needsInput("Choose one resource level.", "Pass --project or --worktree.");
  if (!["list", "env"].includes(verb) && name === undefined) required("Name the resource.");
  if (verb !== "use" && extra !== undefined) required("Unexpected extra resource argument.");
  if (["list", "env"].includes(verb) && name !== undefined)
    required("This command takes no resource name.");
  if (verb === "remove" && level === null) required("Choose --project or --worktree.");
  const timeoutValue = takeFlagValue(rest, "--timeout");
  const timeout = timeoutValue === null ? 600_000 : parseDuration(timeoutValue);
  if (timeout === null) return needsInput("Invalid timeout.", "Pass --timeout 30s, 10m or 1h.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let load: ResourceLoadAnswer | null = null;
  const api: ConversationBoundary["api"] = (method, route, body) =>
    boundary.api(method, route, body, controller.signal);
  try {
    const project = await resolveOnboardingProject(api, takeFlagValue(rest, "--project-id"));
    if (project === null)
      throw new CommandInputError(
        "project_not_found",
        "The selected project was not found.",
        "Pass --project-id from mend projects --json, or run in an adopted checkout.",
      );
    let named = takeFlagValue(rest, "--worktree-id");
    if (named === null) {
      const branch = gitCurrentBranch(process.cwd());
      if (branch?.startsWith("mend/") === true) named = branch.slice(5);
    }
    let worktreeId: string | null = null;
    if (named !== null) {
      const rows = await api<{
        readonly worktrees: ReadonlyArray<{ readonly id: string; readonly name: string }>;
      }>("GET", `/projects/${project.id}/worktrees`);
      worktreeId = rows.worktrees.find((row) => row.id === named || row.name === named)?.id ?? null;
      if (worktreeId === null)
        throw new CommandInputError(
          "worktree_not_found",
          "The selected worktree was not found in this project.",
          "Pass the worktree id from mend change <session> --json.",
        );
    }
    if (
      ["add", "use", "env", "reset"].includes(verb) ||
      ((verb === "stop" || verb === "remove") && level !== "project")
    ) {
      if (worktreeId === null) required("Name the worktree with --worktree-id.");
    }
    const base = `/projects/${encodeURIComponent(project.id)}`;
    const query = `timeZone=UTC${worktreeId === null ? "" : `&worktreeId=${encodeURIComponent(worktreeId)}`}`;
    const resource = `${base}/resources/${encodeURIComponent((name ?? "").replace(/^@/, ""))}`;
    const context = { projectId: project.id, worktreeId };
    switch (verb) {
      case "list": {
        const page = await api<ResourcesPage>("GET", `${base}/resources?${query}`);
        return { status: "done", data: { ...context, ...pageView(page) } };
      }
      case "add": {
        const input = resourceAdditionOf(rest.filter((word) => word !== "--json"));
        if (!input.ok)
          return needsInput(
            input.message,
            "Pass --preset and --version, or --image and --port. Run mend help resource add.",
          );
        const answer = await api<ResourceAdded>("POST", `${base}/worktrees/resources`, {
          worktreeId,
          definition: input.definition,
        });
        const data = {
          ...context,
          kind: answer.kind,
          statusLine: answer.statusLine,
          path: "path" in answer ? answer.path : null,
        };
        return readinessResult(data, [
          {
            id: "declaration",
            state: answer.kind === "written" || answer.kind === "declared" ? "ok" : "todo",
            detail: answer.statusLine,
            fix: "Read and repair the worktree's .mend/mend.toml, then retry the declaration.",
          },
        ]);
      }
      case "stop": {
        const answer = await api<ResourceControlled>("POST", `${resource}/stop?timeZone=UTC`, {
          ...(level === null ? {} : { level }),
          worktreeId,
        });
        return { status: "done", data: { ...context, ...answer } };
      }
      case "remove": {
        const answer = await api<{ readonly statusLine: string }>("DELETE", resource, {
          level,
          worktreeId,
        });
        return { status: "done", data: { ...context, ...answer } };
      }
      case "use": {
        const mode = resourceChoiceOf(extra ?? "");
        if (mode === null || resourcePositionals(rest).length !== 2)
          return needsInput(
            "Choose how this worktree uses the resource.",
            "Pass project, worktree or off after the resource name.",
          );
        const answer = await api<ResourceSelectionEntry>(
          "PUT",
          `${base}/worktrees/${encodeURIComponent(worktreeId ?? "")}/resources/${encodeURIComponent((name ?? "").replace(/^@/, ""))}/selection?timeZone=UTC`,
          { mode },
        );
        return { status: "done", data: { ...context, ...answer } };
      }
      case "env": {
        const answer = await api<ResourceEnvAnswer>(
          "GET",
          `${base}/worktrees/${encodeURIComponent(worktreeId ?? "")}/resources/env?timeZone=UTC`,
        );
        return {
          status: "done",
          data: { ...context, names: Object.keys(answer.env), statusLines: answer.statusLines },
        };
      }
      case "reset": {
        const target = takeFlagValue(rest, "--target");
        if (target !== null && target !== "shared" && target !== "own")
          return needsInput("Invalid database target.", "Pass --target shared or --target own.");
        const answer = await api<{ readonly statusLine: string }>(
          "POST",
          `${base}/worktrees/${encodeURIComponent(worktreeId ?? "")}/resources/${encodeURIComponent((name ?? "").replace(/^@/, ""))}/reset?timeZone=UTC${target === null ? "" : `&target=${target}`}`,
        );
        return { status: "done", data: { ...context, ...answer } };
      }
      case "load": {
        const target = takeFlagValue(rest, "--target");
        if (target !== null && target !== "shared" && target !== "own")
          return needsInput("Invalid database target.", "Pass --target shared or --target own.");
        const from = takeFlagValue(rest, "--from");
        const pull = takeFlagValue(rest, "--pull");
        if ((from === null) === (pull === null))
          return needsInput(
            "Choose one database source.",
            "Pass --from <dump-file> or --pull <postgres-url>.",
          );
        try {
          const answer = await runResourceLoad({
            api,
            upload,
            base: `${base}/resource-loads?timeZone=UTC`,
            name: (name ?? "").replace(/^@/, ""),
            worktreeId,
            target,
            from,
            pull,
            say: () => {},
            signal: controller.signal,
            observe: (row) => {
              load = row;
            },
          });
          return answer.phase === "failed"
            ? {
                status: "failed",
                data: { ...context, load: answer },
                error: {
                  code: "resource_load_failed",
                  message: answer.statusLine,
                  fix: "Inspect the load and its reported cause before starting another load. A failed restore leaves the target unchanged.",
                },
              }
            : { status: "done", data: { ...context, load: answer } };
        } catch (error) {
          if (
            controller.signal.aborted ||
            !(error instanceof Error) ||
            error instanceof MendRequestError
          )
            throw error;
          return {
            status: "failed",
            data: { ...context, load },
            error: {
              code: "resource_load_failed",
              message: error.message,
              fix: "Check the dump file or pg_dump installation and inspect the last load before retrying.",
            },
          };
        }
      }
      default:
        return needsInput("Unknown resource command.", "Run mend help resource.");
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    return {
      status: "timeout",
      data: { load },
      error: {
        code: "timeout",
        message: "The resource operation did not finish before the deadline.",
        fix: "Inspect resource state and the returned load id before retrying a write. Accepted work keeps running.",
      },
    };
  } finally {
    clearTimeout(timer);
  }
};
