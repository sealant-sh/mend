import { createHash } from "node:crypto";

import { T3_GATEWAY_VOLUME } from "./server-edge.ts";
import type { ServerSetupRuntime } from "./server-setup.ts";
import { ServerRefusal } from "./server-store.ts";

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

const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const COMPOSE_WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";

/** Inputs are the exact persisted identity.env bytes, never regenerated or normalized. */
export interface ServerVolumeOwnershipInput {
  readonly dockerContext: string;
  readonly identityBytes: Uint8Array;
  readonly namespace?: ServerDockerNamespace;
}

type ResourceKind = "container" | "network" | "volume";

/**
 * What an earlier Mend install left in a Docker engine, with no installation to own it: stopped
 * containers a generation started, the bundle's Compose networks with nothing attached, and
 * volumes that carry Mend's installation label or a bundle volume's Compose name. The volumes may
 * hold that install's data: its database, repositories and captures.
 */
export interface ServerLeftovers {
  readonly dockerContext: string;
  readonly containers: ReadonlyArray<string>;
  readonly networks: ReadonlyArray<string>;
  readonly volumes: ReadonlyArray<string>;
}

/** Something in a fresh install's way that is not an earlier install's leftover, and why. */
export interface ServerDataInTheWay {
  readonly dockerContext: string;
  readonly kind: ResourceKind;
  readonly name: string;
  /** Mend's by its labels, but something runs on it; false: not Mend's at all. */
  readonly mend: boolean;
  /** Why, as a clause: "carries no labels", "container x is attached to it". */
  readonly why: string;
}

/**
 * What stands where a fresh install's volumes go, before the anchor exists. In the way: every item
 * setup cannot install beside, and the leftovers beside them, if any.
 */
export type ServerOldData =
  | { readonly _tag: "leftovers"; readonly leftovers: ServerLeftovers }
  | {
      readonly _tag: "in-the-way";
      readonly inTheWay: readonly [ServerDataInTheWay, ...ReadonlyArray<ServerDataInTheWay>];
      readonly leftovers: ServerLeftovers | null;
    };

const namedAs = (kind: ResourceKind, names: ReadonlyArray<string>): ReadonlyArray<string> => {
  const [only] = names;
  if (only === undefined) return [];
  return [
    names.length === 1 ? `${kind} ${only}` : `${names.length} ${kind}s (${names.join(", ")})`,
  ];
};

/** Each kind of leftover in a few words: "network mend_default", "2 volumes (a, b)". */
export const leftoverItems = (leftovers: ServerLeftovers): ReadonlyArray<string> => [
  ...namedAs("container", leftovers.containers),
  ...namedAs("network", leftovers.networks),
  ...namedAs("volume", leftovers.volumes),
];

/** The command that removes an earlier install's leftovers from the engine they are in. */
export const leftoversRemoval = (dockerContext: string): string =>
  `DOCKER_CONTEXT=${dockerContext} mend uninstall --server`;

/** How to keep an earlier install's volumes instead: its identity owns them again. */
export const KEEP_THE_DATA =
  "To keep it, put that install's Mend config directory (identity.env and generations) back where it was and run mend server setup: setup takes up the volumes its identity owns.";

