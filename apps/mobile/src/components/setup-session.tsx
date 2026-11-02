import { useRouter } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { EvButton } from "@/components/button";
import { Panel } from "@/components/panel";
import { BodyText, UiText } from "@/components/typography";
import { PROTOCOL_HARNESSES, useSessionActions } from "@/data/live";

/** A setup session starts only after the person picks their agent and consents. */
export function SetupSessionPanel({
  projectId,
  onClose,
}: {
  readonly projectId: string;
  readonly onClose: () => void;
}) {
  const router = useRouter();
  const { start } = useSessionActions();
  const [agent, setAgent] = useState<(typeof PROTOCOL_HARNESSES)[number]>("codex");
  return (
    <Panel>
      <View style={{ padding: 16, gap: 16 }}>
        <UiText weight="medium">Set up this project</UiText>
        <BodyText tone="muted">
          A setup session studies the repository and proposes .mend/ files for you to review. It
          uses your own agent login. Writing these files starts no commands, Services or resources.
        </BodyText>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {PROTOCOL_HARNESSES.map((candidate) => (
            <EvButton
              key={candidate}
              label={candidate}
              variant={agent === candidate ? "primary" : "outline"}
              disabled={start.isPending}
              onPress={() => setAgent(candidate)}
            />
          ))}
        </View>
        <EvButton
          label={start.isPending ? "Starting…" : "Set up this project"}
          disabled={start.isPending}
          onPress={() =>
            start.mutate(
              { projectId, harness: agent, purpose: "setup" },
              {
                onSuccess: (session) =>
                  router.replace({
                    pathname: "/session/[id]",
                    params: { id: session.id, mode: "protocol" },
                  }),
              },
            )
          }
        />
        <EvButton label="Not now" variant="ghost" disabled={start.isPending} onPress={onClose} />
        {start.isError ? <BodyText tone="danger">{start.error.message}</BodyText> : null}
      </View>
    </Panel>
  );
}
