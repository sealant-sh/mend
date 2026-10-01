// Now — a sparse attention inbox (plan §6.1), fed by the LIVE workbench API:
// what is waiting for me, what runs, what recently settled. Not a kanban.

import { useRouter } from "expo-router";
import { useState, type ReactNode } from "react";
import { View } from "react-native";

import { EvButton } from "@/components/button";
import { ClearSettledButton } from "@/components/clear-settled";
import { Panel } from "@/components/panel";
import { RenameSessionModal, type RenameTarget } from "@/components/rename-session";
import { Screen, ScreenHeader } from "@/components/screen";
import { SessionRow } from "@/components/session-row";
import { Eyebrow, MonoText, UiText } from "@/components/typography";
import {
  ACTIVE,
  annotationDetail,
  toSession,
  useAllSessions,
  useConfig,
  useSessionActions,
} from "@/data/live";
import { useEvidenceTheme } from "@/theme/evidence";

function GroupLabel({ label, action }: { readonly label: string; readonly action?: ReactNode }) {
  const { colors } = useEvidenceTheme();
  return (
    <View
      style={{
        backgroundColor: colors.sunken,
        paddingHorizontal: 16,
        paddingVertical: 6,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
      }}
    >
      <Eyebrow>{label}</Eyebrow>
      {action}
    </View>
  );
}

export default function NowScreen() {
  const router = useRouter();
  const config = useConfig();
  const all = useAllSessions();
  const { remove, removeSettled } = useSessionActions();
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
  const rows = (all.data ?? []).map(({ session, project, annotation }) => ({
    dto: session,
    view: toSession(session, project.name),
    detail: annotationDetail(annotation, session.summary),
  }));

  const openSession = (id: string) => router.push({ pathname: "/session/[id]", params: { id } });

  // The stored config has not been read off disk yet: neither panel is true
  // yet, so show the header alone rather than flash "not paired" at a phone
  // that is paired.
  if (config === null) {
    return (
      <Screen topInset>
        <ScreenHeader eyebrow="mend" title="Now" meta="reading this device" />
      </Screen>
    );
  }

  // Nothing to inbox until this phone has a machine to ask.
  if (config.url === "" || config.token === "") {
    return (
      <Screen topInset>
        <ScreenHeader eyebrow="mend" title="Now" meta="not paired" />
        <Panel>
          <View style={{ padding: 16, gap: 12 }}>
            <UiText weight="medium">Pair this phone with your machine</UiText>
            <UiText>
              On the machine running Mend, open Settings → Devices and show the pairing code. Scan
              it here and this phone gets its own token.
            </UiText>
            <MonoText tone="faint">no server · no token</MonoText>
            <EvButton label="Pair with your machine" onPress={() => router.push("/pair")} />
          </View>
        </Panel>
      </Screen>
    );
  }

  const settled = rows.filter(({ dto }) => !ACTIVE.has(dto.status));
  const groups = [
    { label: "Needs you", items: rows.filter(({ dto }) => dto.status === "waiting") },
    {
      label: "Live",
      items: rows.filter(({ dto }) => dto.status !== "waiting" && ACTIVE.has(dto.status)),
    },
    { label: "Recently settled", items: settled.slice(0, 8) },
  ];

  return (
    <Screen topInset>
      <ScreenHeader
        eyebrow="mend"
        title="Now"
        meta={
          all.isError
            ? "sessions could not be read"
            : all.isLoading
              ? "connecting…"
              : `${(groups[0]?.items.length ?? 0) === 0 ? "nothing waiting on you" : `${groups[0]?.items.length} waiting`} · ${groups[1]?.items.length ?? 0} live`
        }
      />
      {all.isError && (
        <Panel>
          <View style={{ padding: 16, gap: 10 }}>
            <MonoText tone="ink2">{all.error.message}</MonoText>
            <View style={{ flexDirection: "row" }}>
              <EvButton
                size="sm"
                variant="outline"
                label={all.isFetching ? "retrying…" : "Retry"}
                disabled={all.isFetching}
                onPress={() => void all.refetch()}
              />
            </View>
          </View>
        </Panel>
      )}
      {groups.map(({ label, items }) =>
        items.length === 0 ? null : (
          <Panel key={label}>
            <GroupLabel
              label={label}
              action={
                label === "Recently settled" ? (
                  <ClearSettledButton
                    sessionIds={settled.map(({ dto }) => dto.id)}
                    pending={removeSettled.isPending}
                    onClear={(ids) => removeSettled.mutate(ids)}
                  />
                ) : undefined
              }
            />
            {items.map(({ dto, view, detail }) => (
              <SessionRow
                key={view.id}
                session={view}
                detail={detail}
                onPress={() => openSession(view.id)}
                onRename={() => setRenaming({ sessionId: dto.id, label: dto.label })}
                {...(ACTIVE.has(dto.status) ? {} : { onDelete: () => remove.mutate(dto.id) })}
              />
            ))}
          </Panel>
        ),
      )}
      <RenameSessionModal target={renaming} onClose={() => setRenaming(null)} />
    </Screen>
  );
}
