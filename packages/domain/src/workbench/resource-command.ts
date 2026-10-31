import { RESOURCE_PRESETS, type ResourcePreset } from "./resource.ts";

/**
 * `mend resource add`'s arguments, read the same way on a person's machine and by the helper in a
 * session (ADR 0019, story 8): a preset at a version, or an image with its ports.
 */

const isPreset = (value: string): value is ResourcePreset => Object.hasOwn(RESOURCE_PRESETS, value);

const flagValue = (args: ReadonlyArray<string>, flag: string): string | null => {
  const at = args.indexOf(flag);
  if (at === -1) return null;
  const next = args[at + 1];
  return next === undefined || next.startsWith("--") ? null : next;
};

/** `smtp=1025` or `dns=53/udp`. */
const portOf = (raw: string) => {
  const match = /^([a-z][a-z0-9-]*)=(\d+)(?:\/(tcp|udp))?$/.exec(raw);
  if (match === null) return null;
  const [, name = "", port = "", protocol = "tcp"] = match;
  return { name, port: Number(port), protocol };
};

const repeated = (args: ReadonlyArray<string>, flag: string): ReadonlyArray<string> =>
  args.flatMap((arg, index) => (arg === flag ? [args[index + 1] ?? ""] : []));

/** Every flag of `mend resource` that takes a value. */
export const RESOURCE_VALUE_FLAGS: ReadonlyArray<string> = [
  "--project",
  "--worktree",
  "--preset",
  "--version",
  "--image",
  "--port",
  "--scope",
  "--definition",
  "--target",
];

/** The arguments that are not flags or a flag's value. */
export const resourcePositionals = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args.filter(
    (arg, index) => !arg.startsWith("--") && !RESOURCE_VALUE_FLAGS.includes(args[index - 1] ?? ""),
  );

/** The body `mend resource add` sends, or why the arguments name none. */
export const resourceAdditionOf = (
  args: ReadonlyArray<string>,
):
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly message: string } => {
  const [name] = resourcePositionals(args);
  if (name === undefined)
    return {
      ok: false,
      message: "name the resource: mend resource add db --preset postgres --version 17",
    };
  const scope = flagValue(args, "--scope") ?? "project";
  if (scope !== "project" && scope !== "worktree") {
    return { ok: false, message: "--scope is project or worktree" };
  }
  const preset = flagValue(args, "--preset");
  const image = flagValue(args, "--image");
  if ((preset === null) === (image === null)) {
    return {
      ok: false,
      message:
        "pass one of --preset <postgres|redis|mysql> --version <v>, --image <ref> --port <name>=<port>, or --from-file --worktree <w>",
    };
  }
  if (preset !== null) {
    if (!isPreset(preset))
      return { ok: false, message: `--preset is ${Object.keys(RESOURCE_PRESETS).join(", ")}` };
    const version = flagValue(args, "--version");
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
