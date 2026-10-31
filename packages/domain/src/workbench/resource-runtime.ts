import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import type { ProjectId, ResourceDefinitionId, WorktreeId } from "../ids.ts";
import {
  choiceInEffect,
  type ResourceBinding,
  type ResourceDefinitionInput,
  resourceEnvPrefix,
  type ResourceName,
  scopePolicyFor,
  type WorktreeChoice,
} from "./resource.ts";

/**
 * How Mend runs a resource on Sealant and what every process in a worktree is told of it (ADR
 * 0019, amendment of 2026-10-31). Pure: the `Resources` service reads the rows, these decide.
 */

/** The database `shared` names on a project Postgres, and the one a worktree Postgres serves. */
export const SHARED_DATABASE = "app";

/** The one login on every Postgres; the reach network is the access boundary, so it has no password. */
export const POSTGRES_USER = "postgres";

/** Every Postgres gets a volume here: dumps live beside the data they protect. */
export const DUMPS_MOUNT = "/mend/dumps";

/** An instance no live workspace reaches for this long stops, and keeps its volumes. */
export const RESOURCE_IDLE_STOP_SECONDS = 1800;

/** `own_` and 12 hex: a database name Postgres takes unquoted, and a shell argument as it is. */
export const OWN_DATABASE = /^own_[0-9a-f]{12}$/;

/**
 * A worktree's own database on its project's Postgres: `own_<12 hex of sha256(worktreeId)>`.
 * Derived, never stored, so a switch back to own always lands on the same data.
 */
export const ownDatabaseName = (worktreeId: WorktreeId): string =>
  `own_${bytesToHex(sha256(utf8ToBytes(worktreeId))).slice(0, 12)}`;

/** The Sealant scope a project's resources run in. */
export const resourceScopeKey = (projectId: ProjectId): string => `mend:${projectId}`;

/** Sealant's key for an instance: the definition's id, and `@<worktree id>` for a worktree resource. */
export const resourceInstanceKey = (
  definitionId: ResourceDefinitionId,
  worktreeId: WorktreeId | null,
): string => (worktreeId === null ? definitionId : `${definitionId}@${worktreeId}`);

/**
 * What Sealant runs for an instance: `@sealant/sdk`'s `ScopeInstanceSpec`, field for field. It has
 * no field for privileged mode, capabilities, host networking or paths, devices or the Docker
 * socket, so a definition cannot ask for one.
 */
export interface ResourceInstanceSpec {
  readonly alias: string;
  readonly worktreeKey: string | null;
  readonly image: string;
  readonly command: ReadonlyArray<string> | null;
  readonly env: Readonly<Record<string, string>>;
  readonly volumes: ReadonlyArray<{ readonly name: string; readonly mountPath: string }>;
  readonly limits: { readonly cpuMillicores: number; readonly memoryBytes: number };
  readonly ready:
    | { readonly kind: "tcp"; readonly port: number }
    | {
        readonly kind: "exec";
        readonly argv: ReadonlyArray<string>;
        readonly user: string | null;
      };
  readonly idleStopAfterSeconds: number;
}

/** The env a preset's image needs to start with no password and the shared database made. */
const presetEnv = (def: ResourceDefinitionInput): Readonly<Record<string, string>> => {
  switch (def.preset) {
    case "postgres":
      return { POSTGRES_HOST_AUTH_METHOD: "trust", POSTGRES_DB: SHARED_DATABASE };
    case "mysql":
      return { MYSQL_ALLOW_EMPTY_PASSWORD: "yes", MYSQL_DATABASE: SHARED_DATABASE };
    case "redis":
    case null:
      return {};
  }
};

const firstPort = (def: ResourceDefinitionInput, protocol?: "tcp") =>
  def.ports.find((port) => protocol === undefined || port.protocol === protocol);

const readyOf = (def: ResourceDefinitionInput): ResourceInstanceSpec["ready"] => {
  if (def.preset === "postgres") {
    return {
      kind: "exec",
      argv: ["pg_isready", "-h", "127.0.0.1", "-U", POSTGRES_USER, "-d", SHARED_DATABASE],
      user: POSTGRES_USER,
    };
  }
  if (def.ready.kind === "command") return { kind: "exec", argv: def.ready.argv, user: null };
  const tcp = firstPort(def, "tcp");
  // A resource with no TCP port has nothing to accept on: it is ready once it runs.
  return tcp === undefined || def.ready.kind === "none"
    ? { kind: "exec", argv: ["sh", "-c", "true"], user: null }
    : { kind: "tcp", port: tcp.port };
};

