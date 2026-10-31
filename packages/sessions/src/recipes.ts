import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  DEFAULT_RECIPE_READY,
  dependencyEnvPrefix,
  ENV_NAME,
  IgnoredDeclaration,
  parseDuration,
  PreviewDeclaration,
  READY_TIMEOUT_MAX_MS,
  READY_TIMEOUT_MIN_MS,
  RECIPE_NAME,
  RecipeRefusal,
  type RecipeReady,
  type RepoRelativePath,
  repoRelativePathOf,
  type ResourceDefinitionInput,
  parseServiceDependency,
  resourceDependenciesOf,
  serviceDependenciesOf,
  type ServiceDependency,
  ServiceDeclarations,
  type ServiceAddress,
  type ServiceHostPolicy,
  ServiceRecipe,
  SetupDeclaration,
} from "@mend/domain/workbench";
import { Effect, Schema } from "effect";
import { parse as parseToml, TomlError } from "smol-toml";

import { readResourceTables } from "./resource-tables.ts";

/**
 * Declared Services (docs/SESSION-SERVICES.md): the repo's `mend.toml`, read from the SESSION's
 * worktree copy, so an agent can add a recipe as part of its change and it reviews like any other
 * edit. A missing file declares nothing. A file that is not TOML, or whose `service` is not a
 * table, is a typed error naming the problem. Anything else wrong is one recipe's refusal, naming
 * its key, and the file's other recipes still list and run. A key this Mend does not read is
 * listed as ignored, so a later version's key never breaks this one.
 *
 * ```toml
 * [service.web]
 * command = "pnpm dev"
 * port = 3000
 * browserScheme = "http"
 * cwd = "apps/web"
 * env = { NODE_ENV = "development" }
 * ready = { http = "/", timeout = "120s" }
 * depends = ["db"]
 *
 * [setup]
 * run = ["pnpm install --frozen-lockfile"]
 * inputs = ["pnpm-lock.yaml"]
 *
 * [service.db]
 * # no command: an already-listening port to adopt
 * port = 5432
 *
 * [preview]
 * service = "web"
 * ```
 */

export const MEND_TOML = "mend.toml";

