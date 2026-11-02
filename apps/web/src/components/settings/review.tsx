import { Panel, SettingsSection } from "#/components/kit/section";

import { InheritedDefaults } from "./sessions-defaults";

/** Settings · Review: the passes Mend runs around each change, as this person's sessions get them. */
export function ReviewSettings() {
  return (
    <Panel>
      <SettingsSection
        title="Review automation"
        why="Mend uses inference for these, on the login of whoever sent the turn. A project can change them for itself."
      >
        <InheritedDefaults
          rows={[
            { key: "autoTour", label: "Compose the description and tour" },
            { key: "autoSuggest", label: "Suggest fixes" },
            { key: "autoName", label: "Name the session" },
          ]}
        />
      </SettingsSection>
    </Panel>
  );
}