/** The literal env values of a definition. A `{ secret }` value is not sent: Sealant's spec is plain. */
const literalEnv = (def: ResourceDefinitionInput) =>
  Object.fromEntries(
    Object.entries(def.env).flatMap(([name, value]) =>
      typeof value === "string" ? [[name, value]] : [],
    ),
  );

/** The env names a definition sets from a project secret, which its instance does not get yet. */
export const secretEnvLeftOut = (def: ResourceDefinitionInput): ReadonlyArray<string> =>
  Object.entries(def.env).flatMap(([name, value]) => (typeof value === "string" ? [] : [name]));

/**
 * The instance a definition runs as: its image pinned by digest, its engine settings, its volumes
 * (a Postgres also gets its dumps volume), its limits and its ready check. A worktree resource is
 * reached only from its worktree.
 */
export const resourceInstanceSpec = (input: {
  readonly definition: ResourceDefinitionInput;
  /** The image pinned to its digest: `postgres:17@sha256:…`. */
  readonly image: string;
  readonly worktreeId: WorktreeId | null;
}): ResourceInstanceSpec => {
  const def = input.definition;
  const dumps =
    def.preset === "postgres" &&
    !def.volumes.some((volume) => volume.name === "dumps" || volume.mountPath === DUMPS_MOUNT)
      ? [{ name: "dumps", mountPath: DUMPS_MOUNT }]
      : [];
  return {
    alias: def.name,
    worktreeKey: def.scope === "worktree" ? input.worktreeId : null,
    image: input.image,
    command: def.command,
    env: { ...literalEnv(def), ...presetEnv(def) },
    volumes: [...def.volumes.map(({ name, mountPath }) => ({ name, mountPath })), ...dumps],
    limits: {
      cpuMillicores: Math.max(10, Math.round(def.limits.cpu * 1000)),
      memoryBytes: def.limits.memoryMiB * 1024 * 1024,
    },
    ready: readyOf(def),
    idleStopAfterSeconds: RESOURCE_IDLE_STOP_SECONDS,
  };
};

/**
 * How one worktree uses each definition, from its stored choice or the policy's default: `off`
 * binds nothing, and a scope the policy refuses runs nowhere.
 */
export const resourceBindings = (
  definitions: ReadonlyArray<{
    readonly spec: ResourceDefinitionInput;
    readonly choice: WorktreeChoice | null;
  }>,
): ReadonlyArray<ResourceBinding> =>
  definitions.flatMap(({ spec, choice }): ReadonlyArray<ResourceBinding> => {
    if (spec.scope === "worktree") {
      return scopePolicyFor(spec).kind === "own-instance"
        ? [{ definition: spec, mode: "worktree" }]
        : [];
    }
    const mode = choiceInEffect(spec, choice);
    return mode === "shared" || mode === "own" ? [{ definition: spec, mode }] : [];
  });

/** The database a binding's processes use; null for an engine that names none. */
export const boundDatabase = (binding: ResourceBinding, worktreeId: WorktreeId): string | null => {
  switch (binding.definition.preset) {
    case "postgres":
      return binding.mode === "own" ? ownDatabaseName(worktreeId) : SHARED_DATABASE;
    case "mysql":
      return SHARED_DATABASE;
    case "redis":
    case null:
      return null;
  }
};

/** `{host}`, `{port}`, `{port.<name>}` and `{env.<NAME>}` filled in; null when one names a secret. */
const renderExport = (def: ResourceDefinitionInput, template: string): string | null => {
  const values = new Map<string, string>([
    ["host", def.name],
    ...def.ports.slice(0, 1).map((port) => ["port", String(port.port)] as const),
    ...def.ports.map((port) => [`port.${port.name}`, String(port.port)] as const),
    ...Object.entries(literalEnv(def)).map(([name, value]) => [`env.${name}`, value] as const),
  ]);
  let missing = false;
  const rendered = template.replace(/\{([^{}]*)\}/g, (_, placeholder: string) => {
    const value = values.get(placeholder);
    if (value === undefined) missing = true;
    return value ?? "";
  });
  return missing ? null : rendered;
};

