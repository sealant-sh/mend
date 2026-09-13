import { createHash } from "node:crypto";

import type { ServerSetupRuntime } from "./server-setup.ts";

/** Concrete daemon names. Override together only for an isolated deployment or integration test. */
export interface ServerDockerNamespace {
  readonly project: string;
  readonly store: string;
  readonly control: string;
  /**
   * The capture store's bucket volume — every session's captures. Present only for a generation
   * whose bundle carries Garage; an install from before the capture store verifies without it,
   * and the upgrade that brings Garage claims it beside the anchor.
   */
  readonly garage?: string;
}

/** Production names from the Docker deployment contract. */
export const MEND_DOCKER_NAMESPACE: ServerDockerNamespace = {
  project: "mend",
  store: "mend-store",
  control: "mend-control",
};

/** The production names for a generation whose bundle carries the Garage bucket. */
export const MEND_DOCKER_NAMESPACE_WITH_GARAGE: ServerDockerNamespace = {
  ...MEND_DOCKER_NAMESPACE,
  garage: "mend-garage",
};

/** The volumes a namespace owns beside the anchor, in claim order. */
export const secondaryVolumesOf = (namespace: ServerDockerNamespace): ReadonlyArray<string> =>
  namespace.garage === undefined ? [namespace.control] : [namespace.control, namespace.garage];

/** The label is immutable after Docker's atomic named-volume creation. */
export const SERVER_VOLUME_OWNER_LABEL = "dev.sealant.mend.installation";

/** Inputs are the exact persisted identity.env bytes, never regenerated or normalized. */
export interface ServerVolumeOwnershipInput {
  readonly dockerContext: string;
  readonly identityBytes: Uint8Array;
  readonly namespace?: ServerDockerNamespace;
}

/** Ownership conflicts require recovery of the original config, not deletion or relabelling. */
export class ServerVolumeOwnershipError extends Error {
  /** Stable error discriminator. */
  readonly _tag = "ServerVolumeOwnershipError" as const;

  /** Distinguishes absent state from an inspection that could not establish absence. */
  readonly reason:
    | "invalid-input"
    | "missing"
    | "conflict"
    | "unowned-data"
    | "docker"
    | "inspection";
  /** Safe operation name, never credentials or raw Docker output. */
  readonly operation: string;

  /** Construct an actionable ownership failure without including identity bytes. */
  constructor(reason: ServerVolumeOwnershipError["reason"], operation: string) {
    super(
      `Docker volume ownership check failed (${reason}, ${operation}). ` +
        (reason === "docker" || reason === "inspection"
          ? "Check Docker access and the selected context, then retry. No absence was assumed."
          : "Retain all Docker data. Restore the original Mend identity/configuration or choose a clean Docker daemon; do not delete or relabel existing data."),
    );
    this.reason = reason;
    this.operation = operation;
  }
}

/** Expected conflicts and Docker failures are values. No secret bytes appear in results. */
export type ServerVolumeOwnershipResult =
  | {
      readonly _tag: "ok";
      readonly value: { readonly owner: string; readonly namespace: ServerDockerNamespace };
    }
  | { readonly _tag: "error"; readonly error: ServerVolumeOwnershipError };

type Result<T> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "error"; readonly error: ServerVolumeOwnershipError };
type Runtime = Pick<ServerSetupRuntime, "run">;

const fail = (reason: ServerVolumeOwnershipError["reason"], operation: string) =>
  ({ _tag: "error", error: new ServerVolumeOwnershipError(reason, operation) }) as const;

const docker = async (
  runtime: Runtime,
  context: string,
  args: ReadonlyArray<string>,
): Promise<Result<string>> => {
  try {
    const output = await runtime.run("docker", ["--context", context, ...args]);
    if (output.status !== 0 || output.error !== undefined)
      return fail("docker", args.slice(0, 2).join(" "));
    return { _tag: "ok", value: output.stdout };
  } catch {
    // Runtime adapters may reject on transport errors. Never reinterpret them as a missing volume.
    return fail("docker", args.slice(0, 2).join(" "));
  }
};

const listNames = async (
  runtime: Runtime,
  context: string,
  kind: "volume" | "container" | "network",
  project?: string,
): Promise<Result<ReadonlyArray<string>>> => {
  const field = kind === "container" ? "Names" : "Name";
  const output = await docker(runtime, context, [
    kind,
    "ls",
    ...(kind === "container" ? ["--all"] : []),
    ...(project === undefined ? [] : ["--filter", `label=com.docker.compose.project=${project}`]),
    "--format",
    `{{json .${field}}}`,
  ]);
  if (output._tag === "error") return output;
  const names: string[] = [];
  try {
    for (const line of output.value.trim().split("\n").filter(Boolean)) {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value))
        return fail("inspection", `${kind} list`);
      names.push(value);
    }
  } catch {
    return fail("inspection", `${kind} list`);
  }
  return { _tag: "ok", value: names };
};

