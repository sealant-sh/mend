import type { SettingSource } from "@mend/domain";

import type { OrganizationSettingsDto, OrganizationViewDto } from "./api.ts";

/**
 * Pure view logic for the defaults in Settings (docs/adr/0003-organizations-and-tenancy.md): the
 * instance's are the operator's, an organization's are its owners', and members read what their
 * projects inherit. Controls a role does not allow are not shown, rather than shown and refused.
 */

/** The switches an organization may set over the instance's. */
export type DefaultSwitch = Exclude<keyof OrganizationSettingsDto, "workspaceImage">;

export const DEFAULT_SWITCHES: ReadonlyArray<{
  readonly key: DefaultSwitch;
  readonly label: string;
  readonly detail: string;
}> = [
  {
    key: "backgroundSessions",
    label: "Run sessions in the background",
    detail:
      "A session keeps running when every terminal and browser disconnects. Off stops a CLI launch's session when the launching mend exits.",
  },
  {
    key: "autoTour",
    label: "Compose the description & tour",
    detail: "Runs at session settle, so review opens with them composed.",
  },
  {
    key: "autoSuggest",
    label: "Suggest fixes",
    detail:
      "Runs at session settle. Drafts suggestions only for concrete defects; most changes get none.",
  },
  {
    key: "autoName",
    label: "Name the session",
    detail: "Runs after the first prompt. A typed label always wins.",
  },
  {
    key: "autoLand",
    label: "Land when a turn completes",
    detail:
      "Pushes the change and opens or updates its pull request after a turn that asked for a change. Sessions started from Slack follow the Slack app's setting.",
  },
];

/** Which defaults a viewer sees: the instance's to the operator, their organization's to members. */
export const defaultsAccess = (
  view: OrganizationViewDto | undefined,
): { readonly instance: boolean; readonly organization: "edit" | "read" | null } => ({
  instance: view?.operator === true,
  organization: view === undefined ? null : view.role === "owner" ? "edit" : "read",
});

/** The sentence every organization default carries. */
export const appliesLine = (organizationName: string): string =>
  `Applies to every project in ${organizationName} unless the project overrides it.`;

export const onOff = (value: boolean): string => (value ? "on" : "off");

/** Where an inherited value came from, as a member reads it: the organization by name. */
export const sourceWord = (source: SettingSource, organizationName: string): string =>
  source === "organization" ? organizationName : "instance";
