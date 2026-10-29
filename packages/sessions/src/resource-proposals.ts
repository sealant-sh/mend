import {
  RESOURCE_NAME,
  RESOURCE_PRESETS,
  ResourceDefinitionInput,
  resourceDefinitionRefusals,
  type ResourceEnvValue,
  resourceNameIssue,
  ResourcePort,
  ResourcePreset,
  type ResourceReady,
  ResourceScope,
  ResourceVolume,
} from "@mend/domain/workbench";
import { Option, Schema } from "effect";

/**
 * `[resource.*]` tables in `mend.toml` (ADR 0019, decision S8): proposals, which run only once a
 * manager approves them in project settings. A bad table refuses that resource alone, naming its
 * full key; the file's other resources still read. A key this Mend does not read is listed as
 * ignored, as recipes' are.
 *
 * ```toml
 * [resource.queue]
 * image = "rabbitmq:4-management"
 * scope = "project"
 * ports = { amqp = 5672 }
 * volumes = { data = "/var/lib/rabbitmq" }
 * env = { RABBITMQ_DEFAULT_USER = "app", RABBITMQ_DEFAULT_PASS = { secret = "RABBITMQ_PASSWORD" } }
 * exports = { URL = "amqp://app:{env.RABBITMQ_DEFAULT_PASS}@{host}:{port.amqp}/" }
 * ```
 */

/** One refusal: the resource (null for the `resource` table itself), its full key, and why. */
export interface ResourceProposalRefusal {
  readonly name: string | null;
  readonly key: string;
  readonly message: string;
}

export interface ResourceProposalIgnored {
  readonly name: string | null;
  readonly key: string;
}