const inspectOwner = async (
  runtime: Runtime,
  context: string,
  name: string,
  owner: string,
): Promise<Result<void>> => {
  const output = await docker(runtime, context, [
    "volume",
    "inspect",
    name,
    "--format",
    "{{json .}}",
  ]);
  if (output._tag === "error") return output;
  try {
    const volume: unknown = JSON.parse(output.value);
    if (
      typeof volume !== "object" ||
      volume === null ||
      !("Name" in volume) ||
      volume.Name !== name ||
      !("Labels" in volume)
    )
      return fail("inspection", "volume inspect");
    const labels = volume.Labels;
    if (labels === null) return fail("conflict", "volume owner");
    if (
      typeof labels !== "object" ||
      Array.isArray(labels) ||
      !Object.values(labels).every((v) => typeof v === "string")
    )
      return fail("inspection", "volume labels");
    if (!(SERVER_VOLUME_OWNER_LABEL in labels) || labels[SERVER_VOLUME_OWNER_LABEL] !== owner)
      return fail("conflict", "volume owner");
    return { _tag: "ok", value: undefined };
  } catch {
    return fail("inspection", "volume inspect");
  }
};

const ensureVolume = async (
  runtime: Runtime,
  context: string,
  name: string,
  owner: string,
): Promise<Result<void>> => {
  // Engine create is atomic by name and does NOT update labels on an existing volume.
  // The return value/name is not ownership evidence: only the subsequent inspect is.
  const created = await docker(runtime, context, [
    "volume",
    "create",
    "--label",
    `${SERVER_VOLUME_OWNER_LABEL}=${owner}`,
    name,
  ]);
  if (created._tag === "error") return created;
  return inspectOwner(runtime, context, name, owner);
};

const inProjectNamespace = (name: string, project: string): boolean =>
  ["-", "_"].some(
    (separator) => name.startsWith(`${project}${separator}`) && name.length > project.length + 1,
  );

const reservedResourceName = (
  name: string,
  kind: "container" | "network",
  namespace: ServerDockerNamespace,
): boolean => {
  if (
    [namespace.project, namespace.store, namespace.control, namespace.garage ?? ""].includes(name)
  )
    return true;
  // Reserve the bundle's service names, replicas, one-offs and default network, including legacy
  // Compose separators. The project label "mend-postgres" must not excuse "mend-postgres-1".
  return ["-", "_"].some((separator) =>
    (kind === "container" ? ["mend", "postgres", "garage"] : ["default"]).some((service) => {
      const reserved = `${namespace.project}${separator}${service}`;
      return (
        name === reserved ||
        (kind === "container" &&
          name.startsWith(reserved) &&
          /^[-_](?:[0-9]+|run[-_][a-f0-9]+)$/.test(name.slice(reserved.length)))
      );
    }),
  );
};

const inspectForeignProject = async (
  runtime: Runtime,
  context: string,
  kind: "container" | "network",
  name: string,
  project: string,
): Promise<Result<void>> => {
  // Project only the ownership evidence. Full container inspection also includes environment secrets.
  const output = await docker(runtime, context, [
    kind,
    "inspect",
    name,
    "--format",
    `{"Name":{{json .Name}},"Labels":{{json .${kind === "container" ? "Config.Labels" : "Labels"}}}}`,
  ]);
  if (output._tag === "error") return output;
  try {
    const resource: unknown = JSON.parse(output.value);
    if (
      typeof resource !== "object" ||
      resource === null ||
      !("Name" in resource) ||
      resource.Name !== (kind === "container" ? `/${name}` : name) ||
      !("Labels" in resource)
    )
      return fail("inspection", `${kind} inspect`);
    const labels = resource.Labels;
    if (labels === null) return fail("unowned-data", `existing ${kind} without anchor`);
    if (
      typeof labels !== "object" ||
      Array.isArray(labels) ||
      !Object.values(labels).every((value) => typeof value === "string")
    )
      return fail("inspection", `${kind} labels`);
    if (!("com.docker.compose.project" in labels))
      return fail("unowned-data", `existing ${kind} without anchor`);
    const foreignProject = labels["com.docker.compose.project"];
    if (typeof foreignProject !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(foreignProject))
      return fail("inspection", `${kind} project label`);
    if (foreignProject === project || !inProjectNamespace(name, foreignProject))
      return fail("unowned-data", `existing ${kind} without anchor`);
    return { _tag: "ok", value: undefined };
  } catch {
    return fail("inspection", `${kind} inspect`);
  }
};

