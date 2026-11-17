import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "#/components/kit/button";
import { Panel, SettingsSection } from "#/components/kit/section";
import { ErrorNote, errorText, StatusWord } from "#/components/kit/status";
import { RuntimeNoteLine } from "#/components/runtime-note";
import { followedEnvironmentNote, useRuntimeFacts } from "#/lib/runtime-support";
import { useTRPC } from "#/lib/trpc";
import { workspaceImageSummary } from "#/lib/workspace-environment";

import { EnvironmentForm } from "./environment-form";
import { useOrganizationView } from "./org-parts";

/** Why projects that follow this environment cannot start, and where an owner moves it. */
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
 * O4 · Environment: the workspace environment every project in the organization inherits unless
 * it sets its own. Owners set it over the instance's, or follow the instance again; members read
 * what applies and where it comes from. Applied whenever a session starts or resumes; workspaces
 * already running are unchanged.
 */
export function OrganizationEnvironmentTab() {
  const trpc = useTRPC();
  const view = useOrganizationView();
  const settings = useSuspenseQuery(trpc.organization.settings.queryOptions()).data;
  const [customizing, setCustomizing] = useState(false);
  const name = view.organization.name;
  const own = settings.organization.workspaceImage;
  const settingsKey = trpc.organization.settings.queryKey();
  const facts = useRuntimeFacts();

  const save = useMutation(
    trpc.organization.setWorkspaceEnvironment.mutationOptions({
      onSuccess: (result, _variables, _context, { client }) => {
        client.setQueryData(settingsKey, result.settings);
        if (result.saved) setCustomizing(false);
      },
    }),
  );
  const follow = useMutation(
    trpc.organization.setWorkspaceEnvironment.mutationOptions({
      onSuccess: (result, _variables, _context, { client }) =>
        client.setQueryData(settingsKey, result.settings),
    }),
  );

  if (settings.editable && (own !== null || customizing)) {
    return (
      <>
        <EnvironmentForm
          title={`Workspace environment · ${name}`}
          why={
            own === null
              ? `Starts from the instance's. Saving sets it for ${name}; projects can override it.`
              : `Set for ${name}. Projects can override it.`
          }
          savedImage={own ?? settings.effective.workspaceImage}
          pending={save.isPending}
          error={save.error}
          allowScan={false}
          saveEffect="new sessions rebuild their image"
          onSave={(image) =>
            save.mutateAsync({ workspaceImage: image }).then((result) => ({
              saved: result.saved ? result.settings.organization.workspaceImage : null,
              resolutions: result.resolutions,
            }))
          }
          actions={
            own === null ? (
              <Button size="sm" variant="ghost" onClick={() => setCustomizing(false)}>
                Keep following the instance
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={follow.isPending}
                onClick={() => follow.mutate({ workspaceImage: null })}
              >
                {follow.isPending ? "Saving…" : "Follow the instance"}
              </Button>
            )
          }
        />
        {follow.error === null ? null : (
          <ErrorNote className="mt-3">{errorText(follow.error)}</ErrorNote>
        )}
      </>
    );
  }

  return (
    <Panel>
      <SettingsSection
        title={`Workspace environment · ${name}`}
        why={
          own === null
            ? "Follows the instance's environment, set by its operator. Projects can override it."
            : `Set by the owners of ${name}. Projects can override it.`
        }
      >
        <StatusWord tone={null}>
          {workspaceImageSummary(settings.effective.workspaceImage)} ·{" "}
          {own === null ? "from the instance" : `set for ${name}`}
        </StatusWord>
        <UnrunnableNote
          text={followedEnvironmentNote(facts, settings.effective.workspaceImage)}
          owner={settings.editable}
          organization={name}
        />
        {settings.editable ? (
          <div className="mt-3">
            <Button size="sm" onClick={() => setCustomizing(true)}>
              Set for {name}
            </Button>
          </div>
        ) : null}
      </SettingsSection>
    </Panel>
  );
}
