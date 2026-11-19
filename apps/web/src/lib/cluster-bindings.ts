/**
 * Cluster bindings on a project's Variables and secrets page (route PR 55, cluster-bindings.md):
 * Kubernetes Secrets and ConfigMaps bound by name, whose keys the platform hands each new
 * workspace, and the service account workspaces run as. Mend keeps the names only, never what is
 * inside. Pure, so what the page shows for each kind of server is tested without one.
 */

/** What the server answers for a project's bindings (`GET /projects/:id/cluster-bindings`). */
export interface ClusterBindingsRead {
  readonly bindings: ReadonlyArray<{
    readonly id: string;
    readonly kind: "secret" | "configmap";
    readonly objectName: string;
  }>;
  readonly serviceAccount: string | null;
  /** Whether this server runs workspaces on Kubernetes, where bindings resolve. */
  readonly clusterCapable: boolean;
}

/**
 * Whether the page shows the section, and how:
 * - `kubernetes`: bind, remove, and set the service account;
 * - `stranded`: this server isn't on Kubernetes but the project still has bindings (moved from one
 *   that was, or bound before a runtime change). They block every launch, so the section says so
 *   and offers Remove only;
 * - `hidden`: not on Kubernetes and nothing bound: there is nothing to show.
 */
export type ClusterSection = "kubernetes" | "stranded" | "hidden";

export const clusterSection = (read: ClusterBindingsRead): ClusterSection => {
  if (read.clusterCapable) return "kubernetes";
  return read.bindings.length > 0 || read.serviceAccount !== null ? "stranded" : "hidden";
};

/** A binding as the page names it: "secret app-env", "ConfigMap feature-flags". */
export const bindingWords = (binding: {
  readonly kind: "secret" | "configmap";
  readonly objectName: string;
}): string => `${binding.kind === "secret" ? "Secret" : "ConfigMap"} ${binding.objectName}`;

/** A refused bind or service account, in a sentence beside the field. */
export const bindingRefusal = (
  outcome:
    | { readonly kind: "rejected"; readonly message: string }
    | { readonly kind: "duplicate"; readonly binding: string },
): string => {
  if (outcome.kind === "rejected") return outcome.message;
  // The server names it `<kind>/<name>`.
  const [kind = "", ...name] = outcome.binding.split("/");
  const words =
    kind === "secret" || kind === "configmap"
      ? bindingWords({ kind, objectName: name.join("/") })
      : outcome.binding;
  return `${words} is already bound to this project.`;
};
