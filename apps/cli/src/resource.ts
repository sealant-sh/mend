import {
  type ResourceAdded,
  resourceAdditionOf,
  type ResourceControlled,
  type ResourceEnvAnswer,
  resourcePositionals,
  resourceRefusalWords,
  type ResourceSelectionEntry,
  type ResourcesPage,
  resourceTableNotices,
  WorktreeChoice,
} from "@mend/domain/workbench";
import { Schema } from "effect";

import type { ApiCall } from "./pair.ts";
import { type ResourceLoadUpload, runResourceLoad } from "./resource-load.ts";
import {
  jsonWithoutCredentials,
  paint,
  printable,
  redactCredentials,
  takeFlagValue,
} from "./shared.ts";

/**
 * `mend resource add|list|remove|use|start|stop|reset|env` (docs/adr/0019-shared-services.md): a
 * project's resources from a person's terminal. What a member adds is the project's, and runs.
 * The server decides every act; these commands print its status lines as they come. Anything a
 * definition stores is someone else's text, so it reaches the terminal through `printable`.
 */

const dim = paint("2");
const say = (line: string) => process.stdout.write(`${redactCredentials(line)}\n`);
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

/** The list as the terminal prints it: settings with their ids, then the file. */
export const renderResources = (
  project: ProjectRef,
  page: ResourcesPage,
  worktree: string | null,
) => {
  const lines: Array<string> = [];
  if (page.settings.length > 0) {
    lines.push(
      "settings",
      ...page.settings.map((entry) => `  ${entryLine(entry, entry.image, entry.id)}`),
    );
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
      ...file.tables.flatMap((table) => [
        `  ${entryLine(table, table.spec.image, null)}`,
        ...(table.add.kind === "ready"
          ? [
              `    ${dim(`mend resource add ${printable(table.spec.name)} --from-file --worktree ${printable(worktree ?? "")}`)}`,
            ]
          : []),
      ]),
      ...resourceTableNotices(file).map((notice) => `  ${printable(notice)}`),
    );
  }
  return lines.length > 0
    ? lines
    : [`no resources in ${printable(project.name)} · mend resource add adds one`];
};

type RemovalTarget =
  | {
      readonly kind: "definition";
      readonly route: string;
      readonly body: unknown;
      readonly line: string;
    }
  | { readonly kind: "none"; readonly message: string };

/**
 * What `mend resource remove` removes, from the page the caller just read: the definition
 * settings hold under the name, or the one `--definition` names by the id `mend resource list`
 * prints, which must be of the name when one is given too.
 */
export const removalTarget = (
  project: ProjectRef,
  page: ResourcesPage,
  name: string | null,
  definition: string | null,
): RemovalTarget => {
  const entry =
    definition === null
      ? page.settings.find((each) => each.spec.name === name)
      : page.settings.find((each) => each.id === definition);
  if (entry === undefined) {
    return {
      kind: "none",
      message:
        definition !== null
          ? `no definition ${printable(definition)} in ${printable(project.name)}`
          : name === null
            ? "name the resource: mend resource remove db"
            : `no @${printable(name)} in ${printable(project.name)}`,
    };
  }
  if (name !== null && entry.spec.name !== name) {
    return {
      kind: "none",
      message: `${printable(entry.id)} is @${printable(entry.spec.name)}, not @${printable(name)} · nothing was removed`,
    };
  }
  return {
    kind: "definition",
    route: `/projects/${encodeURIComponent(project.id)}/resources/${encodeURIComponent(entry.id)}`,
    body: { expectedDigest: entry.digest },
    line: entryLine(entry, entry.image, entry.id),
  };
};

/**
 * What `mend resource add <name> --from-file` adds, from the page read for `--worktree`: the
 * `[resource.<name>]` table in its `.mend/mend.toml`, as the page offers it. A table settings already
 * hold the same is said, and nothing is posted.
 */
