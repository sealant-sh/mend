import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { Panel, SettingsSection } from "#/components/kit/section";
import { StatusWord } from "#/components/kit/status";
import { RuntimeNoteLine } from "#/components/runtime-note";
import { followedEnvironmentNote, useRuntimeFacts } from "#/lib/runtime-support";
import { useTRPC } from "#/lib/trpc";
import { workspaceImageSummary } from "#/lib/workspace-environment";

import { EnvironmentForm } from "./environment-form";
import { useOrganizationView } from "./org-parts";

/** Why new projects started from this image cannot start, and where an owner moves it. */
function UnrunnableNote({
  text,
  owner,
  organization,
}: {
  readonly text: string | null;
  readonly owner: boolean;
  readonly organization: string;
}) {
  if (text === null) return null;
  return (
    <div className="mt-3 grid gap-1.5">
      <RuntimeNoteLine note={{ tone: "refused", text }} />
      <p className="text-[12.5px] text-muted-foreground">
        {owner ? (
          <Link to="/settings/organization/defaults" className="underline underline-offset-2">
            Move it, and the projects that need it, in Defaults
          </Link>
        ) : (
          `Ask an owner of ${organization} to change it.`
        )}
      </p>
    </div>
  );
}

/**
 * O4 · Environment: the organization's starting image. Each new project starts with a copy of it;
 * changing it leaves existing projects' own images as they are (docs/adr/0025). Owners change it;
 * members read it.
 */
export function OrganizationEnvironmentTab() {
  const trpc = useTRPC();
  const view = useOrganizationView();
  const settings = useSuspenseQuery(trpc.organization.settings.queryOptions()).data;
  const name = view.organization.name;
  const own = settings.organization.workspaceImage;
  const settingsKey = trpc.organization.settings.queryKey();
  const facts = useRuntimeFacts();

  const save = useMutation(
    trpc.organization.setWorkspaceEnvironment.mutationOptions({
      onSuccess: (result, _variables, _context, { client }) => {
        client.setQueryData(settingsKey, result.settings);
      },
    }),
  );
  if (settings.editable) {
    return (
      <>
        <EnvironmentForm
          title={`Workspace environment · ${name}`}
          why={`Set for ${name}. Each new project starts with a copy; existing projects keep their own.`}
          savedImage={own}
          pending={save.isPending}
          error={save.error}
          allowScan={false}
          saveEffect="new projects start from it"
          onSave={(image) =>
            save.mutateAsync({ workspaceImage: image }).then((result) => ({
              saved: result.saved ? result.settings.organization.workspaceImage : null,
              resolutions: result.resolutions,
            }))
          }
        />
      </>
    );
  }

  return (
    <Panel>
      <SettingsSection
        title={`Workspace environment · ${name}`}
        why={`Set by the owners of ${name}. Each new project starts with a copy; existing projects keep their own.`}
      >
        <StatusWord tone={null}>
          {workspaceImageSummary(own)} · set for {name}
        </StatusWord>
        <UnrunnableNote
          text={followedEnvironmentNote(facts, own)}
          owner={false}
          organization={name}
        />
      </SettingsSection>
    </Panel>
  );
}
