// Project — repository state and its sessions, live (plan §6.2). The place
// to start an agent (with launch tunables) and step into any session; slide
// a session left to rename or delete, clear the settled set in one sweep.
// Context packs join when the context library ships (plan M3).

import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { EvButton } from "@/components/button";
import { ClearSettledButton } from "@/components/clear-settled";
import { Panel, PanelRow } from "@/components/panel";
import { RenameSessionModal, type RenameTarget } from "@/components/rename-session";
import { Screen, ScreenHeader, SectionLabel } from "@/components/screen";
import { SessionRow } from "@/components/session-row";
import { StartSessionRows } from "@/components/start-session";
import { BodyText, Eyebrow, MonoText } from "@/components/typography";
import type { LaunchOptions } from "@/data/harness-options";
import {
  ACTIVE,
  annotationDetail,
  toSession,
  useProjectSessions,
  useSessionActions,
} from "@/data/live";
import { spacing } from "@/theme/evidence";

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const detail = useProjectSessions(id ?? null);
  const { start, remove, removeSettled } = useSessionActions();
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
  const project = detail.data?.project;
  const sessions = detail.data?.sessions ?? [];

  if (detail.isError && project === undefined) {
    return (
      <Screen>
        <MonoText tone="danger">project · could not be read</MonoText>
        <BodyText tone="muted">{detail.error.message}</BodyText>
        <View style={{ flexDirection: "row" }}>
          <EvButton
            size="sm"
            variant="outline"
            label={detail.isFetching ? "retrying…" : "Retry"}
            disabled={detail.isFetching}
            onPress={() => void detail.refetch()}
          />
        </View>
      </Screen>
    );
  }
  if (project === undefined) {
    return (
      <Screen>
        <MonoText tone="faint">loading…</MonoText>
      </Screen>
    );
  }

  const fire = (
    harness: string,
    options: LaunchOptions,
    base: string | null,
    name: string | null,
  ) => {
    start.mutate(
      { projectId: project.id, harness, base, name, options },
      {
        onSuccess: (session) =>
          router.push({
            pathname: "/session/[id]",
            params: { id: session.id, mode: "protocol" },
          }),
      },
    );
  };

  const settled = sessions.filter((session) => !ACTIVE.has(session.status));

  return (
    <Screen>
      <ScreenHeader
        eyebrow="project"
        title={project.name}
        meta={`${project.defaultBranch}${project.adoptedSha === null ? "" : ` @ ${project.adoptedSha.slice(0, 7)}`}`}
      />

      <SectionLabel>Start a session</SectionLabel>
      <Panel>
        <StartSessionRows pending={start.isPending} projectId={project.id} onStart={fire} />
      </Panel>

      <View
        style={{
          marginBottom: -spacing.sm,
          paddingHorizontal: 4,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Eyebrow>Sessions</Eyebrow>
        <ClearSettledButton
          sessionIds={settled.map((session) => session.id)}
          pending={removeSettled.isPending}
          onClear={(ids) => removeSettled.mutate(ids)}
        />
      </View>
      <Panel>
        {sessions.length === 0 ? (
          <PanelRow first>
            <MonoText tone="faint">no sessions yet — start one above</MonoText>
          </PanelRow>
        ) : (
          sessions.map((session, index) => (
            <SessionRow
              key={session.id}
              session={toSession(session, project.name)}
              detail={annotationDetail(
                detail.data?.annotations.find((row) => row.sessionId === session.id),
                session.summary,
              )}
              first={index === 0}
              onPress={() => router.push({ pathname: "/session/[id]", params: { id: session.id } })}
              onRename={() => setRenaming({ sessionId: session.id, label: session.label })}
              {...(ACTIVE.has(session.status) ? {} : { onDelete: () => remove.mutate(session.id) })}
            />
          ))
        )}
      </Panel>
      <RenameSessionModal target={renaming} onClose={() => setRenaming(null)} />
    </Screen>
  );
}