/** Why setup cannot install in this engine, in words: what is there, and what to do about it. */
export const serverOldDataWords = (found: ServerOldData): string => {
  const elsewhere = "install in another Docker context: mend server setup --context <name>.";
  if (found._tag === "leftovers") {
    const { leftovers } = found;
    const count =
      leftovers.containers.length + leftovers.networks.length + leftovers.volumes.length;
    const them = count === 1 ? "it" : "them";
    const volumes = leftovers.volumes.length;
    return (
      `Docker context ${leftovers.dockerContext} holds what an earlier Mend install left, and no installation owns ${them}: ${leftoverItems(leftovers).join(", ")}. ` +
      (volumes === 0
        ? ""
        : `The ${volumes === 1 ? "volume" : "volumes"} may hold that install's data, and removing ${volumes === 1 ? "it" : "them"} deletes that data. ${KEEP_THE_DATA} `) +
      `Setup does not install beside ${them}. To remove ${them}: ${leftoversRemoval(leftovers.dockerContext)}, then run mend server setup again.`
    );
  }
  const [first, ...more] = found.inTheWay;
  const { dockerContext } = first;
  const beside =
    found.leftovers === null
      ? ""
      : ` Beside ${more.length === 0 ? "it" : "them"}, what an earlier Mend install left: ${leftoverItems(found.leftovers).join(", ")}, which ${leftoversRemoval(dockerContext)} removes.`;
  if (more.length === 0) {
    const { kind, name, mend, why } = first;
    const look = `To see what it is: docker --context ${dockerContext} ${kind} inspect ${name}.`;
    return mend
      ? `Docker context ${dockerContext} has ${kind} ${name} from an earlier Mend install, with no installation to own it, and ${why}. Setup leaves it alone. ${look} Stop what runs there, then remove what that install left with ${leftoversRemoval(dockerContext)}, or ${elsewhere}${beside}`
      : `Docker context ${dockerContext} has a ${kind} named ${name} that is not Mend's: it ${why}. Setup leaves it alone and cannot install beside it. ${look} Remove it yourself if nothing needs it, or ${elsewhere}${beside}`;
  }
  const items = found.inTheWay;
  const mends = items.some((item) => item.mend);
  const foreign = items.some((item) => !item.mend);
  const each = items.map((item) =>
    item.mend
      ? `${item.kind} ${item.name}, from an earlier Mend install with no installation to own it: ${item.why}`
      : `${item.kind} ${item.name}, not Mend's: it ${item.why}`,
  );
  const looks = items.map(
    (item) => `docker --context ${dockerContext} ${item.kind} inspect ${item.name}`,
  );
  return (
    `Docker context ${dockerContext} has ${items.length} things setup cannot install beside: ${each.join("; ")}. Setup leaves them alone. To see what each is: ${looks.join(", ")}. ` +
    (mends
      ? `Stop what runs on Mend's, then remove what that install left with ${leftoversRemoval(dockerContext)}. `
      : "") +
    (foreign
      ? `Remove what is not Mend's yourself if nothing needs it, or ${elsewhere}`
      : `Or ${elsewhere}`) +
    beside
  );
};

/**
 * Ownership conflicts require recovery of the original config, not deletion or relabelling. Data
 * in a fresh install's way (`unowned-data`) is named instead: an earlier install's leftovers, with
 * the command that removes them, or what is not Mend's, with how to look at it.
 */
export class ServerVolumeOwnershipError extends ServerRefusal {
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
  /** With `unowned-data`: what stands in the way. */
  readonly found: ServerOldData | undefined;