const refuseOldData = async (
  runtime: Runtime,
  context: string,
  namespace: ServerDockerNamespace,
  volumes: ReadonlyArray<string>,
): Promise<Result<void>> => {
  if (
    volumes.some(
      (name) =>
        secondaryVolumesOf(namespace).includes(name) || name.startsWith(`${namespace.project}_`),
    )
  )
    return fail("unowned-data", "existing volumes without anchor");
  for (const kind of ["volume", "container", "network"] as const) {
    const labelled = await listNames(runtime, context, kind, namespace.project);
    if (labelled._tag === "error") return labelled;
    if (labelled.value.length > 0) return fail("unowned-data", `existing ${kind} without anchor`);
    if (kind !== "volume") {
      const named = await listNames(runtime, context, kind);
      if (named._tag === "error") return named;
      for (const name of named.value) {
        if (reservedResourceName(name, kind, namespace))
          return fail("unowned-data", `existing ${kind} without anchor`);
        if (name.startsWith(`${namespace.project}_`) || name.startsWith(`${namespace.project}-`)) {
          const foreign = await inspectForeignProject(
            runtime,
            context,
            kind,
            name,
            namespace.project,
          );
          if (foreign._tag === "error") return foreign;
        }
      }
    }
  }
  return { _tag: "ok", value: undefined };
};

const parseOwnershipInput = (input: ServerVolumeOwnershipInput): ServerVolumeOwnershipResult => {
  const namespace = input.namespace ?? MEND_DOCKER_NAMESPACE;
  if (
    !input.dockerContext.trim() ||
    input.identityBytes.byteLength === 0 ||
    !/^[a-z0-9][a-z0-9_-]*$/.test(namespace.project) ||
    ![namespace.store, ...secondaryVolumesOf(namespace)].every((name) =>
      /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name),
    ) ||
    new Set([namespace.store, ...secondaryVolumesOf(namespace)]).size !==
      1 + secondaryVolumesOf(namespace).length
  )
    return fail("invalid-input", "ownership inputs");
  const owner = createHash("sha256").update(input.identityBytes).digest("hex");
  return { _tag: "ok", value: { owner, namespace } };
};

const ownership = async (
  runtime: Runtime,
  input: ServerVolumeOwnershipInput,
  mode: "claim" | "verify",
): Promise<ServerVolumeOwnershipResult> => {
  const parsed = parseOwnershipInput(input);
  if (parsed._tag === "error") return parsed;
  const { owner, namespace } = parsed.value;
  const volumes = await listNames(runtime, input.dockerContext, "volume");
  if (volumes._tag === "error") return volumes;
  if (volumes.value.includes(namespace.store)) {
    const anchor = await inspectOwner(runtime, input.dockerContext, namespace.store, owner);
    if (anchor._tag === "error") return anchor;
  } else {
    if (mode === "verify") return fail("missing", "anchor");
    const empty = await refuseOldData(runtime, input.dockerContext, namespace, volumes.value);
    if (empty._tag === "error") return empty;
    const anchor = await ensureVolume(runtime, input.dockerContext, namespace.store, owner);
    if (anchor._tag === "error") return anchor;
  }
  // No Docker mutation other than the anchor claim may precede ownership verification.
  const current = await listNames(runtime, input.dockerContext, "volume");
  if (current._tag === "error") return current;
  for (const name of secondaryVolumesOf(namespace)) {
    const role = name === namespace.control ? "control" : "garage";
    if (current.value.includes(name)) {
      const owned = await inspectOwner(runtime, input.dockerContext, name, owner);
      if (owned._tag === "error") return owned;
    } else {
      if (mode === "verify") return fail("missing", role);
      const created = await ensureVolume(runtime, input.dockerContext, name, owner);
      if (created._tag === "error") return created;
    }
  }
  return { _tag: "ok", value: { owner, namespace } };
};

/**
 * Call AFTER persisting write-once identity and a complete generation, BEFORE any other Docker
 * mutation or Compose command. Atomic anchor creation selects one identity across config dirs.
 * This never adopts, deletes, or relabels data. Retry with the same persisted bytes after failure.
 * The filesystem lock still serializes operations sharing that identity; labels are not a mutex.
 */
export const claimServerDockerVolumes = (
  runtime: Runtime,
  input: ServerVolumeOwnershipInput,
): Promise<ServerVolumeOwnershipResult> => ownership(runtime, input, "claim");

/** Read-only lifecycle gate. Missing anchor/control is an error, never an allocation from status/logs. */
export const verifyServerDockerVolumes = (
  runtime: Runtime,
  input: ServerVolumeOwnershipInput,
): Promise<ServerVolumeOwnershipResult> => ownership(runtime, input, "verify");
