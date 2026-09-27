// Projects — every adopted repo: start a session in place (with launch
// tunables), and every existing session right there, tappable. Same verbs
// as web and CLI; slide a row left to rename or delete.

import { useRouter } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { EvButton } from "@/components/button";
import { Panel, PanelRow } from "@/components/panel";
import { RenameSessionModal, type RenameTarget } from "@/components/rename-session";
import { Screen, ScreenHeader } from "@/components/screen";
import { SessionRow } from "@/components/session-row";
import { StartSessionRows } from "@/components/start-session";
import { MonoText, UiText } from "@/components/typography";
import type { LaunchOptions } from "@/data/harness-options";
import {
  ACTIVE,
  annotationDetail,
  toSession,
  useAllSessions,
  useProjects,
  useSessionActions,
} from "@/data/live";

export default function ProjectsScreen() {
  const router = useRouter();
  const projects = useProjects();
  const all = useAllSessions();
  const { start, remove } = useSessionActions();
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);

  const fire = (
    projectId: string,
    harness: string,
    options: LaunchOptions,
    base: string | null,
    name: string | null,
  ) => {
    start.mutate(
      { projectId, harness, base, name, options },
      {
        onSuccess: (session) =>
          router.push({
            pathname: "/session/[id]",
            params: { id: session.id, mode: "protocol" },
          }),
      },
    );
  };

  return (
    <Screen topInset>
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <View style={{ flexShrink: 1 }}>
          <ScreenHeader
            eyebrow="mend"
            title="Projects"
            meta={
              projects.data !== undefined
                ? `${projects.data.length} adopted`
                : projects.isError
                  ? "projects could not be read"
                  : "reading projects…"
            }
          />
        </View>
        <EvButton size="sm" label="Adopt" onPress={() => router.push("/adopt")} />
      </View>
      {projects.isError && (
        <Panel>
          <View style={{ padding: 16, gap: 10 }}>
            <MonoText tone="ink2">{projects.error.message}</MonoText>
            <View style={{ flexDirection: "row" }}>
              <EvButton
                size="sm"
                variant="outline"
                label={projects.isFetching ? "retrying…" : "Retry"}
                disabled={projects.isFetching}
                onPress={() => void projects.refetch()}
              />
            </View>
          </View>
        </Panel>
      )}
      {(projects.data ?? []).map((project) => {
        const sessions = (all.data ?? [])
          .filter(({ session }) => session.projectId === project.id)
          .slice(0, 8);
        return (
          <Panel key={project.id}>
            <PanelRow first>
              <View style={{ gap: 4 }}>
                <UiText weight="medium">{project.name}</UiText>
                <MonoText>
                  {project.defaultBranch}
                  {project.adoptedSha === null ? "" : `@${project.adoptedSha.slice(0, 7)}`}
                </MonoText>
              </View>
            </PanelRow>
            <StartSessionRows
              first={false}
              pending={start.isPending}
              projectId={project.id}
              onStart={(harness, options, base, name) =>
                fire(project.id, harness, options, base, name)
              }
            />
            {sessions.map(({ session, annotation }) => (
              <SessionRow
                key={session.id}
                session={toSession(session, project.name)}
                detail={annotationDetail(annotation, session.summary)}
                onPress={() =>
                  router.push({ pathname: "/session/[id]", params: { id: session.id } })
                }
                onRename={() => setRenaming({ sessionId: session.id, label: session.label })}
                {...(ACTIVE.has(session.status)
                  ? {}
                  : { onDelete: () => remove.mutate(session.id) })}
              />
            ))}
          </Panel>
        );
      })}
      <RenameSessionModal target={renaming} onClose={() => setRenaming(null)} />
    </Screen>
  );
}