export class RecipeFileError extends Schema.TaggedError<RecipeFileError>()("RecipeFileError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** One file's declarations as written, before the project's rows and the graph are read. */
export interface MendTomlFile {
  readonly recipes: ReadonlyArray<ServiceRecipe>;
  /** `[resource.*]` tables (ADR 0019); their refusals and ignored keys join the file's. */
  readonly resources: ReadonlyArray<ResourceDefinitionInput>;
  readonly refused: ReadonlyArray<RecipeRefusal>;
  readonly ignored: ReadonlyArray<IgnoredDeclaration>;
  /** `[preview].service` as written; checked against the merged recipes. */
  readonly preview: string | null;
  readonly setup: SetupDeclaration | null;
}

export const EMPTY_MEND_TOML: MendTomlFile = {
  recipes: [],
  resources: [],
  refused: [],
  ignored: [],
  preview: null,
  setup: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

const mendsEnvName = (name: string): string | null =>
  name.startsWith("MEND_")
    ? "MEND_* names are Mend's"
    : name === "PORT"
      ? "PORT is Mend's: it is the recipe's port"
      : null;

interface RecipeFields {
  readonly command: string | null;
  readonly port: number | undefined;
  readonly protocol: "tcp" | "udp";
  readonly browserScheme: "http" | "https" | null;
  readonly cwd: RepoRelativePath | null;
  readonly env: Readonly<Record<string, string>>;
  readonly ready: RecipeReady;
  readonly host: ServiceHostPolicy;
  readonly address: ServiceAddress;
  readonly depends: ReadonlyArray<ServiceDependency>;
}

const DEFAULTS: RecipeFields = {
  command: null,
  port: undefined,
  protocol: "tcp",
  browserScheme: null,
  cwd: null,
  env: {},
  ready: DEFAULT_RECIPE_READY,
  host: "rewrite",
  address: "loopback",
  depends: [],
};

interface KeyContext {
  readonly refuse: (key: string, message: string) => void;
  readonly ignore: (key: string) => void;
}

type KeyReader<K extends keyof RecipeFields> = (
  value: unknown,
  context: KeyContext,
) => RecipeFields[K] | undefined;

const literalOf =
  <const L extends string>(key: string, allowed: ReadonlyArray<L>) =>
  (value: unknown, context: KeyContext): L | undefined => {
    const found = allowed.find((candidate) => candidate === value);
    if (found === undefined) {
      context.refuse(key, `must be ${allowed.map((option) => `"${option}"`).join(" or ")}`);
    }
    return found;
  };

const readTimeout = (value: unknown, context: KeyContext): number | undefined => {
  const ms = typeof value === "string" ? parseDuration(value) : null;
  if (ms === null) {
    context.refuse("ready.timeout", 'must be a quoted duration such as "90s", "2m" or "1h"');
    return undefined;
  }
  if (ms < READY_TIMEOUT_MIN_MS || ms > READY_TIMEOUT_MAX_MS) {
    context.refuse("ready.timeout", "must be between 1s and 10m");
    return undefined;
  }
  return ms;
};

/** A request target Mend writes on one line: a path, printable ASCII, no spaces. */
const HTTP_PATH = /^\/[\x21-\x7e]*$/u;

const READERS: { readonly [K in keyof RecipeFields]: KeyReader<K> } = {
  command: (value, context) => {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    context.refuse("command", "must be a non-empty shell command");
    return undefined;
  },
  port: (value, context) => {
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535) {
      return value;
    }
    context.refuse("port", "must be a port in 1..65535");
    return undefined;
  },
  protocol: literalOf("protocol", ["tcp", "udp"]),
  browserScheme: literalOf("browserScheme", ["http", "https"]),
  cwd: (value, context) => {
    if (typeof value !== "string") {
      context.refuse("cwd", "must be a repository-relative path");
      return undefined;
    }
    const read = repoRelativePathOf(value);
    if (!read.ok) {
      context.refuse("cwd", read.issue);
      return undefined;
    }
    return read.path;
  },
  env: (value, context) => {
    if (!isRecord(value)) {
      context.refuse("env", "must be a table of names to strings");
      return undefined;
    }
    const env: Record<string, string> = {};
    let refused = false;
    for (const [name, setting] of Object.entries(value)) {
      const issue = !ENV_NAME.test(name)
        ? "is not an environment variable name"
        : (mendsEnvName(name) ?? (typeof setting === "string" ? null : "must be a string"));
      if (issue !== null) {
        refused = true;
        context.refuse(`env.${name}`, issue);
      } else if (typeof setting === "string") {
        env[name] = setting;
      }
    }
    return refused ? undefined : env;
  },
  ready: (value, context) => {
    if (!isRecord(value)) {
      context.refuse("ready", 'must be a table such as { http = "/", timeout = "120s" }');
      return undefined;
    }
    const { http, timeout, ...rest } = value;
    for (const key of Object.keys(rest)) context.ignore(`ready.${key}`);
    const timeoutMs =
      timeout === undefined ? DEFAULT_RECIPE_READY.timeoutMs : readTimeout(timeout, context);
    if (http !== undefined && (typeof http !== "string" || !HTTP_PATH.test(http))) {
      context.refuse("ready.http", 'must be a path such as "/" or "/health"');
      return undefined;
    }
    if (timeoutMs === undefined) return undefined;
    return http === undefined
      ? { _tag: "Tcp", timeoutMs }
      : { _tag: "Http", path: http, timeoutMs };
  },
  host: literalOf("host", ["rewrite", "preserve"]),
  address: literalOf("address", ["loopback", "docker"]),
  depends: (value, context) => {
    if (!Array.isArray(value)) {
      context.refuse("depends", "must be a list of recipe names");
      return undefined;
    }
    const names: ServiceDependency[] = [];
    let refused = false;
    const mapped = new Map<string, string>();
    for (const entry of value) {
      const read = parseServiceDependency(entry);
      if ("issue" in read) {
        refused = true;
        context.refuse("depends", read.issue);
        continue;
      }
      const dependency = read.dependency;
      if (typeof dependency === "string") {
        if (!names.includes(dependency)) names.push(dependency);
      } else {
        for (const key of Object.keys(dependency.env)) {
          const earlier = mapped.get(key);
          if (earlier !== undefined) {
            refused = true;
            context.refuse("depends", `${key} comes from @${earlier} and @${dependency.name}`);
          }
          mapped.set(key, dependency.name);
        }
        names.push(dependency);
      }
    }
    return refused ? undefined : names;
  },
};

const isRecipeKey = (key: string): key is keyof RecipeFields => Object.hasOwn(READERS, key);

const readSetupRun = (value: unknown, context: KeyContext): SetupDeclaration["run"] | undefined => {
  if (value === undefined) {
    context.refuse("setup.run", 'is required: a list of shell commands, such as ["pnpm install"]');
    return undefined;
  }
  if (!Array.isArray(value)) {
    context.refuse("setup.run", "must be a list of shell commands");
    return undefined;
  }
  const steps: string[] = [];
  value.forEach((entry: unknown, index) => {
    if (typeof entry === "string" && entry.trim() !== "") steps.push(entry.trim());
    else context.refuse("setup.run", `command ${index + 1} must be a non-empty shell command`);
  });
  const [first, ...more] = steps;
  if (first === undefined) {
    if (value.length === 0) context.refuse("setup.run", "must list at least one command");
    return undefined;
  }
  return steps.length === value.length ? [first, ...more] : undefined;
};

const readSetupInput = (
  entry: unknown,
): { readonly path: RepoRelativePath } | { readonly issue: string } => {
  if (typeof entry !== "string") return { issue: "is not a path" };
  const read = repoRelativePathOf(entry);
  if (!read.ok) return { issue: read.issue };
  return read.path === null
    ? { issue: "is the repository itself; name a file in it" }
    : { path: read.path };
};

const readSetupInputs = (
  value: unknown,
  context: KeyContext,
): ReadonlyArray<RepoRelativePath> | undefined => {
  if (!Array.isArray(value)) {
    context.refuse("setup.inputs", "must be a list of repository-relative file paths");
    return undefined;
  }
  const paths: RepoRelativePath[] = [];
  let refused = false;
  for (const entry of value) {
    const read = readSetupInput(entry);
    if ("issue" in read) {
      refused = true;
      context.refuse("setup.inputs", `${JSON.stringify(entry)} ${read.issue}`);
    } else if (!paths.includes(read.path)) {
      paths.push(read.path);
    }
  }
  return refused ? undefined : paths;
};

const readSetup = (value: unknown, context: KeyContext): SetupDeclaration | null => {
  if (!isRecord(value)) {
    context.refuse("setup", 'must be a table: [setup] run = ["pnpm install"]');
    return null;
  }
  const { run, inputs = [], ...rest } = value;
  for (const key of Object.keys(rest)) context.ignore(`setup.${key}`);
  const steps = readSetupRun(run, context);
  const paths = readSetupInputs(inputs, context);
  return steps === undefined || paths === undefined
    ? null
    : new SetupDeclaration({ run: steps, inputs: paths });
};

type Draft = { -readonly [K in keyof RecipeFields]: RecipeFields[K] };

const readRecipe = (
  name: string,
  entry: Record<string, unknown>,
): {
  readonly recipe: ServiceRecipe | null;
  readonly refused: ReadonlyArray<RecipeRefusal>;
  readonly ignored: ReadonlyArray<IgnoredDeclaration>;
} => {
  const refused: RecipeRefusal[] = [];
  const ignored: IgnoredDeclaration[] = [];
  const context: KeyContext = {
    refuse: (key, message) => refused.push(new RecipeRefusal({ name, key, message })),
    ignore: (key) => ignored.push(new IgnoredDeclaration({ name, key })),
  };
  const draft: Draft = { ...DEFAULTS };
  const assign = <K extends keyof RecipeFields>(key: K, value: unknown) => {
    const read = READERS[key](value, context);
    if (read !== undefined) draft[key] = read;
  };
  for (const [key, value] of Object.entries(entry)) {
    if (isRecipeKey(key)) assign(key, value);
    else context.ignore(key);
  }

  if (entry["port"] === undefined) context.refuse("port", "is required: a port in 1..65535");
  if (draft.protocol === "udp" && draft.browserScheme !== null) {
    context.refuse("browserScheme", "cannot be declared for UDP");
  }
  if (entry["host"] !== undefined && draft.browserScheme !== "http") {
    context.refuse("host", 'needs browserScheme = "http"');
  }
  if (draft.ready._tag === "Http" && draft.protocol === "udp") {
    context.refuse("ready.http", "cannot check a UDP Service over HTTP");
  }
  if (draft.ready._tag === "Http" && entry["command"] === undefined) {
    context.refuse("ready.http", "needs a command: an adopted port is probed once");
  }
  if (draft.address === "docker" && draft.protocol === "udp") {
    context.refuse("address", '"docker" is for TCP Services');
  }

  for (const binding of resourceDependenciesOf(draft.depends)) {
    for (const envName of Object.keys(binding.env)) {
      if (Object.hasOwn(draft.env, envName))
        context.refuse(`env.${envName}`, `${envName} comes from @${binding.name}`);
    }
  }

  if (refused.length > 0 || draft.port === undefined) return { recipe: null, refused, ignored };
  return {
    recipe: new ServiceRecipe({
      name,
      command: draft.command,
      port: draft.port,
      protocol: draft.protocol,
      browserScheme: draft.browserScheme,
      source: "file",
      shadowedBy: null,
      cwd: draft.cwd,
      env: draft.env,
      ready: draft.ready,
      host: draft.host,
      address: draft.address,
      depends: draft.depends,
    }),
    refused,
    ignored,
  };
};

/**
 * Why `mend.toml` does not parse, by position and the parser's reason alone. The parser's own
 * message quotes the lines around the error, which can hold env values, and this text reaches the
 * workspace note, the session's routes and their logs.
 */
export const tomlDiagnostic = (cause: unknown): string => {
  if (!(cause instanceof TomlError)) return "mend.toml is not valid TOML";
  const reason = cause.message.replace(/^Invalid TOML document: /u, "").split("\n", 1)[0];
  return `mend.toml is not valid TOML: line ${cause.line}, column ${cause.column} · ${reason}`;
};

/**
 * Read `mend.toml` text wherever it was read from: the co-located worktree, or the session's live
 * workspace when Mend is not beside the files. `filePath` only names the file in the error.
 */
export const parseMendToml = (
  raw: string,
  filePath: string,
): Effect.Effect<MendTomlFile, RecipeFileError> =>
  Effect.gen(function* () {
    let parsed: unknown;
    try {
      parsed = parseToml(raw);
    } catch (cause) {
      return yield* new RecipeFileError({
        path: filePath,
        message: tomlDiagnostic(cause),
      });
    }
    if (!isRecord(parsed)) return EMPTY_MEND_TOML;
    const { service: services = {}, preview, setup: setupTable, ...rest } = parsed;
    if (!isRecord(services)) {
      return yield* new RecipeFileError({
        path: filePath,
        message: `"service" must be a table of recipes ([service.<name>]).`,
      });
    }

    const recipes: ServiceRecipe[] = [];
    const refused: RecipeRefusal[] = [];
    const { resource, ...unread } = rest;
    const ignored = Object.keys(unread).map((key) => new IgnoredDeclaration({ name: null, key }));
    const resources = readResourceTables(resource);
    refused.push(...resources.refused.map((r) => new RecipeRefusal({ name: null, ...r })));
    ignored.push(...resources.ignored.map((i) => new IgnoredDeclaration({ name: null, ...i })));
    for (const [name, entry] of Object.entries(services)) {
      if (!RECIPE_NAME.test(name)) {
        refused.push(
          new RecipeRefusal({
            name,
            key: "name",
            message: 'is not a usable Service name (lowercase letters, digits, ".", "_", "-")',
          }),
        );
      } else if (!isRecord(entry)) {
        refused.push(new RecipeRefusal({ name, key: "table", message: "must be a table" }));
      } else {
        const read = readRecipe(name, entry);
        if (read.recipe !== null) recipes.push(read.recipe);
        refused.push(...read.refused);
        ignored.push(...read.ignored);
      }
    }

    let previewService: string | null = null;
    if (preview !== undefined) {
      if (!isRecord(preview) || typeof preview["service"] !== "string") {
        refused.push(
          new RecipeRefusal({
            name: null,
            key: "preview.service",
            message: 'must name a recipe: [preview] service = "web"',
          }),
        );
      } else {
        previewService = preview["service"];
        for (const key of Object.keys(preview)) {
          if (key !== "service")
            ignored.push(new IgnoredDeclaration({ name: null, key: `preview.${key}` }));
        }
      }
    }
    const setup =
      setupTable === undefined
        ? null
        : readSetup(setupTable, {
            refuse: (key, message) => refused.push(new RecipeRefusal({ name: null, key, message })),
            ignore: (key) => ignored.push(new IgnoredDeclaration({ name: null, key })),
          });
    return {
      recipes,
      resources: resources.tables,
      refused,
      ignored,
      preview: previewService,
      setup,
    };
  });

export class WorktreeFileError extends Schema.TaggedError<WorktreeFileError>()(
  "WorktreeFileError",
  { path: Schema.String, message: Schema.String },
) {}

const isMissing = (cause: unknown) =>
  cause instanceof Error &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR");

export const WORKTREE_FILE_MAX_BYTES = 16 * 1024 * 1024;

class Refused extends Error {}

const resolveInside = async (root: string, relative: string): Promise<string | null> => {
  let real: string;
  try {
    real = await fs.realpath(path.join(root, relative));
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw cause;
  }
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
    throw new Refused("resolves outside the worktree");
  }
  return real;
};

