import {
  envCollisionRefusals,
  isResourceTableKey,
  ResourceDefinition,
  recipeRefusalLine,
  RESOURCE_PRESETS,
  RESOURCE_TABLES_HEADING,
  resourceDefinitionRefusals,
  resourceTablePresetDefaults,
  withPresetCommand,
  type ResourceEnvValue,
  ResourceLimits,
  resourceNameIssue,
  ResourcePort,
  resourceTableNotices,
  ResourcePreset,
  ResourceReady,
  type ResourceRefusal,
  ResourceVolume,
  type ServiceDeclarations,
} from "@mend/domain/workbench";
import { Option, Schema } from "effect";

/**
 * `[resource.*]` tables in `.mend/mend.toml` (ADR 0019, decision S8): definitions an explicit start
 * reads; launch never starts one. A bad table refuses that
 * resource alone, naming its full key; the file's other resources still read. A key this Mend does
 * not read is listed as ignored, as recipes' are. Fields are checked with the domain's schemas, so
 * a table passes the resource definition rules.
 *
 * ```toml
 * [resource.queue]
 * image = "rabbitmq:4-management"
 * ports = { amqp = 5672 }
 * volumes = { data = "/var/lib/rabbitmq" }
 * env = { RABBITMQ_DEFAULT_USER = "app", RABBITMQ_DEFAULT_PASS = { secret = "RABBITMQ_PASSWORD" } }
 * exports = { URL = "amqp://app:{env.RABBITMQ_DEFAULT_PASS}@{host}:{port.amqp}/" }
 * ```
 */

