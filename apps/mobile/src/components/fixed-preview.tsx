import { View } from "react-native";

import { Panel } from "@/components/panel";
import { BodyText, MonoText, UiText } from "@/components/typography";
import type { ProjectPreviewDto } from "@/data/previews";

/** Fixed URL, persisted target and observed status, with no phone target picker. */
export function FixedPreviewRead({ read }: { readonly read: ProjectPreviewDto }) {
  if (!read.configured && read.fixed === null) return null;
  return (
    <Panel>
      <View style={{ padding: 16, gap: 8 }}>
        <UiText weight="medium">Fixed project preview</UiText>
        <MonoText>{read.url ?? "Address unknown. Start from CLI or web."}</MonoText>
        <BodyText tone="muted">
          Target ·{" "}
          {read.target === null
            ? "not started"
            : `${read.target.name ?? read.target.branch} · ${read.target.branch}`}
          {read.fixed?.targetMode === "default" ? " · shared Local worktree" : ""}
        </BodyText>
        {read.status.map((line) => (
          <MonoText key={line} tone="faint">
            {line}
          </MonoText>
        ))}
        <BodyText tone="muted">Choose or start the target from CLI or web.</BodyText>
      </View>
    </Panel>
  );
}