export const tableAddition = (
  page: ResourcesPage,
  name: string,
  worktree: string,
):
  | { readonly kind: "ready"; readonly body: unknown; readonly line: string }
  | { readonly kind: "added"; readonly message: string }
  | { readonly kind: "refused"; readonly message: string } => {
  const where = `.mend/mend.toml in ${printable(worktree)}`;
  const file = page.file;
  if (file.kind !== "read") {
    return {
      kind: "refused",
      message: `${where} · ${"message" in file ? printable(file.message) : file.kind}`,
    };
  }
  const table = file.tables.find((each) => each.spec.name === name);
  if (table === undefined) {
    return { kind: "refused", message: `no [resource.${printable(name)}] in ${where}` };
  }
  const named = `@${printable(name)}`;
  switch (table.add.kind) {
    case "ready":
      return {
        kind: "ready",
        body: { kind: "definition", spec: table.spec },
        line: entryLine(table, table.spec.image, null),
      };
    case "added":
      return { kind: "added", message: `${named} is in settings already, as ${where} has it` };
    case "denied":
      return { kind: "refused", message: `${printable(table.add.message)} · nothing was added` };
    case "rejected":
      return {
        kind: "refused",
        message: [
          ...table.add.refusals.map(
            (refusal) => `${named} · ${printable(resourceRefusalWords(refusal))}`,
          ),
          "nothing was added",
        ].join("\n"),
      };
  }
};

const isChoice = Schema.is(WorktreeChoice);

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
  const project = await projectOf(takeFlagValue(rest, "--project"));
  const zone = `timeZone=${encodeURIComponent(readerZone())}`;
  const read = (worktreeId: string | null) =>
    api<ResourcesPage>(
      "GET",
      `/projects/${project.id}/resources?${zone}${worktreeId === null ? "" : `&worktreeId=${encodeURIComponent(worktreeId)}`}`,
    );
  /** The `--worktree` named, by name or id; null when none is. */
  const worktreeOf = async () => {
    const named = takeFlagValue(rest, "--worktree");
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
      // A worktree resource starts in the worktree named; a project resource starts either way.
      const from = await worktreeOf();
      const added = async (body: unknown) => {
        const answer = await api<ResourceAdded>(
          "POST",
          `/projects/${project.id}/resources?${zone}${from === null ? "" : `&worktreeId=${encodeURIComponent(from.id)}`}`,
          body,
        );
        say(printable(answer.definition.statusLine));
        const by =
          answer.resolvedBy === null ? "" : ` · digest from ${printable(answer.resolvedBy)}`;
        say(dim(`image ${printable(answer.definition.image)}${by}`));
      };
      if (rest.includes("--from-file")) {
        if (name === null) return fail("name the resource: mend resource add db --from-file");
        if (from === null) {
          return fail("name the worktree whose .mend/mend.toml holds it: --worktree <w>");
        }
        const table = tableAddition(await read(from.id), name, from.label);
        if (table.kind === "refused") return fail(table.message);
        if (table.kind === "added") return say(table.message);
        say(`adding ${table.line}`);
        return added(table.body);
      }
      const addition = resourceAdditionOf(rest);
      if (!addition.ok) return fail(addition.message);
      return added(addition.body);
    }
    case "remove": {
      const target = removalTarget(
        project,
        await read(null),
        name,
        takeFlagValue(rest, "--definition"),
      );
      if (target.kind === "none") return fail(target.message);
      say(`removing ${target.line}`);
      const removed = await api<{ readonly statusLine: string }>(
        "DELETE",
        target.route,
        target.body,
      );
      return say(printable(removed.statusLine));
    }
    case "use": {
      const mode = resourcePositionals(rest)[1] ?? "";
      if (name === null || !isChoice(mode)) {
        return fail("name the resource and a choice: mend resource use db own --worktree checkout");
      }
      const worktree = await worktreeOf();
      if (worktree === null) return fail("name the worktree that uses it: --worktree <w>");
      const held = (await read(null)).settings.find((entry) => entry.spec.name === name);
      if (held === undefined) return fail(`no @${printable(name)} in settings`);
      const chosen = await api<ResourceSelectionEntry>(
        "PUT",
        `/projects/${project.id}/worktrees/${encodeURIComponent(worktree.id)}/resources/${encodeURIComponent(held.id)}/selection?${zone}`,
        { mode },
      );
      return say(printable(chosen.statusLine));
    }
    case "start":
    case "stop": {
      if (name === null) return fail(`name the resource: mend resource ${verb} db`);
      const worktree = await worktreeOf();
      const answer = await api<ResourceControlled>(
        "POST",
        `/projects/${project.id}/resources/${encodeURIComponent(name)}/${verb}?${zone}${worktree === null ? "" : `&worktreeId=${encodeURIComponent(worktree.id)}`}`,
      );
      return say(printable(answer.statusLine));
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
      if (name === null) return fail("name the resource: mend resource reset db --worktree <w>");
      const worktree = await worktreeOf();
      if (worktree === null)
        return fail("name the worktree whose database to reset: --worktree <w>");
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
      if (worktree === null) return fail("name the worktree whose env to print: --worktree <w>");
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
