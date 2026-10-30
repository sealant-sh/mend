import type { ResourceDefinitionInput } from "./resource.ts";

/** One row of an approval's review: what it names, and its value as the definition stores it. */
export interface ResourceReviewRow {
  readonly label: string;
  readonly value: string;
}

/** A free-text value with its boundaries kept: JSON quotes it and escapes what it holds. */
const quoted = (text: string) => JSON.stringify(text);

/** An argument vector element by element, so `["sh", "-c", "a b"]` never reads as four. */
const argv = (args: ReadonlyArray<string>) => JSON.stringify(args);

/**
 * Every field of a definition that runs, as an approver reviews it before approving, one row per
 * env entry, volume and export, every free-text value quoted; then the digest the approval
 * approves (ADR 0019, "Approving a definition"). Each client shows these rows, so two different
 * specs never review alike.
 */
export const resourceReviewRows = (
  spec: ResourceDefinitionInput,
  digest: string,
): ReadonlyArray<ResourceReviewRow> => [
  { label: "image", value: spec.image },
  { label: "scope", value: spec.scope },
  ...(spec.command === null ? [] : [{ label: "command", value: argv(spec.command) }]),
  ...spec.ports.map((port) => ({
    label: `port ${port.name}`,
    value: `${port.port}/${port.protocol}`,
  })),
  ...spec.volumes.map((volume) => ({
    label: `volume ${volume.name}`,
    value: quoted(volume.mountPath),
  })),
  ...Object.entries(spec.env).map(([name, value]) => ({
    label: `env ${name}`,
    value: typeof value === "string" ? quoted(value) : `secret ${quoted(value.secret)}`,
  })),
  {
    label: "limits",
    value: `${spec.limits.cpu} CPU · ${spec.limits.memoryMiB} MiB memory · ${spec.limits.diskGiB} GiB disk`,
  },
  {
    label: "ready",
    value: spec.ready.kind === "command" ? argv(spec.ready.argv) : spec.ready.kind,
  },
  ...Object.entries(spec.exports).map(([name, template]) => ({
    label: `export ${name}`,
    value: quoted(template),
  })),
  { label: "definition digest", value: `sha256:${digest}` },
];
