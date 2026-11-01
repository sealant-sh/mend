import type { WorktreeId } from "../ids.ts";
import { resourceBindings, resourceBindingEnv } from "./resource-runtime.ts";
import {
  resourceEnvPrefix,
  type ResourceDefinitionInput,
  type WorktreeChoice,
} from "./resource.ts";
import {
  resourceDependenciesOf,
  resourceDependencyRefusal,
  type ServiceDependency,
} from "./service-dependency.ts";

/** Resolve export mappings and collisions from definitions and choices, with no runtime access. */
export const serviceResourceEnv = (input: {
  readonly dependencies: ReadonlyArray<ServiceDependency>;
  readonly definitions: ReadonlyArray<{
    readonly spec: ResourceDefinitionInput;
    readonly choice: WorktreeChoice | null;
  }>;
  readonly worktreeId: WorktreeId;
  readonly projectEnvNames: ReadonlySet<string>;
  readonly recipeEnv: Readonly<Record<string, string>>;
}): { readonly env: Readonly<Record<string, string>>; readonly refusal: string | null } => {
  const bindings = resourceBindings(input.definitions);
  const provided = new Map<string, string>();
  // Mappings cannot shadow another binding's automatic names, including a binding not named in depends.
  for (const binding of bindings) {
    const only =
      bindings.filter((other) => other.definition.preset === binding.definition.preset).length ===
      1;
    for (const [name] of resourceBindingEnv(binding, input.worktreeId, only)) {
      if (!input.projectEnvNames.has(name)) provided.set(name, binding.definition.name);
    }
  }
  const env: Record<string, string> = {};
  const required = resourceDependenciesOf(input.dependencies);
  for (const dependency of required) {
    const definition = input.definitions.find((each) => each.spec.name === dependency.name);
    if (definition === undefined)
      return { env: {}, refusal: resourceDependencyRefusal(dependency.name, "missing") };
    const binding = bindings.find((each) => each.definition.name === dependency.name);
    if (binding === undefined)
      return { env: {}, refusal: resourceDependencyRefusal(dependency.name, "off") };
    const prefix = resourceEnvPrefix(binding.definition.name);
    const exports = new Map(
      resourceBindingEnv(binding, input.worktreeId, false).map(([name, value]) => [
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
      const key = source.startsWith("port.")
        ? `port_${source.slice(5).replaceAll("-", "_")}`
        : source;
      const value = exports.get(key.toLowerCase());
      if (value === undefined)
        return {
          env: {},
          refusal: `@${dependency.name} · no export ${source} · check its resource definition`,
        };
      provided.set(name, dependency.name);
      env[name] = value;
    }
  }
  const requiredNames = new Set(required.map((each) => each.name));
  for (const name of Object.keys(input.recipeEnv)) {
    const resource = provided.get(name);
    if (resource !== undefined && requiredNames.has(resource))
      return { env: {}, refusal: `${name} comes from @${resource}` };
  }
  return { env, refusal: null };
};
