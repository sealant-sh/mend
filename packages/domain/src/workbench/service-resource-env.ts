import { resourceBindingEnv } from "./resource-runtime.ts";
import type { ResourceBinding, ResourceDefinition } from "./resource.ts";
import { resourceEnvPrefix } from "./resource.ts";
import { resourceDependenciesOf, type ServiceDependency } from "./service-dependency.ts";

/** The exact Service refusal when its selected resource has not been explicitly started. */
export const missingResourceForService = (
  service: string,
  reference: string,
  name: string | null,
): string =>
  name === null
    ? `${service} needs ${reference} · no resource gives it to this worktree`
    : `${service} needs ${reference} · @${name} is not running for this worktree · mend resource start ${name} --project or --worktree`;

/** Resolve only ${MEND_*} references; unrelated shell text is left untouched. */
export const resolveResourceReferences = (input: {
  readonly service: string;
  readonly recipeEnv: Readonly<Record<string, string>>;
  readonly resourceEnv: Readonly<Record<string, string>>;
  readonly definitions: ReadonlyArray<ResourceDefinition>;
}): { readonly env: Readonly<Record<string, string>>; readonly refusal: string | null } => {
  const env: Record<string, string> = {};
  for (const [key, template] of Object.entries(input.recipeEnv)) {
    if (key.startsWith("MEND_"))
      return { env: {}, refusal: `${input.service} cannot set ${key}: Mend owns MEND_*` };
    let refusal: string | null = null;
    const value = template.replace(
      /\$\{(MEND_[A-Z0-9_]+)\}/g,
      (original: string, reference: string) => {
        const found = input.resourceEnv[reference];
        if (found !== undefined) return found;
        const resource = input.definitions
          .toSorted((a, b) => resourceEnvPrefix(b.name).length - resourceEnvPrefix(a.name).length)
          .find((definition) => reference.startsWith(resourceEnvPrefix(definition.name)));
        refusal ??= missingResourceForService(input.service, reference, resource?.name ?? null);
        return original;
      },
    );
    if (refusal !== null) return { env: {}, refusal };
    env[key] = value;
  }
  return { env, refusal: null };
};

/** Resolve explicit dependency mappings and recipe references at Service start. */
export const serviceResourceEnv = (input: {
  readonly service: string;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
  readonly definitions: ReadonlyArray<ResourceDefinition>;
  readonly bindings: ReadonlyArray<ResourceBinding>;
  readonly projectEnvNames: ReadonlySet<string>;
  readonly resourceEnv: Readonly<Record<string, string>>;
  readonly recipeEnv: Readonly<Record<string, string>>;
}): { readonly env: Readonly<Record<string, string>>; readonly refusal: string | null } => {
  const provided = new Map<string, string>(
    input.bindings.flatMap((binding) =>
      resourceBindingEnv(binding)
        .filter(([name]) => !input.projectEnvNames.has(name))
        .map(([name]) => [name, binding.definition.name] as const),
    ),
  );
  const env: Record<string, string> = {};
  for (const dependency of resourceDependenciesOf(input.dependencies)) {
    const binding = input.bindings.find((each) => each.definition.name === dependency.name);
    if (binding === undefined)
      return {
        env: {},
        refusal: missingResourceForService(input.service, `@${dependency.name}`, dependency.name),
      };
    const prefix = resourceEnvPrefix(binding.definition.name);
    const exports = new Map(
      resourceBindingEnv(binding).map(([name, value]) => [
        name.slice(prefix.length).toLowerCase(),
        value,
      ]),
    );
    for (const [name, source] of Object.entries(dependency.env)) {
      const earlier = provided.get(name);
      if (earlier !== undefined)
        return {
          env: {},
          refusal: `${name} comes from @${earlier} · @${dependency.name} cannot map it again`,
        };
      const value = source.startsWith("port.")
        ? binding.definition.ports.find((port) => port.name === source.slice(5))?.port.toString()
        : exports.get(source.toLowerCase() === "username" ? "user" : source.toLowerCase());
      if (value === undefined)
        return {
          env: {},
          refusal: `@${dependency.name} · no export ${source} · check its resource definition`,
        };
      provided.set(name, dependency.name);
      if (!input.projectEnvNames.has(name)) env[name] = value;
    }
  }
  const resolved = resolveResourceReferences(input);
  if (resolved.refusal !== null) return resolved;
  for (const name of Object.keys(resolved.env)) {
    if (name in env) return { env: {}, refusal: `${name} comes from @${provided.get(name)}` };
  }
  return { env: { ...env, ...resolved.env }, refusal: null };
};
