import { Panel, SettingsSection } from "#/components/kit/section";

import { InheritedDefaults } from "./sessions-defaults";

/**
 * Settings · Landing (docs/adr/0007-landing.md): whether a session's change is pushed and its pull
 * request opened when a turn that asked for a change completes.
 */
export function LandingSettings() {
  return (
    <Panel>
      <SettingsSection
        title="Landing"
        why="Only for turns that asked for a change, never for a question. Mend never merges. A project can change it, and a session when it starts; sessions started from Slack follow the Slack app's setting."
      >
        <InheritedDefaults rows={[{ key: "autoLand", label: "Land when a turn completes" }]} />
      </SettingsSection>
    </Panel>
  );
}
