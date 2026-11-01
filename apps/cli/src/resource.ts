import { createInterface } from "node:readline/promises";

import {
  type ResourceControlled,
  type ResourceEnvAnswer,
  type ResourceSelectionEntry,
  type ResourcesPage,
  type ResourceStarted,
  resourcePositionals,
  resourceAdditionOf,
  resourceAddedLines,
  type ResourceAdded,
  resourceTableNotices,
  resourceListEntries,
  resourceChoiceOf,
  resourceLevelFlag,
  resourceLevelHint,
} from "@mend/domain/workbench";

import type { ApiCall } from "./pair.ts";
import { type ResourceLoadUpload, runResourceLoad } from "./resource-load.ts";
import {
  gitCurrentBranch,
  jsonWithoutCredentials,
  paint,
  printable,
  redactCredentials,
  takeFlagValue,
} from "./shared.ts";

/**
 * `mend resource add|list|remove|use|start|stop|reset|env` (docs/adr/0019-shared-services.md): a
 * project's resources from a person's terminal. Add writes a worktree declaration and starts nothing.
 * The server decides every act; these commands print its status lines as they come. Anything a
 * definition stores is someone else's text, so it reaches the terminal through `printable`.
 */

const dim = paint("2");
const say = (line: string) => process.stdout.write(`${redactCredentials(line)}\n`);
/** A server answer of several lines prints as lines; each is still made printable on its own. */
const sayLines = (text: string) => {
  for (const line of text.split("\n")) say(printable(line));
};
const fail = (message: string): never => {
  process.stderr.write(`mend: ${redactCredentials(message)}\n`);
  process.exit(1);
};

export interface ProjectRef {
  readonly id: string;
  readonly name: string;
}

/** A listed entry: its status line, then the image it runs or would run, then its id when it has one. */
const entryLine = (entry: { readonly statusLine: string }, image: string, id: string | null) =>
  [
    printable(entry.statusLine),
    printable(image),
    ...(id === null ? [] : [dim(printable(id))]),
  ].join("  ");

/** Each name once, its file definition when present, with instance observations underneath. */
export const renderResources = (
  project: ProjectRef,
  page: ResourcesPage,
  worktree: string | null,
) => {
  const lines: Array<string> = [];
  for (const entry of resourceListEntries(page)) {
    lines.push(printable(entry.statusLine));
    for (const instance of entry.instances) {
      lines.push(`  ${entryLine(instance, instance.image, instance.id)}`);
    }
  }
  const file = page.file;
  const where = `.mend/mend.toml in ${printable(worktree ?? "")}`;
  if (file.kind === "unavailable") lines.push(`${where} · ${printable(file.message)}`);
  if (file.kind === "unparsed") {
    lines.push(`${where} · ${printable(file.observed)} · ${printable(file.message)}`);
  }
  if (file.kind === "absent") lines.push(`${where} · absent · ${printable(file.observed)}`);
  if (file.kind === "read") {
    lines.push(
      `${where} · ${printable(file.observed)}`,
      ...resourceTableNotices(file).map((notice) => `  ${printable(notice)}`),
    );
  }
  return lines.length > 0 ? lines : [`no resources in ${printable(project.name)}`];
};

const readerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const resourceCommand = async (
  api: ApiCall,
  projectOf: (explicit: string | null) => Promise<ProjectRef>,
  args: ReadonlyArray<string>,
  upload?: ResourceLoadUpload,
) => {
  const [first, ...after] = args;
  const verb = first?.startsWith("--") === true ? undefined : first;
  const rest = verb === undefined ? args : after;
  const project = await projectOf(takeFlagValue(rest, "--project-id"));
  const zone = `timeZone=${encodeURIComponent(readerZone())}`;
  const read = (worktreeId: string | null) =>
    api<ResourcesPage>(
      "GET",
      `/projects/${project.id}/resources?${zone}${worktreeId === null ? "" : `&worktreeId=${encodeURIComponent(worktreeId)}`}`,
    );
  /** The `--worktree` named, by name or id; null when none is. */
  const worktreeOf = async () => {
    let named = takeFlagValue(rest, "--worktree-id");
    if (named === null) {
      const branch = gitCurrentBranch(process.cwd());
      if (branch?.startsWith("mend/") === true) named = branch.slice(5);
    }
    if (named === null) return null;
    const listing = await api<{
      readonly worktrees: ReadonlyArray<{ readonly id: string; readonly name: string }>;
    }>("GET", `/projects/${project.id}/worktrees`);
    const found = listing.worktrees.find((each) => each.name === named || each.id === named);
    if (found === undefined) {
      return fail(`no worktree named "${printable(named)}" in ${printable(project.name)}`);
    }
    return { id: found.id, label: named };
  };
  const [name = null] = resourcePositionals(rest);
  switch (verb) {
    case "list":
    case undefined: {
      const worktree = await worktreeOf();
      const worktreeName = worktree?.label ?? null;
      const page = await read(worktree?.id ?? null);
      // Each string redacted on its own, so a URL in a spec cannot swallow the JSON around it.
      if (rest.includes("--json")) {
        process.stdout.write(`${jsonWithoutCredentials({ version: 1, ...page })}\n`);
        return;
      }
      for (const line of renderResources(project, page, worktreeName)) say(line);
      return;
    }
    case "add": {
      const input = resourceAdditionOf(rest);
      if (!input.ok) return fail(input.message);
      const worktree = await worktreeOf();
      if (worktree === null) return fail("name the worktree: --worktree-id <w>");
      const answer = await api<ResourceAdded>(
        "POST",
        `/projects/${project.id}/worktrees/resources`,
        {
          worktreeId: worktree.id,
          definition: input.definition,
        },
      );
      for (const line of resourceAddedLines(answer)) say(printable(line));
      return;
    }
    case "remove": {
      if (rest.includes("--project") && rest.includes("--worktree"))
        return fail("choose one level: --project or --worktree");
      if (name === null)
        return fail("name the resource: mend resource remove db --project or --worktree");
      const level = resourceLevelFlag(rest);
      if (level === null)
        return fail(`choose a level: mend resource remove ${name} --project or --worktree`);
      const worktree = await worktreeOf();
      if (worktree === null && level !== "project")
        return fail("name the worktree: --worktree-id <w>");
      const answer = await api<{ readonly statusLine: string }>(
        "DELETE",
        `/projects/${project.id}/resources/${encodeURIComponent(name)}`,
        { level, worktreeId: worktree?.id ?? null },
      );
      return say(printable(answer.statusLine));
    }
    case "use": {
      const mode = resourceChoiceOf(resourcePositionals(rest)[1] ?? "");
      if (name === null || mode === null)
        return fail("name the resource and a choice: mend resource use db project|worktree|off");
      const worktree = await worktreeOf();
      if (worktree === null) return fail("name the worktree: --worktree-id <w>");
      const answer = await api<ResourceSelectionEntry>(
        "PUT",
        `/projects/${project.id}/worktrees/${encodeURIComponent(worktree.id)}/resources/${encodeURIComponent(name)}/selection?${zone}`,
        { mode },
      );
      say(printable(answer.statusLine));
      if (answer.message !== null && answer.message !== answer.statusLine) sayLines(answer.message);
      return;
    }
    case "start":
    case "stop": {
      if (name === null) return fail(`name the resource: mend resource ${verb} db`);
      let level = resourceLevelFlag(rest);
      if (rest.includes("--project") && rest.includes("--worktree"))
        return fail("choose one level: --project or --worktree");
      if (verb === "start" && level === null) {
        if (process.stdin.isTTY !== true || process.stdout.isTTY !== true)
          return fail(resourceLevelHint(name));
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const choice = (await rl.question("project or worktree? ")).trim();
          level = choice === "project" || choice === "worktree" ? choice : null;
        } finally {
          rl.close();
        }
        if (level === null) return fail(resourceLevelHint(name));
      }
      const worktree = await worktreeOf();
      if (worktree === null && !(verb === "stop" && level === "project"))
        return fail("name the worktree: --worktree-id <w>");
      const route = `/projects/${project.id}/resources/${encodeURIComponent(name)}/${verb}?${zone}`;
      if (verb === "stop") {
        const answer = await api<ResourceControlled>("POST", route, {
          ...(level === null ? {} : { level }),
          worktreeId: worktree?.id ?? null,
        });
        say(printable(answer.statusLine));
        if (answer.message !== null) sayLines(answer.message);
        return;
      }
      if (worktree === null) return fail("name the worktree: --worktree-id <w>");
      let answer = await api<ResourceStarted>("POST", route, {
        level,
        worktreeId: worktree.id,
        restart: rest.includes("--restart"),
      });
      if (answer.kind === "needs-restart") {
        say(printable(answer.statusLine));
        for (const used of answer.worktrees) say(`  ${printable(used.name)}`);
        if (process.stdin.isTTY !== true || process.stdout.isTTY !== true)
          return say(printable(answer.hint));
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        let restart = false;
        try {
          restart = /^(y|yes)$/i.test(
            (
              await rl.question(
                `restart @${printable(name)} with this worktree's definition? [y/N] `,
              )
            ).trim(),
          );
        } finally {
          rl.close();
        }
        if (!restart) return;
        answer = await api<ResourceStarted>("POST", route, {
          level,
          worktreeId: worktree.id,
          restart: true,
        });
      }
      say(printable(answer.statusLine));
      if (answer.kind === "started" && answer.message !== null) sayLines(answer.message);
      return;
    }
    case "load": {
      if (name === null) return fail("name the resource: mend resource load db --from dump.sql");
      const worktree = await worktreeOf();
      const target = takeFlagValue(rest, "--target");
      if (target !== null && target !== "shared" && target !== "own")
        return fail("--target is shared or own");
      if (upload === undefined) return fail("streaming uploads are unavailable here");
      try {
        return await runResourceLoad({
          api,
          upload,
          base: `/projects/${project.id}/resource-loads?${zone}`,
          name,
          worktreeId: worktree?.id ?? null,
          target,
          from: takeFlagValue(rest, "--from"),
          pull: takeFlagValue(rest, "--pull"),
          say,
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : "the load could not finish");
      }
    }
    case "reset": {
      if (name === null) return fail("name the resource: mend resource reset db --worktree-id <w>");
      const worktree = await worktreeOf();
      if (worktree === null)
        return fail("name the worktree whose database to reset: --worktree-id <w>");
      const target = takeFlagValue(rest, "--target");
      if (target !== null && target !== "shared" && target !== "own") {
        return fail("--target is shared or own");
      }
      const answer = await api<{ readonly statusLine: string }>(
        "POST",
        `/projects/${project.id}/worktrees/${encodeURIComponent(worktree.id)}/resources/${encodeURIComponent(name)}/reset?${zone}${target === null ? "" : `&target=${target}`}`,
      );
      return say(printable(answer.statusLine));
    }
    case "env": {
      const worktree = await worktreeOf();
      if (worktree === null) return fail("name the worktree whose env to print: --worktree-id <w>");
      const answer = await api<ResourceEnvAnswer>(
        "GET",
        `/projects/${project.id}/worktrees/${encodeURIComponent(worktree.id)}/resources/env?${zone}`,
      );
      // What a shell evals: the exports, then what the project sets itself as comments.
      for (const line of answer.exports) process.stdout.write(`${line}\n`);
      for (const line of answer.statusLines) say(`# ${printable(line)}`);
      return;
    }
    default:
      return fail(
        `unknown resource command "${printable(verb)}" · try: add, list, remove, use, start, stop, reset, load, env`,
      );
  }
};
