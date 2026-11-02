import { Panel, SettingsSection } from "#/components/kit/section";
import type { ProjectDetailDto } from "#/lib/api";

import { AutomationChoice } from "./automation-choice";
import type { SettingsReads } from "./reads";

/** The Review tab draws from the project detail and the organization's defaults alone. */
export const reviewReads: SettingsReads = () => [];

/** Project settings · Review (screen L7): what Mend does with each change once a session settles. */
export function ReviewSettings({ detail }: { readonly detail: ProjectDetailDto }) {
  const { project, capabilities } = detail;
  const disabled = !capabilities.manage;
  return (
    <Panel>
      <SettingsSection
        title="Review automation"
        why="What Mend does with each change. Mend uses inference for these."
      >
        <AutomationChoice
          project={project}
          setting="autoTour"
          label="Compose the description and tour"
          disabled={disabled}
        />
        <AutomationChoice
          project={project}
          setting="autoSuggest"
          label="Suggest fixes"
          disabled={disabled}
        />
        <AutomationChoice
          project={project}
          setting="autoName"
          label="Name the session"
          disabled={disabled}
        />
      </SettingsSection>
    </Panel>
  );
}
