import type { HostUserNamespaces } from "@mend/domain/workbench";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

/**
 * Whether the host whose Docker runs the workspaces lets their Docker services start
 * (`hostUserNamespacesOf` in `@mend/domain`). Every workspace's Docker service is a rootless
 * daemon, so a kernel that refuses unprivileged user namespaces fails every launch, after the
 * image build. The engine asks before a launch creates anything, and fails it at once with the
 * fix instead.
 *
 * `observe` reads the kernel each time it is asked: once the operator applies the setting, the
 * next launch goes ahead without a restart. Null when the workspaces do not run on this host's
 * Docker (a cluster, a remote runtime): nothing here can say, and the launch goes ahead.
 */
export class WorkspaceHostUserNamespaces extends Context.Service<
  WorkspaceHostUserNamespaces,
  {
    readonly observe: () => Effect.Effect<HostUserNamespaces | null>;
  }
>()("@mend/sessions/WorkspaceHostUserNamespaces") {}

/** Nothing observed: the workspaces run elsewhere, or nothing here reads the host. */
export const WorkspaceHostUserNamespacesUnobserved: Layer.Layer<WorkspaceHostUserNamespaces> =
  Layer.succeed(WorkspaceHostUserNamespaces, { observe: () => Effect.succeed(null) });