export interface ResourceProposals {
  readonly proposals: ReadonlyArray<ResourceDefinitionInput>;
  readonly refused: ReadonlyArray<ResourceProposalRefusal>;
  readonly ignored: ReadonlyArray<ResourceProposalIgnored>;
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

type Argv = readonly [string, ...Array<string>];

const isArgv = (value: unknown): value is Argv =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((part) => typeof part === "string" && !part.includes("\0")) &&
  value[0] !== "";

const ARGV_RULE =
  'must be a list: the executable, then its arguments, such as ["rabbitmq-diagnostics", "ping"]';

const isPort = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;

/** `amqp = 5672`, or `dns = { port = 53, protocol = "udp" }`. */
const readPort = (name: string, spec: unknown, context: KeyContext): ResourcePort | undefined => {
  const key = `ports.${name}`;
  if (!isRecord(spec) && typeof spec !== "number") {
    context.refuse(key, 'must be a port, or a table such as { port = 53, protocol = "udp" }');
    return undefined;
  }
  const { port, protocol = "tcp", ...rest } = isRecord(spec) ? spec : { port: spec };
  for (const extra of Object.keys(rest)) context.ignore(`${key}.${extra}`);
  if (!isPort(port)) {
    context.refuse(isRecord(spec) ? `${key}.port` : key, "must be a port in 1..65535");
    return undefined;
  }
  if (protocol !== "tcp" && protocol !== "udp") {
    context.refuse(`${key}.protocol`, `must be ${oneOf(["tcp", "udp"])}`);
    return undefined;
  }
  const read = { name, port, protocol };
  if (Schema.is(ResourcePort)(read)) return read;
  context.refuse(
    key,
    "is not a port name (a lowercase letter, then lowercase letters, digits or single -, at most 15)",
  );
  return undefined;
};

const allRead = <A>(values: ReadonlyArray<A | undefined>): ReadonlyArray<A> | undefined => {
  const read = values.flatMap((value) => (value === undefined ? [] : [value]));
  return read.length === values.length ? read : undefined;
};

const readEnvValue = (
  name: string,
  setting: unknown,
  context: KeyContext,
): ResourceEnvValue | undefined => {
  if (typeof setting === "string") return setting;
  if (!isRecord(setting) || !("secret" in setting)) {
    context.refuse(`env.${name}`, 'must be a string or { secret = "NAME" }');
    return undefined;
  }
  const { secret, ...rest } = setting;
  for (const extra of Object.keys(rest)) context.ignore(`env.${name}.${extra}`);
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

const LIMITS = {
  cpu: { valid: Number.isFinite, rule: "must be a number above 0" },
  memoryMiB: { valid: Number.isSafeInteger, rule: "must be a whole number of MiB above 0" },
  diskGiB: { valid: Number.isSafeInteger, rule: "must be a whole number of GiB above 0" },
} as const;

const isLimit = (key: string): key is keyof typeof LIMITS => Object.hasOwn(LIMITS, key);

interface Fields {
  readonly image: string;
  readonly scope: ResourceScope;
  readonly preset: ResourcePreset;
  readonly command: Argv;
  readonly ports: ReadonlyArray<ResourcePort>;
  readonly volumes: ReadonlyArray<ResourceVolume>;
  readonly env: Readonly<Record<string, ResourceEnvValue>>;
  readonly exports: Readonly<Record<string, string>>;
  readonly ready: ResourceReady;
  readonly limits: Readonly<Partial<Record<keyof typeof LIMITS, number>>>;
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

const READY_KINDS = ["tcp", "none", "preset"] as const;

const READERS: { readonly [K in keyof Fields]: Reader<K> } = {
  image: (value, context) => {
    if (typeof value === "string" && /^\S+$/.test(value)) return value;
    context.refuse("image", 'must be an image reference, such as "rabbitmq:4-management"');
    return undefined;
  },
  scope: literalOf("scope", ResourceScope.literals),
  preset: literalOf("preset", ResourcePreset.literals),
  command: (value, context) => {
    if (isArgv(value)) return value;
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
        if (Schema.is(ResourceVolume)(read)) return read;
        context.refuse(
          `volumes.${name}`,
          RESOURCE_NAME.test(name)
            ? "must be an absolute, normalized path below /"
            : "is not a volume name (a lowercase letter, then lowercase letters, digits or -)",
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
    const kind = READY_KINDS.find((candidate) => candidate === value);
    if (kind !== undefined) return { kind };
    if (!isRecord(value) || !("command" in value)) {
      context.refuse("ready", 'must be "tcp", "none", "preset" or { command = [...] }');
      return undefined;
    }
    const { command, ...rest } = value;
    for (const extra of Object.keys(rest)) context.ignore(`ready.${extra}`);
    if (isArgv(command)) return { kind: "command", argv: command };
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
    const limits: Partial<Record<keyof typeof LIMITS, number>> = {};
    let refused = false;
    for (const [key, limit] of Object.entries(value)) {
      if (!isLimit(key)) {
        context.ignore(`limits.${key}`);
      } else if (typeof limit === "number" && limit > 0 && LIMITS[key].valid(limit)) {
        limits[key] = limit;
      } else {
        refused = true;
        context.refuse(`limits.${key}`, LIMITS[key].rule);
      }
    }
    return refused ? undefined : limits;
  },
};

const isFieldKey = (key: string): key is keyof Fields => Object.hasOwn(READERS, key);

const decodeDefinition = Schema.decodeUnknownOption(ResourceDefinitionInput);

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

/** Relative keys (`ports.amqp`, or "" for the table itself); the caller prefixes them. */
const readResource = (
  name: string,
  entry: Record<string, unknown>,
  context: KeyContext,
): ResourceDefinitionInput | null => {
  let refused = false;
  const guarded: KeyContext = {
    refuse: (key, message) => {
      refused = true;
      context.refuse(key, message);
    },
    ignore: context.ignore,
  };
  const nameIssue = resourceNameIssue(name);
  if (nameIssue !== null) guarded.refuse("name", nameIssue);

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
  if (refused) return null;

  const ports = fields.ports ?? [];
  const decoded = decodeDefinition({
    name,
    scope: fields.scope ?? "project",
    preset: fields.preset ?? null,
    image: fields.image,
    command: fields.command ?? null,
    ports,
    env: fields.env ?? {},
    volumes: fields.volumes ?? [],
    limits: fields.limits ?? {},
    ready: fields.ready ?? defaultReady(fields.preset, ports),
    exports: fields.exports ?? {},
  });
  if (Option.isNone(decoded)) {
    context.refuse("", "is not a resource definition Mend can read");
    return null;
  }
  const refusals = resourceDefinitionRefusals(decoded.value);
  for (const refusal of refusals) context.refuse(refusal.key, refusal.message);
  return refusals.length === 0 ? decoded.value : null;
};

/** `mend.toml`'s `resource` value, as parsed. Absent proposes nothing. */
export const readResourceProposals = (value: unknown): ResourceProposals => {
  if (value === undefined) return { proposals: [], refused: [], ignored: [] };
  if (!isRecord(value)) {
    return {
      proposals: [],
      refused: [
        {
          name: null,
          key: "resource",
          message: "must be a table of resources ([resource.<name>])",
        },
      ],
      ignored: [],
    };
  }
  const proposals: ResourceDefinitionInput[] = [];
  const refused: ResourceProposalRefusal[] = [];
  const ignored: ResourceProposalIgnored[] = [];
  for (const [name, entry] of Object.entries(value)) {
    const full = (key: string) => (key === "" ? `resource.${name}` : `resource.${name}.${key}`);
    const context: KeyContext = {
      refuse: (key, message) => refused.push({ name, key: full(key), message }),
      ignore: (key) => ignored.push({ name, key: full(key) }),
    };
    if (!isRecord(entry)) {
      context.refuse("", "must be a table");
      continue;
    }
    const proposal = readResource(name, entry, context);
    if (proposal !== null) proposals.push(proposal);
  }
  return { proposals, refused, ignored };
};
