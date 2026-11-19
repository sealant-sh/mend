import { useMutation, useSuspenseQuery } from "@tanstack/react-query";

import { useTRPC } from "#/lib/trpc";

import { EnvironmentForm } from "./environment-form";

/**
 * O9 · Instance · Environment (the operator's): the image a new organization on this machine starts
 * with a copy of (docs/adr/0025). Existing organizations keep their own. Only the operator may scan
 * the machine for tools.
 */
export function InstanceEnvironmentTab() {
  const trpc = useTRPC();
  const settings = useSuspenseQuery(trpc.settings.get.queryOptions()).data;
  const save = useMutation(
    trpc.settings.saveWorkspaceEnvironment.mutationOptions({
      onSuccess: (result, _variables, _context, { client }) => {
        if (!result.saved) return undefined;
        client.setQueryData(trpc.settings.get.queryKey(), result.settings);
        return undefined;
      },
    }),
  );
  return (
    <EnvironmentForm
      title="Workspace environment · instance"
      why="Each new organization on this machine starts with a copy; existing ones keep their own. Operators only."
      savedImage={settings.workspaceImage}
      pending={save.isPending}
      error={save.error}
      allowScan
      saveEffect="new organizations start from it"
      onSave={(image) =>
        save.mutateAsync(image).then((result) => ({
          saved: result.saved ? result.settings.workspaceImage : null,
          resolutions: result.resolutions,
        }))
      }
    />
  );
}
