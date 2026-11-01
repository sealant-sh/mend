import { Schema } from "effect";

import { WorktreeId } from "../ids.ts";
import {
  type WorktreeChoice,
  type ResourceLevel,
  ResourceDefinition,
  ResourceName,
  ResourcePreset,
  PresetVersion,
  presetDefinition,
  RESOURCE_LIMIT_DEFAULTS,
} from "./resource.ts";

/** Selectors, add fields and load flags consume a following argument. Level flags are bare. */
export const RESOURCE_VALUE_FLAGS: ReadonlyArray<string> = [
  "--project-id",
  "--worktree-id",
  "--target",
  "--from",
  "--pull",
  "--preset",
  "--version",
  "--image",
  "--port",
];
/** Positional resource command arguments, excluding selector values. */
export const resourcePositionals = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args.filter(
    (arg, index) => !arg.startsWith("--") && !RESOURCE_VALUE_FLAGS.includes(args[index - 1] ?? ""),
  );
/** Explicit level, or none. Callers refuse conflicting level flags. */
export const resourceLevelFlag = (args: ReadonlyArray<string>): ResourceLevel | null =>
  args.includes("--project") ? "project" : args.includes("--worktree") ? "worktree" : null;
/** Postgres's shared/own words are accepted aliases for the two levels. */
export const resourceChoiceOf = (value: string): WorktreeChoice | null =>
  value === "shared"
    ? "project"
    : value === "own"
      ? "worktree"
      : value === "project" || value === "worktree" || value === "off"
        ? value
        : null;
/** Non-interactive starts must make their level explicit. */
export const resourceLevelHint = (name: string): string =>
  `choose a level: mend resource start ${name} --project or --worktree`;
/** An add declares a preset or a whole image definition, without choosing an execution level. */
export const ResourceAddition = Schema.Union([
  Schema.Struct({ name: ResourceName, preset: ResourcePreset, version: PresetVersion }),
  ResourceDefinition,
]);
export type ResourceAddition = typeof ResourceAddition.Type;
export const ResourceAddRequest = Schema.Struct({
  worktreeId: Schema.NullOr(WorktreeId),
  definition: ResourceAddition,
});
export type ResourceAddRequest = typeof ResourceAddRequest.Type;
/** A preset and a whole definition share one validation and rendering path. */
export const resourceAdditionDefinition = (input: ResourceAddition): ResourceDefinition =>
  "version" in input ? presetDefinition(input) : input;

const additionRefused = (message: string) => ({ ok: false as const, message });

/** Parses CLI/helper add flags; all callers send the same API body. */
export const resourceAdditionOf = (
  args: ReadonlyArray<string>,
):
  | { readonly ok: true; readonly definition: ResourceAddition }
  | { readonly ok: false; readonly message: string } => {
  const allowed = ["--preset", "--version", "--image", "--port", "--project-id", "--worktree-id"];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith("--") !== true) continue;
    if (!allowed.includes(arg)) return additionRefused(`unknown add flag: ${arg}`);
    if (args[i + 1] === undefined || args[i + 1]?.startsWith("--"))
      return additionRefused(`${arg} needs a value`);
    i++;
  }
  const names = resourcePositionals(args);
  const name = names[0];
  if (names.length !== 1 || !Schema.is(ResourceName)(name))
    return additionRefused(
      "name the resource: mend resource add db --preset postgres --version 17",
    );
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  const preset = args.includes("--preset") ? value("--preset") : undefined;
  if (preset !== undefined) {
    if (args.includes("--image") || args.includes("--port"))
      return additionRefused("choose --preset with --version, or --image with --port");
    const version = args.includes("--version") ? value("--version") : undefined;
    if (!Schema.is(ResourcePreset)(preset))
      return additionRefused("--preset is postgres, redis or mysql");
    if (!Schema.is(PresetVersion)(version))
      return additionRefused("--version needs an image tag starting with its major version");
    return { ok: true, definition: { name, preset, version } };
  }
  if (args.includes("--version")) return additionRefused("--version needs --preset");
  const ports = args.flatMap((arg, i) => {
    if (arg !== "--port") return [];
    const match = /^([^=]+)=([0-9]+)(?:\/(tcp|udp))?$/.exec(args[i + 1] ?? "");
    return match === null
      ? [{ name: "", port: 0, protocol: "tcp" }]
      : [
          {
            name: match[1],
            port: Number(match[2]),
            protocol: match[3] ?? "tcp",
          },
        ];
  });
  const definition = {
    name,
    preset: null,
    image: args.includes("--image") ? value("--image") : undefined,
    command: null,
    ports,
    volumes: [],
    env: {},
    exports: {},
    limits: RESOURCE_LIMIT_DEFAULTS,
    ready: { kind: ports.some((port) => port.protocol === "tcp") ? "tcp" : "none" },
  };
  if (!Schema.is(ResourceDefinition)(definition))
    return additionRefused("use --image <ref> --port name=port[/udp] (ports 1–65535)");
  return { ok: true, definition };
};

/** Every add outcome carries the rendered table, including copy-only previews. */
export const ResourceAdded = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("written"),
    path: Schema.String,
    worktree: Schema.String,
    table: Schema.String,
    statusLine: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("declared"),
    path: Schema.String,
    table: Schema.String,
    statusLine: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("unparsed"),
    path: Schema.String,
    message: Schema.String,
    table: Schema.String,
    statusLine: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("unreachable"),
    reason: Schema.String,
    table: Schema.String,
    statusLine: Schema.String,
  }),
]);
export type ResourceAdded = typeof ResourceAdded.Type;
/** Lines shared by the helper and CLI; the table retains its newlines. */
export const resourceAddedLines = (answer: ResourceAdded): ReadonlyArray<string> =>
  answer.kind === "unreachable"
    ? [answer.statusLine, ...answer.table.trimEnd().split("\n")]
    : [answer.statusLine];
