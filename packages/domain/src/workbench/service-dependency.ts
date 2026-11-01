import { Schema } from "effect";

/** A Service name keeps its wire representation; a resource binding carries its export mapping. */
export const ServiceDependency = Schema.Union([
  Schema.String,
  Schema.Struct({
    kind: Schema.Literal("resource"),
    name: Schema.String,
    env: Schema.Record(Schema.String, Schema.String),
  }),
]);
export type ServiceDependency = typeof ServiceDependency.Type;
export type RecipeResourceBinding = Exclude<ServiceDependency, string>;

/** Only Services take part in the session's dependency graph. */
export const serviceDependenciesOf = (
  dependencies: ReadonlyArray<ServiceDependency>,
): ReadonlyArray<string> =>
  dependencies.filter((dependency): dependency is string => typeof dependency === "string");

/** Resource bindings are resolved afresh at every process start, never with stored credentials. */
export const resourceDependenciesOf = (
  dependencies: ReadonlyArray<ServiceDependency>,
): ReadonlyArray<RecipeResourceBinding> =>
  dependencies.filter(
    (dependency): dependency is RecipeResourceBinding => typeof dependency !== "string",
  );

/** Read one TOML dependency without effects or runtime lookups. */
export const parseServiceDependency = (
  entry: unknown,
): { readonly dependency: ServiceDependency } | { readonly issue: string } => {
  const namePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  if (typeof entry === "string") {
    if (namePattern.test(entry)) return { dependency: entry };
    if (entry.startsWith("@") && /^[a-z]([a-z0-9-]{0,29}[a-z0-9])?$/.test(entry.slice(1)))
      return { dependency: { kind: "resource", name: entry.slice(1), env: {} } };
    return { issue: "must name a Service or a resource such as @db" };
  }
  if (entry === null || typeof entry !== "object" || Array.isArray(entry))
    return { issue: "must name a Service or a resource such as @db" };
  const named = "shared" in entry ? entry.shared : "resource" in entry ? entry.resource : undefined;
  if (typeof named !== "string" || !/^[a-z]([a-z0-9-]{0,29}[a-z0-9])?$/.test(named))
    return { issue: 'a resource binding needs shared = "db" or resource = "db"' };
  if ("shared" in entry && "resource" in entry)
    return { issue: "a resource binding names shared or resource, not both" };
  if (Object.keys(entry).some((key) => !["shared", "resource", "env"].includes(key)))
    return { issue: `@${named} binding only reads shared, resource and env` };
  const mapping = "env" in entry ? entry.env : {};
  if (mapping === null || typeof mapping !== "object" || Array.isArray(mapping))
    return { issue: `@${named} env must map environment names to exports` };
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key === "PORT" || key.startsWith("MEND_"))
      return { issue: `@${named} cannot map ${key}: Mend owns PORT and MEND_*` };
    if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value))
      return { issue: `@${named} ${key} must name an export such as url, host or port` };
    env[key] = value;
  }
  return { dependency: { kind: "resource", name: named, env } };
};

/** A worktree choice refuses only the Service that requires it. */
export const resourceDependencyRefusal = (name: string, why: "missing" | "off"): string =>
  why === "off"
    ? `@${name} · this worktree has it off · mend resource use ${name} shared`
    : `@${name} · no resource in this project · add it with mend resource add ${name}`;

/** The safe fields a preview may show when a person's stop holds a required resource. */
export const ResourceDependencyStopped = Schema.Struct({ name: Schema.String, by: Schema.String });
export type ResourceDependencyStopped = typeof ResourceDependencyStopped.Type;
