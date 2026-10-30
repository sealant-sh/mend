import {
  RESOURCE_PRESETS,
  resourceProposalNotices,
  type ResourcePreset,
  type ResourcesPage,
} from "@mend/domain/workbench";

import type { ApiCall } from "./pair.ts";
import {
  jsonWithoutCredentials,
  paint,
  printable,
  redactCredentials,
  takeFlagValue,
} from "./shared.ts";

/**
 * `mend resource add|list|remove` (docs/adr/0019-shared-services.md): a project's resources from a
 * person's terminal. Adding proposes; a manager approves in project settings. The server decides
 * every act; these commands print its status lines as they come. Anything a proposal stored is
 * someone else's text, so it reaches the terminal through `printable`.
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

const isPreset = (value: string): value is ResourcePreset => Object.hasOwn(RESOURCE_PRESETS, value);

/** `smtp=1025` or `dns=53/udp`. */
const portOf = (raw: string) => {
  const match = /^([a-z][a-z0-9-]*)=(\d+)(?:\/(tcp|udp))?$/.exec(raw);
  if (match === null) return null;
  const [, name = "", port = "", protocol = "tcp"] = match;
  return { name, port: Number(port), protocol };
};

const repeated = (args: ReadonlyArray<string>, flag: string): ReadonlyArray<string> =>
  args.flatMap((arg, index) => (arg === flag ? [args[index + 1] ?? ""] : []));

const VALUE_FLAGS = [
  "--project",
  "--worktree",
  "--preset",
  "--version",
  "--image",
  "--port",
  "--scope",
  "--proposal",
  "--definition",
];

const positionals = (args: ReadonlyArray<string>) =>
  args.filter(
    (arg, index) => !arg.startsWith("--") && !VALUE_FLAGS.includes(args[index - 1] ?? ""),
  );

/** The body `mend resource add` sends, or why the arguments name none. */
export const proposalOf = (
  args: ReadonlyArray<string>,
):
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly message: string } => {
  const [name] = positionals(args);
  if (name === undefined)
    return {
      ok: false,
      message: "name the resource: mend resource add db --preset postgres --version 17",
    };
  const scope = takeFlagValue(args, "--scope") ?? "project";
  if (scope !== "project" && scope !== "worktree") {
    return { ok: false, message: "--scope is project or worktree" };
  }
  const preset = takeFlagValue(args, "--preset");
  const image = takeFlagValue(args, "--image");
  if ((preset === null) === (image === null)) {
    return {
      ok: false,
      message:
        "pass one of --preset <postgres|redis|mysql> --version <v>, or --image <ref> --port <name>=<port>",
    };
  }
  if (preset !== null) {
    if (!isPreset(preset))
      return { ok: false, message: `--preset is ${Object.keys(RESOURCE_PRESETS).join(", ")}` };
    const version = takeFlagValue(args, "--version");
    if (version === null)
      return { ok: false, message: `--version names the ${preset} version to run, such as 17` };
    return { ok: true, body: { kind: "preset", name, preset, version, scope } };
  }
  const ports = repeated(args, "--port").map((raw) => ({ raw, port: portOf(raw) }));
  const bad = ports.find((each) => each.port === null);
  if (bad !== undefined)
    return {
      ok: false,
      message: `--port ${bad.raw} is not <name>=<port>, such as smtp=1025 or dns=53/udp`,
    };
  const parsed = ports.flatMap((each) => (each.port === null ? [] : [each.port]));
  const spec = {
    name,
    scope,
    preset: null,
    image,
    command: null,
    ports: parsed,
    env: {},
    volumes: [],
    ready: { kind: parsed.some((port) => port.protocol === "tcp") ? "tcp" : "none" },
    exports: {},
  };
  return { ok: true, body: { kind: "definition", spec } };
};

/** A listed entry: its status line, then the image it would run, then its id when it has one. */
const entryLine = (
  entry: { readonly statusLine: string; readonly spec: { readonly image: string } },
  id: string | null,
) =>
  [
    printable(entry.statusLine),
    printable(entry.spec.image),
    ...(id === null ? [] : [dim(printable(id))]),
  ].join("  ");

/** The list as the terminal prints it: settings, proposals with their ids, then the file. */
export const renderResources = (
  project: ProjectRef,
  page: ResourcesPage,
  worktree: string | null,
) => {
  const lines: Array<string> = [];
  if (page.settings.length > 0) {
    lines.push("settings", ...page.settings.map((entry) => `  ${entryLine(entry, entry.id)}`));
  }
  if (page.proposals.length > 0) {
    lines.push("proposals", ...page.proposals.map((entry) => `  ${entryLine(entry, entry.id)}`));
  }
  const file = page.file;
  const where = `mend.toml in ${printable(worktree ?? "")}`;
  if (file.kind === "unavailable") lines.push(`${where} · ${printable(file.message)}`);
  if (file.kind === "unparsed") {
    lines.push(`${where} · ${printable(file.observed)} · ${printable(file.message)}`);
  }
  if (file.kind === "absent") lines.push(`${where} · absent · ${printable(file.observed)}`);
  if (file.kind === "read") {
    lines.push(
      `${where} · ${printable(file.observed)}`,
      ...file.proposals.map((proposal) => `  ${entryLine(proposal, null)}`),
      ...resourceProposalNotices(file).map((notice) => `  ${printable(notice)}`),
    );
  }
  return lines.length > 0
    ? lines
    : [`no resources in ${printable(project.name)} · mend resource add proposes one`];
};

const idsOf = (entries: ReadonlyArray<{ readonly id: string }>) =>
  entries.map((entry) => printable(entry.id)).join(" | ");

