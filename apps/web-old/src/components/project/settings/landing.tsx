import { Panel, SettingsSection } from "#/components/kit/section";
import type { ProjectDetailDto } from "#/lib/api";

import { AutomationChoice } from "./automation-choice";
import type { SettingsReads } from "./reads";

/** The Landing tab draws from the project detail and the organization's defaults alone. */
export const landingReads: SettingsReads = () => [];

/**
 * Project settings · Landing (screen L6). Background sessions are resolved by the launching CLI,
 * the only client that could enforce a foreground stop. Landing (docs/adr/0007) pushes and opens
 * or updates the pull request after a completed turn whose request asked for a change, as the
 * change's owner; never for a question, and Off also covers sessions started from Slack.
 */
export function LandingSettings({ detail }: { readonly detail: ProjectDetailDto }) {
  const { project, capabilities } = detail;
  return (
    <Panel>
      <SettingsSection
        title="Sessions"
        why="Whether sessions keep running when you close every client. Off stops a CLI session when the mend that started it exits."
      >
        <AutomationChoice
          project={project}
          setting="backgroundSessions"
          label="Run sessions in the background"
          disabled={!capabilities.manage}
        />
      </SettingsSection>
      <SettingsSection
        title="Landing"
        why="Push and open a pull request when a turn that asked for a change completes. Mend never merges."
      >
        <AutomationChoice
          project={project}
          setting="autoLand"
          label="Land when a turn completes"
          disabled={!capabilities.manage}
        />
        <p className="mt-1 max-w-[60ch] text-[12.5px] text-muted-foreground">
          A turn read as a question does not land, and neither does one someone else sent. A session
          can choose for itself when it starts. Terminal sessions never land by themselves.
        </p>
      </SettingsSection>
    </Panel>
  );
}