const envPart = (label: string) => label.toUpperCase().replaceAll("-", "_");

/** One binding's env: its own names first, then the conventional ones when it is the only of its engine. */
export const resourceBindingEnv = (
  binding: ResourceBinding,
  worktreeId: WorktreeId,
  only: boolean,
): ReadonlyArray<readonly [string, string]> => {
  const def = binding.definition;
  const prefix = resourceEnvPrefix(def.name);
  const host = def.name;
  const port = firstPort(def);
  const address: ReadonlyArray<readonly [string, string]> = [
    [`${prefix}HOST`, host],
    ...(port === undefined ? [] : [[`${prefix}PORT`, String(port.port)] as const]),
    ...def.ports.map((each) => [`${prefix}PORT_${envPart(each.name)}`, String(each.port)] as const),
  ];
  const database = boundDatabase(binding, worktreeId);
  const at = `${host}:${port?.port ?? ""}`;
  switch (def.preset) {
    case "postgres": {
      const url = `postgres://${POSTGRES_USER}@${at}/${database ?? SHARED_DATABASE}`;
      return [
        ...address,
        [`${prefix}URL`, url],
        [`${prefix}DATABASE`, database ?? SHARED_DATABASE],
        [`${prefix}USERNAME`, POSTGRES_USER],
        ...(only
          ? ([
              ["DATABASE_URL", url],
              ["PGHOST", host],
              ["PGPORT", String(port?.port ?? "")],
              ["PGUSER", POSTGRES_USER],
              ["PGDATABASE", database ?? SHARED_DATABASE],
            ] as const)
          : []),
      ];
    }
    case "mysql":
      return [
        ...address,
        [`${prefix}URL`, `mysql://root@${at}/${SHARED_DATABASE}`],
        [`${prefix}DATABASE`, SHARED_DATABASE],
        [`${prefix}USERNAME`, "root"],
      ];
    case "redis": {
      const url = `redis://${at}`;
      return [...address, [`${prefix}URL`, url], ...(only ? [["REDIS_URL", url] as const] : [])];
    }
    case null:
      return [
        ...address,
        ...Object.entries(def.exports).flatMap(([name, template]) => {
          const value = renderExport(def, template);
          return value === null ? [] : [[`${prefix}${name}`, value] as const];
        }),
      ];
  }
};

/** The env names one resource left to the project, which sets them itself. */
export interface ResourceEnvLeft {
  readonly resource: ResourceName;
  readonly names: ReadonlyArray<string>;
}

/**
 * The env every process in a worktree gets from the resources it uses (story 2): each one's
 * `MEND_RESOURCE_<NAME>_*`, and `DATABASE_URL` with the `PG*` names for the one Postgres and
 * `REDIS_URL` for the one Redis. A name the project's env or secrets set is left as the project
 * sets it, and said. Built from the rows alone, never from what runs, so a slow or failed start
 * still gives the right names.
 */
export const resourceProcessEnv = (input: {
  readonly bindings: ReadonlyArray<ResourceBinding>;
  readonly worktreeId: WorktreeId;
  readonly projectEnvNames: ReadonlySet<string>;
}): {
  readonly env: Readonly<Record<string, string>>;
  readonly left: ReadonlyArray<ResourceEnvLeft>;
} => {
  const env: Record<string, string> = {};
  const left: Array<ResourceEnvLeft> = [];
  for (const binding of input.bindings) {
    const def = binding.definition;
    const only =
      def.preset !== null &&
      input.bindings.filter((other) => other.definition.preset === def.preset).length === 1;
    const kept: Array<string> = [];
    for (const [name, value] of resourceBindingEnv(binding, input.worktreeId, only)) {
      if (input.projectEnvNames.has(name)) kept.push(name);
      else env[name] = value;
    }
    if (kept.length > 0) left.push({ resource: def.name, names: kept });
  }
  return { env, left };
};

/** `export NAME='value'` lines a POSIX shell reads back exactly, sorted by name. */
export const shellExports = (env: Readonly<Record<string, string>>): ReadonlyArray<string> =>
  Object.entries(env)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `export ${name}='${value.replaceAll("'", `'\\''`)}'`);
