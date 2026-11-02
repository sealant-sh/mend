import { Panel } from "#/components/kit/section";
import type { ProjectDetailDto } from "#/lib/api";

import type { SettingsReads } from "./reads";
import { ClusterBindingsSection } from "./secrets-bindings";
import { StoredSecretsSection } from "./secrets-stored";
import { VariablesSection } from "./secrets-variables";

/** What the Secrets tab reads before it shows, started together. */
export const secretsReads: SettingsReads = ({ queryClient, trpc }, projectId) => [
  queryClient.ensureQueryData(trpc.environment.environment.queryOptions({ projectId })),
  queryClient.ensureQueryData(trpc.environment.secrets.queryOptions({ projectId })),
  queryClient.ensureQueryData(trpc.environment.clusterBindings.queryOptions({ projectId })),
];

/**
 * Project settings · Secrets (screen L4): the values every session in this project gets. Plain
 * variables open, then secrets and cluster bindings folded, since the names are all they show.
 * Changes reach new workspace launches, a resumed session included; running workspaces keep what
 * they started with.
 */
export function SecretsSettings({ detail }: { readonly detail: ProjectDetailDto }) {
  const projectId = detail.project.id;
  if (!detail.capabilities.manage)
    return (
      <Panel className="px-[26px] py-6">
        <p className="text-[13.5px] text-ink-2">
          The project&apos;s creator or an organization owner sets its variables and secrets.
        </p>
      </Panel>
    );
  return (
    <Panel>
      <VariablesSection projectId={projectId} />
      <StoredSecretsSection projectId={projectId} />
      <ClusterBindingsSection projectId={projectId} />
    </Panel>
  );
}
