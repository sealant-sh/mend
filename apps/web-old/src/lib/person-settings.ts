import type { PersonAutomationDto, PersonSettingsDto } from "./api.ts";
import { documentWriter } from "./optimistic.ts";

/**
 * Pure view logic for a person's own automation switches (You · Sessions, Review and Landing).
 * Each is On or Off and theirs alone (docs/adr/0025-one-home-per-setting.md); a project's own
 * choice still sits above them.
 */

export type PersonSwitch = keyof PersonSettingsDto;

/** The view with these own values, which are also what the person's sessions get. */
export const withOwnSettings = (
  view: PersonAutomationDto,
  own: PersonSettingsDto,
): PersonAutomationDto => ({ ...view, own, effective: own });

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
