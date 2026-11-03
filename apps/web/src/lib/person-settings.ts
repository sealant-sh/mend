import type { InheritValue } from "#/components/kit/inherit-choice";

import type { PersonAutomationDto, PersonSettingsDto } from "./api.ts";
import { documentWriter } from "./optimistic.ts";

/**
 * Pure view logic for a person's own automation switches (You · Sessions, Review and Landing).
 * Each is Inherit (their organization's default, else the instance's), On or Off, and a project's
 * own choice still sits above them.
 */

export type PersonSwitch = keyof PersonSettingsDto;

/** The stored value as the three-way choice says it: null is Inherit. */
export const choiceOf = (value: boolean | null): InheritValue =>
  value === null ? "inherit" : value ? "on" : "off";

/** The choice as stored. */
export const valueOf = (choice: InheritValue): boolean | null =>
  choice === "inherit" ? null : choice === "on";

const SWITCHES: ReadonlyArray<PersonSwitch> = [
  "autoTour",
  "autoSuggest",
  "autoName",
  "autoLand",
  "backgroundSessions",
];

/** The view with these own values, and what the person's sessions then get. */
export const withOwnSettings = (
  view: PersonAutomationDto,
  own: PersonSettingsDto,
): PersonAutomationDto => {
  const effective = { ...view.effective };
  for (const key of SWITCHES) effective[key] = own[key] ?? view.inherited[key];
  return { ...view, own, effective };
};

/**
 * Every switch writes the one person document, so all of them share one writer: a change shows at
 * once, and a refusal puts back that switch alone.
 */
export const personAutomationWriter = documentWriter<
  PersonAutomationDto,
  Partial<PersonSettingsDto>,
  PersonAutomationDto
>({
  overlay: (view, patch) => withOwnSettings(view, { ...view.own, ...patch }),
  saved: (_server, saved) => saved,
});