export interface ResourceTables {
  readonly tables: ReadonlyArray<ResourceDefinition>;
  /** Keyed in full (`resource.queue.ports.amqp`), which names the resource. */
  readonly refused: ReadonlyArray<ResourceRefusal>;
  readonly ignored: ReadonlyArray<{ readonly key: string }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

interface KeyContext {
  readonly refuse: (key: string, message: string) => void;
  readonly ignore: (key: string) => void;
}

const oneOf = (options: ReadonlyArray<string>): string => {
  const quoted = options.map((option) => `"${option}"`);
  return quoted.length < 2
    ? quoted.join("")
    : `${quoted.slice(0, -1).join(", ")} or ${quoted.at(-1)}`;
};

const isImage = Schema.is(ResourceDefinition.fields.image);
const isCommand = Schema.is(ResourceDefinition.fields.command);
const isReady = Schema.is(ResourceReady);
const isPortNumber = Schema.is(ResourcePort.fields.port);
const isProtocol = Schema.is(ResourcePort.fields.protocol);
const isPort = Schema.is(ResourcePort);
const isVolumeName = Schema.is(ResourceVolume.fields.name);
const isVolume = Schema.is(ResourceVolume);

const ARGV_RULE =
  'must be a list: the executable, then its arguments, such as ["rabbitmq-diagnostics", "ping"]';

/** `amqp = 5672`, or `dns = { port = 53, protocol = "udp" }`. */
const readPort = (name: string, spec: unknown, context: KeyContext): ResourcePort | undefined => {
  const key = `ports.${name}`;
  if (!isRecord(spec) && typeof spec !== "number") {
    context.refuse(key, 'must be a port, or a table such as { port = 53, protocol = "udp" }');
    return undefined;
  }
  const { port, protocol = "tcp", ...rest } = isRecord(spec) ? spec : { port: spec };
  for (const extra of Object.keys(rest)) context.ignore(`${key}.${extra}`);
  if (!isPortNumber(port)) {
    context.refuse(isRecord(spec) ? `${key}.port` : key, "must be a port in 1..65535");
    return undefined;
  }
  if (!isProtocol(protocol)) {
    context.refuse(`${key}.protocol`, `must be ${oneOf(ResourcePort.fields.protocol.literals)}`);
    return undefined;
  }
  const read = { name, port, protocol };
  if (isPort(read)) return read;
  context.refuse(
    key,
    "is not a port name (a lowercase letter, then lowercase letters, digits or single -, not ending in -, at most 15)",
  );
  return undefined;
};

const allRead = <A>(values: ReadonlyArray<A | undefined>): ReadonlyArray<A> | undefined => {
  const read = values.flatMap((value) => (value === undefined ? [] : [value]));
  return read.length === values.length ? read : undefined;
};

const ENV_VALUE_RULE = 'must be a string or { secret = "NAME" }';

const readEnvValue = (
  name: string,
  setting: unknown,
  context: KeyContext,
): ResourceEnvValue | undefined => {
  if (typeof setting === "string") return setting;
  if (!isRecord(setting)) {
    context.refuse(`env.${name}`, ENV_VALUE_RULE);
    return undefined;
  }
  const { secret, ...rest } = setting;
  for (const extra of Object.keys(rest)) context.ignore(`env.${name}.${extra}`);
  if (secret === undefined) {
    context.refuse(`env.${name}`, ENV_VALUE_RULE);
    return undefined;
  }
  if (typeof secret === "string") return { secret };
  context.refuse(`env.${name}.secret`, "must be a project secret's name");
  return undefined;
};

/** Each entry of the table at `key`, read by `read`, or undefined once any is refused. */
const readTable =
  <A>(
    key: string,
    rule: string,
    read: (name: string, value: unknown, context: KeyContext) => A | undefined,
  ) =>
  (value: unknown, context: KeyContext): Readonly<Record<string, A>> | undefined => {
    if (!isRecord(value)) {
      context.refuse(key, rule);
      return undefined;
    }
    const entries = Object.entries(value).map(([name, entry]) => {
      const one = read(name, entry, context);
      return one === undefined ? undefined : ([name, one] as const);
    });
    const all = allRead(entries);
    return all === undefined ? undefined : Object.fromEntries(all);
  };

const LIMIT_RULES: { readonly [K in keyof ResourceLimits]: string } = {
  cpu: "must be a number above 0",
  memoryMiB: "must be a whole number of MiB above 0",
  diskGiB: "must be a whole number of GiB above 0",
};

const isLimitKey = (key: string): key is keyof ResourceLimits => Object.hasOwn(LIMIT_RULES, key);

interface Fields {
  readonly image: string;
  readonly preset: ResourcePreset;
  readonly command: ResourceDefinition["command"];
  readonly ports: ResourceDefinition["ports"];
  readonly volumes: ResourceDefinition["volumes"];
  readonly env: ResourceDefinition["env"];
  readonly exports: ResourceDefinition["exports"];
  readonly ready: ResourceReady;
  readonly limits: Partial<ResourceLimits>;
}

type Reader<K extends keyof Fields> = (
  value: unknown,
  context: KeyContext,
) => Fields[K] | undefined;

const literalOf =
  <const L extends string>(key: string, allowed: ReadonlyArray<L>) =>
  (value: unknown, context: KeyContext): L | undefined => {
    const found = allowed.find((candidate) => candidate === value);
    if (found === undefined) context.refuse(key, `must be ${oneOf(allowed)}`);
    return found;
  };

const READY_RULE = 'must be "tcp", "none", "preset" or { command = [...] }';

const READERS: { readonly [K in keyof Fields]: Reader<K> } = {
  image: (value, context) => {
    if (isImage(value)) return value;
    context.refuse("image", 'must be an image reference, such as "rabbitmq:4-management"');
    return undefined;
  },
  preset: literalOf("preset", ResourcePreset.literals),
  command: (value, context) => {
    if (isCommand(value)) return value;
    context.refuse("command", ARGV_RULE);
    return undefined;
  },
  ports: (value, context) => {
    if (!isRecord(value)) {
      context.refuse("ports", "must be a table of port names to ports, such as { amqp = 5672 }");
      return undefined;
    }
    return allRead(Object.entries(value).map(([name, spec]) => readPort(name, spec, context)));
  },
  volumes: (value, context) => {
    if (!isRecord(value)) {
      context.refuse(
        "volumes",
        'must be a table of volume names to paths, such as { data = "/data" }',
      );
      return undefined;
    }
    return allRead(
      Object.entries(value).map(([name, mountPath]) => {
        const read = { name, mountPath };
        if (isVolume(read)) return read;
        context.refuse(
          `volumes.${name}`,
          (isVolumeName(name) ? null : resourceNameIssue(name)) ??
            "must be an absolute, normalized path below /",
        );
        return undefined;
      }),
    );
  },
  env: readTable("env", 'must be a table of names to strings or { secret = "NAME" }', readEnvValue),
  exports: readTable(
    "exports",
    'must be a table of export names to templates, such as { URL = "http://{host}:{port}/" }',
    (name, template, context): string | undefined => {
      if (typeof template === "string") return template;
      context.refuse(`exports.${name}`, 'must be a template, such as "http://{host}:{port}/"');
      return undefined;
    },
  ),
  ready: (value, context) => {
    const named = { kind: value };
    if (typeof value === "string" && isReady(named)) return named;
    if (!isRecord(value)) {
      context.refuse("ready", READY_RULE);
      return undefined;
    }
    const { command, ...rest } = value;
    for (const extra of Object.keys(rest)) context.ignore(`ready.${extra}`);
    if (command === undefined) {
      context.refuse("ready", READY_RULE);
      return undefined;
    }
    const probe = { kind: "command", argv: command };
    if (isReady(probe)) return probe;
    context.refuse("ready.command", ARGV_RULE);
    return undefined;
  },
  limits: (value, context) => {
    if (!isRecord(value)) {
      context.refuse(
        "limits",
        "must be a table such as { cpu = 2, memoryMiB = 2048, diskGiB = 20 }",
      );
      return undefined;
    }
    const limits: Partial<Record<keyof ResourceLimits, number>> = {};
    let refused = false;
    for (const [key, limit] of Object.entries(value)) {
      if (!isLimitKey(key)) {
        context.ignore(`limits.${key}`);
      } else if (Schema.is(ResourceLimits.fields[key])(limit)) {
        limits[key] = limit;
      } else {
        refused = true;
        context.refuse(`limits.${key}`, LIMIT_RULES[key]);
      }
    }
    return refused ? undefined : limits;
  },
};

const isFieldKey = (key: string): key is keyof Fields => Object.hasOwn(READERS, key);

const decodeDefinition = Schema.decodeUnknownOption(ResourceDefinition);

/** Without `ready`: the preset's own check, else a TCP accept on the first TCP port, else none. */
const defaultReady = (
  preset: ResourcePreset | undefined,
  ports: ReadonlyArray<ResourcePort>,
): ResourceReady =>
  preset !== undefined
    ? { kind: "preset" }
    : ports.some((port) => port.protocol === "tcp")
      ? { kind: "tcp" }
      : { kind: "none" };

type Field = keyof Fields | "name";

/**
 * The fields each rule across fields reads, by the first segment of the key it refuses. A rule
 * whose fields a reader refused is not reported, since it would judge a stand-in.
 */
const READS: Readonly<Record<string, ReadonlyArray<Field>>> = {
  name: ["name"],
  ports: ["ports"],
  volumes: ["volumes"],
  env: ["env"],
  image: ["image", "preset"],
  ready: ["ready", "preset", "ports"],
  exports: ["exports", "preset", "ports", "env"],
};

/** Stands in for a refused name or image, which `READS` then keeps out of every report. */
const STAND_IN = "refused";

/** Relative keys (`ports.amqp`, or "" for the table itself); the caller prefixes them. */
const readResource = (
  name: string,
  entry: Record<string, unknown>,
  context: KeyContext,
): ResourceDefinition | null => {
  const refusedFields = new Set<string>();
  const guarded: KeyContext = {
    refuse: (key, message) => {
      refusedFields.add(key.split(".")[0] ?? key);
      context.refuse(key, message);
    },
    ignore: context.ignore,
  };
  const nameIssue = resourceNameIssue(name);
  if (nameIssue !== null) {
    refusedFields.add("name");
    context.refuse("", nameIssue);
  }

  const fields: { -readonly [K in keyof Fields]?: Fields[K] } = {};
  const assign = <K extends keyof Fields>(key: K, value: unknown) => {
    const read = READERS[key](value, guarded);
    if (read !== undefined) fields[key] = read;
  };
  for (const [key, value] of Object.entries(entry)) {
    if (isFieldKey(key)) assign(key, value);
    else guarded.ignore(key);
  }
  if (entry["image"] === undefined) {
    guarded.refuse(
      "image",
      fields.preset === undefined
        ? 'is required: the image this resource runs, such as "rabbitmq:4-management"'
        : `is required, with its tag: the ${fields.preset} preset runs ${RESOURCE_PRESETS[fields.preset].images.join(", ")}`,
    );
  }

  const defaults = resourceTablePresetDefaults(fields.preset ?? null, fields.image ?? STAND_IN);
  const ports = fields.ports ?? defaults?.ports ?? [];
  const decoded = decodeDefinition({
    name: refusedFields.has("name") ? STAND_IN : name,
    preset: fields.preset ?? null,
    image: fields.image ?? STAND_IN,
    command: fields.command ?? null,
    ports,
    env: fields.env ?? {},
    volumes: fields.volumes ?? defaults?.volumes ?? [],
    limits: fields.limits ?? {},
    ready: fields.ready ?? defaultReady(fields.preset, ports),
    exports: fields.exports ?? {},
  });
  if (Option.isNone(decoded)) {
    context.refuse("", "is not a resource definition Mend can read");
    return null;
  }
  const def = withPresetCommand(decoded.value);
  const reported = resourceDefinitionRefusals(def).filter((refusal) => {
    const reads = READS[refusal.key.split(".")[0] ?? refusal.key];
    return reads === undefined
      ? refusedFields.size === 0
      : !reads.some((field) => refusedFields.has(field));
  });
  for (const refusal of reported) context.refuse(refusal.key, refusal.message);
  return refusedFields.size === 0 && reported.length === 0 ? def : null;
};

/** The key a collision refuses: the export that sets the name, else the table. */
/** `.mend/mend.toml`'s `resource` value, as parsed. Absent declares nothing. */
export const readResourceTables = (value: unknown): ResourceTables => {
  if (value === undefined) return { tables: [], refused: [], ignored: [] };
  if (!isRecord(value)) {
    return {
      tables: [],
      refused: [{ key: "resource", message: "must be a table of resources ([resource.<name>])" }],
      ignored: [],
    };
  }
  const read: ResourceDefinition[] = [];
  const refused: ResourceRefusal[] = [];
  const ignored: Array<{ readonly key: string }> = [];
  const contextOf = (name: string): KeyContext => {
    const full = (key: string) => (key === "" ? `resource.${name}` : `resource.${name}.${key}`);
    return {
      refuse: (key, message) => refused.push({ key: full(key), message }),
      ignore: (key) => ignored.push({ key: full(key) }),
    };
  };
  for (const [name, entry] of Object.entries(value)) {
    const context = contextOf(name);
    if (!isRecord(entry)) {
      context.refuse("", "must be a table");
      continue;
    }
    const table = readResource(name, entry, context);
    if (table !== null) read.push(table);
  }

  // Two tables that set one env name can never be in use together (ADR 0019, A1).
  const collided = new Set<string>();
  for (const { resource, refusal } of envCollisionRefusals(read)) {
    collided.add(resource);
    contextOf(resource).refuse(refusal.key, refusal.message);
  }
  return { tables: read.filter((def) => !collided.has(def.name)), refused, ignored };
};

const noteSection = (heading: string, lines: ReadonlyArray<string>): string =>
  lines.length === 0 ? "" : `${heading}:\n\n${lines.map((line) => `- ${line}`).join("\n")}\n\n`;

/** The workspace note on what `.mend/mend.toml` refuses or ignores: recipes to fix, then resource tables. */
export const declarationsNote = (
  declared: Pick<ServiceDeclarations, "refused" | "ignored">,
  fileName = ".mend/mend.toml",
): string =>
  noteSection(
    `Refused in ${fileName} (fix these before running them)`,
    declared.refused
      .filter((refusal) => !isResourceTableKey(refusal.key))
      .map((refusal) =>
        refusal.name === null
          ? [fileName, refusal.key, refusal.message].join(" · ")
          : recipeRefusalLine(refusal),
      ),
  ) +
  noteSection(
    RESOURCE_TABLES_HEADING.replace(".mend/mend.toml", fileName),
    resourceTableNotices(declared),
  );