/**
 * Opens `relative` in the worktree for reading, or answers null for no file. Never a file that
 * resolves outside it, whatever is swapped in meanwhile (the file opened is checked against the
 * path as it resolves after the open), and never anything but a regular file: a FIFO would hold
 * the read open forever, a directory has no bytes.
 */
const withWorktreeFile = <A>(
  worktree: string,
  relative: string,
  use: (file: fs.FileHandle, size: number) => Promise<A>,
): Effect.Effect<A | null, WorktreeFileError> =>
  Effect.tryPromise({
    try: async () => {
      const root = await fs.realpath(worktree);
      const real = await resolveInside(root, relative);
      if (real === null) return null;
      const file = await fs.open(
        real,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      try {
        const opened = await file.stat();
        if (opened.isDirectory()) throw new Refused("is a directory; name a file");
        if (!opened.isFile()) throw new Refused("is not a regular file");
        const now = await resolveInside(root, relative);
        const there = now === null ? null : await fs.stat(now);
        if (there === null || there.ino !== opened.ino || there.dev !== opened.dev) {
          throw new Refused("changed while it was read");
        }
        return await use(file, opened.size);
      } finally {
        await file.close();
      }
    },
    catch: (cause) =>
      new WorktreeFileError({
        path: relative,
        message: `${relative} ${cause instanceof Refused ? "" : "could not be read: "}${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

/** A worktree file's bytes, or null for none (`withWorktreeFile`), up to the size limit. */
export const readWorktreeFile = (
  worktree: string,
  relative: string,
): Effect.Effect<Uint8Array | null, WorktreeFileError> =>
  withWorktreeFile(worktree, relative, async (file, size) => {
    if (size > WORKTREE_FILE_MAX_BYTES) {
      throw new Refused(`is over the ${WORKTREE_FILE_MAX_BYTES / (1024 * 1024)} MiB Mend reads`);
    }
    return new Uint8Array(await file.readFile());
  });

/** The sha256 of a worktree file's bytes, read in chunks, or null for none (`withWorktreeFile`). */
export const digestWorktreeFile = (
  worktree: string,
  relative: string,
): Effect.Effect<string | null, WorktreeFileError> =>
  withWorktreeFile(worktree, relative, async (file) => {
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(chunk.subarray(0, bytesRead));
    }
  });

/** Read and validate the worktree's `mend.toml`. Missing or unreadable = nothing declared. */
export const readMendToml = (worktree: string): Effect.Effect<MendTomlFile, RecipeFileError> =>
  readWorktreeFile(worktree, MEND_TOML).pipe(
    Effect.orElseSucceed(() => null),
    Effect.flatMap((bytes) =>
      bytes === null
        ? Effect.succeed(EMPTY_MEND_TOML)
        : parseMendToml(new TextDecoder().decode(bytes), path.join(worktree, MEND_TOML)),
    ),
  );

const fileNamesOf = (file: MendTomlFile): ReadonlySet<string> =>
  new Set([
    ...file.recipes.map((recipe) => recipe.name),
    ...file.refused.flatMap((refusal) => (refusal.name === null ? [] : [refusal.name])),
  ]);

/**
 * File + project recipes as ONE declaration set. Collisions are refused at write time (the web
 * checks before creating); if one exists anyway, the file wins: it travels with the repo and
 * reviews like code. A name the file declares wins even while the file's recipe is refused, so a
 * broken entry never quietly runs the project's row instead.
 */
export const mergeRecipes = (
  file: ReadonlyArray<ServiceRecipe>,
  project: ReadonlyArray<ServiceRecipe>,
  fileNames: ReadonlySet<string> = new Set(file.map((recipe) => recipe.name)),
): ReadonlyArray<ServiceRecipe> => [
  ...file,
  ...project.map((recipe) =>
    fileNames.has(recipe.name) ? new ServiceRecipe({ ...recipe, shadowedBy: "file" }) : recipe,
  ),
];

/**
 * The file and the project's rows read whole: merged, then `depends` checked across the merged set
 * (it must name a runnable recipe; a self-reference or a cycle refuses every recipe on it; a recipe
 * whose dependency is refused is refused too), then `[preview]`.
 */
export const resolveDeclarations = (
  file: MendTomlFile,
  project: ReadonlyArray<ServiceRecipe>,
): ServiceDeclarations => {
  const fileNames = fileNamesOf(file);
  const merged = mergeRecipes(file.recipes, project, fileNames);
  const refused: RecipeRefusal[] = [...file.refused];
  const out = new Set<string>(fileNames);
  for (const recipe of merged) if (recipe.shadowedBy === null) out.delete(recipe.name);
  const runnable = new Map(
    merged.flatMap((recipe) =>
      recipe.shadowedBy === null ? [[recipe.name, recipe] as const] : [],
    ),
  );
  const refuse = (name: string, message: string) => {
    runnable.delete(name);
    out.add(name);
    refused.push(new RecipeRefusal({ name, key: "depends", message }));
  };

  for (const recipe of runnable.values()) {
    for (const dependency of serviceDependenciesOf(recipe.depends)) {
      if (dependency === recipe.name) {
        refuse(recipe.name, "names the recipe itself");
        break;
      }
      if (!runnable.has(dependency) && !out.has(dependency)) {
        refuse(recipe.name, `names ${dependency}, which no recipe declares`);
        break;
      }
    }
  }

  for (const recipe of runnable.values()) {
    const named = new Map<string, string>();
    for (const dependency of serviceDependenciesOf(recipe.depends)) {
      const prefix = dependencyEnvPrefix(dependency);
      const earlier = named.get(prefix);
      if (earlier !== undefined) {
        refuse(recipe.name, `names ${earlier} and ${dependency}, which both set ${prefix}_HOST`);
        break;
      }
      named.set(prefix, dependency);
    }
  }

  for (const cycle of cyclesOf(runnable)) {
    const line = [...cycle, cycle[0]].join(" → ");
    for (const name of cycle) if (runnable.has(name)) refuse(name, `forms a cycle: ${line}`);
  }

  for (let changed = true; changed; ) {
    changed = false;
    for (const recipe of runnable.values()) {
      const blocked = serviceDependenciesOf(recipe.depends).find(
        (dependency) => !runnable.has(dependency),
      );
      if (blocked !== undefined) {
        refuse(recipe.name, `names ${blocked}, which is refused`);
        changed = true;
      }
    }
  }

  let preview: PreviewDeclaration | null = null;
  if (file.preview !== null) {
    const target = runnable.get(file.preview);
    const issue =
      target === undefined
        ? `names ${file.preview}, which is not a runnable recipe`
        : target.browserScheme !== "http"
          ? `names ${file.preview}, which has no browserScheme = "http"`
          : null;
    if (issue === null) preview = new PreviewDeclaration({ service: file.preview });
    else refused.push(new RecipeRefusal({ name: null, key: "preview.service", message: issue }));
  }

  return new ServiceDeclarations({
    recipes: merged.filter((recipe) => recipe.shadowedBy !== null || runnable.has(recipe.name)),
    refused,
    ignored: file.ignored,
    preview,
    setup: file.setup,
  });
};

const cyclesOf = (
  recipes: ReadonlyMap<string, ServiceRecipe>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const cycles: Array<ReadonlyArray<string>> = [];
  const done = new Set<string>();
  const visit = (name: string, trail: ReadonlyArray<string>) => {
    const at = trail.indexOf(name);
    if (at >= 0) {
      cycles.push(trail.slice(at));
      return;
    }
    if (done.has(name)) return;
    const recipe = recipes.get(name);
    if (recipe === undefined) return;
    for (const dependency of serviceDependenciesOf(recipe.depends))
      visit(dependency, [...trail, name]);
    done.add(name);
  };
  for (const name of recipes.keys()) visit(name, []);
  return cycles;
};

/**
 * What starting `name` starts, in order: its dependencies first, depth first in listed order, each
 * once, then the recipe. The declarations refused every cycle, so the walk ends.
 */
export const planStart = (
  declarations: ServiceDeclarations,
  name: string,
): ReadonlyArray<ServiceRecipe> => {
  const byName = new Map(
    declarations.recipes.flatMap((recipe) =>
      recipe.shadowedBy === null ? [[recipe.name, recipe] as const] : [],
    ),
  );
  const plan: ServiceRecipe[] = [];
  const visit = (current: string) => {
    const recipe = byName.get(current);
    if (recipe === undefined || plan.includes(recipe)) return;
    for (const dependency of serviceDependenciesOf(recipe.depends)) visit(dependency);
    plan.push(recipe);
  };
  visit(name);
  return plan;
};