  /** Construct an actionable ownership failure without including identity bytes. */
  constructor(
    reason: ServerVolumeOwnershipError["reason"],
    operation: string,
    found?: ServerOldData,
  ) {
    super(
      found !== undefined
        ? serverOldDataWords(found)
        : `Docker volume ownership check failed (${reason}, ${operation}). ` +
            (reason === "docker" || reason === "inspection"
              ? "Check Docker access and the selected context, then retry. No absence was assumed."
              : "Retain all Docker data. Restore the original Mend identity/configuration or choose a clean Docker daemon; do not delete or relabel existing data."),
    );
    this.reason = reason;
    this.operation = operation;
    this.found = found;
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
    ...(project === undefined ? [] : ["--filter", `label=${COMPOSE_PROJECT_LABEL}=${project}`]),
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

/** A Compose container a Mend generation started: its working directory is the generation's. */
export const GENERATION_DIRECTORY = /\/generations\/gen-[0-9a-f-]{36}$/;

/**
 * The bundle's own Compose volumes, as Compose names them under its project. Another Compose
 * project called mend (a checkout of Mend's own repository, say) has other volumes.
 */
export const bundleComposeVolumes = (project: string): ReadonlySet<string> =>
  new Set(
    [
      "mend-config",
      "mend-ssh",
      "mend-postgres",
      "mend-edge-data",
      "mend-edge-config",
      "mend-npm-mirror",
      "mend-docker-mirror",
      T3_GATEWAY_VOLUME,
    ].map((volume) => `${project}_${volume}`),
  );

/** The bundle's Compose networks: the project's default, and the edge's when it runs one. */
export const bundleNetworks = (project: string): ReadonlySet<string> =>
  new Set(["default", "edge"].map((network) => `${project}_${network}`));

interface Inspected {
  readonly labels: Readonly<Record<string, string>> | null;
  /** A container: whether it runs. */
  readonly running: boolean;
  /** A network: the containers attached to it, by name. */
  readonly attached: ReadonlyArray<string>;
}

// Project only the ownership evidence. Full container inspection also includes environment secrets.
const INSPECT_FORMAT: Readonly<Record<ResourceKind, string>> = {
  volume: "{{json .}}",
  container:
    '{"Name":{{json .Name}},"Labels":{{json .Config.Labels}},"Running":{{json .State.Running}}}',
  network: '{"Name":{{json .Name}},"Labels":{{json .Labels}},"Containers":{{json .Containers}}}',
};

const inspectResource = async (
  runtime: Runtime,
  context: string,
  kind: ResourceKind,
  name: string,
): Promise<Result<Inspected>> => {
  const output = await docker(runtime, context, [
    kind,
    "inspect",
    name,
    "--format",
    INSPECT_FORMAT[kind],
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
    const found = resource.Labels;
    let labels: Record<string, string> | null = null;
    if (found !== null) {
      if (typeof found !== "object" || Array.isArray(found))
        return fail("inspection", `${kind} labels`);
      labels = {};
      for (const [key, value] of Object.entries(found)) {
        if (typeof value !== "string") return fail("inspection", `${kind} labels`);
        labels[key] = value;
      }
    }
    let running = false;
    if (kind === "container") {
      if (!("Running" in resource) || typeof resource.Running !== "boolean")
        return fail("inspection", "container state");
      running = resource.Running;
    }
    const attached: Array<string> = [];
    if (kind === "network") {
      const containers = "Containers" in resource ? resource.Containers : undefined;
      if (containers === undefined || typeof containers !== "object" || Array.isArray(containers))
        return fail("inspection", "network containers");
      for (const [id, endpoint] of Object.entries(containers ?? {})) {
        const endpointName: unknown =
          typeof endpoint === "object" && endpoint !== null && "Name" in endpoint
            ? endpoint.Name
            : undefined;
        attached.push(typeof endpointName === "string" ? endpointName : id.slice(0, 12));
      }
    }
    return { _tag: "ok", value: { labels, running, attached } };
  } catch {
    return fail("inspection", `${kind} inspect`);
  }
};

/** Why a resource with a reserved or bundle name is not Mend's, as a clause after "it". */
const notMendsWhy = (
  labels: Readonly<Record<string, string>> | null,
  kind: ResourceKind,
  project: string,
): string => {
  if (labels === null || Object.keys(labels).length === 0) return "carries no labels";
  const owner = labels[COMPOSE_PROJECT_LABEL];
  if (owner === undefined)
    return kind === "volume" ? "carries no Mend label" : "carries no Compose project label";
  if (owner !== project) return `belongs to Compose project ${owner}`;
  return kind === "container"
    ? `carries Compose project label ${project}, but no Mend install started it`
    : `carries Compose project label ${project}, but no Mend install makes a ${kind} by that name`;
};

/**
 * Sort what stands where a fresh install's volumes go: an earlier install's leftovers (Mend's by
 * its labels, nothing running on them), or the first thing in the way that is not, with why.
 * Reads only; an inspection that cannot say is an error, never absence.
 */
const findOldData = async (
  runtime: Runtime,
  context: string,
  namespace: ServerDockerNamespace,
  volumes: ReadonlyArray<string>,
): Promise<Result<ServerOldData | null>> => {
  const project = namespace.project;
  const left: Record<ResourceKind, Array<string>> = { container: [], network: [], volume: [] };
  const inTheWay: Array<ServerDataInTheWay> = [];
  const refuse = (kind: ResourceKind, name: string, mend: boolean, why: string): void => {
    inTheWay.push({ dockerContext: context, kind, name, mend, why });
  };

  // Volumes: the bundle's names, and whatever carries the project's label.
  const projectVolumes = await listNames(runtime, context, "volume", project);
  if (projectVolumes._tag === "error") return projectVolumes;
  const bundleVolumes = bundleComposeVolumes(project);
  const candidates = new Set([
    ...volumes.filter(
      (name) => secondaryVolumesOf(namespace).includes(name) || name.startsWith(`${project}_`),
    ),
    ...projectVolumes.value,
  ]);
  for (const name of candidates) {
    const inspected = await inspectResource(runtime, context, "volume", name);
    if (inspected._tag === "error") return inspected;
    const { labels } = inspected.value;
    if (
      labels?.[SERVER_VOLUME_OWNER_LABEL] !== undefined ||
      (labels?.[COMPOSE_PROJECT_LABEL] === project && bundleVolumes.has(name))
    )
      left.volume.push(name);
    else refuse("volume", name, false, notMendsWhy(labels, "volume", project));
  }

  // Containers and networks with the project's label: a generation's stopped containers and the
  // bundle's networks with nothing attached are leftovers; anything else of the project's is not.
  const networks = bundleNetworks(project);
  for (const kind of ["container", "network"] as const) {
    const labelled = await listNames(runtime, context, kind, project);
    if (labelled._tag === "error") return labelled;
    for (const name of labelled.value) {
      const inspected = await inspectResource(runtime, context, kind, name);
      if (inspected._tag === "error") return inspected;
      const { labels, running, attached } = inspected.value;
      if (kind === "container") {
        if (!GENERATION_DIRECTORY.test(labels?.[COMPOSE_WORKING_DIR_LABEL] ?? ""))
          refuse(kind, name, false, notMendsWhy(labels, kind, project));
        else if (running) refuse(kind, name, true, "it is running");
        else left.container.push(name);
      } else if (!networks.has(name)) refuse(kind, name, false, notMendsWhy(labels, kind, project));
      else if (attached.length > 0)
        refuse(
          kind,
          name,
          true,
          `${namedAs("container", attached).join("")} ${attached.length === 1 ? "is" : "are"} attached to it`,
        );
      else left.network.push(name);
    }
    // Then by name: the bundle's reserved names, and the project's prefix unless another project
    // proves the name its own.
    const named = await listNames(runtime, context, kind);
    if (named._tag === "error") return named;
    for (const name of named.value) {
      if (labelled.value.includes(name)) continue;
      const reserved = reservedResourceName(name, kind, namespace);
      if (!reserved && !name.startsWith(`${project}_`) && !name.startsWith(`${project}-`)) continue;
      const inspected = await inspectResource(runtime, context, kind, name);
      if (inspected._tag === "error") return inspected;
      const { labels } = inspected.value;
      const owner = labels?.[COMPOSE_PROJECT_LABEL];
      if (owner !== undefined && !/^[a-z0-9][a-z0-9_-]*$/.test(owner))
        return fail("inspection", `${kind} project label`);
      if (reserved || owner === undefined || owner === project || !inProjectNamespace(name, owner))
        refuse(kind, name, false, notMendsWhy(labels, kind, project));
    }
  }

  const leftovers: ServerLeftovers | null =
    left.container.length + left.network.length + left.volume.length === 0
      ? null
      : {
          dockerContext: context,
          containers: left.container,
          networks: left.network,
          volumes: left.volume,
        };
  const [first, ...more] = inTheWay;
  if (first !== undefined)
    return { _tag: "ok", value: { _tag: "in-the-way", inTheWay: [first, ...more], leftovers } };
  return { _tag: "ok", value: leftovers === null ? null : { _tag: "leftovers", leftovers } };
};

const refuseOldData = async (
  runtime: Runtime,
  context: string,
  namespace: ServerDockerNamespace,
  volumes: ReadonlyArray<string>,
): Promise<Result<void>> => {
  const found = await findOldData(runtime, context, namespace, volumes);
  if (found._tag === "error") return found;
  if (found.value === null) return { _tag: "ok", value: undefined };
  return {
    _tag: "error",
    error: new ServerVolumeOwnershipError(
      "unowned-data",
      found.value._tag === "leftovers"
        ? "leftovers without anchor"
        : `existing ${found.value.inTheWay[0].kind} without anchor`,
      found.value,
    ),
  };
};

/** What `findServerOldData` read: what stands in the way, nothing (null), or why it could not say. */
export type ServerOldDataResult =
  | { readonly _tag: "ok"; readonly value: ServerOldData | null }
  | { readonly _tag: "error"; readonly error: ServerVolumeOwnershipError };

/**
 * What stands in a fresh install's way in a Docker engine: an earlier install's leftovers, something
 * else, or nothing (null). Null as well when the anchor exists: that is an installation, and the
 * claim decides whose. Reads only. The namespace with Garage by default: a bundle without it never
 * makes that volume, so one there is an install's all the same.
 */
export const findServerOldData = async (
  runtime: Runtime,
  dockerContext: string,
  namespace: ServerDockerNamespace = MEND_DOCKER_NAMESPACE_WITH_GARAGE,
): Promise<ServerOldDataResult> => {
  const volumes = await listNames(runtime, dockerContext, "volume");
  if (volumes._tag === "error") return volumes;
  if (volumes.value.includes(namespace.store)) return { _tag: "ok", value: null };
  return findOldData(runtime, dockerContext, namespace, volumes.value);
};

/**
 * Remove an earlier install's leftovers as `findServerOldData` named them, on the person's word:
 * its stopped containers with their anonymous volumes, then its networks, then its volumes and
 * what they hold. Each kind is said as it goes; what Docker refused comes back in words. A
 * container that started since is refused by Docker (no `--force`), never stopped here.
 */
export const removeServerLeftovers = async (
  runtime: Runtime,
  leftovers: ServerLeftovers,
  write: (line: string) => void,
): Promise<ReadonlyArray<string>> => {
  const failures: Array<string> = [];
  const context = leftovers.dockerContext;
  const kinds = [
    ["container", leftovers.containers],
    ["network", leftovers.networks],
    ["volume", leftovers.volumes],
  ] as const;
  for (const [kind, names] of kinds) {
    const removed: Array<string> = [];
    for (const name of names) {
      const args = kind === "container" ? ["container", "rm", "-v", name] : [kind, "rm", name];
      try {
        const output = await runtime.run("docker", ["--context", context, ...args]);
        if (output.status === 0 && output.error === undefined) removed.push(name);
        else
          failures.push(
            `could not remove ${kind} ${name}: ${(output.error ?? output.stderr.trim()) || "no output"}`,
          );
      } catch (cause) {
        failures.push(
          `could not remove ${kind} ${name}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
    if (removed.length > 0)
      write(`removed ${kind}${removed.length === 1 ? "" : "s"} ${removed.join(", ")}`);
  }
  return failures;
};

/** The installation label's value for an identity: the hash of its exact persisted bytes. */
export const serverVolumeOwner = (identityBytes: Uint8Array): string =>
  createHash("sha256").update(identityBytes).digest("hex");

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
  const owner = serverVolumeOwner(input.identityBytes);
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
