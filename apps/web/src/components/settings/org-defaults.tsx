import { organizationDefaults, organizationDefaultSources } from "@mend/domain";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import {
  InheritChoice,
  InheritedValue,
  type InheritSource,
  type InheritValue,
} from "#/components/kit/inherit-choice";
import { Panel, SettingsSection } from "#/components/kit/section";
import { ErrorNote, errorText } from "#/components/kit/status";
import type { OrganizationSettingsDto, OrganizationSettingsViewDto } from "#/lib/api";
import { documentWriter } from "#/lib/optimistic";
import { DEFAULT_SWITCHES, onOff, type DefaultSwitch } from "#/lib/organization-defaults";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

import { useOrganizationView } from "./org-parts";

const choiceOf = (value: boolean | null): InheritValue =>
  value === null ? "inherit" : value ? "on" : "off";

const valueOf = (choice: InheritValue): boolean | null =>
  choice === "inherit" ? null : choice === "on";

/** The organization's own values over the instance's: what a project on inherit then gets. */
export const withOwnDefaults = (
  view: OrganizationSettingsViewDto,
  organization: OrganizationSettingsDto,
): OrganizationSettingsViewDto => ({
  ...view,
  organization,
  effective: organizationDefaults(view.instance, organization),
});

/**
 * Every default writes the one organization document, so all of them share one writer: a change
 * shows at once over the server's view, with what projects then inherit recomputed.
 */
const organizationDefaultsWriter = documentWriter<
  OrganizationSettingsViewDto,
  Partial<OrganizationSettingsDto>,
  OrganizationSettingsViewDto
>({
  overlay: (view, patch) => withOwnDefaults(view, { ...view.organization, ...patch }),
  saved: (_server, saved) => saved,
});

/** Where Inherit's value comes from: the instance, which its operator sets. */
export const instanceSource = (organizationName: string, operator: boolean): InheritSource => ({
  title: "From the instance default",
  detail: `Set by this machine's operator for every organization on it. Pick On or Off to set it for ${organizationName}.`,
  link: operator ? (
    <Link to="/settings/instance/defaults">Change it in Instance · Defaults</Link>
  ) : (
    "Only operators can change instance defaults"
  ),
});

/**
 * O3 · Defaults: what every project in the organization inherits unless it sets its own. Owners
 * pick Inherit, On or Off for each, and Inherit says what it resolves to and where that comes
 * from; the change shows at once and goes back if the server refuses. Members read each value
 * and its source.
 */
export function DefaultsTab() {
  const trpc = useTRPC();
  const view = useOrganizationView();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const server = useSuspenseQuery(trpc.organization.settings.queryOptions()).data;
  const settings = organizationDefaultsWriter.useVisible(server) ?? server;
  const name = view.organization.name;
  const save = useMutation(
    organizationDefaultsWriter.options({
      queryClient,
      documentKey: trpc.organization.settings.queryKey(),
      mutationKey: trpc.organization.setSettings.mutationKey(),
      send: (patch, latest) =>
        client.organization.setSettings.mutate({ ...latest.organization, ...patch }),
      // Each member's own switches fall back to these.
      related: [trpc.platform.automation.queryKey()],
    }),
  );
  const sources = organizationDefaultSources(settings.organization);
  const instance = instanceSource(name, view.operator);
  const choose = (key: DefaultSwitch, choice: InheritValue) => {
    const value = valueOf(choice);
    if (settings.organization[key] !== value) save.mutate({ [key]: value });
  };

  return (
    <Panel>
      <SettingsSection
        title={`Defaults · ${name}`}
        why={
          settings.editable
            ? "Inherit follows the instance default, set by its operator. A project can still set its own."
            : `Set by the owners of ${name}. A project can still set its own.`
        }
      >
        {DEFAULT_SWITCHES.map((row) =>
          settings.editable ? (
            <InheritChoice
              key={row.key}
              label={row.label}
              value={choiceOf(settings.organization[row.key])}
              resolved={onOff(settings.instance[row.key])}
              source={instance}
              onChange={(choice) => choose(row.key, choice)}
            />
          ) : (
            <InheritedValue
              key={row.key}
              label={row.label}
              resolved={onOff(settings.effective[row.key])}
              source={
                sources[row.key] === "organization"
                  ? {
                      title: `From ${name}'s defaults`,
                      detail: `The owners of ${name} set it for every project here.`,
                    }
                  : instance
              }
            />
          ),
        )}
        {save.error === null ? null : (
          <ErrorNote className="mt-3">{errorText(save.error)}</ErrorNote>
        )}
      </SettingsSection>
    </Panel>
  );
}