type RemovalTarget =
  | {
      readonly kind: "definition";
      readonly route: string;
      readonly body: unknown;
      readonly line: string;
    }
  | { readonly kind: "proposal"; readonly route: string; readonly line: string }
  | { readonly kind: "none"; readonly message: string };

/**
 * What `mend resource remove` removes, from the page the caller just read. A name picks the
 * definition settings hold, or the one proposal of that name, of the ones the caller may remove;
 * a name that matches both is refused with each id. `--definition` and `--proposal` name one by
 * the id `mend resource list` prints, and must be of the name when one is given too.
 */
export const removalTarget = (
  project: ProjectRef,
  page: ResourcesPage,
  name: string | null,
  named: { readonly proposal: string | null; readonly definition: string | null },
): RemovalTarget => {
  const base = `/projects/${encodeURIComponent(project.id)}`;
  const definitionTarget = (entry: ResourcesPage["settings"][number]): RemovalTarget => ({
    kind: "definition",
    route: `${base}/resources/${encodeURIComponent(entry.id)}`,
    body: { expectedDigest: entry.digest },
    line: entryLine(entry, entry.id),
  });
  const proposalTarget = (entry: ResourcesPage["proposals"][number]): RemovalTarget => ({
    kind: "proposal",
    route: `${base}/resource-proposals/${encodeURIComponent(entry.id)}`,
    line: entryLine(entry, entry.id),
  });
  const ofName = (entry: { readonly id: string; readonly spec: { readonly name: string } }) =>
    name === null || entry.spec.name === name
      ? null
      : `${printable(entry.id)} is @${printable(entry.spec.name)}, not @${printable(name)} · nothing was removed`;
  if (named.proposal !== null && named.definition !== null) {
    return { kind: "none", message: "pass --proposal or --definition, not both" };
  }
  if (named.proposal !== null) {
    const entry = page.proposals.find((each) => each.id === named.proposal);
    if (entry === undefined) {
      return {
        kind: "none",
        message: `no proposal ${printable(named.proposal)} in ${printable(project.name)}`,
      };
    }
    const mismatch = ofName(entry);
    return mismatch === null ? proposalTarget(entry) : { kind: "none", message: mismatch };
  }
  if (named.definition !== null) {
    const entry = page.settings.find((each) => each.id === named.definition);
    if (entry === undefined) {
      return {
        kind: "none",
        message: `no definition ${printable(named.definition)} in ${printable(project.name)}`,
      };
    }
    const mismatch = ofName(entry);
    return mismatch === null ? definitionTarget(entry) : { kind: "none", message: mismatch };
  }
  if (name === null) return { kind: "none", message: "name the resource: mend resource remove db" };
  const definition = page.settings.find((entry) => entry.spec.name === name && entry.canRemove);
  const proposals = page.proposals.filter((entry) => entry.spec.name === name && entry.canRemove);
  const [only] = proposals;
  if (definition !== undefined && proposals.length > 0) {
    return {
      kind: "none",
      message: `@${printable(name)} is a definition (${printable(definition.id)}) and a proposal you can remove (${idsOf(proposals)}) · name one with --definition ${printable(definition.id)} or --proposal ${idsOf(proposals)}`,
    };
  }
  if (definition !== undefined) return definitionTarget(definition);
  if (only !== undefined && proposals.length === 1) return proposalTarget(only);
  return {
    kind: "none",
    message:
      proposals.length === 0
        ? `no @${printable(name)} in ${printable(project.name)} that you can remove`
        : `${proposals.length} proposals of @${printable(name)} · name one with --proposal ${idsOf(proposals)}`,
  };
};

const readerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const resourceCommand = async (
  api: ApiCall,
  projectOf: (explicit: string | null) => Promise<ProjectRef>,
  args: ReadonlyArray<string>,
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
  switch (verb) {
    case "list":
    case undefined: {
      const worktreeName = takeFlagValue(rest, "--worktree");
      let worktreeId: string | null = null;
      if (worktreeName !== null) {
        const listing = await api<{
          readonly worktrees: ReadonlyArray<{ readonly id: string; readonly name: string }>;
        }>("GET", `/projects/${project.id}/worktrees`);
        const found = listing.worktrees.find(
          (each) => each.name === worktreeName || each.id === worktreeName,
        );
        if (found === undefined)
          return fail(
            `no worktree named "${printable(worktreeName)}" in ${printable(project.name)}`,
          );
        worktreeId = found.id;
      }
      const page = await read(worktreeId);
      // Each string redacted on its own, so a URL in a spec cannot swallow the JSON around it.
      if (rest.includes("--json")) {
        process.stdout.write(`${jsonWithoutCredentials({ version: 1, ...page })}\n`);
        return;
      }
      for (const line of renderResources(project, page, worktreeName)) say(line);
      return;
    }
    case "add": {
      const proposal = proposalOf(rest);
      if (!proposal.ok) return fail(proposal.message);
      const entry = await api<{ readonly id: string; readonly statusLine: string }>(
        "POST",
        `/projects/${project.id}/resource-proposals?${zone}`,
        proposal.body,
      );
      say(printable(entry.statusLine));
      say(dim(`proposal ${printable(entry.id)} · a manager approves it in project settings`));
      return;
    }
    case "remove": {
      const [name = null] = positionals(rest);
      const target = removalTarget(project, await read(null), name, {
        proposal: takeFlagValue(rest, "--proposal"),
        definition: takeFlagValue(rest, "--definition"),
      });
      if (target.kind === "none") return fail(target.message);
      say(`removing ${target.line}`);
      const removed = await api<{ readonly statusLine: string }>(
        "DELETE",
        target.route,
        target.kind === "definition" ? target.body : undefined,
      );
      return say(printable(removed.statusLine));
    }
    default:
      return fail(`unknown resource command "${printable(verb)}" · try: add, list, remove`);
  }
};
