import { Equal, Schema } from "effect";

import {
  imageReference,
  presetDefinition,
  PresetVersion,
  RESOURCE_LIMIT_DEFAULTS,
  type ResourceDefinitionInput,
  ResourceName,
} from "./resource.ts";

/** A file declaration has no execution level. */
export type ResourceTableFields = Omit<ResourceDefinitionInput, "scope">;

/** The defaults an omitted preset command, port and volume receive from the file reader. */
export const resourceTablePresetDefaults = (
  preset: ResourceTableFields["preset"],
  image: string,
): Pick<ResourceTableFields, "command" | "ports" | "volumes"> | null => {
  const tag = imageReference(image).tag;
  if (preset === null || !Schema.is(PresetVersion)(tag)) return null;
  const input = {
    name: ResourceName.make("resource"),
    preset,
    version: PresetVersion.make(tag),
    scope: "project" as const,
  };
  return presetDefinition(input);
};

const quoted = (value: string): string => JSON.stringify(value).replaceAll("\u007f", "\\u007f");
const key = (value: string): string => (/^[A-Za-z0-9_-]+$/u.test(value) ? value : quoted(value));
const inline = (entries: ReadonlyArray<readonly [string, string]>): string =>
  entries.length === 0
    ? "{}"
    : `{ ${entries.map(([name, value]) => `${key(name)} = ${value}`).join(", ")} }`;
const argv = (values: ReadonlyArray<string>): string => `[${values.map(quoted).join(", ")}]`;

/** Render one compact TOML table, with reader defaults omitted and a final newline. */
export const resourceTableToml = (def: ResourceTableFields): string => {
  const defaults = resourceTablePresetDefaults(def.preset, def.image);
  const lines = [`[resource.${key(def.name)}]`];
  if (def.preset !== null) lines.push(`preset = ${quoted(def.preset)}`);
  lines.push(`image = ${quoted(def.image)}`);
  if (def.command !== null && !Equal.equals(def.command, defaults?.command)) {
    lines.push(`command = ${argv(def.command)}`);
  }
  if (!Equal.equals(def.ports, defaults?.ports ?? [])) {
    lines.push(
      `ports = ${inline(
        def.ports.map((port) => [
          port.name,
          port.protocol === "tcp"
            ? String(port.port)
            : inline([
                ["port", String(port.port)],
                ["protocol", quoted(port.protocol)],
              ]),
        ]),
      )}`,
    );
  }
  if (!Equal.equals(def.volumes, defaults?.volumes ?? [])) {
    lines.push(
      `volumes = ${inline(def.volumes.map((volume) => [volume.name, quoted(volume.mountPath)]))}`,
    );
  }
  if (Object.keys(def.env).length > 0) {
    lines.push(
      `env = ${inline(Object.entries(def.env).map(([name, value]) => [name, typeof value === "string" ? quoted(value) : inline([["secret", quoted(value.secret)]])]))}`,
    );
  }
  if (Object.keys(def.exports).length > 0) {
    lines.push(
      `exports = ${inline(Object.entries(def.exports).map(([name, value]) => [name, quoted(value)]))}`,
    );
  }
  const ready =
    def.preset !== null
      ? { kind: "preset" }
      : { kind: def.ports.some((port) => port.protocol === "tcp") ? "tcp" : "none" };
  if (!Equal.equals(def.ready, ready)) {
    lines.push(
      `ready = ${def.ready.kind === "command" ? inline([["command", argv(def.ready.argv)]]) : quoted(def.ready.kind)}`,
    );
  }
  const limits = (["cpu", "memoryMiB", "diskGiB"] as const)
    .filter((name) => def.limits[name] !== RESOURCE_LIMIT_DEFAULTS[name])
    .map((name) => [name, String(def.limits[name])] as const);
  if (limits.length > 0) lines.push(`limits = ${inline(limits)}`);
  return `${lines.join("\n")}\n`;
};
