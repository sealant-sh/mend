import { useMutation, useSuspenseQuery } from "@tanstack/react-query";

import { useTRPC } from "#/lib/trpc";

import { EnvironmentForm } from "./environment-form";

/**
 * O9 · Instance · Environment (the operator's): the workspace environment every organization on
 * this machine inherits unless it sets its own. Only the operator may scan the machine for tools.
 */
export function InstanceEnvironmentTab() {
  const trpc = useTRPC();
  const settings = useSuspenseQuery(trpc.settings.get.queryOptions()).data;
  const save = useMutation(
    trpc.settings.saveWorkspaceEnvironment.mutationOptions({
      onSuccess: (result, _variables, _context, { client }) => {
        if (!result.saved) return undefined;
        client.setQueryData(trpc.settings.get.queryKey(), result.settings);
        // Organizations that follow the instance read it through their own view.
        return client.invalidateQueries(trpc.organization.settings.queryFilter());
      },
    }),
  );
  return (
    <EnvironmentForm
      title="Workspace environment · instance"
      why="The default for every organization on this machine. Operators only."
      savedImage={settings.workspaceImage}
      pending={save.isPending}
      error={save.error}
      allowScan
      saveEffect="new sessions rebuild their image"
      onSave={(image) =>
        save.mutateAsync(image).then((result) => ({
          saved: result.saved ? result.settings.workspaceImage : null,
          resolutions: result.resolutions,
        }))
      }
    />
  );
}
