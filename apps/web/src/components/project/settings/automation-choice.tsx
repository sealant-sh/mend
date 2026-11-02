import { InheritChoice } from "#/components/kit/inherit-choice";
import type { ProjectDto } from "#/lib/api";
import {
  inheritValue,
  useAutomationSetting,
  useInheritedAutomation,
  type AutomationKey,
} from "#/lib/project-settings";

/**
 * One Inherit · On · Off project setting. Inherit shows what it resolves to and, on hover or
 * focus, where that comes from. A pick shows at once; a refusal puts the old pick back and says
 * so under the row.
 */
export function AutomationChoice({
  project,
  setting,
  label,
  disabled,
}: {
  readonly project: ProjectDto;
  readonly setting: AutomationKey;
  readonly label: string;
  readonly disabled: boolean;
}) {
  const save = useAutomationSetting(project, setting);
  const inherited = useInheritedAutomation();
  const resolved = inherited.of(setting, project.name);
  return (
    <>
      <InheritChoice
        label={label}
        value={inheritValue(project[setting])}
        disabled={disabled}
        onChange={(value) => save.mutate(value)}
        resolved={resolved?.resolved ?? (inherited.failed ? "unknown" : "…")}
        source={
          resolved?.source ??
          (inherited.failed
            ? {
                title: "Where it comes from did not load",
                detail:
                  "Mend could not read the organization's defaults. Pick On or Off to set it here.",
              }
            : {
                title: "Reading the defaults…",
                detail: "Inherit follows the organization's defaults.",
              })
        }
      />
      {save.isError ? (
        <p role="alert" className="pb-1.5 font-mono text-[11.5px] text-danger">
          Not saved: {save.error instanceof Error ? save.error.message : String(save.error)}.{" "}
          {label} is back as it was.
        </p>
      ) : null}
    </>
  );
}
